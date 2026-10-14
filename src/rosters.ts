/**
 * Archivio precalcolato (public/rosters/, generato da scripts/build-rosters.mjs): la rosa
 * storica di ogni squadra, da Wikidata più i periodi che mancavano presi da Wikipedia.
 * L'incrocio tra squadre si fa qui, sul dispositivo: nessuna query a Wikidata per ricerca.
 */
import type { Player, Spell, TeamGroup } from './players';

/** [da, a, flag?] con flag 1 = prestito, 2 = periodo preso da Wikipedia. */
type RawSpell = [number | null, number | null, number?];
/** [id numerico, nome, notorietà, anno di nascita, foto Commons, voce "it:Titolo" / "en:Titolo", periodi] */
type RosterRow = [number, string, number, number | null, string, string, RawSpell[]];

const LOAN = 1;
const WIKI = 2;
const BASE = `${import.meta.env.BASE_URL}rosters/`;

let info: Promise<{ updated: string } | null> | null = null;

/** Data di aggiornamento dell'archivio, o null se l'archivio non c'è. */
export function archiveInfo(): Promise<{ updated: string } | null> {
  info ??= fetch(`${BASE}meta.json`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  return info;
}

const rosters = new Map<string, Promise<RosterRow[]>>();

function roster(id: string): Promise<RosterRow[]> {
  let p = rosters.get(id);
  if (!p) {
    p = fetch(`${BASE}${id}.json`).then((r) => {
      // Squadra senza giocatori noti: 404, oppure (server di sviluppo) la pagina dell'app al posto del file
      if (r.status === 404 || !(r.headers.get('content-type') ?? '').includes('json')) return [];
      if (!r.ok) throw new Error(`Archivio HTTP ${r.status}`);
      return r.json() as Promise<RosterRow[]>;
    });
    p.catch(() => rosters.delete(id)); // al prossimo tentativo si riscarica
    rosters.set(id, p);
  }
  return p;
}

/** Tutti i giocatori (id numerici) passati per una squadra, unendo le voci di una squadra rifondata. */
export async function rosterPlayers(ids: string[]): Promise<Set<number>> {
  const lists = await Promise.all(ids.map(roster));
  const out = new Set<number>();
  for (const list of lists) for (const row of list) out.add(row[0]);
  return out;
}

function wikiUrl(wiki: string, id: string): string {
  const m = /^(it|en):(.+)$/.exec(wiki);
  if (!m) return `https://www.wikidata.org/wiki/${id}`;
  return `https://${m[1]}.wikipedia.org/wiki/${encodeURIComponent(m[2].replace(/ /g, '_'))}`;
}

interface SlotEntry {
  row: RosterRow;
  spells: RawSpell[];
}

export async function findInArchive(groups: TeamGroup[]): Promise<Player[]> {
  // Per ogni squadra scelta: giocatore -> periodi (unendo le voci di una squadra rifondata)
  const slots = await Promise.all(
    groups.map(async (g) => {
      const lists = await Promise.all(g.map(roster));
      const bySlot = new Map<number, SlotEntry>();
      for (const list of lists) {
        for (const row of list) {
          const e = bySlot.get(row[0]);
          if (e) e.spells.push(...row[6]);
          else bySlot.set(row[0], { row, spells: [...row[6]] });
        }
      }
      return bySlot;
    }),
  );

  // Si parte dalla squadra con meno giocatori: è l'incrocio più rapido
  const order = slots.map((_, i) => i).sort((a, b) => slots[a].size - slots[b].size);
  const players: Player[] = [];
  for (const [num, first] of slots[order[0]]) {
    if (!order.every((i) => slots[i].has(num))) continue;
    const spells: Spell[] = [];
    let fromWikipedia = false;
    groups.forEach((g, i) => {
      const raw = slots[i].get(num)!.spells;
      if (raw.every((s) => ((s[2] ?? 0) & WIKI) !== 0)) fromWikipedia = true;
      const mine = raw
        .map(([from, to, flag]): Spell => ({ teamId: g[0], from, to, loan: ((flag ?? 0) & LOAN) !== 0 }))
        .sort((a, b) => (a.from ?? 9999) - (b.from ?? 9999));
      spells.push(...mine);
    });
    const [, name, popularity, born, image, wiki] = first.row;
    const years = spells.flatMap((s) => [s.from, s.to]).filter((y): y is number => y !== null);
    const id = `Q${num}`;
    players.push({
      id,
      name,
      popularity,
      born,
      image,
      url: wikiUrl(wiki, id),
      spells,
      lastYear: years.length ? Math.max(...years) : 0,
      fromWikipedia,
    });
  }
  return players;
}

/**
 * Seconda fonte: giocatori che Wikidata non dà perché la loro carriera lì è incompleta
 * (es. Denswil e Dijks senza il Bologna), ma che su Wikipedia italiana hanno il periodo.
 *
 * 1. Su Wikipedia si cercano le voci con il riquadro carriera che linkano tutte le squadre.
 * 2. Molte sono falsi positivi (chi ha solo giocato contro). Con Wikidata si tengono quelle
 *    più probabili: carriera che conferma tutte le squadre tranne una, o carriera assente.
 * 3. Di queste si legge il riquadro e si confrontano le squadre tramite i loro link.
 */
import { parseYears, type Player, type Spell, type TeamGroup } from './players';
import { fetchRetry } from './net';
import { api, parseCareer, parseCareerWikitext, titlesToIds } from './wikipedia';

const SPARQL = 'https://query.wikidata.org/sparql';
/**
 * Quante voci controllare al massimo. Col testo grezzo (50 voci per richiesta) si può
 * arrivare lontano; renderizzando una pagina per volta (nazionali) molto meno.
 */
const MAX_CHECKS_FAST = 400;
const MAX_CHECKS_SLOW = 120;
const CONCURRENCY = 6;

export interface EnrichProgress {
  checked: number;
  total: number;
  found: Player[];
  /** Wikipedia aveva più candidati di quanti se ne potessero controllare. */
  partial: boolean;
}

interface Candidate {
  qid: string;
  title: string;
  links: number;
}

/** Tutte le combinazioni di voci (per le squadre rifondate ce n'è più d'una), al massimo 4. */
function combos(slots: string[][]): string[][] {
  let out: string[][] = [[]];
  for (const titles of slots) out = out.flatMap((c) => titles.map((t) => [...c, t]));
  return out.slice(0, 4);
}

async function searchCandidates(
  slots: string[][],
  signal?: AbortSignal,
): Promise<{ titles: Map<string, string>; partial: boolean }> {
  const titles = new Map<string, string>(); // qid -> titolo voce del giocatore
  let partial = false;
  for (const combo of combos(slots)) {
    const data = await api(
      {
        action: 'query',
        generator: 'search',
        gsrsearch: `${combo.map((t) => `linksto:"${t.replace(/"/g, '')}"`).join(' ')} hastemplate:"Carriera sportivo"`,
        gsrlimit: '500',
        gsrnamespace: '0',
        prop: 'pageprops',
        ppprop: 'wikibase_item',
      },
      signal,
    );
    if (data.continue) partial = true;
    for (const p of data.query?.pages ?? []) {
      const qid = p.pageprops?.wikibase_item;
      if (qid && !titles.has(qid)) titles.set(qid, p.title);
    }
  }
  return { titles, partial };
}

interface WikidataCareer {
  links: number;
  /** Voci di carriera (P54) in tutto. */
  total: number;
  /** Squadre della carriera visibili con wdt:P54. */
  visible: Set<string>;
}

async function sparql(query: string, signal?: AbortSignal): Promise<any[]> {
  const res = await fetchRetry(SPARQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/sparql-results+json' },
    body: new URLSearchParams({ query }),
    signal,
  });
  if (!res.ok) throw new Error(`Wikidata HTTP ${res.status}`);
  return (await res.json()).results.bindings;
}

/**
 * Carriera Wikidata dei candidati, in due query leggere e parallele. Il join completo
 * (p:P54/ps:P54) su centinaia di giocatori impiega 10-30 secondi; wdt:P54 meno di uno,
 * ma nasconde le squadre quando una ha rango preferito: lo si riconosce perché le
 * squadre visibili sono meno delle voci di carriera.
 */
async function wikidataCareers(qids: string[], signal?: AbortSignal): Promise<Map<string, WikidataCareer>> {
  const values = qids.map((q) => `wd:${q}`).join(' ');
  const [counts, teams] = await Promise.all([
    sparql(
      `SELECT ?p ?links (COUNT(?st) AS ?n) WHERE {
  VALUES ?p { ${values} } ?p wikibase:sitelinks ?links . OPTIONAL { ?p p:P54 ?st }
} GROUP BY ?p ?links`,
      signal,
    ),
    sparql(`SELECT ?p ?t WHERE { VALUES ?p { ${values} } ?p wdt:P54 ?t }`, signal),
  ]);
  const qidOf = (uri: string) => uri.slice(uri.lastIndexOf('/') + 1);
  const out = new Map<string, WikidataCareer>();
  for (const b of counts) {
    out.set(qidOf(b.p.value), { links: Number(b.links.value), total: Number(b.n.value), visible: new Set() });
  }
  for (const b of teams) out.get(qidOf(b.p.value))?.visible.add(qidOf(b.t.value));
  return out;
}

function makePlayer(c: Candidate, title: string, spells: Spell[]): Player {
  const years = spells.flatMap((s) => [s.from, s.to]).filter((y): y is number => y !== null);
  return {
    id: c.qid,
    name: title.replace(/ \(.*\)$/, ''),
    popularity: c.links,
    born: null,
    image: '',
    url: `https://it.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
    spells,
    lastYear: years.length ? Math.max(...years) : 0,
    fromWikipedia: true,
  };
}

/** Varianti che non sono la prima squadra: rose, archivi, femminile, squadre riserve, giovanili. */
const NOT_FIRST_TEAM = /\b(rosa|storico|navbox)\b|\/|^femminile\b|\bII\b|\bNXT\b|\bB$|\bU-?\d+\b|primavera|giovanil|next gen/i;

/**
 * Nomi brevi con cui {{Carriera sportivo}} indica una squadra ("Bologna", "Inter",
 * "Ambrosiana"...): sono i template "Template:Calcio <nome>" che linkano la sua voce.
 */
async function shortNames(titles: string[], signal?: AbortSignal): Promise<Set<string>> {
  const names = new Set<string>();
  for (const title of titles) {
    const data = await api(
      { action: 'query', list: 'backlinks', bltitle: title, blnamespace: '10', bllimit: '500', blredirect: '1' },
      signal,
    );
    for (const b of data.query?.backlinks ?? []) {
      for (const x of [b, ...(b.redirlinks ?? [])]) {
        const m = /^Template:Calcio (.+)$/.exec(x.title);
        if (m && !NOT_FIRST_TEAM.test(m[1])) names.add(m[1]);
      }
    }
  }
  return names;
}

/** Verifica veloce: testo grezzo del riquadro, fino a 50 voci per richiesta. */
async function verifyBatch(
  batch: Candidate[],
  groups: TeamGroup[],
  names: Set<string>[],
  slots: string[][],
  signal?: AbortSignal,
): Promise<Player[]> {
  const data = await api(
    {
      action: 'query',
      prop: 'revisions',
      rvprop: 'content',
      rvslots: 'main',
      rvsection: '0',
      titles: batch.map((c) => c.title).join('|'),
    },
    signal,
  );
  const byTitle = new Map(batch.map((c) => [c.title, c]));
  const found: Player[] = [];
  for (const page of data.query?.pages ?? []) {
    const c = byTitle.get(page.title);
    const text: string = page.revisions?.[0]?.slots?.main?.content ?? '';
    if (!c || !text) continue;
    const rows = parseCareerWikitext(text);
    const spells: Spell[] = [];
    let ok = true;
    groups.forEach((g, i) => {
      const mine = rows.filter((r) => (r.short && names[i].has(r.short)) || (r.link && slots[i].includes(r.link)));
      if (mine.length === 0) ok = false;
      for (const r of mine) spells.push({ teamId: g[0], ...parseYears(r.years), loan: r.loan });
    });
    if (ok) found.push(makePlayer(c, page.title, spells));
  }
  return found;
}

/** Verifica lenta ma universale (serve per le nazionali): pagina renderizzata, una per volta. */
async function verify(c: Candidate, groups: TeamGroup[], signal?: AbortSignal): Promise<Player | null> {
  const page = await api(
    { action: 'parse', page: c.title, prop: 'text', section: '0', redirects: '1', disablelimitreport: '1' },
    signal,
  );
  const career = parseCareer(page.parse?.text ?? '');
  if (career.length === 0) return null;
  const ids = await titlesToIds(
    career.map((r) => r.title),
    signal,
  );
  const spells: Spell[] = [];
  for (const g of groups) {
    const rows = career.filter((r) => g.includes(ids.get(r.title) ?? ''));
    if (rows.length === 0) return null; // in questa squadra non ci ha giocato
    for (const r of rows) spells.push({ teamId: g[0], ...parseYears(r.years), loan: r.loan });
  }
  return makePlayer(c, page.parse.title, spells);
}

async function addThumbs(players: Player[], signal?: AbortSignal): Promise<void> {
  for (let i = 0; i < players.length; i += 50) {
    const chunk = players.slice(i, i + 50);
    const byTitle = new Map(chunk.map((p) => [decodeURIComponent(p.url.split('/wiki/')[1]).replace(/_/g, ' '), p]));
    const data = await api(
      { action: 'query', prop: 'pageimages', piprop: 'thumbnail', pithumbsize: '96', pilimit: '50', titles: [...byTitle.keys()].join('|') },
      signal,
    );
    for (const pg of data.query?.pages ?? []) {
      const p = byTitle.get(pg.title);
      if (p && pg.thumbnail?.source) p.thumb = pg.thumbnail.source;
    }
  }
}

const CACHE_PREFIX = 'ip:wiki:v3:';
const CACHE_TTL = 1000 * 60 * 60 * 24 * 3;
const cacheKey = (groups: TeamGroup[]) => CACHE_PREFIX + groups.map((g) => g.join('+')).sort().join(',');

/**
 * @param groups le squadre scelte (ognuna con le sue voci Wikidata)
 * @param slots per ogni squadra, i titoli delle voci su it.wikipedia
 */
export async function enrichFromWikipedia(
  groups: TeamGroup[],
  slots: string[][],
  known: ReadonlySet<string>,
  onProgress: (p: EnrichProgress) => void,
  signal?: AbortSignal,
): Promise<EnrichProgress> {
  try {
    const raw = localStorage.getItem(cacheKey(groups));
    if (raw) {
      const { t, result } = JSON.parse(raw) as { t: number; result: EnrichProgress };
      if (Date.now() - t < CACHE_TTL) {
        result.found = result.found.filter((p) => !known.has(p.id));
        return result;
      }
    }
  } catch {
    // cache illeggibile: si rifà
  }

  // Se una squadra non ha la voce su it.wikipedia non si può cercare
  if (slots.some((s) => s.length === 0)) return { checked: 0, total: 0, found: [], partial: false };

  const { titles, partial: searchPartial } = await searchCandidates(slots, signal);
  const unknown = [...titles.keys()].filter((q) => !known.has(q));
  if (unknown.length === 0) return { checked: 0, total: 0, found: [], partial: searchPartial };

  const careers = await wikidataCareers(unknown, signal);
  const scored = unknown
    .map((qid) => {
      const c = careers.get(qid);
      const confirmed = groups.filter((g) => g.some((id) => c?.visible.has(id))).length;
      const missing = groups.length - confirmed;
      const hidden = !!c && c.visible.size < c.total;
      // Probabili buchi di Wikidata: manca una sola squadra, non c'è proprio la carriera,
      // oppure parte della carriera è nascosta e non si può dire
      const likely = missing === 1 || !c || c.total === 0 || hidden;
      return { qid, title: titles.get(qid)!, links: c?.links ?? 0, rank: missing === 1 ? 0 : 1, likely };
    })
    .filter((c) => c.likely)
    .sort((a, b) => a.rank - b.rank || b.links - a.links);

  // Strada veloce se ogni squadra ha un nome breve e nessuna è una nazionale
  const names = await Promise.all(slots.map((titles) => shortNames(titles, signal)));
  const national = slots.some((titles) => titles.some((t) => /^Nazionale/i.test(t)));
  const fast = !national && names.every((n) => n.size > 0);
  const max = fast ? MAX_CHECKS_FAST : MAX_CHECKS_SLOW;

  const queue = scored.slice(0, max);
  const progress: EnrichProgress = {
    checked: 0,
    total: queue.length,
    found: [],
    partial: searchPartial || scored.length > max,
  };
  onProgress({ ...progress });
  const report = () => onProgress({ ...progress, found: [...progress.found] });

  if (fast) {
    for (let i = 0; i < queue.length; i += 50) {
      const batch = queue.slice(i, i + 50);
      try {
        progress.found.push(...(await verifyBatch(batch, groups, names, slots, signal)));
      } catch (err) {
        if ((err as Error).name === 'AbortError') throw err;
      }
      progress.checked += batch.length;
      report();
    }
  } else {
    let next = 0;
    const worker = async () => {
      while (next < queue.length) {
        const c = queue[next++];
        try {
          const player = await verify(c, groups, signal);
          if (player) progress.found.push(player);
        } catch (err) {
          if ((err as Error).name === 'AbortError') throw err;
          // una voce che non si legge non blocca le altre
        }
        progress.checked++;
        report();
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  }

  await addThumbs(progress.found, signal).catch(() => {});
  try {
    localStorage.setItem(cacheKey(groups), JSON.stringify({ t: Date.now(), result: progress }));
  } catch {
    // spazio pieno: pazienza
  }
  return progress;
}

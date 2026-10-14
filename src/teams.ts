import { compact, normalize } from './text';

export interface Team {
  id: string;
  name: string;
  aliases: string[];
  country: string;
  national: boolean;
  /** Numero di pagine Wikipedia collegate: misura approssimativa di quanto è nota. */
  popularity: number;
  logo: string;
  /** Altre voci Wikidata della stessa squadra rifondata (es. Vicenza Calcio per L.R. Vicenza). */
  related: string[];
  /** Titolo della voce su it.wikipedia, vuoto se non c'è. */
  itwiki: string;
  /** Nome con cui la chiamano i tifosi ("PSV"), dalle carriere di Wikipedia; vuoto se coincide col nome. */
  short: string;
}

/** Riga di public/teams.json, vedi scripts/build-teams.mjs. */
export type TeamRow = [number, string, string, string, 0 | 1, number, string, string, string?, number[]?];

interface Indexed {
  team: Team;
  /** Varianti normalizzate cercabili; la prima è il nome principale. */
  keys: string[];
  compactKeys: string[];
}

export class TeamIndex {
  private items: Indexed[];
  private byId = new Map<string, Team>();

  constructor(rows: TeamRow[]) {
    this.items = rows.map(([num, name, aliases, country, national, popularity, logo, itwiki, short, related]) => {
      const team: Team = {
        id: `Q${num}`,
        name,
        aliases: aliases ? aliases.split('|') : [],
        country,
        national: national === 1,
        popularity,
        logo,
        related: (related ?? []).map((n) => `Q${n}`),
        itwiki: itwiki ?? '',
        short: short ?? '',
      };
      this.byId.set(team.id, team);
      const variants = [name, ...team.aliases];
      if (team.short) variants.push(team.short);
      // Per le nazionali si scrive il paese ("Italia"), non "nazionale di calcio dell'Italia"
      if (team.national && country) variants.push(country);
      const keys = variants.map(normalize);
      return { team, keys, compactKeys: keys.map((k) => k.replace(/ /g, '')) };
    });
  }

  get(id: string): Team | undefined {
    return this.byId.get(id);
  }

  /** Le squadre più note (l'indice è già in ordine di notorietà), per le sfide casuali. */
  top(n: number, national: boolean): Team[] {
    const out: Team[] = [];
    for (const { team } of this.items) {
      if (team.national !== national) continue;
      // Le nazionali giovanili e femminili non sono "la nazionale"
      if (national && !/^nazionale (maschile )?di calcio d/i.test(team.name)) continue;
      out.push(team);
      if (out.length === n) break;
    }
    return out;
  }

  get size(): number {
    return this.items.length;
  }

  search(query: string, limit = 8, exclude: ReadonlySet<string> = new Set()): Team[] {
    const q = normalize(query);
    if (!q) return [];
    const qc = compact(query);
    const scored: { team: Team; score: number }[] = [];

    for (const item of this.items) {
      if (exclude.has(item.team.id) || item.team.related.some((id) => exclude.has(id))) continue;
      let best = 0;
      for (let i = 0; i < item.keys.length; i++) {
        const key = item.keys[i];
        const isName = i === 0;
        let s = 0;
        if (key === q) s = 85;
        else if (key.startsWith(q)) s = 80;
        else if (key.includes(` ${q}`)) s = 65;
        else if (item.compactKeys[i].startsWith(qc)) s = 60;
        else if (qc.length >= 4 && item.compactKeys[i].includes(qc)) s = 35;
        if (s && isName) s += 3;
        if (s > best) best = s;
      }
      if (best) {
        // Conta molto quanto è nota: "Juventus" deve dare la Juventus di Torino, non un omonimo
        scored.push({ team: item.team, score: best + Math.log2(item.team.popularity + 1) * 6 });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    // Una squadra rifondata compare una volta sola: la voce scelta si porta dietro le altre
    const shown = new Set<string>();
    const out: Team[] = [];
    for (const { team } of scored) {
      if (shown.has(team.id)) continue;
      shown.add(team.id);
      team.related.forEach((id) => shown.add(id));
      out.push(team);
      if (out.length === limit) break;
    }
    return out;
  }
}

/** Tutte le voci Wikidata che contano come questa squadra. */
export function teamIds(team: Team): string[] {
  return [team.id, ...team.related];
}

export function displayName(team: Team): string {
  if (team.national && team.country && /^nazionale di calcio/i.test(team.name)) return team.country;
  return team.short || team.name;
}

export function logoUrl(file: string, width = 64): string {
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=${width}`;
}

let loading: Promise<TeamIndex> | null = null;

export function loadTeams(): Promise<TeamIndex> {
  loading ??= fetch(`${import.meta.env.BASE_URL}teams.json`)
    .then((r) => {
      if (!r.ok) throw new Error(`teams.json HTTP ${r.status}`);
      return r.json() as Promise<TeamRow[]>;
    })
    .then((rows) => new TeamIndex(rows))
    .catch((err) => {
      loading = null;
      throw err;
    });
  return loading;
}

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
}

/** Riga di public/teams.json, vedi scripts/build-teams.mjs. */
export type TeamRow = [number, string, string, string, 0 | 1, number, string];

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
    this.items = rows.map(([num, name, aliases, country, national, popularity, logo]) => {
      const team: Team = {
        id: `Q${num}`,
        name,
        aliases: aliases ? aliases.split('|') : [],
        country,
        national: national === 1,
        popularity,
        logo,
      };
      this.byId.set(team.id, team);
      const variants = [name, ...team.aliases];
      // Per le nazionali si scrive il paese ("Italia"), non "nazionale di calcio dell'Italia"
      if (team.national && country) variants.push(country);
      const keys = variants.map(normalize);
      return { team, keys, compactKeys: keys.map((k) => k.replace(/ /g, '')) };
    });
  }

  get(id: string): Team | undefined {
    return this.byId.get(id);
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
      if (exclude.has(item.team.id)) continue;
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
    return scored.slice(0, limit).map((s) => s.team);
  }
}

export function displayName(team: Team): string {
  return team.national && team.country && /^nazionale di calcio/i.test(team.name)
    ? team.country
    : team.name;
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

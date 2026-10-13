export interface Spell {
  teamId: string;
  from: number | null;
  to: number | null;
  loan: boolean;
}

export interface Player {
  id: string;
  name: string;
  popularity: number;
  born: number | null;
  image: string;
  url: string;
  spells: Spell[];
  /** Ultimo anno noto in una delle squadre scelte, per ordinare dal più recente. */
  lastYear: number;
}

const ENDPOINT = 'https://query.wikidata.org/sparql';
const LOAN = 'Q2914547';

/**
 * Ogni squadra scelta è un gruppo di voci Wikidata: la voce principale più eventuali voci
 * della stessa squadra rifondata. Basta aver giocato in una delle voci del gruppo.
 */
export type TeamGroup = string[];

export function buildQuery(groups: TeamGroup[]): string {
  if (groups.length < 2) throw new Error('Servono almeno due squadre');
  for (const id of groups.flat()) {
    if (!/^Q\d+$/.test(id)) throw new Error(`ID squadra non valido: ${id}`);
  }
  const membership = groups
    .map((g, i) =>
      g.length === 1
        ? `  ?p wdt:P54 wd:${g[0]} .`
        : `  ?p wdt:P54 ?g${i} . VALUES ?g${i} { ${g.map((id) => `wd:${id}`).join(' ')} }`,
    )
    .join('\n');
  const all = groups.flat().map((id) => `wd:${id}`);
  return `SELECT ?p ?pLabel ?links (SAMPLE(?img) AS ?image) (MIN(YEAR(?born)) AS ?birth)
  (SAMPLE(?itwiki) AS ?it) (SAMPLE(?enwiki) AS ?en)
  (GROUP_CONCAT(DISTINCT ?spell; separator="|") AS ?spells) WHERE {
${membership}
  ?p p:P54 ?st . ?st ps:P54 ?team .
  VALUES ?team { ${all.join(' ')} }
  OPTIONAL { ?st pq:P580 ?start }
  OPTIONAL { ?st pq:P582 ?end }
  OPTIONAL { ?st pq:P1642 ?how }
  BIND(CONCAT(STRAFTER(STR(?team), "entity/"), ";",
    COALESCE(STR(YEAR(?start)), ""), ";", COALESCE(STR(YEAR(?end)), ""), ";",
    IF(BOUND(?how) && ?how = wd:${LOAN}, "L", "")) AS ?spell)
  ?p wikibase:sitelinks ?links .
  OPTIONAL { ?p wdt:P18 ?img }
  OPTIONAL { ?p wdt:P569 ?born }
  OPTIONAL { ?itwiki schema:about ?p ; schema:isPartOf <https://it.wikipedia.org/> }
  OPTIONAL { ?enwiki schema:about ?p ; schema:isPartOf <https://en.wikipedia.org/> }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "it,en,[AUTO_LANGUAGE],mul". }
} GROUP BY ?p ?pLabel ?links`;
}

interface Binding {
  [key: string]: { value: string } | undefined;
}

const year = (s: string): number | null => (s ? Number(s) : null);

/** Le voci secondarie di un gruppo vengono ricondotte alla voce principale (la prima). */
export function parseSpells(raw: string, groups: TeamGroup[]): Spell[] {
  const primary = new Map<string, string>();
  for (const g of groups) for (const id of g) primary.set(id, g[0]);
  const teamOrder = groups.map((g) => g[0]);
  const spells = raw
    .split('|')
    .filter(Boolean)
    .map((part): Spell => {
      const [entity, from, to, loan] = part.split(';');
      return { teamId: primary.get(entity) ?? entity, from: year(from), to: year(to), loan: loan === 'L' };
    });
  // Stesso ordine delle squadre scelte, poi cronologico
  return spells.sort(
    (a, b) =>
      teamOrder.indexOf(a.teamId) - teamOrder.indexOf(b.teamId) ||
      (a.from ?? 9999) - (b.from ?? 9999),
  );
}

export function parsePlayers(bindings: Binding[], groups: TeamGroup[]): Player[] {
  return bindings.map((b) => {
    const id = b.p!.value.slice(b.p!.value.lastIndexOf('/') + 1);
    const spells = parseSpells(b.spells?.value ?? '', groups);
    const years = spells.flatMap((s) => [s.from, s.to]).filter((y): y is number => y !== null);
    const img = b.image?.value ?? '';
    return {
      id,
      // Se manca un'etichetta il servizio restituisce l'ID: meglio di niente
      name: b.pLabel?.value ?? id,
      popularity: Number(b.links?.value ?? 0),
      born: b.birth?.value ? Number(b.birth.value) : null,
      image: img ? decodeURIComponent(img.slice(img.lastIndexOf('/') + 1)) : '',
      url: b.it?.value ?? b.en?.value ?? `https://www.wikidata.org/wiki/${id}`,
      spells,
      lastYear: years.length ? Math.max(...years) : 0,
    };
  });
}

const CACHE_PREFIX = 'ip:players:v2:';
const CACHE_TTL = 1000 * 60 * 60 * 24 * 3;

function cacheKey(groups: TeamGroup[]): string {
  return CACHE_PREFIX + groups.map((g) => g.join('+')).sort().join(',');
}

function readCache(groups: TeamGroup[]): Binding[] | null {
  try {
    const raw = localStorage.getItem(cacheKey(groups));
    if (!raw) return null;
    const { t, data } = JSON.parse(raw) as { t: number; data: Binding[] };
    return Date.now() - t < CACHE_TTL ? data : null;
  } catch {
    return null;
  }
}

function writeCache(groups: TeamGroup[], data: Binding[]): void {
  try {
    localStorage.setItem(cacheKey(groups), JSON.stringify({ t: Date.now(), data }));
  } catch {
    // Spazio pieno o storage bloccato: si fa senza cache
  }
}

export type QueryErrorKind = 'rate-limit' | 'timeout' | 'network' | 'server';

export class QueryError extends Error {
  readonly kind: QueryErrorKind;

  constructor(message: string, kind: QueryErrorKind) {
    super(message);
    this.kind = kind;
  }
}

export async function findCommonPlayers(groups: TeamGroup[], signal?: AbortSignal): Promise<Player[]> {
  const cached = readCache(groups);
  if (cached) return parsePlayers(cached, groups);

  const url = `${ENDPOINT}?format=json&query=${encodeURIComponent(buildQuery(groups))}`;
  let res: Response;
  try {
    res = await fetch(url, { signal, headers: { Accept: 'application/sparql-results+json' } });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new QueryError('Connessione non riuscita', 'network');
  }
  if (res.status === 429) throw new QueryError('Troppe richieste a Wikidata', 'rate-limit');
  if (res.status === 500 || res.status === 504) throw new QueryError('Wikidata non ha risposto in tempo', 'timeout');
  if (!res.ok) throw new QueryError(`Wikidata ha risposto con errore ${res.status}`, 'server');

  const data = (await res.json()) as { results: { bindings: Binding[] } };
  writeCache(groups, data.results.bindings);
  return parsePlayers(data.results.bindings, groups);
}

export type SortMode = 'famous' | 'recent' | 'alpha';

export function sortPlayers(players: Player[], mode: SortMode): Player[] {
  const list = [...players];
  if (mode === 'famous') list.sort((a, b) => b.popularity - a.popularity || a.name.localeCompare(b.name, 'it'));
  if (mode === 'recent') list.sort((a, b) => b.lastYear - a.lastYear || b.popularity - a.popularity);
  if (mode === 'alpha') list.sort((a, b) => a.name.localeCompare(b.name, 'it'));
  return list;
}

export function imageUrl(file: string, width = 96): string {
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=${width}`;
}

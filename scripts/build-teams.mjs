// Genera public/teams.json: l'indice di club e nazionali usato per i suggerimenti.
// Va rilanciato solo ogni tanto (npm run teams), non a ogni build.
import { writeFile } from 'node:fs/promises';

const ENDPOINT = 'https://query.wikidata.org/sparql';
const UA = 'IstintoPuro/2.0 (https://github.com/; team index build script)';
const MIN_SITELINKS = 4;
const BATCH = 700;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sparql(query, attempt = 1) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/sparql-results+json',
      'User-Agent': UA,
    },
    body: new URLSearchParams({ query }),
  });
  if (res.ok) {
    // Con query lente Wikidata a volte chiude lo stream a metà: JSON troncato, si riprova
    try {
      return JSON.parse(await res.text()).results.bindings;
    } catch (err) {
      if (attempt >= 5) throw err;
      console.warn('  risposta incompleta, riprovo');
      await sleep(attempt * 5000);
      return sparql(query, attempt + 1);
    }
  }
  if (attempt < 5 && (res.status === 429 || res.status >= 500)) {
    const wait = Number(res.headers.get('retry-after')) * 1000 || attempt * 15000;
    console.warn(`  HTTP ${res.status}, riprovo tra ${wait / 1000}s`);
    await sleep(wait);
    return sparql(query, attempt + 1);
  }
  throw new Error(`SPARQL HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

const qid = (uri) => uri.slice(uri.lastIndexOf('/') + 1);

console.log('1/2 Elenco squadre...');
const base = await sparql(`
SELECT ?t ?links ?nat WHERE {
  VALUES (?type ?nat) { (wd:Q476028 0) (wd:Q103229495 0) (wd:Q6979593 1) (wd:Q135408445 1) }
  ?t wdt:P31 ?type ; wikibase:sitelinks ?links .
  FILTER(?links >= ${MIN_SITELINKS})
}`);

const teams = new Map();
for (const b of base) {
  const id = qid(b.t.value);
  const prev = teams.get(id);
  teams.set(id, {
    id,
    links: Number(b.links.value),
    national: prev?.national || b.nat.value === '1',
    it: '', en: '', aliases: new Set(), country: '', logo: '', itwiki: '',
  });
}
// Polisportive registrate solo come "società sportiva" (es. Boca Juniors, San Lorenzo):
// entrano se ci hanno giocato almeno 15 calciatori
const multi = await sparql(`
SELECT ?t (SAMPLE(?l) AS ?links) (COUNT(DISTINCT ?p) AS ?n) WHERE {
  ?t wdt:P31 wd:Q847017 ; wikibase:sitelinks ?l . FILTER(?l >= ${MIN_SITELINKS})
  FILTER NOT EXISTS { ?t wdt:P31 wd:Q476028 }
  ?st ps:P54 ?t . ?p p:P54 ?st ; wdt:P106 wd:Q937857 .
} GROUP BY ?t HAVING(?n >= 15)`);
for (const b of multi) {
  const id = qid(b.t.value);
  if (teams.has(id)) continue;
  teams.set(id, {
    id,
    links: Number(b.links.value),
    national: false,
    it: '', en: '', aliases: new Set(), country: '', logo: '', itwiki: '',
  });
}
console.log(`  ${teams.size} squadre (di cui ${multi.length} polisportive)`);

const ids = [...teams.keys()];
for (let i = 0; i < ids.length; i += BATCH) {
  const chunk = ids.slice(i, i + BATCH);
  console.log(`2/2 Nomi e stemmi ${i + 1}-${i + chunk.length}...`);
  const rows = await sparql(`
SELECT ?t ?it ?en ?alias ?country ?logo ?itwiki WHERE {
  VALUES ?t { ${chunk.map((id) => `wd:${id}`).join(' ')} }
  { ?t rdfs:label ?it FILTER(LANG(?it) = "it") }
  UNION { ?t rdfs:label ?en FILTER(LANG(?en) = "en") }
  UNION { ?t skos:altLabel ?alias FILTER(LANG(?alias) IN ("it", "en")) }
  UNION { ?t wdt:P17 ?c . ?c rdfs:label ?country FILTER(LANG(?country) = "it") }
  UNION { ?t wdt:P154 ?logo }
  UNION { ?itwiki schema:about ?t ; schema:isPartOf <https://it.wikipedia.org/> }
}`);
  for (const r of rows) {
    const t = teams.get(qid(r.t.value));
    if (r.it) t.it = r.it.value;
    if (r.en) t.en = r.en.value;
    if (r.alias) t.aliases.add(r.alias.value);
    if (r.country && !t.country) t.country = r.country.value;
    if (r.logo && !t.logo) t.logo = decodeURIComponent(qid(r.logo.value));
    if (r.itwiki) t.itwiki = decodeURIComponent(r.itwiki.value.split('/wiki/')[1]).replace(/_/g, ' ');
  }
  await sleep(1500);
}

// Squadre rifondate (es. Vicenza Calcio -> L.R. Vicenza): su Wikidata sono voci separate e i
// giocatori sono divisi tra le due. Si uniscono solo coppie che si citano a vicenda come
// predecessore/successore (P1365/P1366) e che hanno una parola del nome in comune: così i
// passaggi di titolo tra club diversi (Bassano Virtus -> L.R. Vicenza) restano separati.
console.log('Squadre rifondate...');
const lineage = await sparql(`
SELECT ?a ?b WHERE {
  VALUES ?type { wd:Q476028 wd:Q103229495 }
  ?a wdt:P31 ?type ; wdt:P1366 ?b .
  ?b wdt:P1365 ?a .
}`);

const STOP = new Set(('calcio football futbol fussball club fc ac as us ss ssc asd ssd sc cf afc cd sd ud sk fk nk ' +
  'associazione societa sportiva sportivo unione polisportiva dilettantistica calcistica city citta team soccer ' +
  'de di del della la il le los las el sporting athletic atletico real virtus').split(' '));
const words = (t) => new Set(
  `${t.it} ${t.en}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z]+/).filter((w) => w.length > 2 && !STOP.has(w)),
);

const parent = new Map();
const find = (x) => {
  while (parent.has(x) && parent.get(x) !== x) x = parent.get(x);
  return x;
};
// Fusioni tra club diversi che Wikidata registra come predecessore/successore
const NOT_SAME_CLUB = new Set(['Q483020', 'Q216032']); // Paris Saint-Germain, KRC Genk
let merged = 0;
for (const r of lineage) {
  const a = teams.get(qid(r.a.value));
  const b = teams.get(qid(r.b.value));
  if (!a || !b || a.national || b.national) continue;
  if (NOT_SAME_CLUB.has(a.id) || NOT_SAME_CLUB.has(b.id)) continue;
  const wa = words(a);
  if (![...words(b)].some((w) => wa.has(w))) continue;
  for (const id of [a.id, b.id]) if (!parent.has(id)) parent.set(id, id);
  const ra = find(a.id), rb = find(b.id);
  if (ra !== rb) {
    parent.set(rb, ra);
    merged++;
  }
}
const groups = new Map();
for (const id of parent.keys()) {
  const root = find(id);
  if (!groups.has(root)) groups.set(root, []);
  groups.get(root).push(id);
}
for (const members of groups.values()) {
  for (const id of members) teams.get(id).related = members.filter((m) => m !== id);
}
console.log(`  ${merged} unioni in ${groups.size} gruppi`);

// Stessa normalizzazione di src/text.ts: alias che differiscono solo per punti o accenti sono doppioni
const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
const MAX_ALIASES = 8;

// Formato compatto: [id numerico, nome, alias separati da "|", paese, nazionale 0/1, popolarità, stemma,
// titolo della voce su it.wikipedia, (facoltativo) id numerici delle altre voci della stessa squadra rifondata]
const out = [...teams.values()]
  .filter((t) => t.it || t.en)
  .sort((a, b) => b.links - a.links)
  .map((t) => {
    const name = t.it || t.en;
    const seen = new Set([norm(name)]);
    const aliases = [];
    // Prima gli alias più corti: sono quelli che la gente digita ("Inter", "Napoli")
    for (const a of [t.en, ...[...t.aliases].sort((x, y) => x.length - y.length)]) {
      const k = norm(a ?? '');
      if (k.length < 2 || seen.has(k)) continue;
      seen.add(k);
      aliases.push(a);
      if (aliases.length === MAX_ALIASES) break;
    }
    const row = [Number(t.id.slice(1)), name, aliases.join('|'), t.country, t.national ? 1 : 0, t.links, t.logo, t.itwiki];
    if (t.related?.length) row.push(t.related.map((id) => Number(id.slice(1))));
    return row;
  });

await writeFile(new URL('../public/teams.json', import.meta.url), JSON.stringify(out));
console.log(`Fatto: ${out.length} squadre in public/teams.json`);

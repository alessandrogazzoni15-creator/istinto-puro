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
    it: '', en: '', aliases: new Set(), country: '', logo: '',
  });
}
console.log(`  ${teams.size} squadre`);

const ids = [...teams.keys()];
for (let i = 0; i < ids.length; i += BATCH) {
  const chunk = ids.slice(i, i + BATCH);
  console.log(`2/2 Nomi e stemmi ${i + 1}-${i + chunk.length}...`);
  const rows = await sparql(`
SELECT ?t ?it ?en ?alias ?country ?logo WHERE {
  VALUES ?t { ${chunk.map((id) => `wd:${id}`).join(' ')} }
  { ?t rdfs:label ?it FILTER(LANG(?it) = "it") }
  UNION { ?t rdfs:label ?en FILTER(LANG(?en) = "en") }
  UNION { ?t skos:altLabel ?alias FILTER(LANG(?alias) IN ("it", "en")) }
  UNION { ?t wdt:P17 ?c . ?c rdfs:label ?country FILTER(LANG(?country) = "it") }
  UNION { ?t wdt:P154 ?logo }
}`);
  for (const r of rows) {
    const t = teams.get(qid(r.t.value));
    if (r.it) t.it = r.it.value;
    if (r.en) t.en = r.en.value;
    if (r.alias) t.aliases.add(r.alias.value);
    if (r.country && !t.country) t.country = r.country.value;
    if (r.logo && !t.logo) t.logo = decodeURIComponent(qid(r.logo.value));
  }
  await sleep(1500);
}

// Stessa normalizzazione di src/text.ts: alias che differiscono solo per punti o accenti sono doppioni
const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
const MAX_ALIASES = 8;

// Formato compatto: [id numerico, nome, alias separati da "|", paese, nazionale 0/1, popolarità, stemma]
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
    return [Number(t.id.slice(1)), name, aliases.join('|'), t.country, t.national ? 1 : 0, t.links, t.logo];
  });

await writeFile(new URL('../public/teams.json', import.meta.url), JSON.stringify(out));
console.log(`Fatto: ${out.length} squadre in public/teams.json`);

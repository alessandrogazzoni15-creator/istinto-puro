// Genera public/rosters/<Q-id>.json: la rosa storica di ogni squadra dell'indice, presa da
// Wikidata. Con questi file l'app incrocia le squadre direttamente sul telefono, senza
// interrogare Wikidata a ogni ricerca. Va rilanciato ogni tanto (npm run rosters);
// salva i progressi in scripts/.cache, quindi se si interrompe riparte da dove era.
import { mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const ENDPOINT = 'https://query.wikidata.org/sparql';
const UA = 'IstintoPuro/2.0 (roster build script; https://github.com/)';
const ROOT = new URL('../', import.meta.url);
const CACHE = new URL('scripts/.cache/', ROOT);
const OUT = new URL('public/rosters/', ROOT);
const LOAN = 'Q2914547';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const qid = (uri) => uri.slice(uri.lastIndexOf('/') + 1);

async function sparql(query, attempt = 1, maxAttempts = 6) {
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/sparql-results+json',
        'User-Agent': UA,
      },
      body: new URLSearchParams({ query }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (err) {
    if (attempt >= maxAttempts) throw err;
    console.warn(`  rete: ${err.message}, riprovo`);
    await sleep(attempt * 10_000);
    return sparql(query, attempt + 1, maxAttempts);
  }
  if (res.ok) {
    try {
      return JSON.parse(await res.text()).results.bindings;
    } catch (err) {
      if (attempt >= maxAttempts) throw err;
      console.warn('  risposta incompleta, riprovo');
      await sleep(attempt * 5000);
      return sparql(query, attempt + 1, maxAttempts);
    }
  }
  if (attempt < maxAttempts && (res.status === 429 || res.status >= 500)) {
    const wait = Number(res.headers.get('retry-after')) * 1000 || attempt * 15_000;
    console.warn(`  HTTP ${res.status}, riprovo tra ${wait / 1000}s`);
    await sleep(wait);
    return sparql(query, attempt + 1, maxAttempts);
  }
  throw new Error(`SPARQL HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
}


await mkdir(CACHE, { recursive: true });
const teams = JSON.parse(await readFile(new URL('public/teams.json', ROOT), 'utf8'));
const ids = teams.map((r) => `Q${r[0]}`);

// Progressi salvati per squadra (spells.json) e per giocatore (meta.json): se l'indice
// cambia (squadre aggiunte o riordinate) si scarica solo quello che manca.
const SPELLS_FILE = new URL('spells.json', CACHE);
const META_FILE = new URL('meta.json', CACHE);
const spellCache = existsSync(SPELLS_FILE) ? JSON.parse(await readFile(SPELLS_FILE, 'utf8')) : {};
const metaCache = existsSync(META_FILE) ? JSON.parse(await readFile(META_FILE, 'utf8')) : {};

// Recupero dai file per blocco della prima versione dello script
const OLD_TEAMS = new URL('teams-old.json', CACHE);
if (existsSync(new URL('spells-0.json', CACHE)) && existsSync(OLD_TEAMS)) {
  const old = JSON.parse(await readFile(OLD_TEAMS, 'utf8')).map((r) => `Q${r[0]}`);
  for (let i = 0, b = 0; i < old.length; b++) {
    const size = i < 300 ? 4 : i < 2000 ? 40 : 200;
    const file = new URL(`spells-${b}.json`, CACHE);
    if (existsSync(file)) {
      for (const id of old.slice(i, i + size)) spellCache[id] ??= [];
      for (const [team, p, from, to, loan] of JSON.parse(await readFile(file, 'utf8'))) {
        spellCache[team].push([p, from, to, loan]);
      }
    }
    i += size;
  }
  for (let b = 0; existsSync(new URL(`meta-${b}.json`, CACHE)); b++) {
    for (const [n, m] of JSON.parse(await readFile(new URL(`meta-${b}.json`, CACHE), 'utf8'))) metaCache[n] = m;
  }
  await writeFile(SPELLS_FILE, JSON.stringify(spellCache));
  await writeFile(META_FILE, JSON.stringify(metaCache));
  for (const f of await readdir(CACHE)) if (/^(spells|meta)-\d+\.json$/.test(f)) await rm(new URL(f, CACHE));
  console.log(`Recuperati ${Object.keys(spellCache).length} squadre e ${Object.keys(metaCache).length} giocatori già scaricati`);
}

/** Periodi di un gruppo di squadre; se la risposta è troppo grande, si divide il gruppo. */
async function spellsOf(batch) {
  const query = `
SELECT ?team ?p ?ys ?ye ?how WHERE {
  VALUES ?team { ${batch.map((id) => `wd:${id}`).join(' ')} }
  ?st ps:P54 ?team ; wikibase:rank ?rank .
  FILTER(?rank != wikibase:DeprecatedRank)
  ?p p:P54 ?st .
  OPTIONAL { ?st pq:P580 ?s } OPTIONAL { ?st pq:P582 ?e } OPTIONAL { ?st pq:P1642 ?how }
  BIND(YEAR(?s) AS ?ys) BIND(YEAR(?e) AS ?ye)
}`;
  if (batch.length === 1) return sparql(query);
  try {
    return await sparql(query, 1, 2);
  } catch {
    const half = Math.ceil(batch.length / 2);
    console.warn(`  blocco troppo grande, divido ${batch.length} -> ${half} + ${batch.length - half}`);
    return [...(await spellsOf(batch.slice(0, half))), ...(await spellsOf(batch.slice(half)))];
  }
}

// ---------- 1. Chi ha giocato dove ----------
// Le squadre sono in ordine di notorietà: le prime hanno migliaia di giocatori,
// quindi si interrogano a gruppi piccoli; le altre a gruppi grandi.
const todo = ids.filter((id) => !(id in spellCache));
console.log(`1/2 Rose: ${ids.length - todo.length} già scaricate, ${todo.length} da scaricare...`);
for (let i = 0, round = 0; i < todo.length; round++) {
  const rank = ids.indexOf(todo[i]);
  const size = rank < 300 ? 4 : rank < 2000 ? 40 : 200;
  const batch = todo.slice(i, i + size);
  process.stdout.write(`  ${i + batch.length}/${todo.length}\r`);
  const out = await spellsOf(batch);
  for (const id of batch) spellCache[id] = [];
  for (const r of out) {
    spellCache[qid(r.team.value)].push([
      Number(qid(r.p.value).slice(1)),
      r.ys ? Number(r.ys.value) : null,
      r.ye ? Number(r.ye.value) : null,
      r.how && qid(r.how.value) === LOAN ? 1 : 0,
    ]);
  }
  if (round % 10 === 0) await writeFile(SPELLS_FILE, JSON.stringify(spellCache));
  await sleep(1000);
  i += size;
}
await writeFile(SPELLS_FILE, JSON.stringify(spellCache));

const spells = new Map(); // team -> [[player, from, to, flag]]
const players = new Set();
for (const id of ids) {
  const rows = spellCache[id] ?? [];
  if (rows.length) spells.set(id, rows.map((r) => [...r]));
  for (const r of rows) players.add(r[0]);
}
console.log(`  ${[...spells.values()].reduce((n, s) => n + s.length, 0)} periodi, ${players.size} giocatori`);

// ---------- 1b. Periodi che mancano a Wikidata, presi da Wikipedia ----------
// (scripts/build-wiki-careers.mjs; se non c'è, l'archivio contiene solo Wikidata)
const WIKI = 2; // flag sul periodo: viene da Wikipedia
const LOAN_FLAG = 1;
const wikiFile = new URL('wiki-careers.json', CACHE);
const extraPlayers = [];
const wikiInfo = new Map(); // player -> { t: titolo it.wikipedia, b: anno di nascita }
if (existsSync(wikiFile)) {
  const careers = JSON.parse(await readFile(wikiFile, 'utf8'));
  const has = new Map(); // team -> Set(player) secondo Wikidata
  for (const [team, list] of spells) has.set(team, new Set(list.map((s) => s[0])));
  let added = 0;
  for (const [q, c] of Object.entries(careers)) {
    const p = Number(q.slice(1));
    wikiInfo.set(p, c);
    for (const [team, from, to, loan] of c.r) {
      if (has.get(team)?.has(p)) continue; // Wikidata ce l'ha già: vale Wikidata
      if (!spells.has(team)) spells.set(team, []);
      spells.get(team).push([p, from, to, (loan ? LOAN_FLAG : 0) | WIKI]);
      added++;
      if (!players.has(p)) {
        players.add(p);
        extraPlayers.push(p);
      }
    }
  }
  console.log(`  ${added} periodi aggiunti da Wikipedia (${extraPlayers.length} giocatori che Wikidata non aveva)`);
} else {
  console.log('  (nessun file wiki-careers.json: archivio solo da Wikidata)');
}

// ---------- 2. Chi sono i giocatori ----------
console.log('2/2 Nomi, foto e voci Wikipedia...');
const missing = [...players].filter((p) => !(p in metaCache));
console.log(`  ${players.size - missing.length} già noti, ${missing.length} da scaricare`);
const META_BATCH = 1500;
for (let i = 0, round = 0; i < missing.length; i += META_BATCH, round++) {
  const chunk = missing.slice(i, i + META_BATCH);
  process.stdout.write(`  ${i + chunk.length}/${missing.length}\r`);
  const out = await sparql(`
SELECT ?p ?links ?it ?en ?mul ?born ?img ?itw ?enw WHERE {
  VALUES ?p { ${chunk.map((n) => `wd:Q${n}`).join(' ')} }
  ?p wikibase:sitelinks ?links .
  OPTIONAL { ?p rdfs:label ?it FILTER(LANG(?it) = "it") }
  OPTIONAL { ?p rdfs:label ?en FILTER(LANG(?en) = "en") }
  OPTIONAL { ?p rdfs:label ?mul FILTER(LANG(?mul) = "mul") }
  OPTIONAL { ?p wdt:P569 ?born }
  OPTIONAL { ?p wdt:P18 ?img }
  OPTIONAL { ?itw schema:about ?p ; schema:isPartOf <https://it.wikipedia.org/> }
  OPTIONAL { ?enw schema:about ?p ; schema:isPartOf <https://en.wikipedia.org/> }
}`);
  for (const n of chunk) metaCache[n] ??= null; // anche chi non ha risposte non va richiesto di nuovo
  for (const r of out) {
    const n = Number(qid(r.p.value).slice(1));
    if (metaCache[n]) continue; // più foto o date: si tiene la prima
    const wiki = r.itw
      ? `it:${decodeURIComponent(r.itw.value.split('/wiki/')[1])}`
      : r.enw
        ? `en:${decodeURIComponent(r.enw.value.split('/wiki/')[1])}`
        : '';
    metaCache[n] = [
      r.it?.value ?? r.en?.value ?? r.mul?.value ?? `Q${n}`,
      Number(r.links.value),
      r.born ? Number(r.born.value.slice(0, 4)) || null : null,
      r.img ? decodeURIComponent(qid(r.img.value)) : '',
      wiki,
    ];
  }
  if (round % 10 === 0) await writeFile(META_FILE, JSON.stringify(metaCache));
  await sleep(1000);
}
await writeFile(META_FILE, JSON.stringify(metaCache));
const meta = new Map(Object.entries(metaCache).filter(([, m]) => m).map(([n, m]) => [Number(n), m]));

// ---------- Scrittura ----------
// Un file per squadra: [[id, nome, notorietà, nascita, foto, voce, [[da, a, flag?], ...]], ...]
// flag: 1 = prestito, 2 = periodo preso da Wikipedia (assente su Wikidata)
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
let files = 0;
let bytes = 0;
for (const [team, list] of spells) {
  const byPlayer = new Map();
  for (const [p, from, to, loan] of list) {
    if (!byPlayer.has(p)) byPlayer.set(p, []);
    byPlayer.get(p).push(loan ? [from, to, loan] : [from, to]);
  }
  const rows = [...byPlayer].map(([p, s]) => {
    const w = wikiInfo.get(p);
    let [name, links, born, img, wiki] = meta.get(p) ?? [`Q${p}`, 0, null, '', ''];
    if (w) {
      if (/^Q\d+$/.test(name)) name = w.t.replace(/ \(.*\)$/, '');
      born ??= w.b;
      if (!wiki.startsWith('it:')) wiki = `it:${w.t}`;
    }
    return [p, name, links, born, img, wiki, s];
  });
  const json = JSON.stringify(rows);
  await writeFile(new URL(`${team}.json`, OUT), json);
  files++;
  bytes += json.length;
}
await writeFile(new URL('meta.json', OUT), JSON.stringify({ updated: new Date().toISOString().slice(0, 10) }));
console.log(`Fatto: ${files} squadre, ${(bytes / 1e6).toFixed(1)} MB in public/rosters`);

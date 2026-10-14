// Legge da it.wikipedia la carriera nei club di tutti i calciatori (riquadro {{Carriera
// sportivo}}) e la riconduce alle squadre dell'indice. Il risultato, in
// scripts/.cache/wiki-careers.json, viene unito all'archivio da build-rosters.mjs per
// coprire i periodi che mancano a Wikidata. Riprende da dove era se si interrompe.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const API = 'https://it.wikipedia.org/w/api.php';
const UA = 'IstintoPuro/2.0 (career build script; https://github.com/)';
const ROOT = new URL('../', import.meta.url);
const CACHE = new URL('scripts/.cache/', ROOT);
const PROGRESS = new URL('wiki-progress.json', CACHE);
const OUT = new URL('wiki-careers.json', CACHE);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(params, attempt = 1) {
  const url = `${API}?${new URLSearchParams({ ...params, format: 'json', formatversion: '2', maxlag: '5' })}`;
  // Ritmo gentile: Wikipedia limita chi fa troppe richieste ravvicinate
  await sleep(250);
  let wait = attempt * 5000;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60_000) });
    if (res.ok) {
      const data = await res.json();
      if (data.error?.code === 'maxlag') throw new Error('maxlag');
      if (data.error) throw new Error(data.error.info);
      return data;
    }
    if (res.status === 429) {
      // Si aspetta quanto chiede Wikipedia, o sempre di più fino a qualche minuto
      wait = (Number(res.headers.get('retry-after')) || 0) * 1000 || Math.min(attempt * 30_000, 300_000);
    }
    throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    if (attempt >= 12) throw err;
    console.warn(`  ${err.message}, riprovo tra ${Math.round(wait / 1000)}s`);
    await sleep(wait);
    return api(params, attempt + 1);
  }
}

// --- Stesso parser di src/wikipedia.ts (parseCareerWikitext) ---
function splitTop(line) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const two = line.slice(i, i + 2);
    if (two === '{{' || two === '[[') {
      depth++;
      cur += two;
      i++;
    } else if ((two === '}}' || two === ']]') && depth > 0) {
      depth--;
      cur += two;
      i++;
    } else if (line[i] === '|' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += line[i];
  }
  parts.push(cur);
  return parts;
}

function templateBody(text, param) {
  const m = new RegExp(`\\|\\s*${param}\\s*=\\s*\\{\\{\\s*Carriera sportivo`, 'i').exec(text);
  if (!m) return '';
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  while (i < text.length && depth > 0) {
    if (text.startsWith('{{', i)) {
      depth++;
      i += 2;
    } else if (text.startsWith('}}', i)) {
      depth--;
      i += 2;
    } else i++;
  }
  return text.slice(start, i - 2);
}

function parseCareerWikitext(text) {
  const body = templateBody(text, 'Squadre')
    .replace(/<ref[^>]*\/>/g, '')
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const rows = [];
  const cells = splitTop(body.replace(/\n/g, ' ')).map((c) => c.trim());
  for (let i = 0; i < cells.length - 1; i++) {
    if (!/^\d{4}(\s*[-–]\s*(\d{4})?)?$/.test(cells[i])) continue;
    let team = cells[i + 1];
    const loan = /→|&rarr;/.test(team);
    team = team.replace(/→|&rarr;/g, '').replace(/\{\{\s*simbolo[^}]*\}\}/gi, '').trim();
    let short = '';
    let link = '';
    const wl = /\[\[([^|\]]+)(?:\|[^\]]*)?\]\]/.exec(team);
    const tpl = /\{\{\s*Calcio\s+([^|}]+)/i.exec(team);
    if (wl) link = wl[1].trim().replace(/_/g, ' ');
    else if (tpl) short = tpl[1].trim();
    else if (!team.includes('{{')) short = team;
    if (short || link) rows.push({ years: cells[i].replace(/\s+/g, '').replace(/–/g, '-'), loan, short, link });
    i++;
  }
  return rows;
}

function parseYears(text) {
  const m = text.match(/(\d{4})\s*[-–]?\s*(\d{4})?/);
  if (!m) return [null, null];
  const from = Number(m[1]);
  const open = /\d{4}\s*[-–]\s*$/.test(text);
  return [from, m[2] ? Number(m[2]) : open ? null : from];
}

await mkdir(CACHE, { recursive: true });

// ---------- Squadre dell'indice: titolo della voce -> Q-id ----------
const teams = JSON.parse(await readFile(new URL('public/teams.json', ROOT), 'utf8'));
const titleToTeam = new Map();
for (const r of teams) if (r[7]) titleToTeam.set(r[7], `Q${r[0]}`);

// ---------- Nomi brevi: "Template:Calcio Bologna" -> Bologna FC 1909 ----------
const NOT_FIRST_TEAM = /\b(rosa|storico|navbox)\b|\/(man|doc|sandbox)\b|^femminile\b/i;
const shortFile = new URL('wiki-shortnames.json', CACHE);
let shortToTeam;
if (existsSync(shortFile)) {
  shortToTeam = new Map(JSON.parse(await readFile(shortFile, 'utf8')));
} else {
  console.log('Nomi brevi delle squadre...');
  const templates = [];
  let cont = {};
  do {
    const data = await api({ action: 'query', list: 'allpages', apnamespace: '10', apprefix: 'Calcio ', aplimit: 'max', ...cont });
    templates.push(...data.query.allpages.map((p) => p.title));
    cont = data.continue ?? null;
  } while (cont);
  const candidates = templates.filter((t) => !NOT_FIRST_TEAM.test(t.slice(16)));
  shortToTeam = new Map();
  for (let i = 0; i < candidates.length; i += 50) {
    const chunk = candidates.slice(i, i + 50);
    const links = new Map(chunk.map((t) => [t, []]));
    let c = {};
    do {
      // redirects: "Template:Calcio Leeds" rimanda a "Template:Calcio Leeds United"
      const data = await api({ action: 'query', prop: 'links', plnamespace: '0', pllimit: 'max', redirects: '1', titles: chunk.join('|'), ...c });
      const target = new Map();
      for (const r of data.query.redirects ?? []) target.set(r.to, [...(target.get(r.to) ?? []), r.from]);
      for (const p of data.query.pages) {
        for (const l of p.links ?? []) {
          for (const t of [p.title, ...(target.get(p.title) ?? [])]) links.get(t)?.push(l.title);
        }
      }
      c = data.continue ?? null;
    } while (c);
    for (const [t, ls] of links) {
      // Il template linka la voce della squadra; si accetta solo se è una (e una sola) squadra dell'indice
      const hits = [...new Set(ls.map((l) => titleToTeam.get(l)).filter(Boolean))];
      if (hits.length === 1) shortToTeam.set(t.slice(16), hits[0]);
    }
    process.stdout.write(`  ${Math.min(i + 50, candidates.length)}/${candidates.length}\r`);
  }
  await writeFile(shortFile, JSON.stringify([...shortToTeam]));
  console.log(`\n  ${shortToTeam.size} nomi brevi riconosciuti su ${templates.length} template`);
}

// ---------- Carriere di tutti i calciatori ----------
let state = existsSync(PROGRESS)
  ? JSON.parse(await readFile(PROGRESS, 'utf8'))
  : { cont: {}, done: false, pages: 0, careers: {} };
const save = () => writeFile(PROGRESS, JSON.stringify(state));

console.log('Carriere dei calciatori...');
const unmapped = new Map();
let round = 0;
while (!state.done) {
  const data = await api({
    action: 'query',
    generator: 'embeddedin',
    geititle: 'Template:Carriera sportivo',
    geinamespace: '0',
    geilimit: '50',
    prop: 'revisions|pageprops',
    rvprop: 'content',
    rvslots: 'main',
    rvsection: '0',
    ppprop: 'wikibase_item',
    ...state.cont,
  });
  for (const page of data.query?.pages ?? []) {
    const text = page.revisions?.[0]?.slots?.main?.content;
    const player = page.pageprops?.wikibase_item;
    if (!text || !player || !/sport\s*=\s*calcio/i.test(text)) continue;
    // Righe grezze (nome breve o link): la corrispondenza con le squadre si fa alla fine,
    // così si può correggere e rifare senza rileggere Wikipedia
    const raw = parseCareerWikitext(text).map((r) => [r.link ? `[[${r.link}` : r.short, r.years, r.loan ? 1 : 0]);
    if (raw.length === 0) continue;
    const born = /\|\s*AnnoNascita\s*=\s*(\d{4})/.exec(text);
    // Le calciatrici usano gli stessi nomi brevi ("Juventus") per le squadre femminili:
    // l'indice è delle squadre maschili, quindi le loro carriere si tengono fuori
    const female = /\|\s*Sesso\s*=\s*F\b/.test(text);
    state.careers[player] = { t: page.title, b: born ? Number(born[1]) : null, raw, ...(female ? { f: 1 } : {}) };
  }
  state.pages += data.query?.pages?.length ?? 0;
  // Con prop=revisions la risposta può arrivare a metà: si continua finché il generatore non è finito
  if (data.continue) state.cont = data.continue;
  else state.done = true;
  if (++round % 20 === 0) {
    await save();
    process.stdout.write(`  ${state.pages} voci lette, ${Object.keys(state.careers).length} calciatori\r`);
  }
}
await save();

// ---------- Corrispondenza con le squadre dell'indice ----------
const careers = {};
const usage = new Map(); // squadra -> (nome breve -> quante carriere lo usano)
for (const [player, c] of Object.entries(state.careers)) {
  if (c.f) continue;
  const rows = [];
  for (const [name, years, loan] of c.raw) {
    const team = name.startsWith('[[') ? titleToTeam.get(name.slice(2)) : shortToTeam.get(name);
    if (!team) {
      if (!name.startsWith('[[')) unmapped.set(name, (unmapped.get(name) ?? 0) + 1);
      continue;
    }
    if (!name.startsWith('[[')) {
      if (!usage.has(team)) usage.set(team, new Map());
      usage.get(team).set(name, (usage.get(team).get(name) ?? 0) + 1);
    }
    const [from, to] = parseYears(years);
    rows.push(loan ? [team, from, to, 1] : [team, from, to]);
  }
  if (rows.length) careers[player] = { t: c.t, b: c.b, r: rows };
}
await writeFile(OUT, JSON.stringify(careers));

// ---------- Nome comune delle squadre ----------
// Il nome breve più usato nelle carriere di Wikipedia è quello che dicono i tifosi
// ("PSV" e non "Philips Sport Vereniging"): finisce in teams.json, nella posizione 8.
const TEAMS = new URL('public/teams.json', ROOT);
const rowsIdx = JSON.parse(await readFile(TEAMS, 'utf8'));
let named = 0;
for (const row of rowsIdx) {
  const related = Array.isArray(row[8]) ? row[8] : Array.isArray(row[9]) ? row[9] : null;
  const counts = usage.get(`Q${row[0]}`);
  let short = '';
  if (counts) {
    // Almeno 3 carriere, per non prendere un nome usato per sbaglio
    const [best, n] = [...counts].sort((a, b) => b[1] - a[1])[0];
    if (n >= 3 && best !== row[1]) short = best;
  }
  row.length = 8;
  row.push(short);
  if (related) row.push(related);
  if (short) named++;
}
await writeFile(TEAMS, JSON.stringify(rowsIdx));
console.log(`Nome comune per ${named} squadre`);
const top = [...unmapped].sort((a, b) => b[1] - a[1]).slice(0, 15);
console.log(`\nFatto: ${Object.keys(careers).length} calciatori in scripts/.cache/wiki-careers.json`);
console.log('Nomi brevi non riconosciuti più frequenti:', top.map(([n, c]) => `${n} (${c})`).join(', '));

/**
 * Controllo di riserva per un singolo nome: Wikidata a volte ha carriere incomplete
 * (es. Meggiorini senza il Vicenza), mentre il riquadro della voce su it.wikipedia
 * di solito è aggiornato. Si legge la carriera da lì e si risale alle voci Wikidata
 * delle squadre tramite i link della pagina, senza confrontare nomi a mano.
 */
import { fetchRetry } from './net';
import type { TeamGroup } from './players';

const API = 'https://it.wikipedia.org/w/api.php';

export interface CareerRow {
  /** Titolo della voce Wikipedia della squadra, es. "Associazione Calcio ChievoVerona". */
  title: string;
  years: string;
  loan: boolean;
}

export interface WikiCheck {
  name: string;
  url: string;
  /** Per ogni squadra scelta (in ordine), i periodi trovati; vuoto se non ci ha giocato. */
  perTeam: { teamId: string; years: string[] }[];
}

const SKIP_SECTION = /giovanil|allenator|dirigent/i;

/** Estrae le righe di carriera (club e nazionali) dall'HTML della sezione introduttiva. */
export function parseCareer(html: string): CareerRow[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const rows: CareerRow[] = [];
  for (const table of doc.querySelectorAll('table.sinottico_annidata')) {
    if (SKIP_SECTION.test(sectionOf(table))) continue;
    for (const tr of table.querySelectorAll(':scope > tbody > tr')) {
      const cells = tr.querySelectorAll(':scope > td');
      if (cells.length < 2) continue;
      const years = cells[0].textContent?.trim() ?? '';
      if (!/\d{4}/.test(years)) continue;
      const link = [...cells[1].querySelectorAll('a[href^="/wiki/"]')].find(
        (a) => !a.getAttribute('href')!.slice(6).includes(':'),
      );
      if (!link) continue;
      const title = decodeURIComponent(link.getAttribute('href')!.slice(6)).replace(/_/g, ' ');
      rows.push({
        title,
        years: years.replace(/\s+/g, '').replace(/–/g, '-'),
        loan: cells[1].textContent?.includes('→') ?? false,
      });
    }
  }
  return rows;
}

export interface WikitextRow {
  years: string;
  loan: boolean;
  /** Nome breve usato da {{Carriera sportivo}}, es. "Bologna" (diventa {{Calcio Bologna}}). */
  short: string;
  /** Titolo della voce se la riga ha un link esplicito [[...]]. */
  link: string;
}

/** Divide una riga del template sui "|" di primo livello (non dentro {{...}} o [[...]]). */
function splitTop(line: string): string[] {
  const parts: string[] = [];
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
    } else {
      cur += line[i];
    }
  }
  parts.push(cur);
  return parts;
}

/** Il contenuto di "|Squadre = {{Carriera sportivo ... }}", con le graffe annidate bilanciate. */
function templateBody(text: string, param: string): string {
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

/**
 * Carriera nei club dal testo grezzo del riquadro: molto più veloce che farsi
 * renderizzare la pagina, e si possono chiedere 50 voci per volta.
 */
export function parseCareerWikitext(text: string): WikitextRow[] {
  const body = templateBody(text, 'Squadre')
    .replace(/<ref[^>]*\/>/g, '')
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const rows: WikitextRow[] = [];
  // Le righe sono "|anni|squadra|presenze", anche più d'una sulla stessa riga di testo
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

/** Testo dell'intestazione di sezione ("Squadre di club", "Giovanili"...) che precede la tabella. */
function sectionOf(table: Element): string {
  let tr = table.closest('tr')?.previousElementSibling ?? null;
  while (tr) {
    if (tr.classList.contains('sinottico_divisione')) return tr.textContent ?? '';
    tr = tr.previousElementSibling;
  }
  return '';
}

export async function api(params: Record<string, string>, signal?: AbortSignal): Promise<any> {
  const url = `${API}?${new URLSearchParams({ ...params, format: 'json', formatversion: '2', origin: '*' })}`;
  const res = await fetchRetry(url, { signal });
  if (!res.ok) throw new Error(`Wikipedia HTTP ${res.status}`);
  return res.json();
}

const idCache = new Map<string, string | null>();

/** Titolo della voce Wikipedia -> ID Wikidata, seguendo i redirect. */
export async function titlesToIds(titles: string[], signal?: AbortSignal): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const t of titles) {
    const known = idCache.get(t);
    if (known) out.set(t, known);
  }
  const unique = [...new Set(titles)].filter((t) => !idCache.has(t));
  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50);
    const data = await api(
      { action: 'query', prop: 'pageprops', ppprop: 'wikibase_item', redirects: '1', titles: chunk.join('|') },
      signal,
    );
    const q = data.query ?? {};
    const alias = new Map<string, string>();
    for (const n of q.normalized ?? []) alias.set(n.from, n.to);
    for (const r of q.redirects ?? []) alias.set(r.from, r.to);
    const byTitle = new Map<string, string>();
    for (const p of q.pages ?? []) if (p.pageprops?.wikibase_item) byTitle.set(p.title, p.pageprops.wikibase_item);
    for (const t of chunk) {
      let cur = t;
      for (let hops = 0; hops < 3 && alias.has(cur); hops++) cur = alias.get(cur)!;
      const id = byTitle.get(cur) ?? null;
      idCache.set(t, id);
      if (id) out.set(t, id);
    }
  }
  return out;
}

export async function checkOnWikipedia(
  name: string,
  groups: TeamGroup[],
  signal?: AbortSignal,
): Promise<WikiCheck | null> {
  const search = await api(
    { action: 'query', list: 'search', srsearch: name, srlimit: '3', srnamespace: '0', srprop: '' },
    signal,
  );
  for (const hit of search.query?.search ?? []) {
    const page = await api(
      { action: 'parse', page: hit.title, prop: 'text', section: '0', redirects: '1', disablelimitreport: '1' },
      signal,
    );
    const career = parseCareer(page.parse?.text ?? '');
    if (career.length === 0) continue; // non è un calciatore (o la voce non ha il riquadro)

    const ids = await titlesToIds(
      career.map((r) => r.title),
      signal,
    );
    const title: string = page.parse.title;
    return {
      name: title.replace(/ \(.*\)$/, ''),
      url: `https://it.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
      perTeam: groups.map((g) => ({
        teamId: g[0],
        years: career
          .filter((r) => g.includes(ids.get(r.title) ?? ''))
          .map((r) => r.years + (r.loan ? ' (prestito)' : '')),
      })),
    };
  }
  return null;
}

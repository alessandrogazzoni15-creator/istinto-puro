import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './style.css';

import { icon, type IconName } from './icons';
import {
  findCommonPlayers,
  imageUrl,
  QueryError,
  sortPlayers,
  type Player,
  type SortMode,
  type Spell,
} from './players';
import { displayName, loadTeams, logoUrl, teamIds, type Team, type TeamIndex } from './teams';
import { initials, normalize } from './text';
import { enrichFromWikipedia, type EnrichProgress } from './enrich';
import { archiveInfo, findInArchive } from './rosters';
import { checkOnWikipedia, type WikiCheck } from './wikipedia';

const MAX_TEAMS = 6;

const EXAMPLES: { label: string; ids: string[] }[] = [
  { label: 'Juventus e Napoli', ids: ['Q1422', 'Q2641'] },
  { label: 'Inter e Milan', ids: ['Q631', 'Q1543'] },
  { label: 'Barcellona e Real Madrid', ids: ['Q7156', 'Q8682'] },
  { label: 'Roma, Lazio e Italia', ids: ['Q2739', 'Q2609', 'Q676899'] },
];

type Status =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'done'; players: Player[] };

const state = {
  index: null as TeamIndex | null,
  teams: [] as Team[],
  suggestions: [] as Team[],
  active: -1,
  status: { kind: 'idle' } as Status,
  sort: 'famous' as SortMode,
  filter: '',
  hidden: false,
  revealed: new Set<string>(),
  /** Animazione d'ingresso solo quando arrivano risultati nuovi. */
  animate: false,
  /** Giocatori aggiunti dalla seconda fonte (Wikipedia), arrivano dopo quelli di Wikidata. */
  extra: { kind: 'idle' } as { kind: 'idle' } | { kind: 'running' | 'done' | 'error'; progress: EnrichProgress },
  /** Controllo di riserva su Wikipedia per un nome che Wikidata non dà. */
  wiki: { kind: 'idle' } as
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'error' }
    | { kind: 'done'; result: WikiCheck | null },
};

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const input = $<HTMLInputElement>('#team-input');
const list = $<HTMLUListElement>('#team-list');
const picked = $<HTMLOListElement>('#picked');
const results = $<HTMLElement>('#results');
const help = $<HTMLParagraphElement>('#team-help');

document.querySelectorAll<HTMLElement>('[data-icon]').forEach((el) => {
  el.innerHTML = icon(el.dataset.icon as IconName);
});

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function crest(team: Team, size: 'sm' | 'md'): string {
  const px = size === 'sm' ? 32 : 64;
  return team.logo
    ? `<img class="crest crest-${size}" src="${esc(logoUrl(team.logo, px))}" alt="" loading="lazy" decoding="async" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'crest crest-${size} crest-empty'}))">`
    : `<span class="crest crest-${size} crest-empty"></span>`;
}

function teamMeta(team: Team): string {
  if (team.national) return 'Nazionale';
  const base = team.country || 'Club';
  const others = team.related.map((id) => state.index?.get(id)).filter((t): t is Team => !!t);
  return others.length ? `${base}, insieme a ${others.map(displayName).join(', ')}` : base;
}

// ---------- Squadre scelte e suggerimenti ----------

function renderPicked() {
  picked.innerHTML = state.teams
    .map(
      (t, i) => `
      <li class="team">
        ${crest(t, 'md')}
        <span class="team-text">
          <span class="team-name">${esc(displayName(t))}</span>
          <span class="team-meta">${esc(teamMeta(t))}</span>
        </span>
        <button class="icon-btn" type="button" data-remove="${i}" aria-label="Togli ${esc(displayName(t))}">${icon('x')}</button>
      </li>`,
    )
    .join('');
  const full = state.teams.length >= MAX_TEAMS;
  input.disabled = !state.index || full;
  input.placeholder = !state.index
    ? 'Carico le squadre...'
    : full
      ? 'Hai raggiunto 6 squadre'
      : state.teams.length === 0
        ? 'Cerca una squadra o una nazionale'
        : 'Aggiungi un’altra squadra';
}

function renderSuggestions() {
  const open = state.suggestions.length > 0 || (input.value.trim().length > 1 && state.index !== null);
  list.hidden = !open;
  input.setAttribute('aria-expanded', String(open));
  if (!open) {
    input.removeAttribute('aria-activedescendant');
    return;
  }
  if (state.suggestions.length === 0) {
    list.innerHTML = `<li class="suggestion-empty" role="presentation">Nessuna squadra trovata con questo nome</li>`;
    return;
  }
  list.innerHTML = state.suggestions
    .map(
      (t, i) => `
      <li id="opt-${i}" class="suggestion" role="option" aria-selected="${i === state.active}" data-pick="${i}">
        ${crest(t, 'sm')}
        <span class="team-text">
          <span class="team-name">${esc(displayName(t))}</span>
          <span class="team-meta">${esc(teamMeta(t))}</span>
        </span>
      </li>`,
    )
    .join('');
  if (state.active >= 0) input.setAttribute('aria-activedescendant', `opt-${state.active}`);
  else input.removeAttribute('aria-activedescendant');
}

function updateSuggestions() {
  if (!state.index) return;
  const exclude = new Set(state.teams.flatMap(teamIds));
  state.suggestions = state.index.search(input.value, 8, exclude);
  state.active = state.suggestions.length ? 0 : -1;
  renderSuggestions();
}

function closeSuggestions() {
  state.suggestions = [];
  state.active = -1;
  list.hidden = true;
  input.setAttribute('aria-expanded', 'false');
  input.removeAttribute('aria-activedescendant');
}

function addTeam(team: Team) {
  if (state.teams.length >= MAX_TEAMS || state.teams.some((t) => teamIds(t).includes(team.id))) return;
  state.teams.push(team);
  input.value = '';
  closeSuggestions();
  teamsChanged();
  if (!input.disabled) input.focus();
}

function removeTeam(i: number) {
  state.teams.splice(i, 1);
  teamsChanged();
  input.focus();
}

function setTeams(ids: string[]) {
  if (!state.index) return;
  state.teams = ids
    .map((id) => state.index!.get(id))
    .filter((t): t is Team => !!t)
    .slice(0, MAX_TEAMS);
  teamsChanged();
}

input.addEventListener('input', updateSuggestions);
input.addEventListener('focus', () => {
  if (input.value.trim()) updateSuggestions();
});
input.addEventListener('blur', () => {
  // Il click sul suggerimento usa pointerdown, quindi qui si può chiudere subito
  closeSuggestions();
});
input.addEventListener('keydown', (e) => {
  const n = state.suggestions.length;
  if (e.key === 'ArrowDown' && n) {
    e.preventDefault();
    state.active = (state.active + 1) % n;
    renderSuggestions();
  } else if (e.key === 'ArrowUp' && n) {
    e.preventDefault();
    state.active = (state.active - 1 + n) % n;
    renderSuggestions();
  } else if (e.key === 'Enter') {
    if (state.active >= 0 && state.suggestions[state.active]) {
      e.preventDefault();
      addTeam(state.suggestions[state.active]);
    }
  } else if (e.key === 'Escape') {
    input.value = '';
    closeSuggestions();
  } else if (e.key === 'Backspace' && !e.repeat && input.value === '' && state.teams.length) {
    // Solo con una pressione singola: tenendo premuto per svuotare la ricerca non si cancellano le squadre
    removeTeam(state.teams.length - 1);
  }
});
list.addEventListener('pointerdown', (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>('[data-pick]');
  if (!li) return;
  e.preventDefault();
  addTeam(state.suggestions[Number(li.dataset.pick)]);
});
picked.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-remove]');
  if (btn) removeTeam(Number(btn.dataset.remove));
});

// ---------- Ricerca giocatori ----------

let controller: AbortController | null = null;

function teamsChanged() {
  renderPicked();
  syncUrl();
  state.filter = '';
  state.wiki = { kind: 'idle' };
  state.extra = { kind: 'idle' };
  state.revealed.clear();
  controller?.abort();
  if (state.teams.length < 2) {
    state.status = { kind: 'idle' };
    renderResults();
    return;
  }
  runSearch();
}

async function runSearch() {
  const groups = state.teams.map(teamIds);
  controller = new AbortController();
  const { signal } = controller;
  state.status = { kind: 'loading' };
  renderResults();
  // Con l'archivio precalcolato l'incrocio si fa qui, subito, e Wikipedia è già inclusa.
  // Senza (es. in sviluppo prima di generarlo) si interroga Wikidata e poi Wikipedia dal vivo.
  const archive = await archiveInfo();
  try {
    const players = archive ? await findInArchive(groups) : await findCommonPlayers(groups, signal);
    if (signal.aborted) return;
    state.status = { kind: 'done', players };
    state.animate = true;
  } catch (err) {
    if ((err as Error).name === 'AbortError' || signal.aborted) return;
    state.status = { kind: 'error', message: errorMessage(err) };
  }
  renderResults();
  if (state.status.kind === 'done' && !archive) runEnrich(state.status.players, signal);
}

async function runEnrich(players: Player[], signal: AbortSignal) {
  const groups = state.teams.map(teamIds);
  const slots = groups.map((g) => g.map((id) => state.index?.get(id)?.itwiki ?? '').filter(Boolean));
  const empty: EnrichProgress = { checked: 0, total: 0, found: [], partial: false };
  state.extra = { kind: 'running', progress: empty };
  renderExtra();
  let shown = 0;
  let last = empty;
  try {
    const progress = await enrichFromWikipedia(
      groups,
      slots,
      new Set(players.map((p) => p.id)),
      (p) => {
        if (signal.aborted) return;
        last = p;
        state.extra = { kind: 'running', progress: p };
        renderExtra();
        if (p.found.length !== shown) {
          shown = p.found.length;
          renderList();
        }
      },
      signal,
    );
    if (signal.aborted) return;
    state.extra = { kind: 'done', progress };
  } catch (err) {
    if ((err as Error).name === 'AbortError' || signal.aborted) return;
    state.extra = { kind: 'error', progress: last };
  }
  renderExtra();
  renderList();
}

/** Tutti i giocatori: Wikidata più quelli trovati su Wikipedia. */
function allPlayers(): Player[] {
  if (state.status.kind !== 'done') return [];
  return state.extra.kind === 'idle' ? state.status.players : [...state.status.players, ...state.extra.progress.found];
}

function countTitle(n: number): string {
  if (n === 0) return 'Nessun giocatore';
  return `${n} ${n === 1 ? 'giocatore' : 'giocatori'}`;
}

/** Contatore in alto e riga di stato della seconda fonte, senza toccare l'elenco. */
function renderExtra() {
  const count = results.querySelector<HTMLElement>('.count');
  if (count && state.status.kind === 'done') count.textContent = countTitle(allPlayers().length);
  const line = results.querySelector<HTMLElement>('#extra-status');
  if (!line) return;
  const x = state.extra;
  let text = '';
  if (x.kind === 'running') {
    text = x.progress.total
      ? `Cerco su Wikipedia chi manca a Wikidata: ${x.progress.checked} di ${x.progress.total} controllati`
      : 'Cerco su Wikipedia chi manca a Wikidata...';
    if (x.progress.found.length) text += `, ${x.progress.found.length} trovati`;
  } else if (x.kind === 'done' && x.progress.found.length) {
    const n = x.progress.found.length;
    text = `${n} ${n === 1 ? 'giocatore aggiunto' : 'giocatori aggiunti'} da Wikipedia, dove la loro carriera è più completa.`;
  } else if (x.kind === 'idle' && state.status.kind === 'done') {
    const n = state.status.players.filter((p) => p.fromWikipedia).length;
    if (n) text = `${n} ${n === 1 ? 'giocatore viene' : 'giocatori vengono'} da Wikipedia, dove la loro carriera è più completa che su Wikidata.`;
  } else if (x.kind === 'error') {
    text = 'Il controllo su Wikipedia non è riuscito: l’elenco contiene solo i dati di Wikidata.';
  }
  if (x.kind === 'done' && x.progress.partial) {
    text += `${text ? ' ' : ''}Con queste squadre i candidati su Wikipedia erano troppi per controllarli tutti.`;
  }
  line.textContent = text;
  line.hidden = !text;
  line.classList.toggle('is-running', x.kind === 'running');

  const updated = results.querySelector<HTMLElement>('#updated');
  if (updated) {
    archiveInfo().then((a) => {
      if (!a) return;
      const [y, m, d] = a.updated.split('-');
      updated.textContent = ` Aggiornati al ${Number(d)}/${Number(m)}/${y}.`;
    });
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof QueryError) {
    switch (err.kind) {
      case 'rate-limit':
        return 'Wikidata sta ricevendo troppe richieste. Aspetta qualche secondo e riprova.';
      case 'timeout':
        return 'Wikidata ci ha messo troppo a rispondere. Di solito al secondo tentativo va.';
      case 'network':
        return 'Sembra che tu sia offline. Controlla la connessione e riprova.';
      default:
        return `${err.message}. Riprova tra poco.`;
    }
  }
  return 'Qualcosa è andato storto. Riprova.';
}

// ---------- Risultati ----------

function teamList(teams: Team[]): string {
  const names = teams.map((t) => displayName(t));
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} e ${names[names.length - 1]}`;
}

function years(s: Spell): string {
  if (s.from === null && s.to === null) return 'anni n.d.';
  if (s.from !== null && s.from === s.to) return String(s.from);
  return `${s.from ?? '?'}-${s.to ?? 'oggi'}`;
}

function spellsHtml(p: Player): string {
  return state.teams
    .map((t) => {
      const mine = p.spells.filter((s) => s.teamId === t.id);
      if (!mine.length) return '';
      // Ogni periodo resta intero; si va a capo solo tra un periodo e l'altro
      const text = mine
        .map((s) => `<span class="nowrap">${esc(years(s) + (s.loan ? ' (prestito)' : ''))}</span>`)
        .join(', ');
      return `<li class="spell" title="${esc(displayName(t))}">${crest(t, 'sm')}<span class="sr-only">${esc(displayName(t))}: </span><span class="years">${text}</span></li>`;
    })
    .join('');
}

function avatar(p: Player): string {
  const fallback = `<span class="avatar avatar-empty" aria-hidden="true">${esc(initials(p.name))}</span>`;
  const src = p.thumb ?? (p.image ? imageUrl(p.image, 96) : '');
  if (!src) return fallback;
  return `<img class="avatar" src="${esc(src)}" alt="" loading="lazy" decoding="async" width="44" height="44" onerror="this.outerHTML=${esc(JSON.stringify(fallback))}">`;
}

function playerHtml(p: Player, masked: boolean): string {
  const born = p.fromWikipedia
    ? `<span class="born">da Wikipedia</span>`
    : p.born
      ? `<span class="born">nato nel ${p.born}</span>`
      : '';
  return `
    <li class="player${masked ? ' is-masked' : ''}" data-player="${p.id}">
      ${avatar(p)}
      <div class="who">
        ${
          masked
            ? `<button type="button" class="reveal" data-reveal="${p.id}">Mostra nome</button>`
            : `<a class="name" href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.name)}<span class="sr-only"> (si apre in una nuova scheda)</span>${icon('external')}</a>`
        }
        ${masked ? '' : born}
      </div>
      <ul class="spells">${spellsHtml(p)}</ul>
    </li>`;
}

function matches(p: Player, q: string): boolean {
  return normalize(p.name).includes(q);
}

function skeleton(): string {
  return Array.from(
    { length: 6 },
    () => `
    <li class="player skeleton" aria-hidden="true">
      <span class="avatar"></span>
      <div class="who"><span class="bar" style="width:${50 + Math.round(Math.random() * 30)}%"></span><span class="bar bar-sm"></span></div>
      <ul class="spells"><li class="bar bar-pill"></li><li class="bar bar-pill"></li></ul>
    </li>`,
  ).join('');
}

function renderResults() {
  const s = state.status;
  results.setAttribute('aria-busy', String(s.kind === 'loading'));

  if (s.kind === 'idle') {
    const need = state.teams.length === 1 ? 'Aggiungi almeno un’altra squadra.' : 'Comincia scegliendo due squadre.';
    results.innerHTML = `
      <div class="intro">
        <p class="intro-title">${need}</p>
        <p class="intro-text">L’elenco si aggiorna da solo appena ce ne sono due. Oppure prova con:</p>
        <ul class="examples">
          ${EXAMPLES.map((ex, i) => `<li><button type="button" class="chip" data-example="${i}">${esc(ex.label)}</button></li>`).join('')}
        </ul>
      </div>`;
    return;
  }

  const heading = (title: string) => `
    <header class="results-head">
      <h2 class="count">${title}</h2>
      <p class="sub">in ${esc(teamList(state.teams))}</p>
    </header>`;

  if (s.kind === 'loading') {
    results.innerHTML = `${heading('Cerco i giocatori...')}<ul class="players">${skeleton()}</ul>`;
    return;
  }

  if (s.kind === 'error') {
    results.innerHTML = `
      ${heading('Ricerca non riuscita')}
      <div class="notice notice-error" role="alert">
        <p>${esc(s.message)}</p>
        <button type="button" class="btn" data-retry>${icon('retry')}Riprova</button>
      </div>`;
    return;
  }

  results.innerHTML = `
    ${heading(countTitle(allPlayers().length))}
    <div class="toolbar">
      <div class="filter">
        <label class="sr-only" for="filter">Controlla un nome</label>
        <span class="combo-icon">${icon('search')}</span>
        <input id="filter" class="input input-sm" type="search" placeholder="Controlla un nome" value="${esc(state.filter)}" autocomplete="off" spellcheck="false" enterkeyhint="search">
      </div>
      <div class="segmented" role="group" aria-label="Ordina">
        ${(
          [
            ['famous', 'Più noti'],
            ['recent', 'Recenti'],
            ['alpha', 'A-Z'],
          ] as const
        )
          .map(([v, l]) => `<button type="button" data-sort="${v}" aria-pressed="${state.sort === v}">${l}</button>`)
          .join('')}
      </div>
      <div class="actions">
        <button type="button" class="btn btn-ghost" data-hide aria-pressed="${state.hidden}">${icon(state.hidden ? 'eye' : 'eyeSlash')}${state.hidden ? 'Mostra nomi' : 'Nascondi nomi'}</button>
        <button type="button" class="btn btn-ghost" data-share>${icon('link')}<span>Condividi</span></button>
      </div>
    </div>
    <p id="extra-status" class="extra-status" hidden></p>
    <div id="list-area"></div>
    <p class="source">Dati da <a href="https://www.wikidata.org" target="_blank" rel="noopener">Wikidata</a> e <a href="https://it.wikipedia.org" target="_blank" rel="noopener">Wikipedia</a>.<span id="updated"></span> Può mancare qualche giocatore, soprattutto di serie minori o con poche presenze.</p>`;
  renderList();
  renderExtra();
}

/** Solo l'elenco: così il campo "Controlla un nome" non viene ricreato mentre si scrive. */
function renderList() {
  const area = results.querySelector<HTMLElement>('#list-area');
  if (!area || state.status.kind !== 'done') return;
  const q = normalize(state.filter);
  const everyone = allPlayers();
  if (everyone.length === 0) {
    area.innerHTML =
      state.extra.kind === 'running'
        ? ''
        : `<div class="notice">
        <p>Nessuno risulta aver giocato in tutte queste squadre.</p>
        <p class="muted">Se ti viene in mente qualcuno, scrivilo in “Controlla un nome”. E controlla di aver scelto la squadra giusta: prima squadra, giovanili e femminile sono voci separate.</p>
      </div>`;
    return;
  }
  const sorted = sortPlayers(everyone, state.sort);
  const visible = q ? sorted.filter((p) => matches(p, q)) : sorted;

  // In modalità gioco i nomi restano coperti, tranne quelli scoperti o cercati per nome
  const masked = (p: Player) => state.hidden && !state.revealed.has(p.id) && q.length < 3;

  const wiki = state.wiki;
  const wikiFound = !visible.length && wiki.kind === 'done' && wiki.result;
  const wikiYes = wikiFound && wiki.result!.perTeam.every((t) => t.years.length > 0);

  const verdict =
    state.hidden && q.length >= 3
      ? visible.length || wikiYes
        ? `<p class="verdict verdict-yes">${icon('check')}${visible.length ? 'Risposta valida' : 'Valida secondo Wikipedia'}</p>`
        : `<p class="verdict verdict-no">${icon('x')}Non risulta</p>`
      : '';

  const body = visible.length
    ? `<ul class="players${state.animate ? ' animate' : ''}">${visible.map((p) => playerHtml(p, masked(p))).join('')}</ul>`
    : q.length >= 3
      ? wikiHtml()
      : `<div class="notice"><p>Nessun giocatore valido si chiama “${esc(state.filter.trim())}”.</p></div>`;
  state.animate = false;

  area.innerHTML = verdict + body;
}

function wikiHtml(): string {
  const typed = esc(state.filter.trim());
  const wiki = state.wiki;
  if (wiki.kind === 'idle') {
    return `<div class="notice">
      <p>“${typed}” non è nell’elenco. Wikidata però a volte non ha tutta la carriera di un giocatore.</p>
      <button type="button" class="btn" data-wiki>${icon('search')}Controlla su Wikipedia</button>
    </div>`;
  }
  if (wiki.kind === 'loading') {
    return `<div class="notice"><p class="muted">Controllo la carriera su Wikipedia...</p></div>`;
  }
  if (wiki.kind === 'error') {
    return `<div class="notice notice-error"><p>Wikipedia non ha risposto.</p>
      <button type="button" class="btn" data-wiki>${icon('retry')}Riprova</button></div>`;
  }
  const r = wiki.result;
  if (!r) return `<div class="notice"><p>Su Wikipedia non trovo un calciatore che si chiama “${typed}”.</p></div>`;

  const name = `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.name)}</a>`;
  const line = (t: { teamId: string; years: string[] }) => {
    const team = state.teams.find((x) => x.id === t.teamId)!;
    return t.years.length
      ? `<li class="spell">${crest(team, 'sm')}<span class="years">${esc(displayName(team))} ${esc(t.years.join(', '))}</span></li>`
      : `<li class="spell spell-missing">${crest(team, 'sm')}<span class="years">mai in ${esc(displayName(team))}</span></li>`;
  };
  const all = r.perTeam.every((t) => t.years.length > 0);
  return `<div class="notice">
    <p>${all ? `Secondo Wikipedia ${name} ha giocato in tutte le squadre:` : `Secondo Wikipedia ${name} non ha giocato in tutte le squadre:`}</p>
    <ul class="spells">${r.perTeam.map(line).join('')}</ul>
    ${all ? '<p class="muted">Su Wikidata questo periodo manca, per questo non era nell’elenco.</p>' : ''}
  </div>`;
}

async function runWikiCheck() {
  const name = state.filter.trim();
  const groups = state.teams.map(teamIds);
  state.wiki = { kind: 'loading' };
  renderList();
  try {
    const result = await checkOnWikipedia(name, groups);
    if (state.filter.trim() !== name) return; // nel frattempo si è scritto altro
    state.wiki = { kind: 'done', result };
  } catch {
    if (state.filter.trim() !== name) return;
    state.wiki = { kind: 'error' };
  }
  renderList();
}

results.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const ex = t.closest<HTMLElement>('[data-example]');
  if (ex) return setTeams(EXAMPLES[Number(ex.dataset.example)].ids);
  if (t.closest('[data-retry]')) return runSearch();
  const sort = t.closest<HTMLElement>('[data-sort]');
  if (sort) {
    state.sort = sort.dataset.sort as SortMode;
    return renderAndKeepFocus(`[data-sort="${state.sort}"]`);
  }
  if (t.closest('[data-hide]')) {
    state.hidden = !state.hidden;
    state.revealed.clear();
    return renderAndKeepFocus('[data-hide]');
  }
  const reveal = t.closest<HTMLElement>('[data-reveal]');
  if (reveal) {
    state.revealed.add(reveal.dataset.reveal!);
    renderList();
    results.querySelector<HTMLElement>(`[data-player="${reveal.dataset.reveal}"] .name`)?.focus();
    return;
  }
  if (t.closest('[data-wiki]')) return runWikiCheck();
  const share = t.closest<HTMLElement>('[data-share]');
  if (share) shareLink(share);
});

results.addEventListener('input', (e) => {
  const t = e.target as HTMLInputElement;
  if (t.id !== 'filter') return;
  state.filter = t.value;
  state.wiki = { kind: 'idle' };
  renderList();
});

// Invio nel campo nome: se non è nell'elenco, controlla direttamente su Wikipedia
results.addEventListener('keydown', (e) => {
  const t = e.target as HTMLInputElement;
  if (t.id !== 'filter' || e.key !== 'Enter') return;
  if (results.querySelector('[data-wiki]')) runWikiCheck();
});

function renderAndKeepFocus(selector: string) {
  renderResults();
  results.querySelector<HTMLElement>(selector)?.focus();
}

async function shareLink(btn: HTMLElement) {
  const url = location.href;
  const title = `Istinto Puro: ${teamList(state.teams)}`;
  try {
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      await navigator.share({ title, url });
      return;
    }
    await navigator.clipboard.writeText(url);
    btn.innerHTML = `${icon('check')}<span>Link copiato</span>`;
    setTimeout(() => {
      if (btn.isConnected) btn.innerHTML = `${icon('link')}<span>Condividi</span>`;
    }, 2000);
  } catch {
    // Condivisione annullata dall'utente: niente da fare
  }
}

// ---------- URL ----------

function syncUrl() {
  const url = new URL(location.href);
  if (state.teams.length) url.searchParams.set('squadre', state.teams.map((t) => t.id).join(','));
  else url.searchParams.delete('squadre');
  history.replaceState(null, '', url);
}

function idsFromUrl(): string[] {
  const raw = new URL(location.href).searchParams.get('squadre') ?? '';
  return raw.split(',').filter((id) => /^Q\d+$/.test(id));
}

// ---------- Avvio ----------

renderPicked();
renderResults();

loadTeams()
  .then((index) => {
    state.index = index;
    const ids = idsFromUrl();
    if (ids.length) setTeams(ids);
    else renderPicked();
    if (matchMedia('(pointer: fine)').matches && !input.disabled) input.focus();
  })
  .catch(() => {
    input.placeholder = 'Elenco squadre non disponibile';
    help.textContent = 'Non riesco a caricare l’elenco delle squadre. Ricarica la pagina.';
    help.classList.add('help-error');
  });

import '@fontsource-variable/geist';
import '@fontsource/chakra-petch/600.css';
import '@fontsource/chakra-petch/700-italic.css';
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
import { loadCredits, type Credit } from './credits';
import { drawChallenge } from './random';

const MAX_TEAMS = 6;
/** Aiuti all'inizio di ogni sfida; se ne sblocca uno per ogni giocatore indovinato. */
const START_HINTS = 3;

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
  /** "Elenco" mostra tutti i giocatori, "Gioca" li copre finché non li indovini. */
  mode: 'list' as 'list' | 'play',
  filter: '',
  /** Indovinati in modalità gioco. */
  found: new Set<string>(),
  /** Scoperti senza indovinarli (tocco sulla riga o "Mostra tutti"). */
  revealed: new Set<string>(),
  /** Appena indovinati: si evidenziano una volta. */
  justFound: new Set<string>(),
  /** Aiuti disponibili e indizi già scoperti per ogni giocatore. */
  hints: START_HINTS,
  hintLevel: new Map<string, number>(),
  /** Sfida casuale: quante squadre estrarre e se le squadre attuali vengono da un'estrazione. */
  randomCount: 2,
  fromDraw: false,
  drawing: false,
  /** Esito dell'ultimo tentativo in modalità gioco. */
  verdict: null as
    | null
    | { kind: 'nohint' }
    | { kind: 'yes'; names: string[] }
    | { kind: 'again'; names: string[] }
    | { kind: 'no'; guess: string }
    | { kind: 'vague'; guess: string; count: number },
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
  // Sul telefono, appena ci sono due squadre, si chiude la tastiera e si va ai risultati
  const touch = matchMedia('(pointer: coarse)').matches;
  if (touch && state.teams.length >= 2) {
    input.blur();
    results.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
  } else if (!input.disabled) input.focus();
}

function reducedMotion(): boolean {
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function removeTeam(i: number) {
  state.teams.splice(i, 1);
  teamsChanged();
  input.focus();
}

function setTeams(ids: string[], fromDraw = false) {
  if (!state.index) return;
  state.teams = ids
    .map((id) => state.index!.get(id))
    .filter((t): t is Team => !!t)
    .slice(0, MAX_TEAMS);
  teamsChanged(fromDraw);
}

// ---------- Sfida casuale ----------

const drawBtn = $<HTMLButtonElement>('#draw');
const drawHelp = $<HTMLParagraphElement>('#draw-help');
const DRAW_HELP = drawHelp.textContent ?? '';

document.querySelector('.random [role="radiogroup"]')!.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-count]');
  if (!b) return;
  state.randomCount = Number(b.dataset.count);
  document.querySelectorAll('.random [data-count]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
});

drawBtn.addEventListener('click', () => drawRandom());

async function drawRandom() {
  if (!state.index || state.drawing) return;
  state.drawing = true;
  drawBtn.disabled = true;
  drawBtn.classList.add('is-drawing');
  drawHelp.textContent = 'Estraggo le squadre...';
  drawHelp.classList.remove('help-error');
  try {
    const ids = await drawChallenge(state.index, state.randomCount);
    state.mode = 'play';
    setTeams(ids, true);
    drawHelp.textContent = DRAW_HELP;
    if (matchMedia('(max-width: 899px)').matches) {
      results.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
    }
  } catch {
    drawHelp.textContent = 'Non sono riuscito a estrarre una sfida. Riprova.';
    drawHelp.classList.add('help-error');
  } finally {
    state.drawing = false;
    drawBtn.disabled = false;
    drawBtn.classList.remove('is-drawing');
  }
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

function teamsChanged(fromDraw = false) {
  state.fromDraw = fromDraw;
  state.hints = START_HINTS;
  state.hintLevel.clear();
  renderPicked();
  syncUrl();
  state.filter = '';
  state.wiki = { kind: 'idle' };
  state.extra = { kind: 'idle' };
  state.found.clear();
  state.revealed.clear();
  state.verdict = null;
  document.body.classList.toggle('has-teams', state.teams.length > 0);
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

function scoreLabel(n: number): string {
  return n === 1 ? 'giocatore in comune' : 'giocatori in comune';
}

/** Il numero sale fino al totale, come un tabellone. */
function animateCount(el: HTMLElement, n: number) {
  const from = Number(el.dataset.count ?? 0);
  el.dataset.count = String(n);
  if (reducedMotion() || from === n) {
    el.textContent = String(n);
    return;
  }
  const start = performance.now();
  const duration = Math.min(700, 250 + Math.abs(n - from) * 8);
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = String(Math.round(from + (n - from) * eased));
    if (t < 1 && el.isConnected) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Contatore in alto e riga di stato della seconda fonte, senza toccare l'elenco. */
function renderExtra() {
  const count = results.querySelector<HTMLElement>('.score-num');
  if (count && state.status.kind === 'done') {
    const n = allPlayers().length;
    if (count.dataset.count !== String(n)) animateCount(count, n);
    const label = results.querySelector<HTMLElement>('.score-label');
    if (label) label.textContent = scoreLabel(n);
  }
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
  return `${s.from ?? '?'}-${s.to ?? ''}`;
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

/** Indizi possibili per un giocatore, nell'ordine in cui si sbloccano. */
function hintSteps(p: Player): ('born' | 'initials' | 'photo')[] {
  const steps: ('born' | 'initials' | 'photo')[] = [];
  if (p.born) steps.push('born');
  steps.push('initials');
  if (p.image || p.thumb) steps.push('photo');
  return steps;
}

function initialsOf(name: string): string {
  return name
    .replace(/\(.*?\)/g, '')
    .trim()
    .split(/\s+/)
    .map((w) => `${w[0].toUpperCase()}.`)
    .join(' ');
}

function playerHtml(p: Player): string {
  const masked = state.mode === 'play' && !state.found.has(p.id) && !state.revealed.has(p.id);
  const born = p.fromWikipedia
    ? `<span class="born">da Wikipedia</span>`
    : p.born
      ? `<span class="born">nato nel ${p.born}</span>`
      : '';
  const cls = ['player'];
  if (masked) cls.push('is-masked');
  if (state.found.has(p.id) && state.mode === 'play') cls.push('is-found');
  if (state.justFound.has(p.id)) cls.push('just-found');

  let who: string;
  if (masked) {
    const steps = hintSteps(p);
    const level = state.hintLevel.get(p.id) ?? 0;
    const shown = steps.slice(0, level);
    if (shown.includes('photo')) cls.push('hint-photo');
    const chips = shown
      .filter((s) => s !== 'photo')
      .map((s) => `<span class="hint-chip">${s === 'born' ? `Nato nel ${p.born}` : esc(initialsOf(p.name))}</span>`)
      .join('');
    const action =
      level >= steps.length ? 'Mostra il nome' : state.hints > 0 ? 'Usa un aiuto' : 'Nessun aiuto';
    who = `<button type="button" class="reveal${level ? ' has-hints' : ''}" data-hint="${p.id}" aria-label="${action}">
        ${level ? `<span class="hint-chips">${chips}<span class="hint-next">${level >= steps.length ? 'Mostra nome' : `${icon('bulb')}Altro indizio`}</span></span>` : `<span class="reveal-mask" aria-hidden="true"></span><span class="reveal-text">${icon('bulb')}Usa un aiuto</span>`}
      </button>`;
  } else {
    who = `<a class="name" href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.name)}<span class="sr-only"> (si apre in una nuova scheda)</span>${icon('external')}</a>
        ${born}`;
  }
  return `
    <li class="${cls.join(' ')}" data-player="${p.id}">
      ${avatar(p)}
      <div class="who">${who}</div>
      <ul class="spells">${spellsHtml(p)}</ul>
    </li>`;
}

function matches(p: Player, q: string): boolean {
  return normalize(p.name).includes(q);
}

/** Per indovinare: il nome intero, oppure l'inizio di una delle sue parole (es. "destro", "toni"). */
function guessMatches(p: Player, q: string): boolean {
  const name = normalize(p.name);
  return name === q || name.includes(q) && (name.startsWith(q) || name.includes(` ${q}`));
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
    const need = state.teams.length === 1 ? 'Aggiungi un’altra squadra' : 'Scegli due squadre';
    results.innerHTML = `
      <div class="intro">
        <p class="intro-title">${need}</p>
        <p class="intro-text">L’elenco compare da solo. Oppure fatti estrarre una sfida casuale, o prova una di queste:</p>
        <ul class="examples">
          ${EXAMPLES.map((ex, i) => `<li><button type="button" class="chip" data-example="${i}">${esc(ex.label)}</button></li>`).join('')}
        </ul>
      </div>`;
    return;
  }

  const matchup = `<p class="matchup">${state.teams
    .map((t) => `<span class="matchup-team">${esc(displayName(t))}</span>`)
    .join('<span class="vs" aria-hidden="true">×</span>')}</p>`;

  if (s.kind === 'loading') {
    results.innerHTML = `
      <header class="scoreboard is-loading">
        <p class="score"><span class="score-num">--</span><span class="score-label">cerco i giocatori</span></p>
        ${matchup}
      </header>
      <ul class="players">${skeleton()}</ul>`;
    return;
  }

  if (s.kind === 'error') {
    results.innerHTML = `
      <header class="scoreboard">${matchup}</header>
      <div class="notice notice-error" role="alert">
        <p>${esc(s.message)}</p>
        <button type="button" class="btn" data-retry>${icon('retry')}Riprova</button>
      </div>`;
    return;
  }

  const n = allPlayers().length;
  const redraw = state.fromDraw
    ? `<button type="button" class="btn btn-ghost redraw" data-redraw>${icon('shuffle')}Nuova estrazione</button>`
    : '';
  results.innerHTML = `
    <header class="scoreboard">
      <p class="score"><span class="score-num" data-count="0">0</span><span class="score-label">${scoreLabel(n)}</span></p>
      ${matchup}
      ${redraw}
    </header>
    <div class="modes" role="tablist" aria-label="Modalità">
      <button type="button" role="tab" data-mode="list" aria-selected="${state.mode === 'list'}">Elenco</button>
      <button type="button" role="tab" data-mode="play" aria-selected="${state.mode === 'play'}">Gioca</button>
      <span class="modes-thumb" aria-hidden="true"></span>
    </div>
    <div id="mode-area" class="mode-area"></div>
    <p id="extra-status" class="extra-status" hidden></p>
    <div id="list-area"></div>
    <div class="source">
      <p>Dati da <a href="https://www.wikidata.org" target="_blank" rel="noopener">Wikidata</a> e <a href="https://it.wikipedia.org" target="_blank" rel="noopener">Wikipedia</a>.<span id="updated"></span> Può mancare qualche giocatore, soprattutto di serie minori o con poche presenze.</p>
      <button type="button" class="link-btn" data-credits aria-expanded="false" aria-controls="credits">Crediti foto e stemmi</button>
      <div id="credits" class="credits" hidden></div>
    </div>`;
  renderModeArea();
  renderList();
  renderExtra();
}

const SORTS = [
  ['famous', 'Più noti'],
  ['recent', 'Recenti'],
  ['alpha', 'A-Z'],
] as const;

/** Comandi della modalità: ricerca e ordinamento nell'elenco, tentativi nel gioco. */
function renderModeArea() {
  const area = results.querySelector<HTMLElement>('#mode-area');
  if (!area || state.status.kind !== 'done') return;
  results.querySelector('.modes')?.setAttribute('data-active', state.mode);
  if (state.mode === 'list') {
    area.innerHTML = `
      <div class="toolbar">
        <div class="filter">
          <label class="sr-only" for="filter">Cerca nell’elenco</label>
          <span class="combo-icon">${icon('search')}</span>
          <input id="filter" class="input input-sm" type="search" placeholder="Cerca nell’elenco" value="${esc(state.filter)}" autocomplete="off" spellcheck="false" enterkeyhint="search">
        </div>
        <div class="toolbar-row">
          <div class="segmented" role="group" aria-label="Ordina">
            ${SORTS.map(([v, l]) => `<button type="button" data-sort="${v}" aria-pressed="${state.sort === v}">${l}</button>`).join('')}
          </div>
          <button type="button" class="icon-btn icon-btn-lg" data-share aria-label="Condividi la sfida">${icon('link')}</button>
        </div>
      </div>`;
    return;
  }
  const total = allPlayers().length;
  area.innerHTML = `
    <form class="guess" id="guess-form" autocomplete="off">
      <label class="sr-only" for="guess">Scrivi un calciatore</label>
      <input id="guess" class="input guess-input" type="text" placeholder="Scrivi un calciatore" spellcheck="false" autocapitalize="words" enterkeyhint="go">
      <button type="submit" class="btn btn-go">Prova</button>
    </form>
    <div class="play-bar">
      <p class="tally"><strong>${state.found.size}</strong> su ${total} indovinati</p>
      <p class="hints${state.hints === 0 ? ' is-empty' : ''}" title="Tocca un giocatore coperto per usare un aiuto">${icon('bulb')}<strong>${state.hints}</strong> ${state.hints === 1 ? 'aiuto' : 'aiuti'}</p>
      <button type="button" class="btn btn-ghost" data-give-up ${state.revealed.size + state.found.size >= total ? 'disabled' : ''}>${icon('eye')}Mostra tutti</button>
      <button type="button" class="icon-btn icon-btn-lg" data-share aria-label="Condividi la sfida">${icon('link')}</button>
    </div>
    <div id="feedback" class="feedback" aria-live="polite">${feedbackHtml()}</div>`;
}

function feedbackHtml(): string {
  const v = state.verdict;
  if (!v) return '';
  if (v.kind === 'yes') {
    const n = v.names.length;
    return `<p class="verdict verdict-yes">${icon('check')}${esc(v.names.join(', '))}<span class="unlock">+${n} ${n === 1 ? 'aiuto' : 'aiuti'}</span></p>`;
  }
  if (v.kind === 'nohint') return `<p class="verdict verdict-again">Aiuti finiti: indovina un nome per sbloccarne un altro</p>`;
  if (v.kind === 'again') return `<p class="verdict verdict-again">${esc(v.names.join(', '))}: già indovinato</p>`;
  if (v.kind === 'vague') return `<p class="verdict verdict-again">“${esc(v.guess)}” vale per ${v.count} giocatori: scrivi anche il cognome</p>`;
  // Sbagliato: si può ancora controllare su Wikipedia, che a volte ha carriere più complete
  const wiki = state.wiki;
  let extra = `<button type="button" class="link-btn" data-wiki>Controlla su Wikipedia</button>`;
  if (wiki.kind === 'loading') extra = `<span class="muted">controllo su Wikipedia...</span>`;
  if (wiki.kind === 'error') extra = `<span class="muted">Wikipedia non risponde</span>`;
  if (wiki.kind === 'done') extra = wikiHtml();
  return `<p class="verdict verdict-no">${icon('x')}“${esc(v.guess)}” non risulta</p>${extra}`;
}

function submitGuess(raw: string) {
  const guess = raw.trim();
  const q = normalize(guess);
  if (q.length < 3) return;
  const hits = allPlayers().filter((p) => guessMatches(p, q));
  state.wiki = { kind: 'idle' };
  state.filter = guess; // serve al controllo su Wikipedia
  if (hits.length === 0) {
    state.verdict = { kind: 'no', guess };
  } else if (hits.length > 3) {
    state.verdict = { kind: 'vague', guess, count: hits.length };
  } else {
    const fresh = hits.filter((p) => !state.found.has(p.id) && !state.revealed.has(p.id));
    if (fresh.length) {
      fresh.forEach((p) => {
        state.found.add(p.id);
        state.justFound.add(p.id);
      });
      state.hints += fresh.length; // ogni giocatore indovinato sblocca un aiuto
      state.verdict = { kind: 'yes', names: fresh.map((p) => p.name) };
    } else {
      state.verdict = { kind: 'again', names: hits.map((p) => p.name) };
    }
  }
  renderModeArea();
  renderList();
  const input = results.querySelector<HTMLInputElement>('#guess');
  if (state.verdict.kind === 'yes' && input) input.value = '';
  else if (input) {
    input.value = guess;
    if (state.verdict.kind === 'no' && !reducedMotion()) {
      input.classList.remove('shake');
      void input.offsetWidth; // riavvia l'animazione
      input.classList.add('shake');
    }
  }
  input?.focus();
  // Porta in vista il primo giocatore indovinato
  const first = state.verdict.kind === 'yes' ? results.querySelector('.just-found') : null;
  first?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
  state.justFound.clear();
}

/** Solo l'elenco: così i campi di ricerca non vengono ricreati mentre si scrive. */
function renderList() {
  const area = results.querySelector<HTMLElement>('#list-area');
  if (!area || state.status.kind !== 'done') return;
  const everyone = allPlayers();
  if (everyone.length === 0) {
    area.innerHTML =
      state.extra.kind === 'running'
        ? ''
        : `<div class="notice">
        <p>Nessuno risulta aver giocato in tutte queste squadre.</p>
        <p class="muted">Controlla di aver scelto la squadra giusta: prima squadra, giovanili e femminile sono voci separate.</p>
      </div>`;
    return;
  }
  const sorted = sortPlayers(everyone, state.sort);
  const q = state.mode === 'list' ? normalize(state.filter) : '';
  const visible = q ? sorted.filter((p) => matches(p, q)) : sorted;

  let body: string;
  if (visible.length) {
    // In gioco gli indovinati salgono in cima, nell'ordine scelto
    const ordered =
      state.mode === 'play'
        ? [...visible.filter((p) => state.found.has(p.id)), ...visible.filter((p) => !state.found.has(p.id))]
        : visible;
    body = `<ul class="players${state.animate ? ' animate' : ''}">${ordered.map(playerHtml).join('')}</ul>`;
  } else if (q.length >= 3) {
    body = `<div class="notice">${listWikiHtml()}</div>`;
  } else {
    body = `<div class="notice"><p>Nessuno nell’elenco si chiama “${esc(state.filter.trim())}”.</p></div>`;
  }
  state.animate = false;
  area.innerHTML = body;
}

/** Elenco filtrato senza risultati: invito a controllare su Wikipedia. */
function listWikiHtml(): string {
  const typed = esc(state.filter.trim());
  const wiki = state.wiki;
  if (wiki.kind === 'idle') {
    return `<p>“${typed}” non è nell’elenco.</p>
      <button type="button" class="btn" data-wiki>${icon('search')}Controlla su Wikipedia</button>`;
  }
  if (wiki.kind === 'loading') return `<p class="muted">Controllo la carriera su Wikipedia...</p>`;
  if (wiki.kind === 'error') {
    return `<p>Wikipedia non ha risposto.</p><button type="button" class="btn" data-wiki>${icon('retry')}Riprova</button>`;
  }
  return wikiHtml();
}

function wikiHtml(): string {
  const wiki = state.wiki;
  if (wiki.kind !== 'done') return '';
  const r = wiki.result;
  if (!r) return `<p class="muted">Su Wikipedia non trovo un calciatore con questo nome.</p>`;
  const name = `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.name)}</a>`;
  const line = (t: { teamId: string; years: string[] }) => {
    const team = state.teams.find((x) => x.id === t.teamId)!;
    return t.years.length
      ? `<li class="spell">${crest(team, 'sm')}<span class="years">${esc(t.years.join(', '))}</span></li>`
      : `<li class="spell spell-missing">${crest(team, 'sm')}<span class="years">mai</span></li>`;
  };
  const all = r.perTeam.every((t) => t.years.length > 0);
  return `<div class="wiki-result">
    <p>${all ? `Secondo Wikipedia ${name} ha giocato in tutte le squadre:` : `Secondo Wikipedia ${name} non ha giocato in tutte le squadre:`}</p>
    <ul class="spells">${r.perTeam.map(line).join('')}</ul>
  </div>`;
}

async function runWikiCheck() {
  const name = state.filter.trim();
  const groups = state.teams.map(teamIds);
  state.wiki = { kind: 'loading' };
  if (state.mode === 'play') {
    const fb = results.querySelector<HTMLElement>('#feedback');
    if (fb) fb.innerHTML = feedbackHtml();
  } else renderList();
  try {
    const result = await checkOnWikipedia(name, groups);
    if (state.filter.trim() !== name) return; // nel frattempo si è scritto altro
    state.wiki = { kind: 'done', result };
  } catch {
    if (state.filter.trim() !== name) return;
    state.wiki = { kind: 'error' };
  }
  if (state.mode === 'play') {
    const fb = results.querySelector<HTMLElement>('#feedback');
    if (fb) fb.innerHTML = feedbackHtml();
  } else renderList();
}

results.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const ex = t.closest<HTMLElement>('[data-example]');
  if (ex) return setTeams(EXAMPLES[Number(ex.dataset.example)].ids);
  if (t.closest('[data-retry]')) return runSearch();
  const mode = t.closest<HTMLElement>('[data-mode]');
  if (mode) {
    const next = mode.dataset.mode as 'list' | 'play';
    if (next === state.mode) return;
    state.mode = next;
    state.filter = '';
    state.wiki = { kind: 'idle' };
    state.verdict = null;
    results.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-selected', String(b === mode)));
    renderModeArea();
    renderList();
    if (next === 'play' && matchMedia('(pointer: fine)').matches) results.querySelector<HTMLElement>('#guess')?.focus();
    return;
  }
  const sort = t.closest<HTMLElement>('[data-sort]');
  if (sort) {
    state.sort = sort.dataset.sort as SortMode;
    results.querySelectorAll('[data-sort]').forEach((b) => b.setAttribute('aria-pressed', String(b === sort)));
    return renderList();
  }
  if (t.closest('[data-give-up]')) {
    allPlayers().forEach((p) => state.found.has(p.id) || state.revealed.add(p.id));
    state.verdict = null;
    renderModeArea();
    return renderList();
  }
  if (t.closest('[data-redraw]')) return drawRandom();
  const hint = t.closest<HTMLElement>('[data-hint]');
  if (hint) return useHint(hint.dataset.hint!);
  if (t.closest('[data-wiki]')) return runWikiCheck();
  const credits = t.closest<HTMLElement>('[data-credits]');
  if (credits) return toggleCredits(credits);
  const share = t.closest<HTMLElement>('[data-share]');
  if (share) shareLink(share);
});

results.addEventListener('submit', (e) => {
  const form = e.target as HTMLFormElement;
  if (form.id !== 'guess-form') return;
  e.preventDefault();
  submitGuess(form.querySelector<HTMLInputElement>('#guess')!.value);
});

results.addEventListener('input', (e) => {
  const t = e.target as HTMLInputElement;
  if (t.id === 'guess') {
    t.classList.remove('shake');
    return;
  }
  if (t.id !== 'filter') return;
  state.filter = t.value;
  state.wiki = { kind: 'idle' };
  renderList();
});

// Invio nel campo di ricerca: se il nome non è nell'elenco, controlla direttamente su Wikipedia
results.addEventListener('keydown', (e) => {
  const t = e.target as HTMLInputElement;
  if (t.id !== 'filter' || e.key !== 'Enter') return;
  if (results.querySelector('[data-wiki]')) runWikiCheck();
});

/** Tocco su un giocatore coperto: un indizio in più (costa un aiuto), poi il nome. */
function useHint(id: string) {
  const p = allPlayers().find((x) => x.id === id);
  if (!p) return;
  const level = state.hintLevel.get(id) ?? 0;
  if (level >= hintSteps(p).length) {
    state.revealed.add(id);
    renderList();
    results.querySelector<HTMLElement>(`[data-player="${id}"] .name`)?.focus();
    return;
  }
  if (state.hints === 0) {
    state.verdict = { kind: 'nohint' };
  } else {
    state.hints--;
    state.hintLevel.set(id, level + 1);
    state.verdict = null;
  }
  renderModeArea();
  renderList();
  results.querySelector<HTMLElement>(`[data-hint="${id}"]`)?.focus();
}

/** Autore e licenza di ogni foto e stemma mostrati (le licenze Creative Commons lo chiedono). */
async function toggleCredits(btn: HTMLElement) {
  const panel = results.querySelector<HTMLElement>('#credits');
  if (!panel) return;
  const open = panel.hidden;
  panel.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
  if (!open) return;

  // In gioco i nomi ancora da indovinare non si svelano nemmeno qui
  const hidden = (p: Player) => state.mode === 'play' && !state.found.has(p.id) && !state.revealed.has(p.id);
  const items = [
    ...state.teams.filter((t) => t.logo).map((t) => ({ file: t.logo, label: `Stemma ${displayName(t)}` })),
    ...allPlayers()
      .filter((p) => p.image)
      .map((p) => ({ file: p.image, label: hidden(p) ? 'Giocatore da indovinare' : p.name })),
  ];
  if (items.length === 0) {
    panel.innerHTML = '<p class="muted">Nessuna foto o stemma in questa ricerca.</p>';
    return;
  }
  panel.innerHTML = '<p class="muted">Carico i crediti da Wikimedia Commons...</p>';
  try {
    const list = await loadCredits(items);
    panel.innerHTML = `
      <p class="muted">Immagini da Wikimedia Commons, ognuna con la sua licenza.</p>
      <ul class="credits-list">${list.map(creditHtml).join('')}</ul>`;
  } catch {
    panel.innerHTML = '<p class="muted">Wikimedia Commons non risponde. Riprova tra poco.</p>';
  }
}

function creditHtml(c: Credit): string {
  const license = c.licenseUrl
    ? `<a href="${esc(c.licenseUrl)}" target="_blank" rel="noopener">${esc(c.license)}</a>`
    : esc(c.license);
  return `<li><strong>${esc(c.label)}</strong>: <a href="${esc(c.page)}" target="_blank" rel="noopener">immagine</a> di ${esc(c.author)}, ${license}</li>`;
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
    btn.innerHTML = icon('check');
    btn.classList.add('is-done');
    btn.setAttribute('aria-label', 'Link copiato');
    setTimeout(() => {
      if (!btn.isConnected) return;
      btn.innerHTML = icon('link');
      btn.classList.remove('is-done');
      btn.setAttribute('aria-label', 'Condividi la sfida');
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
// Animazione del titolo una sola volta, all'apertura
requestAnimationFrame(() => document.body.classList.add('is-ready'));

loadTeams()
  .then((index) => {
    state.index = index;
    // L'estrazione usa l'archivio delle rose: senza archivio resta spenta
    archiveInfo().then((a) => {
      drawBtn.disabled = !a;
      if (!a) drawHelp.textContent = 'Disponibile nella versione online.';
    });
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

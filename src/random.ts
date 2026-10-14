/**
 * Sfida casuale: estrae N squadre note che abbiano davvero dei giocatori in comune,
 * usando l'archivio delle rose. Si costruisce una squadra alla volta, tenendo
 * l'incrocio dei giocatori: così la sfida ha sempre almeno una risposta.
 */
import { rosterPlayers } from './rosters';
import { teamIds, type Team, type TeamIndex } from './teams';

const CLUBS = 120;
/** Pubblico italiano: più spesso si parte da un club italiano, così le sfide sono riconoscibili. */
const HOME = 'Italia';
const HOME_SHARE = 0.6;
const NATIONALS = 24;
/** Giocatori in comune minimi alla fine; un po' di più a metà, per non arrivare in fondo a zero. */
const MIN_FINAL = 3;
const MIN_STEP = 6;
const MAX_CANDIDATES = 40;
const ATTEMPTS = 6;

export class NoChallengeError extends Error {}

function shuffle<T>(list: T[], rand: () => number): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function intersect(a: Set<number>, b: Set<number>): Set<number> {
  const out = new Set<number>();
  for (const x of a) if (b.has(x)) out.add(x);
  return out;
}

export async function drawChallenge(index: TeamIndex, count: number, rand: () => number = Math.random): Promise<string[]> {
  const clubs = index.top(CLUBS, false);
  const pool = [...clubs, ...index.top(NATIONALS, true)];

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    // Si parte sempre da un club: con una nazionale come base le sfide vengono troppo facili
    const home = clubs.filter((t) => t.country === HOME);
    const base = home.length && rand() < HOME_SHARE ? home : clubs;
    const first = base[Math.floor(rand() * base.length)];
    const chosen: Team[] = [first];
    let common = await rosterPlayers(teamIds(first));

    while (chosen.length < count) {
      const last = chosen.length === count - 1;
      const min = last ? MIN_FINAL : MIN_STEP;
      const taken = new Set(chosen.flatMap(teamIds));
      const hasNational = chosen.some((t) => t.national);
      const candidates = pool.filter((t) => !taken.has(t.id) && !(t.national && hasNational));
      // Prima i club dello stesso paese: si incrociano molto di più, quindi si scarica meno
      const same = shuffle(candidates.filter((t) => t.country === first.country), rand);
      const other = shuffle(candidates.filter((t) => t.country !== first.country), rand);
      const ordered = [...same.slice(0, MAX_CANDIDATES / 2), ...other].slice(0, MAX_CANDIDATES);

      let next: Team | null = null;
      for (let i = 0; i < ordered.length && !next; i += 6) {
        const batch = ordered.slice(i, i + 6);
        const sets = await Promise.all(batch.map((t) => rosterPlayers(teamIds(t))));
        for (let k = 0; k < batch.length; k++) {
          const inter = intersect(common, sets[k]);
          if (inter.size >= min) {
            next = batch[k];
            common = inter;
            break;
          }
        }
      }
      if (!next) break;
      chosen.push(next);
    }
    if (chosen.length === count) return shuffle(chosen, rand).map((t) => t.id);
  }
  throw new NoChallengeError('Nessuna sfida trovata');
}

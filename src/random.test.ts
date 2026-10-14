import { describe, expect, it, vi } from 'vitest';
import { TeamIndex, type TeamRow } from './teams';

// Rose finte: A, B e C condividono 1..5; D non condivide nulla con nessuno
const rosters: Record<string, number[]> = {
  Q1: [1, 2, 3, 4, 5, 6, 7, 8],
  Q2: [1, 2, 3, 4, 5, 6, 9],
  Q3: [1, 2, 3, 4, 5, 10],
  Q4: [50, 51, 52],
};
vi.mock('./rosters', () => ({
  rosterPlayers: async (ids: string[]) => new Set(ids.flatMap((id) => rosters[id] ?? [])),
}));

const rows: TeamRow[] = [
  [1, 'Alfa', '', 'Italia', 0, 90, '', ''],
  [2, 'Beta', '', 'Italia', 0, 80, '', ''],
  [3, 'Gamma', '', 'Spagna', 0, 70, '', ''],
  [4, 'Delta', '', 'Spagna', 0, 60, '', ''],
];

describe('sfida casuale', () => {
  it('estrae squadre con almeno 3 giocatori in comune', async () => {
    const { drawChallenge } = await import('./random');
    const index = new TeamIndex(rows);
    for (let i = 0; i < 10; i++) {
      const ids = await drawChallenge(index, 3);
      expect(new Set(ids)).toEqual(new Set(['Q1', 'Q2', 'Q3']));
    }
  });

  it('se la sfida è impossibile lo dice invece di inventare', async () => {
    const { drawChallenge, NoChallengeError } = await import('./random');
    const index = new TeamIndex(rows);
    await expect(drawChallenge(index, 4)).rejects.toBeInstanceOf(NoChallengeError);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { findInArchive } from './rosters';

const files: Record<string, unknown> = {
  // Vicenza storico e L.R. Vicenza: voci diverse della stessa squadra
  'Q8643.json': [[1, 'Roberto Baggio', 120, 1967, 'Baggio.jpg', 'it:Roberto Baggio', [[1982, 1985]]]],
  'Q56542463.json': [[2, 'Riccardo Meggiorini', 20, 1985, '', 'it:Riccardo Meggiorini', [[2020, 2022, 2]]]],
  'Q2768.json': [
    [2, 'Riccardo Meggiorini', 20, 1985, '', 'it:Riccardo Meggiorini', [[2012, 2014]]],
    [3, 'Solo Torino', 5, null, '', '', [[1990, 1991, 1]]],
  ],
};

vi.stubGlobal('fetch', async (url: string) => {
  const name = url.slice(url.lastIndexOf('/') + 1);
  return name in files
    ? new Response(JSON.stringify(files[name]), { status: 200, headers: { 'content-type': 'application/json' } })
    : new Response('', { status: 404 });
});
afterEach(() => vi.clearAllMocks());

describe('incrocio sull’archivio', () => {
  it('trova chi ha giocato in tutte le squadre, unendo le voci di una squadra rifondata', async () => {
    const players = await findInArchive([['Q56542463', 'Q8643'], ['Q2768']]);
    expect(players.map((p) => p.name)).toEqual(['Riccardo Meggiorini']);
    const [m] = players;
    expect(m.spells).toEqual([
      { teamId: 'Q56542463', from: 2020, to: 2022, loan: false },
      { teamId: 'Q2768', from: 2012, to: 2014, loan: false },
    ]);
    expect(m.fromWikipedia).toBe(true);
    expect(m.url).toBe('https://it.wikipedia.org/wiki/Riccardo_Meggiorini');
  });

  it('una squadra senza file non fa trovare nessuno', async () => {
    expect(await findInArchive([['Q2768'], ['Q999999']])).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { buildQuery, parsePlayers, parseSpells, sortPlayers } from './players';

describe('query', () => {
  it('chiede i giocatori di tutte le squadre', () => {
    const q = buildQuery(['Q1422', 'Q2641', 'Q676899']);
    expect(q).toContain('wdt:P54 wd:Q1422, wd:Q2641, wd:Q676899');
  });

  it('rifiuta meno di due squadre e ID non validi', () => {
    expect(() => buildQuery(['Q1422'])).toThrow();
    expect(() => buildQuery(['Q1422', 'Q1 } DROP'])).toThrow();
  });
});

describe('lettura risultati', () => {
  it('ordina i periodi per squadra scelta e poi per anno', () => {
    const spells = parseSpells('Q1422;2009;2010;|Q2641;1992;1995;|Q1422;2004;2006;|Q2641;;;L', ['Q2641', 'Q1422']);
    expect(spells.map((s) => `${s.teamId}:${s.from}`)).toEqual(['Q2641:1992', 'Q2641:null', 'Q1422:2004', 'Q1422:2009']);
    expect(spells[1].loan).toBe(true);
  });

  const bindings = [
    {
      p: { value: 'http://www.wikidata.org/entity/Q1' },
      pLabel: { value: 'Zeta' },
      links: { value: '10' },
      spells: { value: 'Q1422;1990;2000;|Q2641;2001;2003;' },
    },
    {
      p: { value: 'http://www.wikidata.org/entity/Q2' },
      pLabel: { value: 'Alfa' },
      links: { value: '50' },
      image: { value: 'http://commons.wikimedia.org/wiki/Special:FilePath/Alfa%20Rossi.jpg' },
      birth: { value: '1980' },
      it: { value: 'https://it.wikipedia.org/wiki/Alfa' },
      spells: { value: 'Q1422;1995;1996;|Q2641;1997;1998;' },
    },
  ];

  it('estrae nome, foto, link e ultimo anno', () => {
    const [z, a] = parsePlayers(bindings, ['Q1422', 'Q2641']);
    expect(z.url).toBe('https://www.wikidata.org/wiki/Q1');
    expect(z.lastYear).toBe(2003);
    expect(a.image).toBe('Alfa Rossi.jpg');
    expect(a.born).toBe(1980);
    expect(a.url).toBe('https://it.wikipedia.org/wiki/Alfa');
  });

  it('ordina per notorietà, anno o nome', () => {
    const players = parsePlayers(bindings, ['Q1422', 'Q2641']);
    expect(sortPlayers(players, 'famous')[0].name).toBe('Alfa');
    expect(sortPlayers(players, 'recent')[0].name).toBe('Zeta');
    expect(sortPlayers(players, 'alpha')[0].name).toBe('Alfa');
  });
});

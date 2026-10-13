import { describe, expect, it } from 'vitest';
import { buildQuery, parsePlayers, parseSpells, parseYears, sortPlayers } from './players';

describe('query', () => {
  it('chiede i giocatori di tutte le squadre', () => {
    const q = buildQuery([['Q1422'], ['Q2641'], ['Q676899']]);
    expect(q).toContain('?m0 ps:P54 wd:Q1422 . ?p p:P54 ?m0 .');
    expect(q).toContain('?m2 ps:P54 wd:Q676899 . ?p p:P54 ?m2 .');
    // wdt:P54 nasconderebbe la carriera di chi ha una squadra attuale con rango preferito
    expect(q).not.toContain('wdt:P54');
  });

  it('per una squadra rifondata accetta una qualsiasi delle sue voci', () => {
    const q = buildQuery([['Q56542463', 'Q8643'], ['Q2768']]);
    expect(q).toContain('VALUES ?g0 { wd:Q56542463 wd:Q8643 }');
  });

  it('rifiuta meno di due squadre e ID non validi', () => {
    expect(() => buildQuery([['Q1422']])).toThrow();
    expect(() => buildQuery([['Q1422'], ['Q1 } DROP']])).toThrow();
  });
});

describe('lettura risultati', () => {
  it('ordina i periodi per squadra scelta e poi per anno', () => {
    const spells = parseSpells('Q1422;2009;2010;|Q2641;1992;1995;|Q1422;2004;2006;|Q2641;;;L', [['Q2641'], ['Q1422']]);
    expect(spells.map((s) => `${s.teamId}:${s.from}`)).toEqual(['Q2641:1992', 'Q2641:null', 'Q1422:2004', 'Q1422:2009']);
    expect(spells[1].loan).toBe(true);
  });

  it('riconduce le voci secondarie alla squadra scelta', () => {
    const spells = parseSpells('Q8643;1990;1995;|Q2768;2000;2001;', [['Q56542463', 'Q8643'], ['Q2768']]);
    expect(spells[0].teamId).toBe('Q56542463');
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
    const [z, a] = parsePlayers(bindings, [['Q1422'], ['Q2641']]);
    expect(z.url).toBe('https://www.wikidata.org/wiki/Q1');
    expect(z.lastYear).toBe(2003);
    expect(a.image).toBe('Alfa Rossi.jpg');
    expect(a.born).toBe(1980);
    expect(a.url).toBe('https://it.wikipedia.org/wiki/Alfa');
  });

  it('ordina per notorietà, anno o nome', () => {
    const players = parsePlayers(bindings, [['Q1422'], ['Q2641']]);
    expect(sortPlayers(players, 'famous')[0].name).toBe('Alfa');
    expect(sortPlayers(players, 'recent')[0].name).toBe('Zeta');
    expect(sortPlayers(players, 'alpha')[0].name).toBe('Alfa');
  });
});

describe('anni da Wikipedia', () => {
  it('capisce periodi, anno singolo e carriera in corso', () => {
    expect(parseYears('2012-2014')).toEqual({ from: 2012, to: 2014 });
    expect(parseYears('2005')).toEqual({ from: 2005, to: 2005 });
    expect(parseYears('2019-')).toEqual({ from: 2019, to: null });
    expect(parseYears('2019–2021')).toEqual({ from: 2019, to: 2021 });
  });
});

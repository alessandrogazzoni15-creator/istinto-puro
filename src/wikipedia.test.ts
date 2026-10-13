// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCareer, parseCareerWikitext } from './wikipedia';

const html = readFileSync(`${__dirname}/fixtures/meggiorini.html`, 'utf8');

describe('carriera da Wikipedia', () => {
  const career = parseCareer(html);

  it('legge club e nazionali con gli anni e la voce della squadra', () => {
    expect(career).toContainEqual({ title: 'Torino Football Club', years: '2012-2014', loan: false });
    expect(career.some((r) => r.years === '2020-2022' && r.title.includes('Vicenza'))).toBe(true);
  });

  it('segna i prestiti', () => {
    expect(career).toContainEqual({ title: 'Spezia Calcio', years: '2005', loan: true });
  });

  it('esclude le giovanili', () => {
    expect(career.some((r) => r.years === '1997-2000')).toBe(false);
  });
});

describe('carriera dal testo grezzo', () => {
  const read = (name: string) => readFileSync(`${__dirname}/fixtures/${name}.wikitext`, 'utf8');

  it('legge anni, nome breve e prestiti', () => {
    const rows = parseCareerWikitext(read('meggiorini'));
    expect(rows).toContainEqual({ years: '2020-2022', loan: false, short: 'Vicenza', link: '' });
    expect(rows).toContainEqual({ years: '2005', loan: true, short: 'Spezia', link: '' });
    expect(rows.some((r) => r.years === '1997-2000')).toBe(false); // giovanili escluse
  });

  it('gestisce carriere in corso e righe con spazi', () => {
    expect(parseCareerWikitext(read('denswil'))).toContainEqual({ years: '2019-2021', loan: false, short: 'Bologna', link: '' });
    expect(parseCareerWikitext(read('denswil'))).toContainEqual({ years: '2026-', loan: false, short: 'AEL Limassol', link: '' });
    const coco = parseCareerWikitext(read('coco'));
    expect(coco).toContainEqual({ years: '2001-2002', loan: true, short: 'Barcellona', link: '' });
    expect(coco).toHaveLength(10);
  });
});

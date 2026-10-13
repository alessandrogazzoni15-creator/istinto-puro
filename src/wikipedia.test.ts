// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCareer } from './wikipedia';

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

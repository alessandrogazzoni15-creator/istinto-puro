import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { displayName, TeamIndex, type TeamRow } from './teams';

const rows = JSON.parse(readFileSync(new URL('../public/teams.json', import.meta.url), 'utf8')) as TeamRow[];
const index = new TeamIndex(rows);
const first = (q: string) => index.search(q, 1)[0]?.id;

describe('ricerca squadre', () => {
  it('trova i club più noti con il nome che si usa davvero', () => {
    expect(first('juve')).toBe('Q1422');
    expect(first('Juventus')).toBe('Q1422');
    expect(first('napoli')).toBe('Q2641');
    expect(first('inter')).toBe('Q631');
    expect(first('milan')).toBe('Q1543');
    expect(first('roma')).toBe('Q2739');
    expect(first('lazio')).toBe('Q2609');
    expect(first('real madrid')).toBe('Q8682');
    expect(first('barcellona')).toBe('Q7156');
  });

  it('ignora maiuscole, accenti e punteggiatura', () => {
    expect(first('A.C. MILAN')).toBe('Q1543');
    expect(first('ssc napoli')).toBe('Q2641');
  });

  it('trova le nazionali scrivendo il paese', () => {
    expect(first('italia')).toBe('Q676899');
    expect(displayName(index.get('Q676899')!)).toBe('Italia');
  });

  it('non propone squadre già scelte', () => {
    const ids = index.search('juventus', 8, new Set(['Q1422'])).map((t) => t.id);
    expect(ids).not.toContain('Q1422');
  });

  it('restituisce niente per una ricerca vuota', () => {
    expect(index.search('   ')).toEqual([]);
  });
});

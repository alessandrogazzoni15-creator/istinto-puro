/** Minuscolo, senza accenti, punteggiatura trasformata in spazi singoli. */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Come normalize ma senza spazi: "A.C. Milan" e "AC Milan" diventano uguali. */
export function compact(s: string): string {
  return normalize(s).replace(/ /g, '');
}

export function initials(name: string): string {
  const words = name.replace(/\(.*?\)/g, '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0][0];
  const last = words.length > 1 ? words[words.length - 1][0] : '';
  return (first + last).toUpperCase();
}

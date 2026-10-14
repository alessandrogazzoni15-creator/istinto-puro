/**
 * Crediti di foto e stemmi presi da Wikimedia Commons: autore e licenza di ogni file,
 * come chiedono le licenze Creative Commons (la citazione può stare in una pagina di crediti).
 */
import { fetchRetry } from './net';

export interface Credit {
  /** Cosa mostra l'immagine: il giocatore o la squadra. */
  label: string;
  file: string;
  author: string;
  license: string;
  licenseUrl: string;
  page: string;
}

const API = 'https://commons.wikimedia.org/w/api.php';

/** L'autore su Commons è HTML (link, grassetti): serve solo il testo. */
function plain(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  let text = (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim();
  // Alcuni file ripetono il testo in due lingue di interfaccia: "Unknown authorUnknown author"
  const half = text.length / 2;
  if (Number.isInteger(half) && text.slice(0, half) === text.slice(half)) text = text.slice(0, half);
  return /^unknown author$/i.test(text) ? 'autore sconosciuto' : text;
}

export async function loadCredits(items: { file: string; label: string }[]): Promise<Credit[]> {
  const byFile = new Map<string, string>();
  for (const { file, label } of items) if (file && !byFile.has(file)) byFile.set(file, label);
  const files = [...byFile.keys()];
  const out: Credit[] = [];

  for (let i = 0; i < files.length; i += 50) {
    const chunk = files.slice(i, i + 50);
    const params = new URLSearchParams({
      action: 'query',
      prop: 'imageinfo',
      iiprop: 'extmetadata|url',
      iiextmetadatafilter: 'Artist|LicenseShortName|LicenseUrl',
      titles: chunk.map((f) => `File:${f}`).join('|'),
      format: 'json',
      formatversion: '2',
      origin: '*',
    });
    const res = await fetchRetry(`${API}?${params}`);
    if (!res.ok) throw new Error(`Commons HTTP ${res.status}`);
    const data = await res.json();

    // Commons normalizza i titoli (es. "_" -> " "): si risale al nome chiesto
    const asked = new Map<string, string>();
    for (const f of chunk) asked.set(`File:${f}`, f);
    for (const n of data.query?.normalized ?? []) {
      const original = asked.get(n.from);
      if (original) asked.set(n.to, original);
    }

    for (const page of data.query?.pages ?? []) {
      const file = asked.get(page.title) ?? page.title.replace(/^File:/, '');
      const info = page.imageinfo?.[0];
      const meta = info?.extmetadata ?? {};
      out.push({
        label: byFile.get(file) ?? file,
        file,
        author: meta.Artist ? plain(meta.Artist.value) : 'autore non indicato',
        license: meta.LicenseShortName?.value ?? 'licenza non indicata',
        licenseUrl: meta.LicenseUrl?.value ?? '',
        page: info?.descriptionurl ?? `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(file)}`,
      });
    }
  }
  return out.sort((a, b) => a.label.localeCompare(b.label, 'it'));
}

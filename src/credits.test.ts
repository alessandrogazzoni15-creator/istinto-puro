// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadCredits } from './credits';

afterEach(() => vi.unstubAllGlobals());

describe('crediti delle immagini', () => {
  it('legge autore e licenza e ripulisce i testi ripetuti', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(
        JSON.stringify({
          query: {
            normalized: [{ from: 'File:Foto_1.jpg', to: 'File:Foto 1.jpg' }],
            pages: [
              {
                title: 'File:Foto 1.jpg',
                imageinfo: [
                  {
                    descriptionurl: 'https://commons.wikimedia.org/wiki/File:Foto_1.jpg',
                    extmetadata: {
                      Artist: { value: '<span>Unknown author</span><span>Unknown author</span>' },
                      LicenseShortName: { value: 'Public domain' },
                    },
                  },
                ],
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );
    const [c] = await loadCredits([{ file: 'Foto_1.jpg', label: 'Renzo Merlin' }]);
    expect(c).toMatchObject({ label: 'Renzo Merlin', author: 'autore sconosciuto', license: 'Public domain' });
  });
});

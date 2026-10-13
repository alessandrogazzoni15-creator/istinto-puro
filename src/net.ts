const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });

/**
 * fetch che, se Wikidata o Wikipedia rispondono "troppe richieste" (429) o sono
 * momentaneamente giù (503), aspetta e riprova invece di arrendersi subito.
 */
export async function fetchRetry(url: string, init: RequestInit = {}, attempts = 3): Promise<Response> {
  for (let i = 1; ; i++) {
    const res = await fetch(url, init);
    if ((res.status !== 429 && res.status !== 503) || i >= attempts) return res;
    const retryAfter = Number(res.headers.get('retry-after'));
    await sleep(retryAfter > 0 ? Math.min(retryAfter, 10) * 1000 : i * 2000, init.signal ?? undefined);
  }
}

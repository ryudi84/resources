const UA = 'grail-knife-finder/1.0 (+https://github.com/ryudi84/resources)';

/** GET a JSON endpoint with a deadline and exponential-backoff retries. */
export async function fetchJson(url: string, timeoutMs = 20_000, retries = 2): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      });
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status}`);
      }
      if (!res.ok) return null; // 4xx other than 429: endpoint disabled/moved, don't retry
      return await res.json();
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
      }
    }
  }
  throw lastError;
}

/** Process items in parallel chunks (default 25) — avoids sequential awaits and connection-pool exhaustion. */
export const BULK_CHUNK_SIZE = 25;

/** Bulk UPDATE/DELETE `.in('sku', …)` batch size — one statement per chunk. */
export const MOVE_UPDATE_CHUNK_SIZE = 100;

export async function runInChunks(items, size, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += size) {
    const chunk = items.slice(i, i + size);
    const settled = await Promise.allSettled(chunk.map((item) => fn(item)));
    for (let j = 0; j < chunk.length; j += 1) {
      const item = chunk[j];
      const outcome = settled[j];
      if (outcome.status === 'fulfilled') results.push(outcome.value);
      else results.push({ item, error: outcome.reason?.message || String(outcome.reason) });
    }
  }
  return results;
}

export interface PoolItem<T> {
  v: T;
  preDelayMs?: number;
}

/**
 * 固定并发的工作池（默认串行），每个任务前有可配置间隔，
 * 用于对公众号等敏感站点限速，避免触发风控。
 */
export async function runPool<T>(
  items: PoolItem<T>[],
  worker: (item: T, index: number) => Promise<void>,
  opts: { concurrency?: number } = {},
): Promise<void> {
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 1, items.length || 1));
  let idx = 0;
  const runners = Array.from({ length: concurrency }, async (_, w) => {
    while (true) {
      const i = idx++;
      if (i >= items.length) break;
      const item = items[i];
      const delay = item.preDelayMs ?? 0;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      await worker(item.v, i);
    }
  });
  await Promise.all(runners);
}

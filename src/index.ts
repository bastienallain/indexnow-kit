import { submitUrls, type SubmitResult } from "./core.ts";
import { loadConfig, type IndexNowConfig } from "./config.ts";

export * from "./core.ts";
export * from "./key.ts";
export * from "./sitemap.ts";
export * from "./diff.ts";
export * from "./config.ts";

export interface NotifyOptions {
  config?: IndexNowConfig;
  fetch?: typeof fetch;
  logger?: Pick<Console, "info" | "warn" | "error">;
}

/**
 * À appeler dans `after()` (next/server) après `revalidatePath` / `revalidateTag`.
 * Accepte des chemins (`/blog/post`) ou des URL absolues. Ne lève jamais : journalise.
 */
export async function notifyIndexNow(pathsOrUrls: string | string[], options: NotifyOptions = {}): Promise<SubmitResult | null> {
  const log = options.logger ?? console;
  try {
    const config = options.config ?? loadConfig();
    const list = Array.isArray(pathsOrUrls) ? pathsOrUrls : [pathsOrUrls];
    const urls = list.map((item) => new URL(item, `https://${config.host}`).href);
    const result = await submitUrls(urls, {
      key: config.key,
      host: config.host,
      keyLocation: config.keyLocation,
      endpoint: config.endpoint,
      dryRun: !config.enabled,
      fetch: options.fetch,
    });
    if (result.dryRun) log.info(`[indexnow] dry-run (hors production) : ${result.submitted.length} URL non envoyées`);
    for (const batch of result.batches) {
      (batch.ok ? log.info : log.error)(`[indexnow] ${batch.status} ${batch.urls} URL : ${batch.message}`);
    }
    for (const r of result.rejected) log.warn(`[indexnow] écartée ${r.url} : ${r.reason}`);
    return result;
  } catch (error) {
    log.error(`[indexnow] ${(error as Error).message}`);
    return null;
  }
}

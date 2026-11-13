import { type SubmitResult } from "./core.ts";
import { type IndexNowConfig } from "./config.ts";
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
export declare function notifyIndexNow(pathsOrUrls: string | string[], options?: NotifyOptions): Promise<SubmitResult | null>;

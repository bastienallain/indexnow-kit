export declare const DEFAULT_ENDPOINT = "https://api.indexnow.org/indexnow";
export declare const MAX_URLS_PER_REQUEST = 10000;
export interface SubmitOptions {
    key: string;
    /** Host canonique, sans protocole : `www.example.com`. */
    host: string;
    keyLocation?: string;
    endpoint?: string;
    dryRun?: boolean;
    /** Attente maximale acceptée sur un 429 avant d'abandonner (ms). */
    maxRetryWaitMs?: number;
    /** Délai maximal par requête (ms). Dans `after()`, une requête bloquée occupe la fonction Vercel. */
    timeoutMs?: number;
    fetch?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
}
export interface BatchResult {
    status: number;
    ok: boolean;
    urls: number;
    message: string;
}
export interface SubmitResult {
    ok: boolean;
    dryRun: boolean;
    submitted: string[];
    /** URL écartées avant envoi, avec la raison. */
    rejected: {
        url: string;
        reason: string;
    }[];
    batches: BatchResult[];
}
/** `https://Café.fr:443/x` → `xn--caf-dma.fr` (punycode, port par défaut retiré). */
export declare function normalizeHost(input: string): string;
/** Garde les URL http(s) du host exact, dédoublonnées. Le protocole impose un seul host par requête (sinon 422). */
export declare function prepareUrls(urls: Iterable<string>, host: string): {
    accepted: string[];
    rejected: {
        url: string;
        reason: string;
    }[];
};
export declare function chunk<T>(items: T[], size: number): T[][];
/** `Retry-After` accepte des secondes ou une date HTTP. */
export declare function parseRetryAfter(value: string | null, now?: number): number | null;
export declare function submitUrls(urls: Iterable<string>, options: SubmitOptions): Promise<SubmitResult>;

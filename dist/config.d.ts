export interface IndexNowConfig {
    key: string;
    host: string;
    keyLocation?: string;
    endpoint?: string;
    /** false = dry-run : rien n'est envoyé. */
    enabled: boolean;
}
export declare class IndexNowConfigError extends Error {
    name: string;
}
/**
 * Lit et valide la config. Envoi actif seulement si `VERCEL_ENV === "production"`
 * ou `INDEXNOW_ENABLED === "true"`, et jamais vers un host `*.vercel.app`.
 */
export declare function loadConfig(env?: Record<string, string | undefined>): IndexNowConfig;

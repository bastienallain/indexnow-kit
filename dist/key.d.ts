/** 8 à 128 caractères a-z A-Z 0-9 et tiret (https://www.indexnow.org/documentation). */
export declare const KEY_PATTERN: RegExp;
export declare function isValidKey(key: string): boolean;
export declare function generateKey(length?: number): string;
export declare function defaultKeyLocation(host: string, key: string): string;
export interface VerifyResult {
    ok: boolean;
    url: string;
    status: number | null;
    problems: string[];
    warnings: string[];
}
/**
 * Lit le fichier de clé comme le ferait un moteur : sans cookie, sans suivre les redirections.
 * La spec exige un accès « without login, firewall, or IP restrictions » (https://www.indexnow.org/faq).
 */
export declare function verifyKeyFile(options: {
    host: string;
    key: string;
    keyLocation?: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
}): Promise<VerifyResult>;

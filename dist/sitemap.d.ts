/** URL → lastmod (ISO) ou null si absent. */
export type SitemapEntries = Map<string, string | null>;
export declare class SitemapError extends Error {
    name: string;
}
/** Parse un `<urlset>` ou un `<sitemapindex>` (https://www.sitemaps.org/protocol.html). */
export declare function parseSitemap(xml: string): {
    kind: "urlset" | "index";
    items: {
        loc: string;
        lastmod: string | null;
    }[];
};
export declare function fetchSitemapEntries(url: string, options?: {
    fetch?: typeof fetch;
    maxDepth?: number;
    timeoutMs?: number;
}): Promise<SitemapEntries>;

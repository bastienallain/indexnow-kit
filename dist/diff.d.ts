import type { SitemapEntries } from "./sitemap.ts";
export interface SitemapDiff {
    added: string[];
    changed: string[];
    /** Les URL supprimées se soumettent aussi (https://www.indexnow.org/faq). */
    removed: string[];
    /** max(taille précédente, taille actuelle). */
    total: number;
}
export declare function diffSitemaps(previous: SitemapEntries, next: SitemapEntries): SitemapDiff;
export interface MassChangeCheck {
    suspicious: boolean;
    reason?: string;
}
/**
 * Garde-fou : tout resoumettre est exactement ce que la FAQ IndexNow interdit.
 * Causes typiques : `lastModified: new Date()` dans `app/sitemap.ts`, sitemap vidé ou tronqué.
 */
export declare function checkMassChange(diff: SitemapDiff, next: SitemapEntries, maxRatio?: number, minUrls?: number): MassChangeCheck;

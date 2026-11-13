import type { SitemapEntries } from "./sitemap.ts";

export interface SitemapDiff {
  added: string[];
  changed: string[];
  /** Les URL supprimées se soumettent aussi (https://www.indexnow.org/faq). */
  removed: string[];
  total: number;
}

export function diffSitemaps(previous: SitemapEntries, next: SitemapEntries): SitemapDiff {
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  for (const [url, lastmod] of next) {
    if (!previous.has(url)) added.push(url);
    // Sans lastmod des deux côtés, on ne peut rien affirmer : on ne soumet pas.
    else if (lastmod !== null && lastmod !== previous.get(url)) changed.push(url);
  }
  for (const url of previous.keys()) if (!next.has(url)) removed.push(url);
  return { added, changed, removed, total: next.size };
}

export interface MassChangeCheck {
  suspicious: boolean;
  reason?: string;
}

/**
 * Garde-fou contre `lastModified: new Date()` dans `app/sitemap.ts` : chaque déploiement
 * « modifie » alors toutes les URL, et tout resoumettre est exactement ce que la FAQ IndexNow interdit.
 */
export function checkMassChange(diff: SitemapDiff, next: SitemapEntries, maxRatio = 0.5, minUrls = 20): MassChangeCheck {
  if (diff.total < minUrls) return { suspicious: false };
  const ratio = diff.changed.length / diff.total;
  if (ratio <= maxRatio) return { suspicious: false };

  const lastmods = new Set([...next.values()].filter(Boolean));
  const reason =
    lastmods.size === 1
      ? `Toutes les URL ont le même lastmod (${[...lastmods][0]}) : app/sitemap.ts utilise sans doute new Date(). Utiliser la vraie date de modification du contenu.`
      : `${Math.round(ratio * 100)} % des URL ont changé de lastmod (seuil ${Math.round(maxRatio * 100)} %).`;
  return { suspicious: true, reason };
}

import type { SitemapEntries } from "./sitemap.ts";

export interface SitemapDiff {
  added: string[];
  changed: string[];
  /** Les URL supprimées se soumettent aussi (https://www.indexnow.org/faq). */
  removed: string[];
  /** max(taille précédente, taille actuelle). */
  total: number;
}

export function diffSitemaps(previous: SitemapEntries, next: SitemapEntries): SitemapDiff {
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  for (const [url, lastmod] of next) {
    if (!previous.has(url)) added.push(url);
    // Sans lastmod côté nouveau sitemap, on ne peut rien affirmer : on ne soumet pas.
    else if (lastmod !== null && lastmod !== previous.get(url)) changed.push(url);
  }
  for (const url of previous.keys()) if (!next.has(url)) removed.push(url);
  return { added, changed, removed, total: Math.max(previous.size, next.size) };
}

export interface MassChangeCheck {
  suspicious: boolean;
  reason?: string;
}

const ONE_HOUR = 3_600_000;

/**
 * Garde-fou : tout resoumettre est exactement ce que la FAQ IndexNow interdit.
 * Causes typiques : `lastModified: new Date()` dans `app/sitemap.ts`, sitemap vidé ou tronqué.
 */
export function checkMassChange(diff: SitemapDiff, next: SitemapEntries, maxRatio = 0.5, minUrls = 20): MassChangeCheck {
  if (diff.total < minUrls) return { suspicious: false };
  const touched = diff.added.length + diff.changed.length + diff.removed.length;
  const ratio = touched / diff.total;
  if (ratio <= maxRatio) return { suspicious: false };

  if (next.size === 0) return { suspicious: true, reason: "Le sitemap est vide : tout le site serait soumis comme supprimé." };
  if (diff.removed.length > diff.total * maxRatio) {
    return { suspicious: true, reason: `${diff.removed.length} URL ont disparu du sitemap (sitemap tronqué, mauvais host, ou refonte).` };
  }
  const times = [...next.values()].map((v) => (v ? Date.parse(v) : NaN)).filter((t) => !Number.isNaN(t));
  const spread = times.length ? times.reduce((a, b) => Math.max(a, b)) - times.reduce((a, b) => Math.min(a, b)) : Infinity;
  const reason =
    times.length === next.size && spread < ONE_HOUR
      ? "Toutes les URL ont un lastmod dans la même heure : app/sitemap.ts utilise sans doute new Date(). Utiliser la vraie date de modification du contenu."
      : `${Math.round(ratio * 100)} % des URL ont changé (seuil ${Math.round(maxRatio * 100)} %).`;
  return { suspicious: true, reason };
}

/** URL → lastmod (ISO) ou null si absent. */
export type SitemapEntries = Map<string, string | null>;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => ENTITIES[name] ?? "")
    .replace(/&#(x?)([0-9a-f]+);/gi, (_, hex: string, code: string) =>
      String.fromCodePoint(parseInt(code, hex ? 16 : 10)),
    )
    .trim();
}

function tag(block: string, name: string): string | null {
  const match = block.match(new RegExp(`<(?:\\w+:)?${name}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`, "i"));
  return match?.[1] ? decodeXml(match[1]) : null;
}

function blocks(xml: string, name: string): string[] {
  return xml.match(new RegExp(`<(?:\\w+:)?${name}[\\s>][\\s\\S]*?</(?:\\w+:)?${name}>`, "gi")) ?? [];
}

/** Parse un `<urlset>` ou un `<sitemapindex>` (https://www.sitemaps.org/protocol.html). */
export function parseSitemap(xml: string): { kind: "urlset" | "index"; items: { loc: string; lastmod: string | null }[] } {
  const isIndex = /<(?:\w+:)?sitemapindex[\s>]/i.test(xml);
  const items = blocks(xml, isIndex ? "sitemap" : "url")
    .map((block) => ({ loc: tag(block, "loc"), lastmod: tag(block, "lastmod") }))
    .filter((item): item is { loc: string; lastmod: string | null } => Boolean(item.loc));
  return { kind: isIndex ? "index" : "urlset", items };
}

function normalizeLastmod(value: string | null): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? value : new Date(time).toISOString();
}

export async function fetchSitemapEntries(
  url: string,
  options: { fetch?: typeof fetch; maxDepth?: number } = {},
): Promise<SitemapEntries> {
  const doFetch = options.fetch ?? fetch;
  const entries: SitemapEntries = new Map();
  const seen = new Set<string>();

  async function visit(current: string, depth: number) {
    if (seen.has(current)) return;
    seen.add(current);
    const response = await doFetch(current, { headers: { Accept: "application/xml, text/xml" } });
    if (!response.ok) throw new Error(`Sitemap ${current} : statut ${response.status}`);
    const xml = await response.text();
    const parsed = parseSitemap(xml);
    if (parsed.kind === "index") {
      if (depth >= (options.maxDepth ?? 2)) throw new Error(`Sitemap ${current} : index trop imbriqué`);
      for (const child of parsed.items) await visit(child.loc, depth + 1);
    } else {
      for (const item of parsed.items) entries.set(item.loc, normalizeLastmod(item.lastmod));
    }
  }

  await visit(url, 0);
  return entries;
}

/** URL → lastmod (ISO) ou null si absent. */
export type SitemapEntries = Map<string, string | null>;

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Une seule passe : `&amp;#38;` reste `&#38;` (pas de double décodage). */
function decodeXml(value: string): string {
  const cdata = value.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  if (cdata?.[1] !== undefined) return cdata[1].trim();
  return value
    .replace(/&(?:(amp|lt|gt|quot|apos)|#x([0-9a-f]+)|#(\d+));/gi, (match, name?: string, hex?: string, dec?: string) => {
      if (name) return NAMED[name.toLowerCase()] ?? match;
      const code = parseInt(hex ?? dec ?? "", hex ? 16 : 10);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    })
    .trim();
}

// Sans préfixe d'espace de noms : `<image:loc>` ou `<xhtml:link>` ne doivent pas être pris pour l'URL de la page.
function tag(block: string, name: string): string | null {
  const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return match?.[1] ? decodeXml(match[1]) : null;
}

function blocks(xml: string, name: string): string[] {
  return xml.match(new RegExp(`<${name}[\\s>][\\s\\S]*?</${name}>`, "gi")) ?? [];
}

export class SitemapError extends Error {
  override name = "SitemapError";
}

/** Parse un `<urlset>` ou un `<sitemapindex>` (https://www.sitemaps.org/protocol.html). */
export function parseSitemap(xml: string): { kind: "urlset" | "index"; items: { loc: string; lastmod: string | null }[] } {
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  // Une page HTML (challenge, 404 déguisée) donnerait 0 URL et ferait croire à la suppression de tout le site.
  if (!isIndex && !/<urlset[\s>]/i.test(xml)) {
    throw new SitemapError("Ni <urlset> ni <sitemapindex> : la réponse n'est pas un sitemap.");
  }
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

async function readBody(response: Response): Promise<string> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  // Fichier .xml.gz servi tel quel (pas via Content-Encoding) : magic bytes 1f 8b.
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).text();
  }
  return new TextDecoder().decode(bytes);
}

export async function fetchSitemapEntries(
  url: string,
  options: { fetch?: typeof fetch; maxDepth?: number; timeoutMs?: number } = {},
): Promise<SitemapEntries> {
  const doFetch = options.fetch ?? fetch;
  const entries: SitemapEntries = new Map();
  const seen = new Set<string>();

  async function visit(current: string, depth: number) {
    if (seen.has(current)) return;
    seen.add(current);
    const response = await doFetch(current, {
      headers: { Accept: "application/xml, text/xml" },
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
    });
    if (!response.ok) throw new SitemapError(`Sitemap ${current} : statut ${response.status}`);
    const parsed = parseSitemap(await readBody(response));
    if (parsed.kind === "index") {
      if (depth >= (options.maxDepth ?? 2)) throw new SitemapError(`Sitemap ${current} : index trop imbriqué`);
      for (const child of parsed.items) await visit(child.loc, depth + 1);
    } else {
      for (const item of parsed.items) entries.set(item.loc, normalizeLastmod(item.lastmod));
    }
  }

  await visit(url, 0);
  return entries;
}

import { describe, expect, test } from "bun:test";
import {
  checkMassChange,
  chunk,
  diffSitemaps,
  fetchSitemapEntries,
  generateKey,
  isValidKey,
  loadConfig,
  normalizeHost,
  notifyIndexNow,
  parseRetryAfter,
  parseSitemap,
  prepareUrls,
  submitUrls,
  verifyKeyFile,
} from "./index.ts";

const KEY = "a1b2c3d4e5f6a7b8";
const silent = { info() {}, warn() {}, error() {} };

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { fn, calls };
}

describe("clé", () => {
  test("génère une clé valide", () => {
    const key = generateKey();
    expect(key).toHaveLength(32);
    expect(isValidKey(key)).toBe(true);
  });
  test("refuse les formats hors spec", () => {
    expect(isValidKey("short")).toBe(false);
    expect(isValidKey("I-love-IndexNow-3000")).toBe(true);
    expect(isValidKey("a".repeat(129))).toBe(false);
    expect(isValidKey("abc_def_ghi")).toBe(false);
  });
});

describe("préparation des URL", () => {
  test("filtre le host, dédoublonne, retire le fragment", () => {
    const { accepted, rejected } = prepareUrls(
      ["https://www.ex.com/a", "https://www.ex.com/a#top", "https://ex.com/b", "ftp://www.ex.com/c", "pas une url"],
      "https://WWW.ex.com/",
    );
    expect(accepted).toEqual(["https://www.ex.com/a"]);
    expect(rejected.map((r) => r.url)).toEqual(["https://ex.com/b", "ftp://www.ex.com/c", "pas une url"]);
  });
  test("découpe en lots", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
  test("Retry-After en secondes et en date", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter(null)).toBeNull();
  });
});

describe("submitUrls", () => {
  test("envoie le corps attendu par la spec", async () => {
    const { fn, calls } = mockFetch(() => new Response(null, { status: 202 }));
    const result = await submitUrls(["https://ex.com/a"], { key: KEY, host: "ex.com", fetch: fn });
    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe("https://api.indexnow.org/indexnow");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ host: "ex.com", key: KEY, urlList: ["https://ex.com/a"] });
  });
  test("lots de 10 000", async () => {
    const { fn, calls } = mockFetch(() => new Response(null, { status: 200 }));
    const urls = Array.from({ length: 10_001 }, (_, i) => `https://ex.com/p${i}`);
    const result = await submitUrls(urls, { key: KEY, host: "ex.com", fetch: fn });
    expect(calls).toHaveLength(2);
    expect(result.submitted).toHaveLength(10_001);
  });
  test("dry-run n'appelle pas le réseau", async () => {
    const { fn, calls } = mockFetch(() => new Response(null, { status: 200 }));
    const result = await submitUrls(["https://ex.com/a"], { key: KEY, host: "ex.com", fetch: fn, dryRun: true });
    expect(calls).toHaveLength(0);
    expect(result.submitted).toEqual(["https://ex.com/a"]);
  });
  test("429 : attend Retry-After puis réessaie une fois", async () => {
    let n = 0;
    const waits: number[] = [];
    const { fn } = mockFetch(() =>
      ++n === 1 ? new Response(null, { status: 429, headers: { "Retry-After": "2" } }) : new Response(null, { status: 200 }),
    );
    const result = await submitUrls(["https://ex.com/a"], {
      key: KEY,
      host: "ex.com",
      fetch: fn,
      sleep: async (ms) => void waits.push(ms),
    });
    expect(waits).toEqual([2000]);
    expect(result.ok).toBe(true);
  });
  test("403 : échec explicite", async () => {
    const { fn } = mockFetch(() => new Response("bad key", { status: 403 }));
    const result = await submitUrls(["https://ex.com/a"], { key: KEY, host: "ex.com", fetch: fn });
    expect(result.ok).toBe(false);
    expect(result.batches[0]?.message).toContain("Clé invalide");
  });
});

describe("verifyKeyFile", () => {
  test("OK", async () => {
    const { fn, calls } = mockFetch(() => new Response(`${KEY}\n`, { headers: { "Content-Type": "text/plain; charset=utf-8" } }));
    const result = await verifyKeyFile({ host: "ex.com", key: KEY, fetch: fn });
    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe(`https://ex.com/${KEY}.txt`);
    expect(calls[0]?.init?.redirect).toBe("manual");
  });
  test("redirection i18n détectée", async () => {
    const { fn } = mockFetch(() => new Response(null, { status: 307, headers: { Location: `/fr/${KEY}.txt` } }));
    const result = await verifyKeyFile({ host: "ex.com", key: KEY, fetch: fn });
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain("Redirection 307");
  });
  test("HTML renvoyé par un catch-all", async () => {
    const { fn } = mockFetch(() => new Response("<!doctype html>", { headers: { "Content-Type": "text/html" } }));
    const result = await verifyKeyFile({ host: "ex.com", key: KEY, fetch: fn });
    expect(result.problems[0]).toContain("HTML");
  });
  test("401 Deployment Protection", async () => {
    const { fn } = mockFetch(() => new Response(null, { status: 401 }));
    const result = await verifyKeyFile({ host: "ex.com", key: KEY, fetch: fn });
    expect(result.problems[0]).toContain("Deployment Protection");
  });
});

describe("sitemap", () => {
  const urlset = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <url><loc>https://ex.com/a?x=1&amp;y=2</loc><lastmod>2026-11-01</lastmod></url>
    <url><loc><![CDATA[https://ex.com/b]]></loc></url></urlset>`;
  test("parse urlset, entités et CDATA", () => {
    expect(parseSitemap(urlset)).toEqual({
      kind: "urlset",
      items: [
        { loc: "https://ex.com/a?x=1&y=2", lastmod: "2026-11-01" },
        { loc: "https://ex.com/b", lastmod: null },
      ],
    });
  });
  test("suit un sitemap index", async () => {
    const index = `<sitemapindex><sitemap><loc>https://ex.com/s1.xml</loc></sitemap></sitemapindex>`;
    const { fn } = mockFetch((url) => new Response(url.endsWith("index.xml") ? index : urlset));
    const entries = await fetchSitemapEntries("https://ex.com/index.xml", { fetch: fn });
    expect(entries.get("https://ex.com/a?x=1&y=2")).toBe("2026-11-01T00:00:00.000Z");
    expect(entries.get("https://ex.com/b")).toBeNull();
  });
});

describe("diff", () => {
  test("ajouts, modifications, suppressions", () => {
    const prev = new Map([["/a", "1"], ["/b", "1"], ["/c", null]]);
    const next = new Map([["/a", "1"], ["/b", "2"], ["/c", null], ["/d", null]]);
    prev.set("/gone", "1");
    expect(diffSitemaps(prev, next)).toEqual({ added: ["/d"], changed: ["/b"], removed: ["/gone"], total: 4 });
  });
  test("détecte lastModified: new Date()", () => {
    const now = "2026-11-13T10:00:00.000Z";
    const prev = new Map(Array.from({ length: 30 }, (_, i) => [`/p${i}`, "2026-01-01T00:00:00.000Z"] as const));
    const next = new Map(Array.from({ length: 30 }, (_, i) => [`/p${i}`, now] as const));
    const check = checkMassChange(diffSitemaps(prev, next), next);
    expect(check.suspicious).toBe(true);
    expect(check.reason).toContain("new Date()");
  });
});

describe("config", () => {
  test("dry-run hors production", () => {
    expect(loadConfig({ INDEXNOW_KEY: KEY, INDEXNOW_HOST: "ex.com", VERCEL_ENV: "preview" }).enabled).toBe(false);
    expect(loadConfig({ INDEXNOW_KEY: KEY, INDEXNOW_HOST: "ex.com", VERCEL_ENV: "production" }).enabled).toBe(true);
    expect(loadConfig({ INDEXNOW_KEY: KEY, INDEXNOW_HOST: "ex.com", INDEXNOW_ENABLED: "true" }).enabled).toBe(true);
  });
  test("host repris de Vercel, *.vercel.app refusé", () => {
    expect(loadConfig({ INDEXNOW_KEY: KEY, VERCEL_PROJECT_PRODUCTION_URL: "www.ex.com" }).host).toBe("www.ex.com");
    expect(() => loadConfig({ INDEXNOW_KEY: KEY, VERCEL_PROJECT_PRODUCTION_URL: "proj.vercel.app" })).toThrow("vercel.app");
  });
  test("clé invalide refusée", () => {
    expect(() => loadConfig({ INDEXNOW_KEY: "bad", INDEXNOW_HOST: "ex.com" })).toThrow("INDEXNOW_KEY");
  });
});

describe("notifyIndexNow", () => {
  test("résout les chemins sur le host et ne lève jamais", async () => {
    const { fn, calls } = mockFetch(() => new Response(null, { status: 200 }));
    const config = { key: KEY, host: "ex.com", enabled: true };
    await notifyIndexNow(["/blog/x", "https://ex.com/y"], { config, fetch: fn, logger: silent });
    expect(JSON.parse(String(calls[0]?.init?.body)).urlList).toEqual(["https://ex.com/blog/x", "https://ex.com/y"]);
    expect(await notifyIndexNow("/x", { logger: silent, config: undefined })).toBeNull();
  });
});

describe("corrections de la relecture", () => {
  test("une page HTML n'est pas un sitemap", () => {
    expect(() => parseSitemap("<!doctype html><html></html>")).toThrow("pas un sitemap");
  });
  test("pas de double décodage, <image:loc> ignoré", () => {
    const xml = `<urlset><url><image:image><image:loc>https://ex.com/img.png</image:loc></image:image>
      <loc>https://ex.com/a?q=&amp;#38;</loc></url></urlset>`;
    expect(parseSitemap(xml).items[0]?.loc).toBe("https://ex.com/a?q=&#38;");
  });
  test("sitemap .xml.gz", async () => {
    const xml = `<urlset><url><loc>https://ex.com/gz</loc></url></urlset>`;
    const gz = Bun.gzipSync(new TextEncoder().encode(xml));
    const { fn } = mockFetch(() => new Response(gz));
    const entries = await fetchSitemapEntries("https://ex.com/s.xml.gz", { fetch: fn });
    expect([...entries.keys()]).toEqual(["https://ex.com/gz"]);
  });
  test("IDN et port par défaut", () => {
    expect(normalizeHost("https://Café.fr:443/x")).toBe("xn--caf-dma.fr");
    expect(prepareUrls(["https://café.fr/a"], "café.fr").accepted).toEqual(["https://xn--caf-dma.fr/a"]);
  });
  test("une URL écartée rend le résultat non ok", async () => {
    const { fn } = mockFetch(() => new Response(null, { status: 200 }));
    const result = await submitUrls(["https://ex.com/a"], { key: KEY, host: "www.ex.com", fetch: fn });
    expect(result.ok).toBe(false);
    expect(result.rejected).toHaveLength(1);
  });
  test("sitemap vidé : suppression massive détectée", () => {
    const prev = new Map(Array.from({ length: 100 }, (_, i) => [`/p${i}`, null] as const));
    const next = new Map<string, string | null>();
    const diff = diffSitemaps(prev, next);
    expect(diff.total).toBe(100);
    expect(checkMassChange(diff, next).suspicious).toBe(true);
  });
  test("lastmod new Date() aux millisecondes près", () => {
    const prev = new Map(Array.from({ length: 30 }, (_, i) => [`/p${i}`, "2026-01-01T00:00:00.000Z"] as const));
    const next = new Map(Array.from({ length: 30 }, (_, i) => [`/p${i}`, `2026-11-13T10:00:00.${String(i).padStart(3, "0")}Z`] as const));
    expect(checkMassChange(diffSitemaps(prev, next), next).reason).toContain("new Date()");
  });
});

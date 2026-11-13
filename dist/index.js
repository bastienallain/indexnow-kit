// src/core.ts
var DEFAULT_ENDPOINT = "https://api.indexnow.org/indexnow";
var MAX_URLS_PER_REQUEST = 1e4;
var STATUS_MESSAGES = {
  200: "URL reçues.",
  202: "URL reçues, validation de la clé en attente (le moteur ira lire le fichier de clé).",
  400: "Format de requête invalide.",
  403: "Clé invalide : fichier de clé introuvable ou contenu différent de la clé.",
  422: "URL hors du host déclaré, ou clé non conforme au schéma.",
  429: "Trop de requêtes (spam potentiel)."
};
function normalizeHost(input) {
  const bare = input.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  try {
    return new URL(`https://${bare}`).host;
  } catch {
    throw new Error(`Host invalide : ${input}`);
  }
}
function prepareUrls(urls, host) {
  const wanted = normalizeHost(host);
  const accepted = new Set;
  const rejected = [];
  for (const raw of urls) {
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      rejected.push({ url: raw, reason: "URL invalide" });
      continue;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      rejected.push({ url: raw, reason: "protocole non http(s)" });
    } else if (parsed.host.toLowerCase() !== wanted) {
      rejected.push({ url: raw, reason: `host ${parsed.host} ≠ ${wanted}` });
    } else {
      parsed.hash = "";
      accepted.add(parsed.href);
    }
  }
  return { accepted: [...accepted], rejected };
}
function chunk(items, size) {
  const out = [];
  for (let i = 0;i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}
function parseRetryAfter(value, now = Date.now()) {
  if (!value)
    return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds))
    return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}
var defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function submitUrls(urls, options) {
  const host = normalizeHost(options.host);
  const { accepted, rejected } = prepareUrls(urls, host);
  const result = {
    ok: rejected.length === 0,
    dryRun: Boolean(options.dryRun),
    submitted: [],
    rejected,
    batches: []
  };
  if (accepted.length === 0 || options.dryRun) {
    result.submitted = options.dryRun ? accepted : [];
    return result;
  }
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const maxWait = options.maxRetryWaitMs ?? 60000;
  for (const batch of chunk(accepted, MAX_URLS_PER_REQUEST)) {
    const body = JSON.stringify({
      host,
      key: options.key,
      ...options.keyLocation ? { keyLocation: options.keyLocation } : {},
      urlList: batch
    });
    const send = () => doFetch(options.endpoint ?? DEFAULT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body,
      signal: AbortSignal.timeout(options.timeoutMs ?? 15000)
    });
    let response = await send();
    if (response.status === 429) {
      const wait = parseRetryAfter(response.headers.get("retry-after"));
      if (wait !== null && wait <= maxWait) {
        await sleep(wait);
        response = await send();
      }
    }
    const ok = response.status === 200 || response.status === 202;
    let message = STATUS_MESSAGES[response.status] ?? `Statut inattendu ${response.status}.`;
    if (!ok) {
      const text = (await response.text().catch(() => "")).slice(0, 300);
      if (text)
        message += ` Réponse : ${text}`;
    }
    result.batches.push({ status: response.status, ok, urls: batch.length, message });
    if (ok)
      result.submitted.push(...batch);
    else
      result.ok = false;
    if (response.status === 429 || response.status === 403)
      break;
  }
  if (result.submitted.length < accepted.length)
    result.ok = false;
  return result;
}

// src/config.ts
import { z } from "zod";

// src/key.ts
var KEY_PATTERN = /^[a-zA-Z0-9-]{8,128}$/;
function isValidKey(key) {
  return KEY_PATTERN.test(key);
}
function generateKey(length = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(Math.ceil(length / 2)));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, length);
}
function defaultKeyLocation(host, key) {
  return `https://${normalizeHost(host)}/${key}.txt`;
}
async function verifyKeyFile(options) {
  const url = options.keyLocation ?? defaultKeyLocation(options.host, options.key);
  const result = { ok: false, url, status: null, problems: [], warnings: [] };
  if (!isValidKey(options.key)) {
    result.problems.push("La clé ne respecte pas le format 8-128 caractères [a-zA-Z0-9-].");
  }
  const locationHost = new URL(url).host.toLowerCase();
  if (locationHost !== normalizeHost(options.host)) {
    result.problems.push(`Le fichier de clé est sur ${locationHost}, pas sur ${normalizeHost(options.host)}.`);
  }
  if (new URL(url).pathname !== `/${options.key}.txt`) {
    result.warnings.push("Fichier de clé hors racine : seules les URL sous son dossier seront couvertes par la clé.");
  }
  let response;
  try {
    response = await (options.fetch ?? fetch)(url, {
      redirect: "manual",
      headers: { Accept: "text/plain" },
      signal: AbortSignal.timeout(options.timeoutMs ?? 1e4)
    });
  } catch (error) {
    result.problems.push(`Requête impossible : ${error.message}`);
    return result;
  }
  result.status = response.status;
  if (response.status >= 300 && response.status < 400) {
    result.problems.push(`Redirection ${response.status} vers ${response.headers.get("location")} : souvent un middleware i18n ou un rewrite. Exclure /${options.key}.txt du matcher.`);
  } else if (response.status === 401 || response.status === 403) {
    result.problems.push(`Accès refusé (${response.status}) : Vercel Deployment Protection, WAF ou challenge anti-bot sur le domaine de production.`);
  } else if (response.status !== 200) {
    result.problems.push(`Statut ${response.status} : le fichier doit répondre 200 (placer la clé dans public/${options.key}.txt).`);
  } else {
    const body = (await response.text()).trim();
    if (body !== options.key) {
      result.problems.push(body.startsWith("<") ? "Le fichier renvoie du HTML : une route catch-all ou un rewrite l'intercepte." : "Le contenu du fichier ne correspond pas à la clé.");
    }
    const type = response.headers.get("content-type") ?? "";
    if (!type.startsWith("text/plain")) {
      result.warnings.push(`Content-Type « ${type || "absent"} » : text/plain attendu.`);
    }
  }
  result.ok = result.problems.length === 0;
  return result;
}

// src/config.ts
var EnvSchema = z.object({
  INDEXNOW_KEY: z.string().regex(KEY_PATTERN, "INDEXNOW_KEY : 8 à 128 caractères [a-zA-Z0-9-]"),
  INDEXNOW_HOST: z.string().min(1).optional(),
  INDEXNOW_KEY_LOCATION: z.url().optional(),
  INDEXNOW_ENDPOINT: z.url().optional(),
  INDEXNOW_ENABLED: z.enum(["true", "false"]).optional(),
  VERCEL_ENV: z.string().optional(),
  VERCEL_PROJECT_PRODUCTION_URL: z.string().optional()
});

class IndexNowConfigError extends Error {
  name = "IndexNowConfigError";
}
function loadConfig(env = process.env) {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join(".")} : ${i.message}`).join(" ; ");
    throw new IndexNowConfigError(`Config IndexNow invalide : ${details}`);
  }
  const vars = parsed.data;
  const rawHost = vars.INDEXNOW_HOST ?? vars.VERCEL_PROJECT_PRODUCTION_URL;
  if (!rawHost) {
    throw new IndexNowConfigError("INDEXNOW_HOST manquant (et VERCEL_PROJECT_PRODUCTION_URL absent).");
  }
  const host = normalizeHost(rawHost);
  if (host.endsWith(".vercel.app")) {
    throw new IndexNowConfigError(`Host ${host} refusé : soumettre le domaine canonique (celui du sitemap et des balises canonical). Définir INDEXNOW_HOST.`);
  }
  const enabled = vars.INDEXNOW_ENABLED === "true" || vars.INDEXNOW_ENABLED !== "false" && vars.VERCEL_ENV === "production";
  return {
    key: vars.INDEXNOW_KEY,
    host,
    keyLocation: vars.INDEXNOW_KEY_LOCATION,
    endpoint: vars.INDEXNOW_ENDPOINT,
    enabled
  };
}
// src/sitemap.ts
var NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decodeXml(value) {
  const cdata = value.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  if (cdata?.[1] !== undefined)
    return cdata[1].trim();
  return value.replace(/&(?:(amp|lt|gt|quot|apos)|#x([0-9a-f]+)|#(\d+));/gi, (match, name, hex, dec) => {
    if (name)
      return NAMED[name.toLowerCase()] ?? match;
    const code = parseInt(hex ?? dec ?? "", hex ? 16 : 10);
    return code >= 0 && code <= 1114111 ? String.fromCodePoint(code) : match;
  }).trim();
}
function tag(block, name) {
  const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return match?.[1] ? decodeXml(match[1]) : null;
}
function blocks(xml, name) {
  return xml.match(new RegExp(`<${name}[\\s>][\\s\\S]*?</${name}>`, "gi")) ?? [];
}

class SitemapError extends Error {
  name = "SitemapError";
}
function parseSitemap(xml) {
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  if (!isIndex && !/<urlset[\s>]/i.test(xml)) {
    throw new SitemapError("Ni <urlset> ni <sitemapindex> : la réponse n'est pas un sitemap.");
  }
  const items = blocks(xml, isIndex ? "sitemap" : "url").map((block) => ({ loc: tag(block, "loc"), lastmod: tag(block, "lastmod") })).filter((item) => Boolean(item.loc));
  return { kind: isIndex ? "index" : "urlset", items };
}
function normalizeLastmod(value) {
  if (!value)
    return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? value : new Date(time).toISOString();
}
async function readBody(response) {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes[0] === 31 && bytes[1] === 139) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).text();
  }
  return new TextDecoder().decode(bytes);
}
async function fetchSitemapEntries(url, options = {}) {
  const doFetch = options.fetch ?? fetch;
  const entries = new Map;
  const seen = new Set;
  async function visit(current, depth) {
    if (seen.has(current))
      return;
    seen.add(current);
    const response = await doFetch(current, {
      headers: { Accept: "application/xml, text/xml" },
      signal: AbortSignal.timeout(options.timeoutMs ?? 20000)
    });
    if (!response.ok)
      throw new SitemapError(`Sitemap ${current} : statut ${response.status}`);
    const parsed = parseSitemap(await readBody(response));
    if (parsed.kind === "index") {
      if (depth >= (options.maxDepth ?? 2))
        throw new SitemapError(`Sitemap ${current} : index trop imbriqué`);
      for (const child of parsed.items)
        await visit(child.loc, depth + 1);
    } else {
      for (const item of parsed.items)
        entries.set(item.loc, normalizeLastmod(item.lastmod));
    }
  }
  await visit(url, 0);
  return entries;
}
// src/diff.ts
function diffSitemaps(previous, next) {
  const added = [];
  const changed = [];
  const removed = [];
  for (const [url, lastmod] of next) {
    if (!previous.has(url))
      added.push(url);
    else if (lastmod !== null && lastmod !== previous.get(url))
      changed.push(url);
  }
  for (const url of previous.keys())
    if (!next.has(url))
      removed.push(url);
  return { added, changed, removed, total: Math.max(previous.size, next.size) };
}
var ONE_HOUR = 3600000;
function checkMassChange(diff, next, maxRatio = 0.5, minUrls = 20) {
  if (diff.total < minUrls)
    return { suspicious: false };
  const touched = diff.added.length + diff.changed.length + diff.removed.length;
  const ratio = touched / diff.total;
  if (ratio <= maxRatio)
    return { suspicious: false };
  if (next.size === 0)
    return { suspicious: true, reason: "Le sitemap est vide : tout le site serait soumis comme supprimé." };
  if (diff.removed.length > diff.total * maxRatio) {
    return { suspicious: true, reason: `${diff.removed.length} URL ont disparu du sitemap (sitemap tronqué, mauvais host, ou refonte).` };
  }
  const times = [...next.values()].map((v) => v ? Date.parse(v) : NaN).filter((t) => !Number.isNaN(t));
  const spread = times.length ? times.reduce((a, b) => Math.max(a, b)) - times.reduce((a, b) => Math.min(a, b)) : Infinity;
  const reason = times.length === next.size && spread < ONE_HOUR ? "Toutes les URL ont un lastmod dans la même heure : app/sitemap.ts utilise sans doute new Date(). Utiliser la vraie date de modification du contenu." : `${Math.round(ratio * 100)} % des URL ont changé (seuil ${Math.round(maxRatio * 100)} %).`;
  return { suspicious: true, reason };
}

// src/index.ts
async function notifyIndexNow(pathsOrUrls, options = {}) {
  const log = options.logger ?? console;
  try {
    const config2 = options.config ?? loadConfig();
    const list = Array.isArray(pathsOrUrls) ? pathsOrUrls : [pathsOrUrls];
    const urls = list.map((item) => new URL(item, `https://${config2.host}`).href);
    const result = await submitUrls(urls, {
      key: config2.key,
      host: config2.host,
      keyLocation: config2.keyLocation,
      endpoint: config2.endpoint,
      dryRun: !config2.enabled,
      fetch: options.fetch
    });
    if (result.dryRun)
      log.info(`[indexnow] dry-run (hors production) : ${result.submitted.length} URL non envoyées`);
    for (const batch of result.batches) {
      log[batch.ok ? "info" : "error"](`[indexnow] ${batch.status} ${batch.urls} URL : ${batch.message}`);
    }
    for (const r of result.rejected)
      log.warn(`[indexnow] écartée ${r.url} : ${r.reason}`);
    return result;
  } catch (error) {
    log.error(`[indexnow] ${error.message}`);
    return null;
  }
}
export {
  DEFAULT_ENDPOINT,
  IndexNowConfigError,
  KEY_PATTERN,
  MAX_URLS_PER_REQUEST,
  SitemapError,
  checkMassChange,
  chunk,
  defaultKeyLocation,
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
  verifyKeyFile
};

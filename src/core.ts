// Spec: https://www.indexnow.org/documentation (lue le 2026-11-13)

export const DEFAULT_ENDPOINT = "https://api.indexnow.org/indexnow";
export const MAX_URLS_PER_REQUEST = 10_000;

const STATUS_MESSAGES: Record<number, string> = {
  200: "URL reçues.",
  202: "URL reçues, validation de la clé en attente (le moteur ira lire le fichier de clé).",
  400: "Format de requête invalide.",
  403: "Clé invalide : fichier de clé introuvable ou contenu différent de la clé.",
  422: "URL hors du host déclaré, ou clé non conforme au schéma.",
  429: "Trop de requêtes (spam potentiel).",
};

export interface SubmitOptions {
  key: string;
  /** Host canonique, sans protocole : `www.example.com`. */
  host: string;
  keyLocation?: string;
  endpoint?: string;
  dryRun?: boolean;
  /** Attente maximale acceptée sur un 429 avant d'abandonner (ms). */
  maxRetryWaitMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface BatchResult {
  status: number;
  ok: boolean;
  urls: number;
  message: string;
}

export interface SubmitResult {
  ok: boolean;
  dryRun: boolean;
  submitted: string[];
  /** URL écartées avant envoi, avec la raison. */
  rejected: { url: string; reason: string }[];
  batches: BatchResult[];
}

export function normalizeHost(input: string): string {
  return input
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
}

/** Garde les URL http(s) du host exact, dédoublonnées. Le protocole impose un seul host par requête (sinon 422). */
export function prepareUrls(urls: Iterable<string>, host: string) {
  const wanted = normalizeHost(host);
  const accepted = new Set<string>();
  const rejected: { url: string; reason: string }[] = [];
  for (const raw of urls) {
    let parsed: URL;
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

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** `Retry-After` accepte des secondes ou une date HTTP. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function submitUrls(urls: Iterable<string>, options: SubmitOptions): Promise<SubmitResult> {
  const host = normalizeHost(options.host);
  const { accepted, rejected } = prepareUrls(urls, host);
  const result: SubmitResult = {
    ok: true,
    dryRun: Boolean(options.dryRun),
    submitted: [],
    rejected,
    batches: [],
  };
  if (accepted.length === 0 || options.dryRun) {
    result.submitted = options.dryRun ? accepted : [];
    return result;
  }

  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const maxWait = options.maxRetryWaitMs ?? 60_000;

  for (const batch of chunk(accepted, MAX_URLS_PER_REQUEST)) {
    const body = JSON.stringify({
      host,
      key: options.key,
      ...(options.keyLocation ? { keyLocation: options.keyLocation } : {}),
      urlList: batch,
    });
    const send = () =>
      doFetch(options.endpoint ?? DEFAULT_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body,
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
      if (text) message += ` Réponse : ${text}`;
    }
    result.batches.push({ status: response.status, ok, urls: batch.length, message });
    if (ok) result.submitted.push(...batch);
    else result.ok = false;
    // Un 429 persistant : inutile d'insister sur les lots suivants.
    if (response.status === 429 || response.status === 403) break;
  }
  if (result.submitted.length < accepted.length) result.ok = false;
  return result;
}

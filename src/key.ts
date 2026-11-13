import { normalizeHost } from "./core.ts";

/** 8 à 128 caractères a-z A-Z 0-9 et tiret (https://www.indexnow.org/documentation). */
export const KEY_PATTERN = /^[a-zA-Z0-9-]{8,128}$/;

export function isValidKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

export function generateKey(length = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(Math.ceil(length / 2)));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, length);
}

export function defaultKeyLocation(host: string, key: string): string {
  return `https://${normalizeHost(host)}/${key}.txt`;
}

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
export async function verifyKeyFile(options: {
  host: string;
  key: string;
  keyLocation?: string;
  fetch?: typeof fetch;
}): Promise<VerifyResult> {
  const url = options.keyLocation ?? defaultKeyLocation(options.host, options.key);
  const result: VerifyResult = { ok: false, url, status: null, problems: [], warnings: [] };

  if (!isValidKey(options.key)) {
    result.problems.push("La clé ne respecte pas le format 8-128 caractères [a-zA-Z0-9-].");
  }
  const locationHost = new URL(url).host.toLowerCase();
  if (locationHost !== normalizeHost(options.host)) {
    result.problems.push(`Le fichier de clé est sur ${locationHost}, pas sur ${normalizeHost(options.host)}.`);
  }
  if (new URL(url).pathname !== `/${options.key}.txt`) {
    result.warnings.push(
      "Fichier de clé hors racine : seules les URL sous son dossier seront couvertes par la clé.",
    );
  }

  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, { redirect: "manual", headers: { Accept: "text/plain" } });
  } catch (error) {
    result.problems.push(`Requête impossible : ${(error as Error).message}`);
    return result;
  }
  result.status = response.status;

  if (response.status >= 300 && response.status < 400) {
    result.problems.push(
      `Redirection ${response.status} vers ${response.headers.get("location")} : souvent un middleware i18n ou un rewrite. Exclure /${options.key}.txt du matcher.`,
    );
  } else if (response.status === 401 || response.status === 403) {
    result.problems.push(
      `Accès refusé (${response.status}) : Vercel Deployment Protection, WAF ou challenge anti-bot sur le domaine de production.`,
    );
  } else if (response.status !== 200) {
    result.problems.push(`Statut ${response.status} : le fichier doit répondre 200 (placer la clé dans public/${options.key}.txt).`);
  } else {
    const body = (await response.text()).trim();
    if (body !== options.key) {
      result.problems.push(
        body.startsWith("<")
          ? "Le fichier renvoie du HTML : une route catch-all ou un rewrite l'intercepte."
          : "Le contenu du fichier ne correspond pas à la clé.",
      );
    }
    const type = response.headers.get("content-type") ?? "";
    if (!type.startsWith("text/plain")) {
      result.warnings.push(`Content-Type « ${type || "absent"} » : text/plain attendu.`);
    }
  }
  result.ok = result.problems.length === 0;
  return result;
}

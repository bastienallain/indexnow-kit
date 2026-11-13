import { z } from "zod";
import { normalizeHost } from "./core.ts";
import { KEY_PATTERN } from "./key.ts";

const EnvSchema = z.object({
  INDEXNOW_KEY: z.string().regex(KEY_PATTERN, "INDEXNOW_KEY : 8 à 128 caractères [a-zA-Z0-9-]"),
  INDEXNOW_HOST: z.string().min(1).optional(),
  INDEXNOW_KEY_LOCATION: z.url().optional(),
  INDEXNOW_ENDPOINT: z.url().optional(),
  /** "true" active l'envoi hors Vercel production (ex. GitHub Action). */
  INDEXNOW_ENABLED: z.enum(["true", "false"]).optional(),
  VERCEL_ENV: z.string().optional(),
  VERCEL_PROJECT_PRODUCTION_URL: z.string().optional(),
});

export interface IndexNowConfig {
  key: string;
  host: string;
  keyLocation?: string;
  endpoint?: string;
  /** false = dry-run : rien n'est envoyé. */
  enabled: boolean;
}

export class IndexNowConfigError extends Error {
  override name = "IndexNowConfigError";
}

/**
 * Lit et valide la config. Envoi actif seulement si `VERCEL_ENV === "production"`
 * ou `INDEXNOW_ENABLED === "true"`, et jamais vers un host `*.vercel.app`.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): IndexNowConfig {
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
    throw new IndexNowConfigError(
      `Host ${host} refusé : soumettre le domaine canonique (celui du sitemap et des balises canonical). Définir INDEXNOW_HOST.`,
    );
  }
  const enabled =
    vars.INDEXNOW_ENABLED === "true" || (vars.INDEXNOW_ENABLED !== "false" && vars.VERCEL_ENV === "production");
  return {
    key: vars.INDEXNOW_KEY,
    host,
    keyLocation: vars.INDEXNOW_KEY_LOCATION,
    endpoint: vars.INDEXNOW_ENDPOINT,
    enabled,
  };
}

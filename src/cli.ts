#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { submitUrls, type SubmitResult } from "./core.ts";
import { loadConfig } from "./config.ts";
import { generateKey, verifyKeyFile } from "./key.ts";
import { fetchSitemapEntries, type SitemapEntries } from "./sitemap.ts";
import { checkMassChange, diffSitemaps } from "./diff.ts";

const HELP = `indexnow-kit <commande>

  init [--dir public]           Génère une clé et écrit public/{clé}.txt
  verify                        Vérifie le fichier de clé en production
  submit <url|chemin>...        Soumet des URL
  sync --sitemap <url> [--state .indexnow/state.json] [--max-ratio 0.5] [--allow-mass] [--initial]
                                Diffe le sitemap avec l'état mémorisé et soumet ajouts, modifications, suppressions

Variables : INDEXNOW_KEY, INDEXNOW_HOST, INDEXNOW_ENABLED=true (hors Vercel production), INDEXNOW_KEY_LOCATION, INDEXNOW_ENDPOINT.
Sans VERCEL_ENV=production ni INDEXNOW_ENABLED=true : dry-run.`;

interface StateFile {
  version: 1;
  sitemap: string;
  updatedAt: string;
  entries: Record<string, string | null>;
}

function report(result: SubmitResult) {
  if (result.dryRun) console.log(`dry-run : ${result.submitted.length} URL auraient été envoyées.`);
  for (const b of result.batches) console.log(`${b.ok ? "✓" : "✗"} ${b.status} · ${b.urls} URL · ${b.message}`);
  for (const r of result.rejected) console.warn(`écartée ${r.url} : ${r.reason}`);
}

/** En CI GitHub, `::warning::` remonte dans le résumé du run au lieu de rester dans les logs. */
function warn(message: string) {
  console.warn(process.env.GITHUB_ACTIONS === "true" ? `::warning title=indexnow-kit::${message}` : `attention : ${message}`);
}

async function readState(path: string, sitemap: string): Promise<SitemapEntries | null> {
  let state: StateFile;
  try {
    state = JSON.parse(await readFile(path, "utf8")) as StateFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (state.sitemap !== sitemap) {
    warn(`L'état mémorisé concerne ${state.sitemap}, pas ${sitemap} : il est ignoré.`);
    return null;
  }
  return new Map(Object.entries(state.entries));
}

async function writeState(path: string, sitemap: string, entries: SitemapEntries) {
  const state: StateFile = { version: 1, sitemap, updatedAt: new Date().toISOString(), entries: Object.fromEntries(entries) };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      dir: { type: "string", default: "public" },
      sitemap: { type: "string" },
      state: { type: "string", default: ".indexnow/state.json" },
      "max-ratio": { type: "string", default: "0.5" },
      "allow-mass": { type: "boolean", default: false },
      initial: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, ...args] = positionals;

  if (!command || values.help) {
    console.log(HELP);
    return command ? 0 : 1;
  }

  if (command === "init") {
    const key = generateKey();
    const file = join(values.dir, `${key}.txt`);
    await mkdir(values.dir, { recursive: true });
    await writeFile(file, key);
    console.log(`Fichier créé : ${file}\nAjouter dans Vercel (Production) : INDEXNOW_KEY=${key}`);
    console.log("La clé n'est pas secrète : le fichier est public par nature.");
    return 0;
  }

  const config = loadConfig();

  if (command === "verify") {
    const result = await verifyKeyFile(config);
    console.log(`${result.ok ? "✓" : "✗"} ${result.url} (statut ${result.status ?? "—"})`);
    for (const p of result.problems) console.error(`  problème : ${p}`);
    for (const w of result.warnings) console.warn(`  attention : ${w}`);
    return result.ok ? 0 : 1;
  }

  const submitOptions = { ...config, dryRun: !config.enabled };

  if (command === "submit") {
    if (args.length === 0) throw new Error("submit : au moins une URL ou un chemin.");
    const urls = args.map((a) => new URL(a, `https://${config.host}`).href);
    const result = await submitUrls(urls, submitOptions);
    report(result);
    return result.ok ? 0 : 1;
  }

  if (command === "sync") {
    if (!values.sitemap) throw new Error("sync : --sitemap <url> requis.");
    const maxRatio = Number(values["max-ratio"]);
    if (!(maxRatio > 0 && maxRatio <= 1)) throw new Error("--max-ratio : nombre entre 0 (exclu) et 1.");
    const next = await fetchSitemapEntries(values.sitemap);
    const previous = await readState(values.state, values.sitemap);

    if (!previous && !values.initial) {
      // La FAQ IndexNow déconseille de soumettre rétroactivement : on mémorise seulement.
      if (config.enabled) await writeState(values.state, values.sitemap, next);
      warn(
        `Aucun état précédent : ${next.size} URL ${config.enabled ? "mémorisées" : "lues (dry-run : état non sauvegardé)"}, rien n'est soumis. Normal au premier passage ; sinon l'état a été perdu (cache expiré ?).`,
      );
      return 0;
    }
    if (previous && previous.size > 0 && next.size === 0) {
      console.error("Arrêt : le sitemap ne contient plus aucune URL. Rien n'est soumis, l'état est conservé.");
      return 2;
    }

    const diff = diffSitemaps(previous ?? new Map(), next);
    console.log(`+${diff.added.length} ajoutées · ~${diff.changed.length} modifiées · -${diff.removed.length} supprimées (sur ${diff.total})`);

    if (previous && !values["allow-mass"]) {
      const mass = checkMassChange(diff, next, maxRatio);
      if (mass.suspicious) {
        console.error(`Arrêt : ${mass.reason}\nRelancer avec --allow-mass après une vraie refonte.`);
        return 2;
      }
    }

    const urls = [...diff.added, ...diff.changed, ...diff.removed];
    const result = await submitUrls(urls, submitOptions);
    report(result);
    // L'état n'avance que si tout est parti : sinon le prochain passage retentera.
    if (result.ok && !result.dryRun) await writeState(values.state, values.sitemap, next);
    return result.ok ? 0 : 1;
  }

  console.error(`Commande inconnue : ${command}\n\n${HELP}`);
  return 1;
}

// exitCode plutôt que process.exit() : laisse stdout se vider quand il est redirigé.
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: Error) => {
    console.error(`indexnow-kit : ${error.message}`);
    process.exitCode = 1;
  },
);

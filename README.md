# indexnow-kit

IndexNow pour un site **Next.js (App Router) hébergé sur Vercel**, DNS chez Cloudflare.
Pourquoi ces choix : voir [`2026-11-13-audit-indexnow.md`](./2026-11-13-audit-indexnow.md).

Trois déclencheurs complémentaires :

| Cas | Déclencheur | Outil |
|---|---|---|
| Contenu publié sans redéploiement (CMS headless, back-office) | webhook / Server Action, juste après `revalidatePath` | `notifyIndexNow()` dans `after()` |
| Pages ajoutées, modifiées ou supprimées par un déploiement | GitHub Action `deployment_status` réussi | `indexnow-kit sync` (diff de sitemap) |
| Contrôle | CI ou à la main | `indexnow-kit verify` |

Cloudflare n'intervient pas : en DNS only (nuage gris, recommandé avec Vercel), Crawler Hints ne voit aucun trafic.

## Installation (5 minutes)

```sh
bun add github:bastienallain/indexnow-kit#<sha>   # ou bun add indexnow-kit une fois publié
bunx indexnow-kit init                 # crée public/<clé>.txt et affiche INDEXNOW_KEY
```

1. Commiter `public/<clé>.txt`.
2. Dans Vercel → Settings → Environment Variables (Production) : `INDEXNOW_KEY=<clé>` et, si le domaine de prod n'est pas le premier domaine du projet, `INDEXNOW_HOST=www.example.com`.
3. Si un `middleware.ts` / `proxy.ts` existe, exclure les `.txt` du matcher :
   ```ts
   export const config = { matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.txt$).*)"] };
   ```
4. Déployer, puis : `INDEXNOW_KEY=… INDEXNOW_HOST=… bunx indexnow-kit verify`.

## Contenu dynamique : `notifyIndexNow`

```ts
// app/api/revalidate/route.ts
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { notifyIndexNow } from "indexnow-kit";

export async function POST(request: Request) {
  // … vérifier la signature du webhook du CMS …
  const { slug } = await request.json();
  revalidatePath(`/blog/${slug}`);
  after(() => notifyIndexNow([`/blog/${slug}`, "/blog"]));
  return Response.json({ revalidated: true });
}
```

Même chose dans une Server Action (`"use server"`). `notifyIndexNow` ne lève jamais d'exception : il journalise. Hors `VERCEL_ENV=production`, il fait un dry-run.

## Déploiements : GitHub Action

Copier [`templates/indexnow.yml`](./templates/indexnow.yml) dans `.github/workflows/`, définir `INDEXNOW_KEY` et `INDEXNOW_HOST` dans les variables du dépôt. Le workflow utilise la version d'`indexnow-kit` figée par le lockfile du site (jamais un `bunx` non épinglé, qui exécuterait n'importe quel paquet portant ce nom avec la clé dans l'environnement).

- Déclencheurs : déploiement Vercel de production réussi, un passage quotidien (rattrapage + maintien du cache d'état, que GitHub évince après 7 jours sans accès), et un lancement manuel avec l'option `allow_mass`.
- `actions/cache` refuse l'événement `deployment_status` (pas de `GITHUB_REF`) : le job `relay` relance donc le workflow en `workflow_dispatch` sur la branche par défaut, où l'état se restaure et se sauvegarde. Constaté sur un vrai run le 2026-11-13.
- Nom d'environnement : le filtre accepte tout ce qui commence par `Production` (à confirmer dans l'onglet Deployments du dépôt).

- Premier passage : mémorise le sitemap sans rien soumettre (la FAQ IndexNow déconseille la rétro-soumission). `--initial` pour forcer.
- Ensuite : soumet ajouts, modifications de `lastmod` et suppressions.
- Arrêt (code 2) si la réponse n'est pas un sitemap, si le sitemap est vide, ou si plus de 50 % des URL changent d'un coup (cas typique : `lastModified: new Date()` dans `app/sitemap.ts`). `--allow-mass` après une vraie refonte.

`lastModified` doit être la **vraie** date de modification du contenu, sinon le diff n'a pas de sens.

## Variables

| Variable | Rôle |
|---|---|
| `INDEXNOW_KEY` | obligatoire, 8–128 caractères `[a-zA-Z0-9-]` |
| `INDEXNOW_HOST` | host canonique ; défaut `VERCEL_PROJECT_PRODUCTION_URL` ; `*.vercel.app` refusé |
| `INDEXNOW_ENABLED` | `true` pour envoyer hors Vercel production (GitHub Action) ; `false` coupe tout |
| `INDEXNOW_KEY_LOCATION` | seulement si la clé n'est pas à la racine (restreint la portée) |
| `INDEXNOW_ENDPOINT` | défaut `https://api.indexnow.org/indexnow` (partagé avec tous les moteurs) |

## Pièges vérifiés par `verify`

Redirection (middleware i18n), 401/403 (Deployment Protection « All Deployments », WAF, challenge), HTML à la place de la clé (rewrite catch-all), mauvais Content-Type.

## Limites connues

- Installation depuis GitHub : `dist/` est commité (bun et pnpm bloquent les scripts d'installation des dépendances). Après toute modification de `src/`, lancer `bun run build` et commiter `dist/` ; la CI le vérifie.
- Toute URL écartée (host différent, par exemple www contre apex) fait échouer `submit`/`sync` : c'est voulu, l'état n'avance pas tant que le host n'est pas corrigé.

## Développement

```sh
bun test && bun check && bun run build
```

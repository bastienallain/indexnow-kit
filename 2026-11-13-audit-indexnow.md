# Audit IndexNow — Cloudflare DNS + Vercel + Next.js (2026-11-13)

Légende : **V** = vérifié (source primaire lue le 2026-11-13, lien) · **C** = cru (déduction, source tierce ou non lu).

## 1. Le protocole (ce qui contraint le code)

| Fait | Statut |
|---|---|
| Un seul POST à `https://api.indexnow.org/indexnow` est partagé avec Bing, Yandex, Naver, Seznam, Yep, Amazonbot | V [faq](https://www.indexnow.org/faq) |
| Google ne figure pas parmi les participants | V (absent de la liste) ; « n'y participe pas » = C |
| Clé : 8–128 caractères `[a-zA-Z0-9-]`, fichier UTF-8 `/{key}.txt` contenant seulement la clé | V [documentation](https://www.indexnow.org/documentation) |
| Un `keyLocation` hors racine restreint les URL couvertes à son dossier | V documentation |
| Fichier de clé accessible « without login, firewall, or IP restrictions » | V faq |
| POST : 10 000 URL max, toutes du même host (sinon 422) ; chaque sous-domaine = host distinct | V |
| www vs apex = deux hosts distincts | C (par analogie avec les sous-domaines) |
| 200 reçu · 202 reçu, validation de clé en attente · 400 format · 403 clé invalide · 422 host/clé · 429 trop de requêtes | V documentation |
| Ne soumettre que les URL changées ; attendre ≥ 5 min avant de resoumettre une URL (≥ 10 min après un 429, respecter `Retry-After`) | V faq |
| Soumettre aussi les URL supprimées (404/410) et redirigées | V faq |
| Pas de rétro-soumission d'anciens changements : le sitemap + `lastmod` s'en charge | V faq |
| Un 202 n'est pas une preuve : la clé est validée plus tard, l'échec est silencieux | C (source : [instantindexnow.com](https://instantindexnow.com/indexnow/nextjs), site commercial) ; cohérent avec la doc (202 = « validation pending ») |

## 2. Cloudflare : utile ou non ?

- **Crawler Hints** soumet à IndexNow sur un **cache MISS** Cloudflare — V [doc](https://developers.cloudflare.com/cache/advanced-configuration/crawler-hints/). Aucun log, aucun contrôle de la clé (rien de documenté).
- Avec Vercel, le DNS Cloudflare doit rester **DNS only (nuage gris)** : proxy déconseillé par Vercel, Bot Protection inactif derrière un proxy — C (page KB Vercel lue seulement via résumé de recherche) ; doc reverse-proxy V partiel [vercel.com/docs/security/reverse-proxy](https://vercel.com/docs/security/reverse-proxy).
- En nuage gris, aucun trafic ne passe par Cloudflare → **Crawler Hints inopérant** — C (déduction solide, pas écrit par Cloudflare).
- Si un domaine est malgré tout en orange : désactiver Crawler Hints (sinon deux sources de soumission) et exclure `/{key}.txt` de tout challenge WAF.

**Conclusion : Cloudflare ne joue aucun rôle dans l'automatisation.** Tout se fait côté Vercel / Next.js.

## 3. Vercel : quels déclencheurs existent vraiment

| Déclencheur | Moment | Plan | Statut |
|---|---|---|---|
| Deploy Hook | **lance** un déploiement (ce n'est pas un post-deploy) | tous | V [doc](https://vercel.com/docs/deploy-hooks) |
| Webhook `deployment.succeeded` | après mise en ligne, signé `x-vercel-signature` (HMAC-SHA1) | **Pro / Enterprise** | V [doc](https://vercel.com/docs/webhooks) |
| GitHub Action sur `deployment_status` = success | après mise en ligne | tous | C (événement GitHub standard, doc GitHub non relue ici) |
| Vercel Cron | Hobby 1×/jour (±59 min), Pro 1×/minute | tous | V [doc](https://vercel.com/docs/schedules/cron-jobs/usage-and-pricing) |
| Soumission pendant `next build` / `postbuild` | **avant** mise en ligne → le moteur voit l'ancienne version ou un 404 | — | à proscrire |

Variables : `VERCEL_ENV` et `VERCEL_PROJECT_PRODUCTION_URL` existent au build et au runtime ; `VERCEL_GIT_PREVIOUS_SHA` n'existe qu'au build et seulement avec un Ignored Build Step → inutilisable pour un diff — V [doc](https://vercel.com/docs/environment-variables/system-environment-variables).

Bloqueurs : Deployment Protection en mode « All Deployments » renvoie 401 sur la prod — V [doc](https://vercel.com/docs/deployment-protection). Bot Protection : Off par défaut, comportement envers Bingbot non lu.

## 4. Next.js

- `public/{key}.txt` est servi à la racine : solution retenue. Un segment `app/[key].txt/route.ts` n'est pas documenté (C : ne marche pas).
- `after()` de `next/server` : stable depuis 15.1, utilisable dans Route Handlers et Server Functions, repose sur `waitUntil` sur Vercel — V [doc](https://nextjs.org/docs/app/api-reference/functions/after).
- `app/sitemap.ts` expose `lastModified` — V [doc](https://nextjs.org/docs/app/api-reference/file-conventions/metadata/sitemap).
- Pièges (source tierce, C) : `middleware`/`proxy` i18n qui redirige `/{key}.txt`, `rewrites()` catch-all, host `*.vercel.app` soumis au lieu du domaine canonique.
- Piège ajouté (C, constat fréquent) : `lastModified: new Date()` dans `sitemap.ts` → toutes les URL « changent » à chaque déploiement → soumission massive = abus. Le diff doit détecter ce cas et refuser.

## 5. L'existant (npm, GitHub Actions)

- Aucun paquet Next.js + IndexNow établi : le plus avancé, `nextjs-indexnow`, a 37 téléchargements/semaine et 0 étoile ; il soumet au `postbuild` (trop tôt, cf. §3).
- `bojieyang/indexnow-action` (65 étoiles) filtre par fenêtre de `lastmod` → rate les suppressions.
- `JannikWempe/indexnow-submit-action` : diff par état persistant (bonne idée, 0 étoile).
- Aucun ne couvre le cas « CMS headless → webhook → soumission immédiate ».

## 6. Recommandation

Un **paquet unique, sans dépendance réseau tierce**, avec trois déclencheurs complémentaires (hybride) :

1. **Événement** (contenu CMS ou Server Action) : `notifyIndexNow(urls)` appelé dans `after()` juste après `revalidatePath/Tag`. Couvre le contenu publié sans redéploiement. Soumission immédiate et ciblée.
2. **Déploiement** : CLI `indexnow sync --sitemap <url>` lancée **après** mise en ligne (GitHub Action `deployment_status`, tous plans), qui diffe le sitemap avec un état mémorisé (cache GitHub Actions) : URL ajoutées, modifiées (`lastmod`) et supprimées. Refuse si > X % des URL changent sans raison (garde-fou `lastModified: new Date()`).
3. **Vérification** : `indexnow verify` (fichier de clé joignable sans redirection, corps exact, pas de 401/403), à lancer en CI et une fois à l'installation.

Garde-fous communs : `VERCEL_ENV === 'production'` obligatoire, host canonique forcé (jamais `*.vercel.app`), lots de 10 000, respect de `Retry-After` sur 429, dry-run par défaut hors prod.

Webhook Vercel `deployment.succeeded` : option pour les comptes Pro, mais il faut alors un stockage d'état (KV) côté app. La GitHub Action reste plus simple et marche sur Hobby.

**npm** : publier en public est possible (nom `indexnow-kit` libre au 2026-11-13, V `npm view` → 404). Commencer par une installation depuis le dépôt Git, publier quand le paquet a tourné sur un vrai site.

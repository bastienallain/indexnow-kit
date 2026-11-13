# indexnow-kit

Paquet IndexNow pour Next.js sur Vercel. Contexte et sources : `2026-11-13-audit-indexnow.md`.

- Le code publié tourne sous **Node** (Next.js/Vercel) : uniquement `fetch`, Web Crypto, `node:*`. Pas d'API `Bun.*` dans `src/` (hors tests).
- Bun sert d'outil : `bun test`, `bun check`, `bun run build` (bundle `bun build` + déclarations `tsc -p tsconfig.build.json`).
- Seule dépendance runtime : zod (validation de la config, règle globale).
- Ne jamais soumettre pendant le build : uniquement après mise en ligne (GitHub Action `deployment_status`) ou dans `after()`.
- `dist/` est généré : ne pas l'éditer.
- Tester le réseau réel sous sandbox : `NODE_USE_ENV_PROXY=1` (sinon `fetch failed`).

# GameTracker frontend

The SPA: React 18 + React Router 6, built with Vite 5, served in production by nginx from
`frontend/Dockerfile` (multi-stage — Node builds, `nginxinc/nginx-unprivileged:alpine` serves).

This file used to be the unmodified `create-vite` template text, which said nothing about this
application and recommended migrating to TypeScript.

## Running it

```bash
npm ci
npm run dev      # :5173, proxies /api to http://localhost:3000
npm run lint
npm run build    # emits dist/ — this is also the typecheck gate in CI
```

Override the backend the dev server proxies to with `VITE_API_PROXY_TARGET`. In every other
environment the API base is `window.location.origin + '/api'`: the SPA and the API are same-origin,
because the nginx that serves this also proxies `/api` to the backend.

## Layout

| Path | |
|---|---|
| `src/App.jsx` | Every page and view, plus the router. One large component by convention, not by accident |
| `src/App.css` | The whole theme — glassmorphism dark, six accent presets |
| `src/GameDetailModal.jsx` | Game detail overlay |
| `src/StatsPage.jsx` | Statistics, with hand-rolled CSS/SVG charts |
| `src/ApiDocsPage.jsx` | API Reference — Swagger UI over the live v2 contract |
| `src/ApiTokensSection.jsx` | My Account → API Tokens |
| `src/dateUtils.js` | Local-day bucketing, shared so two pages cannot disagree about which day an instant belongs to |
| `src/contexts/ToastContext.jsx` | Global toasts |
| `SharedLibrary.jsx` | The shared-library page. Note it sits **outside** `src/` |

## Two things that will bite you

**The accent presets mutate `--color-accent` at runtime.** Everything downstream derives from it
through `color-mix`. CSS and SVG inherit that for free; a canvas chart cannot, which is why the
charts on the statistics page are hand-rolled rather than pulled from a library.

**A failed fetch must never render as empty.** An empty library and a library that failed to load
look identical if you render the empty state on error — that shipped once, and a user reported
that their games had been deleted. Error states render the error and nothing else: no zeroed
counters, no empty axes.

See `CLAUDE.md` at the repository root for the full architecture, and the mandatory UI/UX review
that frontend changes go through.

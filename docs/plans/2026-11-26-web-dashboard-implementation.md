# Implementation plan — local web dashboard

- Date: 2026-11-26
- Design of record: `docs/superpowers/specs/2026-11-26-local-web-dashboard-design.md`
- Rules: plain-ESM JavaScript, no framework and no build step. Loopback
  only. Every API response is an allow-list projection. The compaction
  plugin is not required (its facts arrive through pinned advisory
  records). Scope is a filter over existing state, never new persistence.

Each task ends with the listed verification. Commits are conventional, one
per task or small group, described with `jj describe -m`; `main` is pushed
at milestones.

## M1 — JSON builders (pure)

- **T1.1** `packages/router/src/web-data.js`: `buildSummary`, `buildModels`,
  `buildPlans`, `buildTrends`, `buildDecisions` as pure functions over
  state fixtures (turns, decisions, pin, billing, pool entries, now).
  Prices come from the shared modules (`resolveBillings`, `unitPrice`,
  `tierAt`); per-turn spend prices the turn's exact buckets at the model's
  resolved rates. Tests first: each endpoint's contract shape.
- **T1.2** Scope filtering: the same fixture measured under
  `scope=session` (a given session hash) and `scope=all` must produce the
  filtered and unfiltered aggregates. Tests.
- **T1.3** Allow-list projection: one projection function feeds every
  builder. A test passes state records shaped with sensitive fields
  (`promptText`, tool output, `apiKey`, `token`) and asserts none can
  appear anywhere in any response.
- **T1.4** Plans card data: burn per plan via `creditsFromTurns` +
  `projectBurn`, account-wide in both scopes; unpriced plans carry no burn
  and carry their `allowanceNote`. Tests.

## M2 — Server and command

- **T2.1** `packages/router/src/web.js`: `node:http` server bound to
  `127.0.0.1`, `startWebServer({ config, ... })` → `{ url, close }`; busy
  port falls back to an ephemeral port and the URL reports it. Serves
  `/api/*.json` from the M1 builders and the M3 static assets. Loopback
  smoke test on an ephemeral port: fetch each endpoint and `/`.
- **T2.2** Failure handling: a throwing builder returns `503` JSON and
  never throws into the plugin. Test.
- **T2.3** TUI: `/router web` starts and prints the URL, `/router web
  stop` stops, `/router web` twice reports the running server. Menu entry
  and help line. TUI tests.
- **T2.4** Config: `web: { port: 7410 }` default in
  `packages/shared/src/config.js`, documented in `docs/configuration.md`.
  Plugin teardown closes the server when the host offers a dispose hook.

## M3 — The page

- **T3.1** Static assets in `packages/router/web/`: `index.html`,
  `style.css`, `app.js`. ChatGPT-style shell (clean column, system fonts,
  dark/light), sections verdict-first per the spec: header with scope
  switcher (This session / Everything), spend by model with unit price and
  basis, plan burn cards, compaction economics, trend sparklines (inline
  SVG). `fetch` polling ~10s. `package.json` `files` ships `web/`.
- **T3.2** Asset tests: `/` serves the page; the tarball includes the
  assets.
- **T3.3** Manual polish against the spec's page section, run locally on
  real data.

## M4 — Milestone

- Changelog entries (router: server and page; shared: `web` config
  default), `bun test`, `bun run test:rust`, `bun run check`, describe,
  push `main`, CI green. Release happens with the next version bump by the
  usual staged flow.

## Risks

- Plugin dispose hooks vary by host: if teardown is unavailable the server
  lives until the host exits; `/router web stop` is the documented control.
- `turns.jsonl` is already size-capped by the state module, so trend
  aggregation has a bounded input.

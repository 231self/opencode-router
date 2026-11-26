# Local web dashboard — design spec

Status: approved design, pending written review.
Date: 2026-11-26.
Related: `docs/ideas/2026-11-26-usage-tracking-and-cost-comparison.md` (the
future commercial recommender), `docs/data-sources.md` (every number's
provenance).

## Goal

A dashboard served from inside the router plugin on localhost, showing what
the plugins already compute — spend, unit prices, plan burn, compaction
economics, routing decisions — in a clean ChatGPT-style web page. Two
scopes: **the session it was launched from** and **everything the host has
ever run** (all sessions in the state dir).

## Non-goals

No chat. No control surface (no click-to-act on policy, pins, or
compaction). No remote binding, no auth, no aggregation upload. The
commercial recommender is a later product; this dashboard's only nod to it
is that its JSON API is the contract that service would consume.

## Shape

In-plugin server (approach B from the design discussion). The router plugin
hosts it because it owns the CLI and TUI surface; compaction facts reach it
through the persisted advisory records in pins, so the compaction plugin
does not need to be installed. Missing data means missing cards, never
invented numbers.

## Architecture

- `packages/router/src/web.js`: a `node:http` server bound to `127.0.0.1`
  only. Started on demand by `/router web` (prints the URL); `/router web
  stop` stops it. Never started at plugin load.
- Port: `web.port` in config, default `7410`. If the port is busy, bind an
  ephemeral port and report the actual URL.
- Data flows through the existing shared modules only: `readTurns`,
  `readDecisions`, `readPin`, `resolveBillings`, `creditsFromTurns`,
  `projectBurn`, `resolvePool`, `unitPrice`, `measureMix`. The web layer
  computes nothing the sidebars do not already compute.
- The plugin's turn path is untouched. The server is closed on plugin
  teardown when the host provides a dispose hook.

## Scopes: this session, and all sessions

- **`scope=session`** — the session the dashboard was launched from. The
  session hash is captured at launch and fixed for the life of the page.
  Turns, decisions, context growth, and unit-price mixes are filtered to
  that session.
- **`scope=all`** (default) — every session in the state dir: the entire
  server's history.
- Plan burn is account-wide and identical in both scopes; the card says so
  rather than implying a per-session allowance.
- The header always names the launching session (hash, model, start time)
  regardless of scope.

The turn log and decision log already record `session`, so scope is a
filter over existing records — no new persistence.

## API

All endpoints are `GET`, same-origin, JSON. Every response is an
**allow-list projection**: counts, sizes, prices, labels, and identifiers
only. Prompt text, tool output, and credentials cannot appear in any
response even if the underlying state records carry them.

- `/api/summary.json?scope=all|session` — headline verdict/decision line,
  totals (turns, tokens, spend — tokens priced at the resolved rates), the
  headline model's unit price record (the session's current model under
  `scope=session`; the highest-spend model under `scope=all`), compaction
  economics (break-even, cost to compact, per-turn savings).
- `/api/models.json?scope=…` — pool models: `unitPrice` record (with
  `basis` and `measured`), rate card, `costSource`, `local`.
- `/api/plans.json` — records in the billing schema (`type` → `vendor` →
  `plan`), price, allowance note, and burn (`used`, `allowance`,
  `percentUsed`, `projected`, `daysLeft`) where one is computable.
- `/api/trends.json?scope=…&days=30` — per-day aggregates: turns, bucket
  token counts (input, output, cache read, cache write), spend.
- `/api/decisions.json?scope=…&limit=20` — recent decisions: chosen model,
  source, reason, turn class, timestamp.

The record shapes are exactly the shared module outputs (`unitPrice`,
plan records, `projectBurn`), so a future recommender consumes the same
contract.

## The page

One static page (`index.html`, `app.js`, `style.css` bundled in the
package) in the ChatGPT shell style: clean column, system fonts, card
list, dark/light following the system. Vanilla JS `fetch`, polled every
~10s. Inline SVG sparklines — no chart library, no framework, no build
step.

Sections, conclusion first:

1. **Header** — the verdict/decision line (`compact now · pays back in 3
   turns`, `running deepseek-flash · kept for cache`), the launching
   session's identity, and the **scope switcher: This session / Everything**.
2. **Spend by model** — unit price with its basis (`measured mix · 213
   turns`, `reference mix · stand-in`), the rate card beside it.
3. **Plan burn** — one card per plan in `type → vendor → plan` order, each
   with its own bar and reset projection, labelled account-wide.
4. **Compaction economics** — break-even, cost to compact (naming the
   KV-cache invalidation), per-turn savings, horizon verdicts.
5. **Trends** — turns, tokens, spend per day as sparklines, scoped by the
   switcher.

## Privacy and binding

- `127.0.0.1` only. No CORS headers. The wall between this and any future
  hosted service; aggregation export would be a separate, opt-in feature.
- The allow-list projection is enforced in one place (the JSON builders),
  tested against state records that contain sensitive-shaped fields.
- No prompt text, tool output, or credential is ever rendered or returned.

## Error handling

- Every handler is wrapped: a failure returns `503` JSON and never throws
  into the plugin. A failed builder yields a missing card, not a zero.
- Port busy → ephemeral port, URL reported. `/router web` twice reports the
  running server rather than starting a second one.

## Testing

- The JSON builders are pure functions over state fixtures; contract tests
  pin each endpoint's shape.
- An allow-list test feeds state records with prompt-text-shaped fields and
  asserts none can appear in any response.
- One loopback smoke test on an ephemeral `127.0.0.1` port: start, fetch,
  stop. (AGENTS.md's "no network in tests" is read as no external network;
  the loopback test is how the binding rule is pinned.) If the repo owner
  rules otherwise, the smoke test is dropped and handlers are tested
  directly.
- Scope tests: the same fixture measured under `scope=session` and
  `scope=all` must produce the filtered and unfiltered aggregates.

## Future (out of scope)

The commercial recommender consumes `/api/*.json` (or the same shapes
submitted by opt-in aggregation) and answers "which model / which plan
should you buy" against the market. The dashboard's data contract is
already that service's contract.

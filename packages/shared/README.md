# @231self/opencode-shared

Shared runtime for
[`@231self/opencode-router`](https://www.npmjs.com/package/@231self/opencode-router)
and `@231self/opencode-compaction`. Plain ESM, no npm dependencies.

- `cost.js` — normalises every cost shape seen in the wild (OpenCode V2
  catalog, models.dev, V2 client) into per-million-token tier prices
  (`normaliseCost`, `tiersOf`, `mergeCost`, `costSource`) and models a turn's
  cost with a measured cache-hit share (`modelledTurnCost`). The economics
  model adds `contextDebt` (the per-turn carrying cost of the accumulated
  context and the projected cost of the next N turns) and `compactionRoi`
  (per-turn savings, the one-time cache-invalidation premium, break-even
  turns). Missing prices stay `undefined` so displays say "unknown" instead
  of inventing `$0`.
- `price-table.js` — the read side of the public price table (models.dev,
  LiteLLM), shared so both plugins see one cached table instead of the
  compaction falling back to a host catalog it has no reason to trust. The
  router owns fetching and refreshing; anyone may read.
- `cost-resolution.js` — which prices apply to a model, decided once. The
  precedence is a configured plan (the user's own bill), then a public price
  table, then the model's own catalog entry, then a sibling catalog entry,
  then nothing. The catalog sits below the public table on purpose: it is the
  host's own opinion of a price and is not always right, where a published
  rate is checkable. `resolveCost` returns the tiers and an `ownBill` flag
  that turns on one test — does the user pay per token here — so a stand-in
  for a flat pool informs a report and never vetoes. Both plugins call this
  rather than each writing the precedence, which had already drifted between
  them. `priceSourceLabel` words the "priced at" line from the same result.
- `tokens.js` — token estimation (`estimateTokens`, `partTokens`,
  `countContextTokens`), V2 active-context measurement
  (`measureSessionContext`, including `type: "compaction"` checkpoints), and
  `cacheHitShare`: the observed cache-read share of a turn's prompt, with the
  denominator `input + cache.read + cache.write` verified against recorded
  provider costs.
- `plan.js` — plan billing facts and the shadow prices they imply. The
  built-in catalog of published plan tiers (Xiaomi MiMo Token Plan, ChatGPT
  plans) carries each number's source and check date; `planTiers` turns
  credits into the same per-million-token shape `cost.js` takes, so the
  economics helpers work on plan prices unchanged. `creditCost`,
  `creditsFromTurns`, and `cacheExpiryCredits` price usage and cache expiry in
  credits; `projectBurn` projects allowance burn from measured usage. Missing
  numbers stay missing: no weights means "unknown", never `$0`, and a plan
  whose allowance the vendor never published is marked `unpriced`, so no
  helper returns a number for it. `billing` may hold several plans at once:
  `resolveBillings` returns every one, `planForModel` attributes a model to
  the plan covering it, `withPlan` appends without losing what is recorded,
  and `creditsFromTurns` reports `byPlan` — one share per plan — so a display
  shows which allowance is running out rather than a blended figure.
  `plan-wizard.js` is the first-init setup flow over an injected dialog
  adapter, so both TUI parts can run it and tests can script it.
  `plan-feed.js` reads plan prices from a public tracker feed (LimitDex JSON):
  a price, the vendor's exact limit wording, and a check date. It copies a
  price and can never supply an allowance that does not exist, and a failed
  fetch is a short reason rather than an exception.
  `plan-catalog.js` layers a user file over the built-in plan catalog, so a
  plan can be added or corrected at `~/.config/omlx-router/plans.json`
  without waiting for a release. The file is the same shape as the built-in
  set, so moving the catalog to a shared public file later is a copy.
- A plan that publishes a dollar budget rather than a token count (GitHub
  Copilot: $10/mo for $15 of API credits) is priced against the model's own
  list price. The budget buys `allowanceUsd / listPrice` tokens, so the
  shadow price is that list price scaled by `priceUsd / allowanceUsd` — a
  grounded discount factor, not a guess. No list price, no source for N, and
  no price is computed. The factor is what you get **at full use of the
  budget**; spend less and your effective price per token is worse.
- Plans differ in how well their allowance is published, and the display says
  which is which. A **published token quota** (Bolt: 10M tokens/month) gives
  an exact shadow price with no derivation. A **dollar budget** (Copilot,
  Replit) gives one derived from the model's list price. A **usage window**
  (Claude, Cursor, ChatGPT) publishes no token count at all, so no price is
  computed — the plan is recorded and shown, and nothing is invented for it.
- `sidebar.js` — sidebar block registration for TUI hosts. The renderable
  layer loads the host's OpenTUI core lazily and is skipped where there is
  none, so the package keeps zero external dependencies and non-TUI hosts
  are unaffected. A block is one text renderable holding `compute()`'s
  lines, refreshed on the host's own events.
- `config.js` / `state.js` — the host adapters both plugins share: the
  `OMLX_ROUTER_*` env vars, the config file schema (including the `{env:}`
  placeholder handling), and the `~/.local/state/omlx-router/` state paths
  (pins, decisions, turns). One source of truth for the security-sensitive
  parsing and schema.
- `judge-client.js` — the oMLX judge client: model discovery, JSON-only chat
  with one repair round, an LRU cache, and timeouts. Each plugin supplies its
  own system message and validates its own verdict shape. `refs.js` holds
  model-reference equality, `kilo.js` is the Kilo host shim, and `format.js`
  is the labelled popup layout shared by the router TUI, the CLI, and Kilo.

Part of the [opencode-router](https://github.com/231self/opencode-router)
monorepo. Apache-2.0.

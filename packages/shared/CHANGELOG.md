# Changelog

## Unreleased

### Added

- `web.port` config default (`7410`) for the router's local dashboard.

### Fixed

- `creditsFromTurns` keeps record identity when given already-resolved
  records, and the plan-burn call sites now pass them. Matching burn
  buckets to records by `===` across separate resolutions never matched, so
  every plan's burn row counted 0 credits used.

## 0.3.0 — 2026-11-26

### Added

- `unit-price.js`: the unit price of a model — what 1M tokens of a typical
  turn cost the user on it. The resolved rate card (plan rates first, then
  the public price list) blended with the token mix of the user's own turn
  log (`measureMix`: uncached input, cache reads, cache writes, output).
  A model with no turns falls back to a published reference blend — 7 : 2 : 1
  cache hits : input : output (Artificial Analysis, via aicost.tools'
  blended-rate glossary, checked 2026-11-26) — labelled `reference mix ·
  stand-in`, which informs but never vetoes.
- Billing schema `type` → `vendor` → `plan`: records carry `type`
  (subscription or payg), `vendor`, and one of the vendor's `plans`. `tier`
  remains as the legacy name for `plan` and resolves identically; a user's
  `plans.json` may key the table `plans` or `tiers`. Payg is a type with no
  vendor and no plan, and `payg: true` still reads as its marker.

### Fixed

- A ChatGPT plan no longer displays as if nothing is consumed. Plus carries
  a weekly allowance beside its 5-hour window (whichever runs out first
  stops you); Pro consumes a weekly Work/Codex allowance with no five-hour
  limit; Go a monthly one. Where the vendor publishes no size — "does not
  correspond to a fixed number of messages or tasks" — the plan stays
  unpriced and names the allowance that is consumed instead of implying
  there is none. Cursor and Claude say the same in their own terms.

## 0.2.0 — 2026-11-24

### Added

- `plan.js` holds several plans at once. `billing` may be a list; `resolveBillings`
  returns every plan, `planForModel` attributes a model to the plan covering it,
  and `withPlan` appends without losing what is recorded. `weightsFor`,
  `planTiers`, `creditCost`, and `cacheExpiryCredits` price each model at its own
  plan. `creditsFromTurns` reports `byPlan`, one share per plan, so a display
  shows which allowance is the one running out instead of a blended figure.
- `plan.js` — plan billing facts and the shadow prices they imply. The
  built-in catalog of published Xiaomi MiMo Token Plan tiers carries each
  number's source and check date. `planTiers` turns credits into the same
  per-million-token shape `cost.js` takes, so every economics helper works on
  plan prices unchanged. `creditCost`, `creditsFromTurns`, and
  `cacheExpiryCredits` price usage and cache expiry in credits;
  `projectBurn` projects allowance burn from measured usage. Missing numbers
  stay missing: no weights means "unknown", never `$0`.
- `plan-wizard.js` — the first-init plan setup flow over an injected dialog
  adapter, so both TUI parts can run it and tests can script it. A back-out
  saves nothing; "pay per token" and "skip" are recorded so the question
  never repeats.
- `plan-feed.js` — plan prices from a public tracker feed (LimitDex publishes
  its dataset as free JSON, read daily from vendor pages). The feed supplies a
  price, the vendor's exact limit wording, and a check date. It cannot supply
  a token allowance the vendor never published, so `applyPlanFacts` copies a
  price and nothing else, and `fetchLimitDex` never throws: an offline run is
  a short reason the TUI can print.
- Plans without a published allowance are now recorded as `unpriced`: price
  kept, allowance null, `planLabel` says "allowance not published", and every
  credit or burn helper returns null instead of a guessed number. This covers
  usage-window plans such as the ChatGPT ones.
- `cost-resolution.js` — the precedence for whose prices apply to a model,
  moved here from the two plugins that each wrote their own copy and had
  drifted apart. Plan (the user's own bill) beats a public price table beats
  the host catalog beats a sibling entry beats nothing. The catalog sits
  below the public table because it is the host's own opinion of a price and
  is not always right; a published rate is checkable. `resolveCost` carries
  the `ownBill` flag that decides whether money may veto, and
  `priceSourceLabel` words the "priced at" line from its result.
- `price-table.js` — the read side of the public price table (models.dev,
  LiteLLM), so the compaction advisory can price against a published rate
  instead of falling back to the host catalog. The router still fetches and
  refreshes the cache; this only reads it.
- `plan-catalog.js` — a user-editable plan catalog at
  `~/.config/omlx-router/plans.json`, layered over the built-in set. A plan
  can be added or corrected without a release, and the file is the same shape
  as the built-in catalog so a shared public catalog is a copy, not a rewrite.
- A dollar budget is priced, not left unpriced. A plan like GitHub Copilot
  ($10/mo for $15 of API credits) publishes no token count, but one follows
  from the model's own list price: the budget buys `allowanceUsd / listPrice`
  tokens. `planTiers` takes that list price and returns it scaled by
  `priceUsd / allowanceUsd`. The source for N is the model's own published
  price, not a guess.
- `sidebar.js` — sidebar block registration for TUI hosts. The renderable
  layer loads the host's OpenTUI core lazily and is skipped where there is
  none, keeping this package free of external dependencies.

## 0.1.4 — 2026-11-23

### Added

- `referencePrice`, the priced sibling entry for the same model ID. A flat-rate
  pool publishes zeros for a model whose list price lives elsewhere
  (`xiaomi-token-plan-sgp/mimo-v2.6-pro` vs `xiaomi/mimo-v2.6-pro`), so the
  cost comparison can still be computed — labelled with the provider it came
  from, because a sibling's prices are a reference and never the user's bill. A
  `-free` model has no priced sibling and stays honestly unpriced.

## 0.1.3 — 2026-11-23

### Added

- `costState`, the three-way pricing read behind the compaction report:
  `priced` (real numbers), `flat` (the pool publishes explicit zeros), and
  `unknown` (no catalog entry). `xiaomi-token-plan-sgp/mimo-v2.6-pro` is
  `flat`, `openai/gpt-6.2-sol` is `unknown`; they were previously
  indistinguishable.
- `promptPartTokens`, the prompt-visible size of one part.

### Fixed

- The active-context counter no longer counts reasoning and host bookkeeping
  as prompt. `contextMessageTokens` stringified whole messages, so reasoning
  text, `reasoningEncryptedContent`, snapshots, timestamps and the compaction
  message's `metadata.recent` all counted toward the context size. On a real
  500k-token session that read as 496,861 tokens against a billed prefill of
  159,057. `countContextTokens` uses the same prompt-only rule.

## 0.1.2 — 2026-11-23

### Added

- Export `contextMessageTokens`, the per-message V2 active-context counter used
  by the compaction tail estimator. Compaction 0.1.3 imports it; shared 0.1.1
  did not export it, so that pair failed to load.

## 0.1.1 — 2026-11-22

### Added

- `tierAt` resolves the price tier that applies at a token count, so callers
  can price the keep, compacted, summary, and rebuild contexts independently.
- `compactionRoi` accepts `keepCost`, `steadyCost`, `firstTurnCost`,
  `summaryCost`, and `rebuildCost`, letting a caller supply measured costs
  instead of a single flat tier.

### Fixed

- `countContextTokens` counts a completed compaction checkpoint's summary.
  It was previously invisible to the fallback counter and to the optimiser,
  so a compacted context was measured without the text it retained.
- A measured rebuild premium compares input-side costs only; a normal turn's
  output tokens no longer leak into the compaction cost.
- Negative per-turn savings are never reported as `worthIt`, even when a
  one-time credit makes the break-even zero.

## 0.1.0 — 2026-11-22

### Added

- Initial extraction of the shared runtime from `@231self/opencode-router`:
  pricing and measurement (`cost.js`: `normaliseCost`, `tiersOf`, `mergeCost`,
  `costSource`, `modelledTurnCost`; `tokens.js`: `estimateTokens`, `partTokens`,
  `countContextTokens`, `measureSessionContext`, `cacheHitShare` — semantics
  unchanged, with their recorded-cost validation fixtures), and the host
  adapters (`config.js`, `state.js`) covering the `OMLX_ROUTER_*` env vars,
  the config schema with `{env:}` placeholder handling, and the
  `~/.local/state/omlx-router/` state paths.
- The cache-aware economics model: `contextDebt` (per-turn carrying cost of
  the accumulated context and the projected cost of the next N turns) and
  `compactionRoi` (per-turn savings, the one-time cache-invalidation premium,
  break-even turns, `worthIt`) — validated against a recorded turn whose cost
  reconciles exactly to $0.028712 and a recorded compaction-checkpoint
  session.
- The oMLX judge client (`judge-client.js`): model discovery, JSON-only chat
  with one repair round, an LRU cache, timeouts, and offline `extractJson`.
  Both plugins supply their own system message and validate their own verdict
  shape.
- Model-reference helpers (`refs.js`), the Kilo shim (`kilo.js`), and the
  labelled, aligned popup formatter (`format.js`) used by the router TUI, the
  CLI, and Kilo.

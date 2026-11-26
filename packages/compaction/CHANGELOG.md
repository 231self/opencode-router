# Changelog

## Unreleased

### Fixed

- Plan burn rows in `/ctx report` and the sidebar counted 0 credits used:
  the burn buckets matched plan records by object identity across separate
  resolutions, which never matches. They now pass the resolved records and
  show the real burn.

## 0.3.0 — 2026-11-26

### Added

- Unit price in the advisory. The advisory carries the same per-model unit
  price the router weighs (one shared precedence and one shared turn mix),
  `/ctx report` shows it (`unit price · $0.46 per Mtok · measured mix · 213
  turns`), and context growth is priced at it — `+4,000 tokens · ≈ $0.002
  per turn at unit price`, the holding cost in the compact-or-wait trade.
  The sidebar shows `unit $0.46/M · measured mix` (or `stand-in mix`).
- Plan setup asks in the schema's order — payg or subscription, then vendor,
  then the vendor's plan — and records `type`, `vendor`, `plan`.

### Changed

- The plan feed refresh says `size not published by the vendor` rather than
  `not published by the vendor`: the ChatGPT weekly allowance exists and is
  consumed; only its size is unpublished.

## 0.2.0 — 2026-11-24

### Added

- Plan billing. `/ctx plan` sets up the plan facts (price, allowance, credit
  weights) from the built-in catalog of published tiers or by hand, and
  records them in the config with their source and check date. On first load
  with a flat-plan model and no billing recorded the plugin asks once;
  "skip" and "pay per token" are recorded too, so the question never
  repeats.
- Several plans at once. `billing` is now a list; `/ctx plan` adds a plan
  beside the ones on file rather than replacing them. Each plan is attributed
  to the models it covers — the catalog's weight table, or a `models` list —
  so every model is priced at its own plan's rates. The sidebar and
  `/ctx report` show each plan its own burn instead of one blended figure,
  and `/ctx plan refresh` re-reads every tracked plan's price in place.
- `/ctx plan refresh` — re-reads the plan's price from a public tracker feed
  (LimitDex publishes its dataset as free JSON). The command is the only
  path to the network: it runs nothing on a turn, keeps the recorded facts
  when the feed is down, and prints the vendor's own limit wording beside
  the price. For a plan whose token allowance is not published (`ChatGPT
  Plus`, for example) it records the price and says the shadow price cannot
  be computed — it never invents an allowance.
- Plan-aware economics. With a plan recorded, `/ctx report` prices the
  comparison in plan credits at your own rates (`basis plan rate · your own
  credits`), shows the allowance burn (`12.4B of 82.0B credits (15%)`), and
  prices a cache expiry as the credit premium it charges over staying hot
  (`150.0M credits to re-bill (120x hot)`). Plan prices are your own bill,
  so unlike a sibling's list price they may veto a compaction that does not
  pay.
- `/ctx menu` action menu and `/ctx help [command]` command reference, in
  the same shape as `/router`. Bare `/ctx` opens the menu; `/ctx report`
  shows the advisory directly. An unrecognised command points at the help.
- The cost of compacting is named as what it is: the **KV-cache
  invalidation**. Compacting destroys the cache, so the next turn re-prefills
  the whole compacted context at cache-write rates — which run ~120x a cache
  read. That burst is 20x the summary cost in practice, so `/ctx report`
  leads the economics with it and labels it. This is the one-time cost that
  decides whether a compaction pays.
- On a plan the trade is measured **in credits**, the unit the allowance
  burns. The dollar figures are near zero there — a tiny shadow price times a
  big token count — so the invalidation reads as `$0.0172` and looks trivial.
  In credits it is `148.8M`, which is the real cost. `/ctx report` shows both:
  the dollars, and a `plan credits` section with the figure that decides.
  The **verdict** follows the credit figures on a plan, since they are the
  constraint that actually binds; without a plan, dollars decide.
- Sidebar block: window use, plan name, allowance burn and projection,
  cache-expiry exposure. Refreshes on model changes and finished turns.
  Leads with the verdict — `compact now`, `keep working`, or `delegate` —
  then the evidence behind it, since the conclusion is the point of the block.

### Changed

- The decision "whose prices apply to this model" is no longer written here:
  it moved to `@231self/opencode-shared/cost-resolution.js`, which the router
  calls too. The two copies had drifted — this one priced a flat pool at a
  sibling's list price while the router priced it at catalog prices. They
  cannot disagree now, and the `ownBill` flag that decides whether money may
  veto lives beside the precedence instead of being re-derived.
- The advisory now prices against the public price table (models.dev, LiteLLM)
  when one exists, ahead of the host catalog. The catalog is the host's own
  opinion of a price and is not always right; a published rate is checkable,
  so it wins whenever both speak. Without a cached table the advisory reads
  the catalog exactly as before.

## 0.1.6 — 2026-11-23

### Added

- Flat-rate plans get real economics instead of a dead end. A plan pool
  publishes zeros for a model whose list price is in a sibling catalog entry,
  and 0.1.5 answered `worth it no` for it — which made compaction look
  pointless on a plan. `/ctx` now computes the comparison at that list price
  and says so: `priced at list price · xiaomi/mimo-v2.6-pro`, `break-even 1
  turn (at list price)`, `worth it yes · free on your plan`. A `-free` model
  with no priced sibling is still shown as `no reference price · $0 marginal`.
- Capacity in the `context` section: size against the model's limit, headroom
  and percent free. A plan makes cost irrelevant but the window finite, so
  when headroom drops below 15% the closing note says the window is nearly
  full rather than "keep working".
- `/ctx` reports what the host did with the last `/ctx here` request
  (`last /ctx here`, `outcome accepted` or `failed · http 409`).

### Fixed

- `/ctx here` no longer fails silently. The request path swallowed every error
  and skipped the host call without comment when `session.compact` was absent,
  so it could look broken forever with no way to tell which happened. The
  outcome is now recorded and shown; only a status code or an error name is
  persisted, never an error message, which may echo prompt text.
- A `/ctx here` request is also honored at `session.step.ended`, the step
  boundary where the host says an admitted compaction runs, instead of only
  from inside an in-flight request.
- A projection at a sibling's list price never vetoes a structural
  `compact-now`. The veto now applies only to the user's own prices: a
  projection must not block an action whose real marginal cost is zero.
- `1 turn` instead of `1 turns`; no nested parentheses in `summary cost`.
- Depends on `@231self/opencode-shared` `^0.1.4`.

## 0.1.5 — 2026-11-23

### Fixed

- The report no longer prints economics it did not compute. A model with no
  usable prices produced `per turn $0.0000`, `break-even never turns`,
  `worth it no` and `summary cost $0.0000 (estimated)` — placeholders that
  read as results — and silently dropped the `horizons` section. The report
  now distinguishes a flat-rate plan (`flat plan · $0 marginal`, no cost
  savings) from missing data (`no price data · not computed`, `worth it
  unknown`), and always renders the horizons, saying why a row has no number.
- The context size comes from the prompt the provider billed
  (`input + cache.read + cache.write` of the newest request) whenever a
  request has run since the last compaction, and from the message estimate
  otherwise. `/ctx` shows which. A request's billed prefill is the only
  authoritative size; counting messages measures parts the host prunes.
- A prediction is recorded only for a compaction observed as it happens. A
  checkpoint first noticed after a restart or an install used the context as
  it stands now as the "post-compaction" size, which is how a session that had
  grown for two days recorded a 2,352% phantom prediction error. The summary
  size is still learned either way.
- Predicted and actual compacted sizes are on one scale, so a prediction error
  now measures the compacted-size model rather than a unit mismatch.

### Changed

- `/ctx` opens with a `context` section: current size, growth, and the source
  (`billed` or `estimated`).
- `summary cost` and `rebuild` say `modelled` when they are modelled from
  prices. They claimed `estimated` and `modelled` respectively for the same
  situation.
- Depends on `@231self/opencode-shared` `^0.1.3`.

## 0.1.4 — 2026-11-23

### Fixed

- Depend on `@231self/opencode-shared` `^0.1.2`. Version 0.1.3 imported the
  new `contextMessageTokens` export but declared `^0.1.1`, so npm could
  resolve shared 0.1.1, which lacks it, and the plugin failed to load. The
  code is otherwise identical to 0.1.3.

## 0.1.3 — 2026-11-23

### Fixed

- The context hook measures the active session (`ctx.session.context`) instead
  of its local outgoing message segment. In a 233k-token session the plugin
  recorded 7,461 tokens, so `/ctx` reported `not-yet` from the small-context
  branch while the session was under real pressure. The active size now drives
  `lastContextTokens`, growth, checkpoint detection, and the compacted tail.
  `contextMessageTokens` is shared by the active-context counter and the tail
  estimator.

## 0.1.2 — 2026-11-22

### Added

- The advisory prices with the cache hit rate the provider actually reported
  over the last five steps on the current model (`cacheWindow`). An idle gap
  longer than the provider's cache lifetime is treated as a cold cache; the
  defaults are five minutes for Anthropic and OpenAI, and no expiry for
  unknown providers. `pin.cacheHitRatio` remains the fallback until the first
  measurement. `/ctx` shows the rate, source, and sample count.
- `/ctx` shows the same economics at 3, 8, and 15 turns (`horizons`), not just
  at the decision horizon.
- Real compactions calibrate the estimate. The post-compaction context size
  replaces the assumed summary size; the first post-compaction turn's reported
  usage replaces the modelled rebuild cost; the summary request is read from
  the completed checkpoint's own token usage and model when OpenCode supplies
  them, and estimated otherwise. Observations are stored per
  model in `compaction-calibration.json`, and `/ctx` labels each number
  measured, estimated, or modelled.
- Each compaction also records the size the plugin predicted against the size
  the host actually sent. `/ctx` shows the last prediction and the mean
  absolute relative error; `bun run compaction:report` prints the same
  calibration for every model without a live session.

### Fixed

- The summary request's cost now comes from the completed checkpoint's own
  `tokens` and `model`, which OpenCode supplies for manual, automatic, and
  native compactions. Timestamp-based attribution of ordinary model steps is
  gone, so a slow turn can no longer be billed as compaction.
- A compaction checkpoint's summary is counted in the prefill by both the
  fallback token counter and the optimiser, so the compacted size and the
  predicted size use the same definition.
- Rebuild capture pairs by assistant-message id and start time, ignores steps
  that started before the checkpoint, and records the model that actually ran
  the step.
- A delayed advisory re-reads the pin before writing, abandons the write if the
  pin was deleted, and preserves a newer same-model variant, force flag,
  redirect, request marker, or advisory. Overflow compares redirects
  structurally and writes the cleared state in one update.
- Calibration updates take a cross-process lock that fails fast instead of
  stealing another writer's lock. A failed commit does not advance the pin's
  checkpoint, arm rebuild capture, or consume a rebuild sample.
- Checkpoint deduplication lives inside the locked update and in the
  calibration artifact rather than the routing pin, and observation writes
  preserve that metadata.
- The prediction compared at the next compaction is the one stored by the last
  advisory for the same model; opaque or empty checkpoints are counted but
  not used to learn a size or an error.
- Prices are resolved per token count (`tierAt`), including strict `gt`
  thresholds and partial overrides. Measured summary and rebuild samples are
  priced at each observation's own prefill and averaged as dollars, not at the
  mean prefill. An explicit zero cache-write price is no longer replaced.
- Cache samples ignore zero-prefill steps and mixed-model turn-log seeds before
  choosing between live and persisted data, and the window is bounded by the
  live ring.
- The economics veto runs after the guard, so a held `compact-now` cannot
  survive an unprofitable estimate. Horizons use net payback for `worth it`.
- The usage stream's debug path logs a fixed message instead of stringifying
  an exception that may carry prompt text.
- The `/ctx` popup test enforces 72 columns, and an unknown command is clipped
  before it reaches the popup.

## 0.1.1 — 2026-11-22

### Fixed

- The TUI command is `/ctx` only. OpenCode already owns `/compact`, so the
  plugin's slash command — and its `ctx` alias — duplicated or shadowed the
  native command. `/ctx` shows the advisory; `/ctx here` asks the host to
  compact. The popup copy now says what will happen instead of describing the
  hook machinery.

## 0.1.0 — 2026-11-22

### Added

- Initial release. The context optimiser moves out of `@231self/opencode-router`
  (which becomes pure model selection): the `optimise` WASM core with its
  explicit ABI (`alloc`, `dealloc`, `optimise`, `result_len`, `abi_version`),
  the request builder and in-place plan application, the V2 `context` hook
  (optimise + pin measurement), and the Kilo
  `experimental.chat.messages.transform` path.
- The compaction advisory. Each turn produces one of `compact-now`, `delegate`,
  or `not-yet` from three layers: deterministic trajectory signals (a tool
  burst followed by synthesis is a sub-task boundary), the cache economics
  from `@231self/opencode-shared` (break-even turns and a veto when compaction
  does not pay within the horizon), and a small local judge that refines only
  uncertain candidates. A failed judge call leaves the deterministic verdict
  standing.
- Anti-oscillation: a verdict change waits out a cooldown that grows with the
  judge's measured instability, stored by
  `bun run compaction:calibrate --repeat n` in
  `~/.local/state/omlx-router/compaction-noise.json`.
- `/compact` (alias `/ctx`) shows the current verdict with its numbers, and
  `/compact here` asks the host to compact the session; the request clears
  itself even if the host refuses.

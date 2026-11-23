# Changelog

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

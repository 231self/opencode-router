# Changelog

## Unreleased

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
  usage replaces the modelled rebuild cost; the summary request is measured
  when an explicit `/ctx here` marks its boundary. Observations are stored per
  model in `compaction-calibration.json`, and `/ctx` labels each number
  measured, estimated, or modelled.
- Each compaction also records the size the plugin predicted against the size
  the host actually sent. `/ctx` shows the last prediction and the mean
  absolute error; `bun run compaction:report` prints the same calibration for
  every model without a live session.

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

# Changelog

## Unreleased

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

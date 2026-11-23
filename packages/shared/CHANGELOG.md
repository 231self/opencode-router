# Changelog

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

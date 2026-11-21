# Compaction economics and monorepo restructure — design spec

Date: 2026-11-21
Status: design approved in brainstorming; awaiting spec review
Covers: compaction research sub-projects #1–#4 (cost model, per-pin tolerance,
context-debt routing, structure-aware trigger) delivered as a new plugin package

## 1. Background

Two recent papers make context compaction a first-class cost and performance
lever:

- **NVIDIA, "You don't need long context"** (arXiv:2611.05306, Nov 2026).
  Later tokens cost up to 7× more to generate than earlier ones (256K vs 16K
  context-window serving on H100s). Frequent compaction (thresholds 48K/36K
  down to 16K/12K) holds task accuracy within −3.7…+5.6 ppts across 13
  long-horizon and long-input benchmarks while cutting estimated cost 2.2×–8.8×.
  Single-action compaction (one action per context, compact semantic state
  between) nearly preserves accuracy but degrades models unevenly (Claude
  Opus 4.5 flat, GPT 5.6 Sol −2.0…−3.3 ppts) — compaction tolerance is a
  model property.
- **JHU + Google DeepMind, "Self-Compacting Language Model Agents"**
  (SelfCompact, arXiv:2606.23525, Jun 2026). Fixed token-threshold triggers
  ignore trajectory structure and discard partial results mid-derivation. A
  compaction tool plus a lightweight rubric (fire when a sub-task resolved or
  the trajectory converges; suppress mid-derivation or when stuck) matches or
  beats fixed-interval summarization at 30–70% lower per-question cost.
  Unprompted models cannot tell when their context is rotting; the rubric
  closes that gap without training.

Neither paper prices compaction under **cache-billed serving**. Growing context
is largely re-served from the prompt cache (`cache.read` at a fraction of the
input price), while compaction invalidates the KV prefix and forces a
`cache.write` spike on the next turn. The break-even point between NVIDIA's
decode savings and this cache-invalidation cost is computable from recorded
usage — which is exactly what this repo already measures (`cacheHitShare`,
`modelledTurnCost`, verified to the cent against a recorded $0.028712 turn).

Caution imported from arXiv:2606.22528 (governance decay): compaction silently
erodes safety and permission instructions. Any compaction surface we ship must
re-assert guardrails.

## 2. Goals and non-goals

Goals:

1. Price compaction with measured cache economics: `contextDebt` and
   `compactionRoi`, validated against recorded sessions.
2. A structure-aware "compact now / not yet" verdict: deterministic signal
   scoring, judge refinement only where the heuristic is uncertain, noise
   calibration, and a flip-flop guard.
3. Surfaces that advise and enable, never act: advisory popup/toast plus one
   explicit compact-here command. The plugin never fires compaction itself.
4. Per-pin compaction tolerance measured by the benchmark harness and used as
   a routing signal (follow-on phase).
5. A monorepo structure where model selection and context management are
   separate plugin packages sharing one pricing library and one release
   pipeline. The papers' ablation studies (fixed threshold vs deterministic vs
   hybrid) run on our existing bench machinery as the paper's evaluation.

Non-goals:

- No automatic compaction. The human (or the model, via the command) decides.
- No third Rust crate beyond the two described below; no wasm-bindgen anywhere.
- No changes to plugin IDs, `OMLX_ROUTER_*` env vars, or state paths
  (`~/.local/state/omlx-router/` stays; `compaction-noise.json` lands there).
- No JSX/TSX or `@opentui/core`/`solid-js` in any TUI surface.
- No network in tests; judge calls are mocked.
- No prompt text in logs or decision records — signals and hashes only.

## 3. Architecture

The repository becomes a private workspace root with three publishable
packages:

```
package.json          # private: true, workspaces: ["packages/*"], check pipeline
.github/workflows/    # ci.yml, security.yml, release.yml
packages/econ/        # @231self/opencode-econ — shared pricing library
packages/router/      # @231self/opencode-router — model selection plugin + CLI
packages/compaction/  # @231self/opencode-compaction — context management plugin
```

Dependency graph: `router → econ`, `compaction → econ`. No dependency between
router and compaction. (`@231self/opencode-econ` is a provisional name; rename
at spec review if desired.)

### 3.1 packages/econ

Pure ESM JavaScript, zero dependencies. Holds `cost.js` (cost-shape
normalisation, `tiersOf`, `normaliseCost`, `mergeCost`, `costSource`,
`modelledTurnCost`) and `tokens.js` (`estimateTokens`, `partTokens`,
`countContextTokens`, `measureSessionContext`, `cacheHitShare`) exactly as they
exist today, plus the new economics functions (section 4) and the recorded-cost
validation fixtures. The documented semantics stay: `input` excludes cached
tokens; the cache-share denominator is `input + cache.read + cache.write`.

### 3.2 packages/router

Model selection only: the pool, judge-based routing, pins, bounce guards,
status popups, and the CLI bin `opencode-model-router` (alias `omlx-router`).
It no longer invokes the context optimiser.

Its Rust crate keeps `route` and routing math. The explicit ABI keeps
`alloc`, `dealloc`, `route`, `result_len`, `abi_version`; `optimise` is
removed (breaking change, see section 8). `dist/core.wasm`, the 614400 B size
gate, and the pure-core rules (no I/O, clock, randomness, or imports in
`core/`) stay.

### 3.3 packages/compaction

Everything context: the optimiser plugin surface (moved from the router), the
economics consumers, the hybrid trigger, the advisory popup/toast, and the
explicit compact-here command.

Its Rust crate owns `optimise` and the context-optimisation math. Its ABI:
`alloc`, `dealloc`, `optimise`, `result_len`, `abi_version`. Same size gate,
same pure-core rules. The pricing model (section 4) lives in `packages/econ`
and the trigger scoring (section 5.1) in this package's JS; where either needs
arithmetic the Rust also implements, the JS mirrors the Rust (the established
`tokens.js` pattern).

## 4. Economics model (in packages/econ)

Two new pure functions. All token counts are estimates or measured usage;
prices are per-million-token tier prices already normalised by `cost.js`.

### 4.1 contextDebt

```
contextDebt({ price, contextTokens, prefixTokens, cacheHitRatio, outputTokens,
              projectedTurns }) -> { perTurnDelta, projectedCost }
```

The projected cost of the next `projectedTurns` turns at the current, still
growing context: each turn re-pays the prefix (mostly `cache.read`, plus the
input price on the drift share). `perTurnDelta` is that prefix carrying cost
per turn (`prefix × ratio × cache.read + prefix × (1 − ratio) × input`, per
million tokens); `projectedCost` is `projectedTurns ×` the full modelled turn
cost at `contextTokens`. Returned so a display can say "keeping this context
costs $X over the next N turns".

### 4.2 compactionRoi

```
compactionRoi({ price, contextTokens, compactedTokens, cacheState,
                cacheHitRatio, outputTokens, expectedTurns })
  -> { perTurnSavings, invalidationCost, breakEvenTurns, worthIt }
```

- `perTurnSavings` = modelled turn cost at `contextTokens` minus the modelled
  turn cost at `compactedTokens`, using the measured `cacheHitRatio` (from
  `cacheHitShare` of the last turn's recorded usage when not given; the pin
  fallback stays 0.8 and 0 disables).
- `invalidationCost` = the one-time cache-invalidation premium: the first
  post-compaction turn writes the whole compacted prefill at `cache.write`
  (falling back to the input price where writes are not billed separately)
  plus the output cost, minus what a steady compacted turn costs once cached.
- `breakEvenTurns` = `ceil(invalidationCost / perTurnSavings)` (0 when
  savings are immediate or the premium is non-positive; `Infinity` when
  compaction never pays).
- `worthIt` = `breakEvenTurns <= expectedTurns`.

Validation: replay recorded sessions (including `type: "compaction"`
checkpoints that `measureSessionContext` already parses) and assert the model
reconciles recorded host-reported costs — the $0.028712 reconciliation turn is
the standing fixture. Any discovered mismatch becomes a regression test.

## 5. Trigger (hybrid: deterministic candidates, judge refinement)

### 5.1 Deterministic signal scoring (plain ESM JS in packages/compaction)

Signals extracted per turn from message structure and usage — signals and
hashes only:

- context growth rate (tokens per turn over a window)
- tool-output share of recent tokens (heavy output stretches suggest mid-search)
- subtask-boundary markers: completed tool sequence followed by assistant
  synthesis, todo-list transitions, edit → test → result cadence
- synthesis ratio: assistant-text share of the most recent turn
- staleness proxy: age of the untouched context tail relative to turn count

A pure scoring function maps signals to `{ verdict: "compact-now" | "not-yet" |
"uncertain", confidence, signals }`. Candidates are turns where compaction is
plausible (boundary markers present, growth rate above floor).

### 5.2 Judge refinement (only at uncertain candidates)

Reusing the router's exported judge bridge, a rubric call asks the
SelfCompact question set: fire when a sub-task resolved or the trajectory is
converging; suppress mid-derivation or when stuck. Consultation is selective —
the router's "judge consulted on a minority of turns" discipline — and never
logs prompt text.

Calibration: `compaction:calibrate --repeat n` re-samples verdicts and writes
the noise band to `~/.local/state/omlx-router/compaction-noise.json`. The
verdict-change threshold is floored at the calibrated band (the
`switchThreshold` floored at `verdictNoiseBand` pattern).

### 5.3 Flip-flop guard

A verdict change requires a minimum number of turns since the last change
(configurable, mirroring `flipFlopTurns`) and an ROI gap beyond the calibrated
noise band. The advisory cannot oscillate.

## 6. Surfaces

- **Advisory popup/toast** in the TUI, following the popup layout helper rules
  (sections, one fact per row, values wrapped at 72 columns, ≤80-column
  regression gate): verdict, break-even turns, estimated savings over the
  expected horizon, recommended checkpoint.
- **Explicit compact-here command** invoking the host's compaction at the
  recommended checkpoint. The plugin never fires compaction on its own. The
  recommended compaction prompt includes a guardrail re-assertion line
  (governance decay): safety and permission instructions must survive the
  compaction.
- No new CLI bin. The router CLI stays as-is.

## 7. Host integration (spike at implementation start)

Verify before building surfaces: (a) how a plugin invokes host compaction, and
(b) how a plugin registers a user-invocable command. If (a) is unavailable, the
command degrades to staging the recommended compaction prompt for the user.
This spike is bounded to reading the host plugin API and a throwaway probe.

## 8. Migration and release

Breaking changes:

- `optimise` moves out of the router's wasm ABI into the compaction package.
  Documented in both changelogs. The router plugin stops invoking the
  optimiser; users who want it install `@231self/opencode-compaction` too.

Release pipeline:

- `release.yml` stages each workspace package whose version is not yet on npm,
  in dependency order (econ first). Per-package `CHANGELOG.md`, per-package
  version guards (`## <version> ` sections).
- Trusted publishers: one config per package on npmjs.com (same repo
  `231self/opencode-router`, workflow `release.yml`, staged-only, "Require 2FA
  and disallow bypass tokens" retained). The first publish after creating each
  config must be approved within 2 days — create the configs when the first
  three-package release is ready to stage.
- Approval order matters: `econ` must be approved (and thus installable)
  before its dependents, because their published manifests reference it.
- AGENTS.md: the bump list becomes per-package; the hard rules (no tokens, CI
  publishes, staged approval) are unchanged.

## 9. Testing and regression policy

Standing rules: every discovered issue becomes a regression test; no network
in tests; judge mocked; fixtures are recorded session shapes (including
compaction checkpoints); popup layout ≤80 columns; one size gate per wasm
artifact (614400 B).

The bench script doubles as the paper's ablation harness: fixed-threshold vs
deterministic-only vs hybrid, reporting realized cost and task accuracy over
the existing suites (`rescoreScenario` machinery reused, re-run vs rescore
distinguished as today).

## 10. Paper alignment

Thesis: *Compaction under cache pricing — when does it actually pay?* The
system is router + compaction advisor as sibling packages. Contributions:
(a) the cache-aware cost model with recorded-cost validation, (b) the
break-even curve (compaction frequency vs realized cost, per cache
read/write price tier), (c) the noise-calibrated hybrid trigger against
fixed-threshold and rubric-only baselines, (d) per-pin compaction tolerance as
a routing signal. arXiv tech report first (the NVIDIA paper is one too), then
a systems/efficiency workshop or industry track.

## 11. Phasing

Each phase lands green (`bun run check` equivalents per package) with its own
regression tests and release notes.

1. **Monorepo restructure** — workspaces, `packages/econ` extraction, the
   crate split, and the package split. Includes the optimiser surface move:
   the router stops invoking the optimiser and becomes pure model selection
   (documented behaviour change alongside the ABI move). All three packages
   publishable, release.yml extended.
2. **Economics** — `contextDebt`, `compactionRoi`, recorded-session
   validation fixtures in `packages/econ`.
3. **Compaction MVP** — hybrid trigger, calibration script and artifact,
   popup/toast, explicit command (the optimiser move landed in phase 1).
4. **Context-debt routing** — the router's switch decision consumes
   `contextDebt` (projected next-turn cost at current vs compacted context).
5. **Tolerance + paper** — per-pin compaction tolerance bench, ablation runs,
   paper draft.

## 12. Risks and open questions

- Host API for compaction invocation and plugin commands (section 7 spike).
  Design degrades gracefully if invocation is missing.
- Publish ordering across three staged packages (mitigated: econ-first
  approval in the runbook).
- The router's `optimise` ABI removal breaks direct wasm consumers (expected
  to be nobody; documented regardless).
- Provisional package name `@231self/opencode-econ` — confirm or rename at
  spec review.
- Expected-turns estimation for `worthIt` starts conservative (user-configured
  horizon with a session-cadence fallback); refine with data later.

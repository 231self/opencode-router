# Changelog

## 0.5.0 — 2026-11-26

### Added

- Unit price per pool model: what 1M tokens of a typical turn cost the user
  on that model, blended from the resolved rate card (plan rates first) and
  the measured r/w/cache/input mix of the user's own turns. `/router pool`
  shows it per model with its basis — `unit $0.13/M · measured mix · 213
  turns`, or `reference mix · stand-in` for a model never used (the
  published 7 : 2 : 1 cache : input : output blend, cited in code).
- `/router plan` records the plan from the router side in the billing
  schema's order: payg or subscription, then vendor, then the vendor's
  plan.

### Changed

- The cost projection weighs measurements instead of assumptions. The
  cache-read share falls back to the measured share of the turn log (was a
  fixed 0.8) and the expected output size to the measured output per turn
  (was 1200). Measured, not assumed — the incumbent's own measured share
  still applies first, and `pin.cacheHitRatio: 0` still turns the discount
  off.
- Payg is recorded as a billing type (`type: "payg"`); `payg: true` still
  reads as its marker.

## 0.4.0 — 2026-11-24

### Added

- Plan-aware routing. With a plan billing record configured (the compaction
  plugin's `/ctx plan` writes it), the models the plan covers are scored at
  the plan's own shadow prices — plan credits are what the user actually
  spends, so they outrank catalog and reference prices. Marked `plan rate`
  in `/router pool`. Local models stay free: they burn no allowance.
- `/router plan` records the plan from the router side, so plan-aware routing
  no longer depends on the compaction plugin being installed. Providers come
  from the shared plan catalog; a plan already on file is added beside, never
  replaced. A plan whose vendor publishes a dollar budget (GitHub Copilot,
  Replit) is priced against the model's own list price.
- Sidebar block: leads with the router's own decision — `running
  deepseek-flash · kept for cache`, `switched · cheaper`, `pinned by you` —
  then the policy that decided it and the evidence (pin, quality score,
  judge). The conclusion is the point of the block; the numbers explain it.
  Refreshes on model changes and finished turns.

### Changed

- A plan with no published allowance (a usage-window plan such as ChatGPT
  Plus) contributes no shadow price, so the models it covers keep catalog
  prices instead of being priced at a rate that does not exist.
- Model cost resolution moved to `@231self/opencode-shared/cost-resolution.js`,
  shared with the compaction plugin. The router's pool and the advisory's
  economics now read one precedence (plan, catalog, fallback, none) and one
  `ownBill` flag, so the two can never price the same model differently.

## 0.3.6 — 2026-11-23

### Changed

- Release and dependency only. Carries compaction `0.1.6` and depends on
  `@231self/opencode-shared` `^0.1.4`, which adds `referencePrice`. No router
  code changes.

## 0.3.5 — 2026-11-23

### Fixed

- Context measurement no longer counts reasoning and host bookkeeping as
  prompt. `measureSessionContext` is shared with the compaction plugin, and it
  stringified whole messages: on a real 500k-token session it read 496,861
  tokens against a billed prefill of 159,057. Router decisions that weigh
  context size now use the corrected count.
- A model whose catalog entry is all zeros (a flat-rate pool) is no longer
  treated as having no prices. Depends on `@231self/opencode-shared` `^0.1.3`
  for `costState`.

## 0.3.4 — 2026-11-23

### Changed

- Depend on `@231self/opencode-shared` `^0.1.2`. Carries compaction `0.1.4`,
  which fixes the dependency floor that made 0.1.3 fail to load. No router
  code changes.

## 0.3.3 — 2026-11-23

### Changed

- Documentation and release only. Carries compaction `0.1.3`, which measures
  the active session context instead of the hook's outgoing segment. No router
  code changes.

## 0.3.2 — 2026-11-22

### Changed

- Depends on `@231self/opencode-shared` `^0.1.1`, which adds per-tier cost
  resolution and measured-cost inputs to the compaction ROI. No router code
  changes; this release carries the corrected shared dependency floor and the
  documentation updates from the preceding patches.

## 0.3.1 — 2026-11-22

### Changed

- Documentation only. The benchmark reports were regenerated with the 0.3.0
  per-turn context projection: long-session `balanced` now lands near
  always-frontier while `switch` stays 38% cheaper, so the earlier
  cost-neutral claim is superseded. The README's doc links, which resolved
  inside the package after the split, now use absolute repository URLs.

## 0.3.0 — 2026-11-22

### Changed

- **Breaking:** the context optimiser moved to
  [`@231self/opencode-compaction`](https://www.npmjs.com/package/@231self/opencode-compaction).
  The router is model selection only, and the `route` ABI no longer carries
  `optimise`. Install the compaction plugin to keep pruning oversized tool
  output.
- Pricing, measurement, the oMLX judge client, the config and state adapters,
  the Kilo shim, and popup layout now come from
  `@231self/opencode-shared`; the router imports them and keeps no copies.
- The switch decision prices candidates over the pin horizon instead of one
  turn. Every turn is priced at the context it actually reaches: a
  long-context price tier applies from the turn that crosses it, and a model
  that outgrows its window is charged the cache-invalidation premium where the
  overflow happens, then continues from the compacted size.

### Fixed

- Long-context price tiers (`context_over_200k`-style catalog entries) were
  silently unpriced in scoring: a non-tiered base entry blocked every tiered
  entry that followed it in catalog order, so the high tier never applied.

## 0.2.8 — 2026-11-21

### Changed

- No code changes since 0.2.7. This release exists to validate the CI release
  pipeline: it is staged by GitHub Actions over npm trusted publishing (OIDC)
  and approved with 2FA, so it carries a signed provenance attestation
  (0.2.7 was published manually and has none). Behaviour is identical to
  0.2.7.

## 0.2.7 — 2026-11-21

### Added

- The incumbent is priced with the **measured** cache-hit share of the
  session's last turn (verified against recorded provider costs: cached tokens
  are reported apart from `input`, which covers only cache misses). A pin that
  has not served a turn yet is priced cold — it has earned no cache — and
  `pin.cacheHitRatio` (0.8) remains the fallback when nothing is measurable
  and the hard off switch at 0.
- `bun run judge:calibrate --repeat n` re-samples verdicts, pushes each one
  through the core's scoring, and stores the widest score-gap movement as a
  verdict-noise band. `pin.switchThreshold` is floored at that band, so a gap
  inside the judge's own spread cannot flip the model (the flip-flop turn
  guard stays). Measured on a local Qwen3-4B over 18 re-sampled verdicts:
  zero movement — the floor is a no-op for deterministic judges and matters
  for noisy ones.
- The benchmark reports now include two sensitivity sweeps over the cache-hit
  assumption (rescoring fixed decisions and re-running the router) and
  measured judge wall-clock next to the modelled dollars. The long suite
  crosses over: at 50% reuse switching every turn is 14% cheaper than keeping
  the incumbent, at 95% keeping is 9% cheaper, and the documented 80% default
  sits near the crossover — the two retention modes are cost-neutral there
  within the assumption's own sensitivity.

### Changed

- Every `/router` popup — menus and subcommands alike — is now labelled,
  aligned, wrapped text instead of long `·`-chained lines: section titles,
  a label column, one fact per row, and values wrapped under a hanging indent
  (`src/format.js`). The same layout renders in the OpenCode TUI, Kilo, and
  the CLI, and a regression test sweeps every popup asserting no line runs
  past 80 columns and that rows in a section share one value column.
- Model labels no longer show a `#default` variant suffix.

### Fixed

- Mutating a config object returned by `readConfig` (for example
  `config.judge.baseURL = ...`) no longer poisons the shared defaults for the
  rest of the process: `mergeConfig` deep-copies its base.
- Error alerts and download toasts wrap or clip instead of running past the
  popup width — long provisioning errors (like a missing oMLX admin key) were
  single 180-column lines.

## 0.2.6 — 2026-11-21

### Security

- `bun run security` and a CI job fail the build on secret-shaped strings in
  the tree or the published tarball, on credential-shaped files, and on any npm
  dependency (there are none on purpose). gitleaks scans the full history and
  `cargo audit` watches `core/Cargo.lock`; Dependabot tracks the GitHub actions
  and Rust crates.
- The wasm core's memory is capped at 16 MiB, `unsafe` is denied outside the
  C ABI boundary, and oversized requests (over 1 MiB), pools (over 1024
  models), and transcripts (over 5,000 messages) are refused. A core trap
  degrades to `skip` instead of failing the turn.

## 0.2.5 — 2026-11-19

### Added

- `/router help [command]` prints the options for a single command, and the
  menu's Help item opens a picker over the same reference. The menu now also
  exposes `pricing refresh`, `quality refresh`, and `pins clear`, so every
  command and subcommand is reachable without typing.
- `/router retention [cache|balanced|switch]` renames `pin-mode`, which was
  easy to confuse with `/router pins` (per-session state). The old name stays
  as an alias, the config key `pin.mode` is unchanged, and the menu now reads
  "Model retention" and "Session pins".
- README documents routing on/off, and what `forced`, `pin-kept`, and
  `first-turn` mean when the model never changes.

### Fixed

- A command that requires a subcommand and is run bare shows that command's
  help and its available subcommands instead of guessing or silently ignoring
  the input.

## 0.2.4 — 2026-11-18

### Fixed

- OpenCode V2 no longer downgrades to a smaller context window on the strength
  of a queued compaction. A later prompt verifies a completed checkpoint and
  checks that the active conversation fits before switching.

## 0.2.3 — 2026-11-18

### Added

- Pricing fallback: when the host catalog has no price, the router reads the
  public models.dev and LiteLLM tables (no access token) and caches them for 24
  hours. `/router pricing refresh`, `opencode-model-router pricing`, and
  `opencode-model-router pricing provider/model` manage the table; `pricing`
  config controls the sources.
- Commands with optional parameters print a `usage:` line naming them, and an
  unknown parameter is rejected with the allowed values instead of being
  ignored (`/router pricing resfresh` no longer silently lists prices).
  `/router subagents` now requires `on` or `off` rather than enabling routing
  when called bare. The CLI behaves the same way.

### Fixed

- Cost parsing accepts every shape the hosts emit: catalog tier arrays,
  models.dev's flat `{input, output, cache_read, cache_write}` with `tiers` and
  `context_over_200k`, and the V2 client's `{text: {input: {price}}}` with
  context overrides. A price the host leaves out stays missing, so the display
  says `unknown` instead of `$0`, and a real zero still reads as free.

## 0.2.2 — 2026-11-17

### Added

- `/router pins` lists the automatic per-session routing state, marks manual
  pins, shows active blocks, and can clear all pins. Status now says "sessions"
  next to the count.
- Failover handles payment and quota failures (HTTP 402, insufficient
  credits/balance, usage limits) and blocks the whole provider for auth, billing,
  or quota errors. Rate limits and server errors still block only the model.

### Changed

- The auth/billing/quota cooldown is 5 minutes instead of 30.

## 0.2.1 — 2026-11-17

### Added

- `/router pricing` shows input, output, and cache-read prices for each pool
  model, with local models marked free.

### Changed

- The Policy menu item now says it also covers custom weights.

## 0.2.0 — 2026-11-17

### Added

- Custom policy weights: `policyWeights` overrides any preset, and
  `policyByClass` varies the blend by turn class (`planning`, `review`,
  `trivial`, and so on). `/router policy custom` prints the active weights.
  The benchmark adds a mixed-weight scenario.
- Local models are first-class pool members: `pool.localCostZero` prices
  loopback providers at zero, and free local models get size-based quality
  (under 3B 0.35, 3–8B 0.45, 8–30B 0.55, 30B+ 0.72). The benchmark includes a
  local 27B and 4B. A free adequate model now releases a paid incumbent.
- Quality scores come from public datasets by default, keyless and cached
  daily: Epoch AI (SWE-bench Verified or MirrorCode, then ECI) followed by the
  LMArena Code Arena. `quality.sources` sets the priority, `quality.overrides`
  still win, and unmatched models keep the heuristic. `/router quality` and
  `omlx-router quality` show per-source counts and age; `refresh` fetches both.
- `judge.provision.backend` (`auto` | `omlx` | `none`): llama.cpp and other
  OpenAI-compatible judge servers are detected, and the download commands print
  a setup recipe instead of failing on the oMLX admin API.
- Failover on provider failures: a 429, 5xx, timeout, or auth error blocks the
  model for a cooldown, clears the pin, and queues a same-turn redirect to the
  next candidate through OpenCode's `model.resolve` hook. Config under
  `failover`; the blocklist shows in `/router debug`.
- `bun run quality:eval`: eight verifiable coding tasks run through OpenCode
  with fixed models, graded by deterministic checks. Results live in
  `docs/benchmarks/`.
- `bun run bench`: a deterministic routing and cost benchmark over a ten-turn
  session, comparing fixed models, a simulated tier baseline, and the router in
  `cache`, `balanced`, and `switch` modes. `bun run bench:long` repeats it from
  12k to 208k context. Results live in `docs/benchmarks/`.
- `/router version` and `omlx-router version --json`: router version, host, ABI,
  and wasm path for scripts and bug reports.
- `/router debug` and `omlx-router debug [--json]`: read-only diagnostics with a
  secret-free config digest, catalog/judge health, pins, last decision, and turn
  timing. Available from the TUI menu as **Diagnostics**.

### Changed

- Package renamed to `@231self/opencode-router`. The CLI installs as
  `opencode-model-router`, with `omlx-router` kept as an alias. Plugin IDs,
  config/state paths, and `OMLX_ROUTER_*` env vars are unchanged.
- The README now leads with a "How it works" section covering the judge prompt
  and floor, deterministic signals, gates and scoring, pin modes, the context
  optimiser, the three cache layers, and subagent policy, with npm/CI/license
  badges and a quick start.

### Fixed

- A pinned model that leaves the pool (context gate, catalog change) now hands
  over to an adequate candidate instead of the highest scorer.
- Context size no longer raises complexity at all. The context gate and the
  optimiser handle capacity, so routine edits at 10–200k stay on smaller
  models instead of being routed to the frontier model.
- Near-miss models (shortfall within `limits.shortfallTolerance`) now compete
  only when no exact-adequate candidate exists. The tolerance is a starvation
  fallback, not a licence to under-route.
- A free adequate model can now release a paid incumbent; the cost-release
  filter previously skipped zero-cost candidates.
- A pin no longer holds an inadequate model when complexity rises gradually. The
  +2 jump rule missed a 1→2→3 climb, so a cheap incumbent could stay above the
  turn's required quality; it now releases with reason `quality-gate` and
  selects the best adequate candidate.

## 0.1.2 — 2026-11-16

### Added

- `pin.mode`: `cache` (sticky), `balanced` (default), or `switch` (best every
  turn, cold-cache scoring). `/router pin-mode` and the Pin mode menu item
  expose it.
- `/router explain` is a readable breakdown (policy, verdict, judge time, top
  scores, per-turn cost), and `/router pool` shows each model's cost.

### Fixed

- Pins release after `pin.maxTurns` (8) or `pin.maxAgeMs` (30 min) even while
  active. A model costing more than `pin.costSwitchRatio` (4×) the cheapest
  adequate challenger is replaced even if it has the higher score, because one
  cache miss is cheaper than keeping an overpriced incumbent indefinitely.

## 0.1.1 — 2026-11-16

### Added

- A **Choose the pool** quickstart with explicit `pool.source: "list"` and
  `pool.models` examples; `/router pool` and `omlx-router pool` now print the
  config path and the exact commands to change the pool.

### Fixed

- An empty `favorites` pool no longer expands to every available model, which
  could silently route to zero-cost models the user never selected. Empty
  favorites now pause routing; `pool.source: "available"` is the explicit
  opt-in, and an unknown source selects nothing.

### Changed

- Clearer plugin IDs: `omlx-router` (server) and `omlx-router.tui` (TUI),
  replacing `omlx.router` / `omlx.router.tui`.
- The TUI part listens for `session.model.selected`, refreshes the session, and
  shows a short model-switch toast, so a routed model is visible even when the
  host footer lags.
- `/router` now opens a navigable action menu with descriptions for every item;
  `/router status` is a compact, aligned view instead of a long text blob.
- `/router pool` is an interactive setup flow for favorites, an explicit model
  list, or the explicit all-available opt-in. When the pool is empty, a startup
  toast and the status hint point to it instead of silently routing.

## 0.1.0 — 2026-11-16

First release.

### Added

- Per-turn routing for OpenCode V2, with same-turn model switching from the
  prompt hook.
- Deterministic Rust/WASM decision core: turn envelope, triage, scoring,
  cache-aware pinning, optimiser planning.
- oMLX small-model judge with automatic smallest-model selection, 5 s default
  timeout, LRU verdict cache, repair retry, and deterministic fallback.
- Judge provisioning with explicit consent: TUI/CLI offer, model metadata and
  size before confirmation, oMLX admin download, progress, cancel, and
  post-download verification. Never downloads automatically.
- Live prompt tests (`tests/e2e`) for OpenCode V2 and Kilo: deterministic judge
  stub, multi-turn pin/threshold/jump/override scenarios, subagent policy,
  judge failure and malformed-output fallbacks, disabled mode, Kilo boundary
  semantics, and a real-oMLX judge smoke test. Each step asserts the decision
  record, the model the host actually used, and per-turn timing.
- Per-turn telemetry from host events: routing, local judge, remote model,
  tool/other, time to first token, steps, tokens, and cost. `/router timing`,
  `omlx-router timing`, and `/router status` show the split; records are
  `turns.jsonl` with no prompt text.
- `tests/judge-calibration.mjs` measures the real judge's verdicts and latency
  on simple/edit/debug/planning/review/large-context cases.
- Pool sources: host favorites (default), explicit list, all available models;
  include/exclude globs; tool, context, and status filters; local-model guard.
- Policies: cost-first (default), quality-first, latency-first, with per-agent
  overrides for all of them.
- Cache-aware pinning with switch threshold, idle TTL, flip-flop guard, user
  `/model` override detection, compaction reset, and per-session tool-failure
  escalation.
- Context optimiser: dedupe, truncate, stub stale tool outputs, protect system
  and user text, overflow hand-off to host compaction.
- Subagent routing: role detection, agent policies, explicit agent-model forced
  pins, parent-model tie-break, independent pins and escalation.
- OpenCode TUI `/router` command and palette entry: status, on/off, interactive
  policy picker, pool, history, timing, explain, pin/auto, judge probe,
  subagents.
- Kilo V1 shim: routes at the next request boundary through the SDK transport,
  best-effort optimiser transform, boundary-labelled decisions.
- `omlx-router` CLI: status, config get/set, history, timing, doctor, pool.
- Apache-2.0 license, CI (rustfmt, clippy, Rust tests, wasm build, Bun tests,
  wasm size gate), and user documentation.

### Fixed

- The 4B judge copied the schema's `complexity: 1` example and under-classified
  debug, review, and planning turns. The judge prompt now uses few-shot examples
  and an explicit "do not copy" rule; the core also raises the judge verdict to
  a deterministic floor from code, error, planning, review, and context signals.
- Marker matching now uses word boundaries and common inflections, so `Inspect`
  no longer matches `spec`, `prefix` no longer matches `fix`, and `designs` /
  `tests` still match their markers.
- Multi-file turns now set a `multiFile` signal; planning and review turns have
  a minimum complexity of 3. The routing eval found two under-routes (a
  three-file refactor and a design comparison) before this change; both now
  match the oracle.
- The default judge timeout is 5 s: the 4B is usually under 1 s but cold calls
  measured 3.4 s.

- The OpenCode V2 context hook only reports a model's provider and id. The
  adapter now fills in limits from the live catalog, so the optimiser no longer
  sees zero context and reports a false overflow on every turn.
- Context-hook state writes no longer overwrite a routing pin written by a
  concurrent prompt hook. Cache-aware pinning now survives turns with tool use.
- Pin policy: a downward complexity change no longer counts as a jump, a
  selection that stays on the incumbent is no longer recorded as a switch, and
  idle TTL only switches when a different model is actually best.
- A rejected `switchModel` call is recorded with `applied: "none"` and the
  error, instead of claiming the decision was applied.

### Notes

- No TypeScript application code; no Python runtime.
- Kilo cannot switch the in-flight turn through its V1 API; decisions apply at
  the next boundary.

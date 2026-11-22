# Compaction under cache pricing: when does it actually pay?

Draft — v0.1, 2026-11-22. Numbers marked [pending] need the live runs
(`tolerance:eval`, long-suite ablation). Everything else is measured.

## Abstract

Context compaction is usually studied as a quality trade-off: summarize the
history, lose some accuracy, gain room. On cache-billed serving it is also a
*pricing* trade-off that the existing work does not model. A growing context
is largely re-served from the provider's prompt cache at a fraction of the
input price; compaction destroys that cache and forces the compacted prefix
to be re-written at the cache-write price. We give the break-even
formulation for this trade-off, validate the underlying cost model against
recorded provider usage to the cent, and build a compaction advisory for
coding agents that combines trajectory structure, cache economics, and a
small local judge with calibration and anti-oscillation guards. In an
ablation over recorded-shaped trajectories, a fixed token threshold — the
common scaffold default — makes the wrong call exactly where the literature
predicts (mid-derivation), while the structural and hybrid triggers do not.
We also identify a third action beyond "keep" and "compact": *delegate* —
sending the next step to a fresh-context subagent — which recent work
(Elephant-Goldfish) shows can improve review quality while costing nothing
in context.

## 1. The cost of a turn on cache-billed APIs

Provider usage for one turn is three token buckets: `input` (cache misses),
`cache.read` (hits), and `cache.write` (newly cached). All prices are per
million tokens, so the recorded cost of a turn is

    cost = (input × pin + read × pread + write × pwrite
            + (output + reasoning) × pout) / 1M.

We verified this identity against a recorded deepseek/deepseek-v4-pro turn
with no cache writes: 39,357 misses at $0.66/M, 44,928 hits at $0.022/M, and
883 output tokens at $1.98/M give $0.028712 to the cent, and `input` is *not*
the total prompt (hits exceed it). That turn validates the read side of the
identity; the write term is exercised by the premium below, and needs a
recorded turn with `cache.write > 0` before the full identity is confirmed.
Two consequences follow.

**The prefix is re-paid every turn, cheaply.** The accumulated context of an
agent session is billed each turn, mostly as cache reads. We call the
per-turn cost of that prefix the *context debt*:

    debt(turn) = prefix × (h × pread + (1 − h) × pin) / 1M,

where h is the measured cache-hit share of the session's last turn. Our
router uses the measured share (fallback 0.8, 0 to disable) and prices cold
pins at zero rather than assuming cache help that has not been observed.

**Compaction invalidates the cache.** Summarizing the history rewrites the
prefix: the next turn pays `pwrite` over the compacted context where it
would have paid `pread` over the old one. The one-time *invalidation
premium* is

    premium = compacted × (pwrite − (h × pread + (1 − h) × pin)) / 1M,

with `pwrite` falling back to `pin` where writes are not billed separately
(then the premium is exactly the lost cache discount). Compaction pays after

    break-even = ceil(premium / (turn(C, h) − turn(C′, h)))

turns, where C′ is the compacted context. This is the term missing from the
"compaction saves 2.2×–8.8×" line of work on long contexts [NVIDIA,
arXiv:2611.05306]: those savings are computed at flat retail token prices,
where re-warming a cache is free. On real cache-billed pricing the savings
net against the premium, and the break-even is computable per session from
data the host already has.

## 2. When to compact is a structural question

Fixed token thresholds pay "no heed to trajectory structure" and discard
partial results mid-derivation [SelfCompact, arXiv:2606.23525]. We split the
decision into three layers:

1. **Structure.** Deterministic signals from the message list and measured
   growth: a tool burst followed by assistant synthesis (a sub-task
   boundary), per-turn growth, tool-output share, review intent. Signals are
   numbers and booleans; no prompt text is recorded anywhere.
2. **Economics.** The break-even from §1. A structural "compact now" that
   does not pay within the session's expected horizon is vetoed. Missing
   prices never veto: absent data must not silently suppress the advisory.
3. **A judge, at uncertain candidates only.** A small local model answers
   the SelfCompact rubric (fire at sub-task resolution or convergence, never
   mid-derivation) plus the delegation question. A failed judge call means
   the deterministic verdict stands.

Two guards keep the advisory honest. The verdict cannot oscillate: a change
must wait out a cooldown that scales with the judge's *measured* instability
(re-sampled verdicts on the same case, stored as a calibration artifact).
And the rubric carries hard suppression lines. In our first live calibration
the judge answered "compact" 3/3 at 0.9 confidence on a mid-debugging
trajectory; after adding "a large context alone is never a reason to
compact" and "partial results must not be discarded", the same case reads
"wait" 3/3 at confidence 1.0, while the review case still reads "delegate"
3/3 at 0.98. Calibration instability across all cases: 0.

## 3. Delegate: the third action

Compaction frames a growing context as a liability to compress. Recent work
inverts this: for review and verification, *zero* context can be an
advantage — the reviewer does not inherit the author's assumptions
(Elephant-Goldfish, google/elephant-goldfish-model). Our verdict space
therefore includes "delegate": at a sub-task boundary where the next step is
review-like, recommend a fresh-context subagent instead of summarizing.
Delegate costs no cache writes and no summarization loss; the caution
cutting the other way (governance decay, arXiv:2606.22528) is that
fresh-context steps must receive guardrails explicitly, since they inherit
none.

## 4. The advisory in a routing agent

The system is two OpenCode plugins: a model router and a context manager,
sharing a pricing library. Two integration points are worth noting.

**Context debt enters the switch decision.** The router compares models on
projected cost over the pin horizon, not one turn. Each turn is priced at the
context it actually reaches, so a long-context tier only applies from the
turn that crosses it, and a model that overflows its window keeps its served
turns at full price, then pays the compaction premium and continues from the
smaller context. Charging the final tier retroactively, or pricing every turn
at the compacted size, made a late overflow look free and could reverse the
ranking. Building this also exposed a bug in the incumbent's own cost code:
long-context price tiers (the `context_over_200k` class of catalog entries)
were silently unpriced in scoring because a non-tiered base entry blocked
them in catalog order.

**Cache hits are the incumbent's moat.** Switching models destroys the
prompt cache; the challenger's first turn pays full input price. The router
prices this asymmetry with the measured cache-hit share and floors the
switch threshold at the judge's own verdict-noise band, so a model is never
flipped on a score gap smaller than the judge can distinguish.

## 5. Preliminary measurements

- Cost-model validation: the recorded turn (no cache writes) reconciles to
  $0.028712 exactly, through both the bucket identity and the ratio model at
  the measured hit share (h = 44,928 / 84,285).
- Judge economics on real sessions: consulted on 36% of turns (132 of 207
  decisions resolved without it: 50 pin-kept, 38 forced, 38 heuristic);
  fresh verdicts average 1,216 ms, p95 1,509 ms.
- Compaction-verdict calibration: instability 0 across re-sampled verdicts;
  median verdict latency 572–705 ms.
- Strategy ablation on recorded-shaped trajectories (4 cases, 3 samples
  each): fixed threshold 6/12 (wrong mid-derivation and on the review case in
  every sample), deterministic trigger 12/12, hybrid 12/12. The arms run the
  production advisory, including the economics veto and the guard; only the
  judge call is replaced offline. The fixed baseline compacted 9× where the
  oracle compacted 3×. These are fixture-label verdicts, not task quality.
  [pending: same ablation over the long suite with the live judge and
  recorded sessions]
- Per-model compaction tolerance: [pending — `tolerance:eval`; the SAC
  spread to expect is model-dependent degradation, flat for some models and
  several points for others]

## 6. Limitations

The break-even model treats the compacted size as a configuration estimate
(summary size plus the recent tail) rather than a measured value; the JS
advisory models repeated compaction within a horizon as one compaction; and
the growth projection assumes the current prompt is representative. The
direction of the error is mixed rather than one-sided: a summary larger than
the estimate understates the premium and makes compaction look cheaper, while
a prompt busier than average overstates growth and makes it look dearer. The
verdict layer's generalization rests on a four-case calibration and a small
local judge; the artifact mechanism (calibrate, store, respect the band) is
the claim, not any single verdict.

## References (working)

- NVIDIA, "You don't need long context," arXiv:2611.05306, Nov 2026.
- Li et al., "Self-Compacting Language Model Agents" (SelfCompact),
  arXiv:2606.23525, Jun 2026.
- Google, Elephant-Goldfish Model, github.com/google/elephant-goldfish-model,
  Oct 2026 (from Rensin's "Elephants, Goldfish, and the New Golden Age").
- "Governance Decay: How Context Compaction Silently Erases Safety
  Instructions," arXiv:2606.22528.
- "Fast KV Compaction via Attention Matching," arXiv:2602.16284.

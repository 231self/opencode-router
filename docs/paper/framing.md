# Context as inventory: a unified theory of model-usage cost

Working document — v0.2, 2026-11-23. Companion to `draft.md`, which handles
one force (compaction under cache pricing) in full. This document states the
general theory, says what each term is, and marks what is **measured**,
**projected**, or **unmeasured**. Nothing here is claimed as a result.

## 1. The one-line theory

Producing an accepted task completion from an LLM agent consumes three
scarce resources: **money**, **window capacity**, and **attention quality**
(context rot). Every "force" in model-usage optimization is a marginal term
of one objective — minimize expected cost per accepted task subject to the
window — and optimal behavior equalizes the shadow prices of those three
resources across the available actions (keep, compact, delegate, switch
model, reshape the prompt).

    min   E[ cost per accepted task ]
    over  actions per turn: {keep, compact, delegate, switch model, reshape}
    s.t.  context S <= window W
          P(task success) >= q*

where cost is a vector scalarized at the deployment's shadow prices:

    cost = money(S, cache state, model)
         + latency(S, model)
         + rework(quality of context, model, prompt artifacts)

A flat plan sets the *cash* price of the next token to zero. It does not
set the shadow price of the plan allowance to zero (§4), and it does not
set the other terms to zero. Any report that shows only the cash term will
conclude that compaction is worthless on a plan; the binding constraints
there are capacity, rot, and allowance burn.

## 2. Context rot is the quality term — and it is a slope, not an endpoint

Context rot is the phenomenon: output quality degrades as context grows
beyond the useful content. The quality-vs-context curve Q(S) is its
dose-response measurement. The theory needs the *marginal* rot rate
dQ/dS at the current operating point, because every decision compares
that slope against a setup cost — not the end-to-end drop at some far
length. Three mechanisms, with different remedies:

- **Scale rot** — same facts, longer haystack. Attention dilution, the
  "lost in the middle" U-curve (Liu et al. 2023; the Context Rot report,
  Chroma 2025; NoLiMa). Remedy: keep S tight.
- **Distractor rot** — irrelevant content inserted between the relevant
  facts. Remedy: curate; summarize away noise.
- **Age rot** — the relevant fact grows old. Primacy/recency effects;
  early constraints stop being attended to. Remedy: *re-anchor* — move
  the fact fresh.

This decomposition matters because **compaction is not only size
reduction: it is also context refreshment.** A summary converts age rot
into fresh tokens. That predicts compaction can help even when money is
zero and the window is far from full — the flat-plan regime where the
money-only theory says "keep working".

Status: **unmeasured in our data**. The literature establishes the
phenomenon; the slope at our operating points (coding-agent sessions,
these models) is what the live tolerance ablation must produce.

## 3. The inventory mapping

A session's context behaves like inventory. This is not a metaphor: it
yields a falsifiable cadence law.

| Inventory concept | Session equivalent | Status |
|---|---|---|
| holding cost h | context debt per turn: `prefix x (h_hit x p_read + (1-h_hit) x p_in) / 1M`, plus rot rate priced in quality units; on a plan `p_read` and `p_in` become the allowance shadow price `s` (§4) | debt formula **measured** (validated to the cent, read side); rot half **unmeasured**; `s` **projected** (§4) |
| setup cost K | compaction: summary tokens + cache-invalidation premium + rebuild cost | **measured** (checkpoint calibration) |
| stockout cost | rework from missing context: re-asks, repair turns | **unmeasured** |
| order quantity | tokens removed per compaction | controlled (config) |
| order cycle T | turns between compactions | observed / controlled |

With growth rate g tokens/turn, turns between compactions T, average
stock S_avg ~ gT/2, cost per turn = h . gT/2 + K/T, minimized at

    T* = sqrt( 2K / (h . g) )            [EOQ cadence law]

Predictions that follow, all falsifiable:

- **P1 (square-root cadence).** Optimal compaction interval scales with
  sqrt(K / (h.g)), not linearly. K is configurable (summaryTokens) and h
  varies across model price lists, so the law is testable by sweeping both
  in recorded-shaped trajectories before any live run.
- **P2 (cache pricing delays compaction).** h is dominated by the cache
  read discount, which is small. Larger h . g would mean frequent
  compaction; measured h says the opposite: long cycles are rational.
  This is the general form of `draft.md`'s break-even result.
- **P3 (flat-plan drift, revised).** With the cash price at zero, h_money
  is `s . prefix` (§4). While the period's allowance has slack, `s` is
  near zero and only rot and capacity bound T*: flat-plan sessions should
  run longer contexts than priced sessions. When the burn projection
  crosses the allowance, `s` jumps to `P/N` and behavior converges to the
  priced regime. The regressor is burn fraction of the allowance, not the
  plan type. Checkable in our own sessions; cross-plan comparison stays
  confounded by model.
- **P4 (rot shortens the cycle).** Distractor-heavy work (reading large
  logs, wide code exploration) raises the quality half of h and should
  shorten the observed cycle at equal money prices.
- **P5 (capability substitutes for curation).** A stronger model is more
  rot-resistant: flatter dQ/dS. The tolerance ablation across models
  should show per-model compaction tolerance moving with capability.
  This is the router's premise stated as a curve.
- **P6 (prompt artifacts are capital).** Durable prompt docs (AGENTS.md
  and friends) raise Q and flatten rot by making facts retrievable and
  reducing distractor sensitivity. They are a fixed investment paid once,
  reducing both the required stock and the stockout rate. Measurable as
  repair-turn rate before/after.
- **P7 (end-of-period tightening).** With a hard allowance, `s` rises as
  remaining slack falls, so T* shortens within a billing period.
  Observable as compaction hazard increasing with burn fraction.
  Unmeasured.

## 4. The plan shadow price — money is never zero

A flat plan sets the *cash* price of the next token to $0. It does not make
tokens free. The plan is a finite allowance (N tokens per period at price
P) and a finite capacity (concurrent turns, requests per minute). Tokens
that one long context burns are tokens no other session gets. The price of
one more token is the **shadow price**: the real cost of one more unit of a
scarce resource when no bill shows it.

What binds, in three cases:

1. **Token allowance.** The average price of a token is `P/N`. The
   marginal price depends on slack. If the period ends under budget, the
   next token costs nothing extra in cash — but the burn still reduces the
   slack other sessions can use. If the period will end over budget, every
   token costs at least `P/N` (it displaces other work), and if overage is
   priced at `p_ov`, the marginal token costs `p_ov`. If hitting the cap
   stops the work, the marginal cost is the value of the stopped work.
2. **Rate and concurrency.** The plan caps parallel turns or requests per
   minute. A fat context makes each turn slower (compute grows with
   tokens), so the cost shows up as queueing and lost throughput. Per-turn
   durations are already in our turn records; the shadow price here is
   slot-time, and its unit is seconds, not dollars.
3. **Cache reads against the allowance.** Providers discount the price of
   cache reads but may still count them at full weight against a token
   allowance. This is provider policy. The weighting is a labelled input,
   never a silent assumption.

An estimator we can compute from our own records (`turns.jsonl` already
stores per-turn input, output, cache read and cache write tokens):

    burn_rate  = tokens consumed per day (rolling window)
    projection = burn_rate x days left in the period
    s          = p_ov   if overage is priced and projection >= budget
               = P/N    if projection >= budget
               = 0      while slack is large (cash), burn still counts

A simple, honest planning rule: show the burn fraction against the budget
everywhere, use `s = P/N` for money terms once the projection crosses the
budget, and label the basis every time.

Worked example, illustrative numbers only: a plan of $200 per month with a
200M token allowance gives `s = $1/M tokens`. A session that keeps 500k
tokens of context and re-reads them every turn burns 0.5M tokens per turn:
$0.50 of allowance per turn at `s`, $4 over 8 turns. The cash bill is $0.
The allowance bill is not.

What this changes in the theory:

- The holding cost `h` is never zero. On a plan, replace `p_read` and
  `p_in` in the debt formula with `s`. The EOQ law `T* = sqrt(2K/(h.g))`
  then applies to plans unchanged; only the unit of `h` changes from
  dollars to allowance units.
- P3 and P7 above change shape accordingly.
- The caution in §5 weakens: money figures do not collapse to zero on a
  plan; they convert to allowance units at `s`, and only reach zero when
  the allowance is slack.

Status: burn tracking is **measurable today** from recorded usage; `P/N`,
the overage policy, and the cache-read weighting are **user-supplied
inputs**; the concurrency shadow price is **unmeasured**. Where the host
exposes plan data (OpenCode's `GET /api/experimental/usage/limits`
reports budget limit/spent/reset and per-period meters), the allowance
side is machine-readable. For third-party flat-plan gateways that expose
no usage/plan/quota endpoint and no rate-limit headers (verified on
ours), the plan facts must be configured.

## 5. The production-function view (broader frame)

The inventory model covers keep/compact timing. The full choice set —
model, prompt artifacts, delegation, reuse — is a producer's problem:
accepted work is produced from three inputs with prices.

    output: accepted task completions
    inputs: context stock S      (price: debt + rot + window shadow price)
            model capability m   (price: token rates at m's quality point)
            prompt capital P     (price: one-time authoring/maintenance)
            reuse R              (price: build cost amortized over hits)

This is where CPU-ARC (arXiv:2611.09891) slots in: it is a process
innovation that eliminates the solver term on hits, with break-even
`B/(S_source - C)` invocations — the same fixed-cost-amortization
arithmetic as K in the EOQ law, on the cross-request axis. Compaction
amortizes within a session; caching compiles across requests; both are
moves against re-paying for computation already done. The difference is
the hit condition: reuse needs equirational instances, compaction needs
none. Open-ended agentic sessions are the hard case for reuse and the
natural case for compaction.

One caution the CPU-ARC accounting shares with ours: savings stated in
money are regime-specific. Its 16-291x assumes per-token retail billing;
on a flat plan the same numbers must convert to allowance units at `s`
(§4) instead. They reach zero only when the allowance is slack. The
theory's answer is that the *vector* of costs is invariant, only the
shadow prices move.

## 6. How to examine it

Ordered by feasibility. Instruments already built are marked.

1. **Synthetic price sweep of P1 (now).** Sweep K (summaryTokens) and h
   (model price lists, cache ratios) in recorded-shaped trajectories;
   fit total cost per accepted task against T; compare sqrt law against
   fixed-threshold and turn-count policies. Uses the existing
   ablation harness and checkpoint calibration. No live endpoints needed.
   — This is the strongest feasible test of the theory's structure.
2. **Rot dose-response (needs live endpoints).** Fixed task suite against
   seeded contexts of controlled size and composition: relevant-only
   (scale rot), distractor-padded (distractor rot), relevant-but-old
   (age rot). Measure acceptance rate and repair turns. Output: Q(S)
   per model, per mechanism. This is the pending `tolerance:eval`.
3. **Cadence ablation (needs live endpoints).** Force compaction at
   intervals 1/3/5/8 turns on the long suite; measure cost per accepted
   task including rework. Fit P1 on real data.
4. **Allowance-pressure observation (now, observational).** Track burn
   fraction (rolling token burn against the configured allowance) and
   compaction events in our own flat-plan sessions; test whether
   compaction hazard rises with burn fraction (P3, P7). Same models in
   frame, so no cross-model confound; workload still confounds. A weaker
   companion: compare context size distributions between flat-plan and
   list-priced sessions of comparable work, reported as correlation only.
5. **Prompt-capital before/after (now, observational).** Repair-turn
   rate and context growth rate around the introduction of durable
   project docs in our own sessions.

Measurement honesty rules, unchanged from `draft.md`: cost identities are
verified against recorded usage; rework is counted in turns, not dollars,
unless priced explicitly at a named price list; every money figure names
its basis (catalog, list price, plan); nothing is presented as measured
because it is plausible.

## 7. What would falsify the theory

- Q(S) flat in our tasks: the quality term is zero at these scales and
  the theory collapses to money-only EOQ (which `draft.md` already
  validates — the theory would add nothing).
- Cadence independent of K and h in the sweep: the inventory structure is
  wrong; timing is governed by something outside the objective (e.g.
  habit, scaffolding defaults).
- Rework cost negligible across all sessions: stockouts are free and the
  U-curve has no left wall; under-context is not a force.
- Burn fraction of the allowance does not predict compaction timing once
  window proximity is controlled: the plan shadow price adds nothing and
  the flat plan really is money-free.

## 8. Open questions for the theory

- Scalarize quality into "cost per accepted task" (via rework turns), or
  keep it as the constraint `P(success) >= q*`? The scalar form makes the
  EOQ law exact; the constraint form matches how practitioners reason.
- Is the window shadow price observable? The capacity line in `/ctx`
  (% free) is a proxy; near the limit the price should spike — is
  "15% headroom" the right knee or a guess?
- Where does delegation sit in the production function? It buys fresh
  context at the price of context transfer loss — arguably a second
  inventory system with its own stockout cost.
- What do providers count against a token allowance — cache reads at full
  weight, at a discount, or not at all? This decides how strong `s` is on
  a plan and needs a per-provider answer.
- Is the concurrency shadow price expressible in tokens at all, or does it
  need its own unit (slot-time)? Slot-time is measurable from turn
  durations; pricing it is not.

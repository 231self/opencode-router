# Working notes — economics of context management

State updates from the plugin session. Not paper prose; inputs to fold into
`framing.md` / `draft.md`. Date: 2026-11-24.

## 1. Shadow prices are derived and coded

- `packages/shared/src/plan.js` (16 tests) derives the credit scale.
- Max tier: $100 / 82B credits.
- Derived (projected) shadow prices at Max rates:
  - cache-hit input: $0.00305/M
  - cache-miss input: $0.366/M
  - output: $0.732/M
- These land within 0.3% of catalog list prices.
- Interpretation: the credit scale is list pricing in another unit. The
  conversion itself is prior art (tokker.dev). Our contribution is the
  **cache-state split** (2.5 vs 300 credits = 120x) and the expiry term.

## 2. Plan taxonomy — the cap type decides which shadow price binds

Every flat plan caps something; four kinds:

1. **Prepaid credits / allowance** — `s` exact at `P/N`.
2. **Published usage multipliers** (e.g. "5x Pro") — `s` bounded, not
   identified without the base numbers.
3. **Capacity caps** — concurrency / hours / requests — `s` in slot-time
   (seconds), not dollars.
4. **Unpublished** — unknown; stay unknown.

A report must name which kind it is pricing. Cite trackers (LimitSheet,
LimitDex, tokker, Sovyron, dialagram) as the data sources.

## 3. Correction: off-peak 0.8x is uniform and cancels in T*

- The 0.8x credit coefficient is uniform across token types.
- It scales K and h together, so it **cancels** in `T* = sqrt(2K/(h.g))`.
- Uniform price shifts move *when to run heavy work*, not *when to compact*.
- Only non-uniform (per-token-type) price changes move the cadence.
- State this as its own prediction: the EOQ law is invariant to the uniform
  price level, sensitive only to relative prices.
- Check against data: cache-hit vs cache-miss ratios vary across providers
  and plans, so `h` varies non-uniformly across plans even at equal price
  levels.

## 4. Expiry-risk term (new holding-cost term)

- Cache expiry re-bills a 500k prefix at 300 credits = 150M credits at once.
- 150M / 82B = 0.18% of the quota, equal to 120 hot re-reads at 2.5 credits.
- Compaction as expiry insurance: the premium (cold minus hot) is what
  compaction can save if the summary stays small enough to stay hot.
- New term absent from retail-price framing: on credits, `h` is time-varying
  through cache state, not just context size.

## 5. Veto semantics (epistemics of whose prices they are)

- Plan prices come from the user's own bill → MAY veto a compaction.
- A sibling list price is a projection → may NOT veto.
- Paper version: a shadow price computed from your own allowance is
  decision-grade; one borrowed from a price list is advisory.

## Prior art (unchanged; cite and differentiate)

- tokker.dev — subscription caps to $/1M at full use, assumptions stated.
- sovyron.com/plans — per-plan break-evens.
- tokenews.xyz — real $/MTok per plan.
- limitdex.com + limitsheet.com — plan data catalogs, verbatim quotes,
  unknown stays unknown (same honesty rule).

## P1 sweep inputs

- `h` from retail price lists and from `plan.js` credit weights.
- `K` from `summaryTokens` config knob.
- Sweep both; no live endpoints needed.

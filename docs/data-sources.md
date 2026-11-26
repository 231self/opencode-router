# Where the numbers come from

Every number the plugins show comes from one of three datasets. Nothing is
pulled from anywhere else, and a value that cannot be sourced is left out
rather than guessed. This is the source of truth for the code and for
anything built on top of it.

## 1. Plan facts — what you pay

Your subscription: vendor, plan, price, allowance, per-model weights.

| Rank | Source | Trust |
|---|---|---|
| 1 | Your own record — the `/ctx plan` / `/router plan` wizard, `~/.config/omlx-router/plans.json` | Your bill. Overrides everything below. |
| 2 | `PLAN_CATALOG` (`packages/shared/src/plan.js`) — vendor-published facts. Every entry carries `source.url` and a `checked` date. | Published and checkable. |
| 3 | LimitDex tracker feed (`packages/shared/src/plan-feed.js`, `/ctx plan refresh`) — plan prices and the vendor's exact limit wording, with a check date. | Third-party measurement of vendor facts. |
| 4 | Nothing | The allowance stays **unpriced**. Never invented. |

Scope: billing is `type` (payg / subscription) → `vendor` → `plan`. A plan
whose allowance size the vendor does not publish (for example ChatGPT Pro's
weekly allowance) is recorded unpriced and its display names the allowance
that is consumed instead of implying there is none.

## 2. Model prices — what a token costs

The list price of a model, and the price you actually pay for it.

One precedence for both plugins, in `packages/shared/src/cost-resolution.js`:

| Rank | Source | Trust |
|---|---|---|
| 1 | Your plan's rate for the model (shadow price) | Your own bill. May veto an action that does not pay. |
| 2 | Public price list (models.dev, LiteLLM) — `packages/shared/src/price-table.js` reads what `packages/router/src/pricing.js` fetches | A published rate. Outranks the host. |
| 3 | The host catalog (OpenCode's own price for the model) | Fallback. The host's opinion, not always right. |
| 4 | A sibling entry in the host catalog for the same model | Projection only. May inform, never vetoes. |
| 5 | Nothing | Unknown. Not guessed. |

## 3. Workload facts — how much you use

Your own turn log, and nothing else. `measureTokensPerTurn`, `measureMix`,
and `measureWindow` (`packages/shared/src/plan.js`,
`packages/shared/src/unit-price.js`) measure message size, billed-bucket
mix, and window consumption from your recorded turns. No measurement, no
number — with one labelled exception: a model with no measured turns gets
its token mix from a published reference blend, 7 : 2 : 1 cache hits :
input : output (the Artificial Analysis blend, via the blended-rate glossary
at aicost.tools, checked 2026-11-26). It is labelled `reference mix ·
stand-in` and, like every projection, informs but never vetoes.

## Derived values: measured vs projected

- **Measured** values are computed from your turn log and labelled as such.
- **Projected** values (shadow prices, window budgets, ROI figures) are
  computed from the datasets above, are labelled with their basis ("at list
  price", "at full use of the budget"), and a projection never vetoes an
  action — only your own bill does.
- A number is never printed as a result when it was not computed.
- The **unit price** of a model (`packages/shared/src/unit-price.js`) is the
  cost of 1M tokens of a typical turn: the resolved rate card blended with
  the turn mix. Its `basis` names the mix — `measured mix · N turns` or
  `reference mix · stand-in` — and the router's decisions and the compaction
  advisory both weigh this one number.

## Privacy

No prompt text, tool output, or credentials are ever persisted or displayed
by these datasets. Plans hold prices and allowances; the turn log holds
counts and sizes.

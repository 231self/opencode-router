import { expect, test } from "bun:test"

import { advise, nextGuard } from "../src/advise.js"
import { composeAdvisory } from "../src/advisory.js"

const PRICED_MODEL = {
  providerID: "deepseek",
  id: "deepseek-v4-pro",
  cost: [{ input: 1, output: 2, cache: { read: 0.1, write: 1.25 } }],
  limit: { context: 262144, output: 8192 },
}

function toolPart(text = "x".repeat(4000)) {
  return { type: "tool", tool: "bash", state: { status: "completed", output: text } }
}
function textPart(text) {
  return { type: "text", text }
}
function message(role, ...parts) {
  return { info: { role }, parts }
}

const BOUNDARY = [
  message("user", textPart("implement the parser change")),
  message("assistant", toolPart(), toolPart(), toolPart()),
  message("assistant", textPart("Changes applied: ".concat("y".repeat(400)))),
]

test("a pressured boundary with prices advises compaction when it pays", async () => {
  const { advisory, guard } = await advise({
    config: { compaction: { expectedTurns: 8, summaryTokens: 1200 }, pin: { cacheHitRatio: 0.8 } },
    model: PRICED_MODEL,
    messages: BOUNDARY,
    measuredTokens: 100_000,
    previousTokens: 60_000,
  })
  expect(advisory.verdict).toBe("compact-now")
  expect(advisory.worthIt).toBe(true)
  expect(advisory.breakEvenTurns).toBeLessThanOrEqual(8)
  expect(guard.turns).toBe(1)
  expect(guard.verdict).toBe("compact-now")
})

test("a measured cache ratio replaces the configured fallback", async () => {
  const { advisory } = await advise({
    config: { compaction: { expectedTurns: 8, horizons: [3, 8, 15] }, pin: { cacheHitRatio: 0.8 } },
    model: PRICED_MODEL,
    messages: BOUNDARY,
    measuredTokens: 100_000,
    previousTokens: 60_000,
    cache: { ratio: 0.95, samples: 4, source: "measured" },
  })
  expect(advisory.cache.ratio).toBe(0.95)
  expect(advisory.cache.source).toBe("measured")
  expect(advisory.projections.map((entry) => entry.turns)).toEqual([3, 8, 15])
  expect(advisory.projections).toHaveLength(3)
})

test("without provider usage the advisory records the configured fallback", async () => {
  const { advisory } = await advise({
    config: { compaction: { expectedTurns: 8 }, pin: { cacheHitRatio: 0.8 } },
    model: PRICED_MODEL,
    messages: BOUNDARY,
    measuredTokens: 100_000,
    previousTokens: 60_000,
  })
  expect(advisory.cache).toEqual({ ratio: 0.8, samples: 0, source: "fallback" })
})

test("the configured horizon list controls which projections are shown", async () => {
  const { advisory } = await advise({
    config: { compaction: { expectedTurns: 8, horizons: [2, 20] }, pin: { cacheHitRatio: 0.8 } },
    model: PRICED_MODEL,
    messages: BOUNDARY,
    measuredTokens: 100_000,
    previousTokens: 60_000,
  })
  expect(advisory.projections.map((entry) => entry.turns)).toEqual([2, 20])
})

test("calibrated compactions supply the summary size and real costs", async () => {
  const calibration = {
    models: {
      "deepseek/deepseek-v4-pro": {
        summary: { value: 5_000, samples: 2 },
        request: { value: { input: 100_000, read: 0, write: 0, output: 5_000 }, samples: 1 },
        rebuild: { value: { input: 1_000, read: 4_000, write: 900, output: 200 }, samples: 1 },
        lastPrediction: { predicted: 4_300, actual: 5_000, error: 0.1628 },
        error: { value: 0.12, samples: 2 },
      },
    },
  }
  const { advisory } = await advise({
    config: { compaction: { expectedTurns: 8 }, pin: { cacheHitRatio: 0.8 } },
    model: PRICED_MODEL,
    messages: BOUNDARY,
    measuredTokens: 100_000,
    previousTokens: 60_000,
    calibration,
  })
  expect(advisory.estimates.summaryTokens).toBe(5_000)
  expect(advisory.estimates.summarySource).toBe("measured")
  expect(advisory.estimates.summaryCost).toBeCloseTo(0.11, 9)
  expect(advisory.estimates.summaryCostSource).toBe("measured")
  expect(advisory.estimates.rebuildSource).toBe("measured")
  expect(advisory.estimates.rebuildCost).toBeCloseTo(0.002525, 9)
  expect(advisory.estimates.lastPrediction).toMatchObject({ predicted: 4_300, actual: 5_000 })
  expect(advisory.estimates.predictionError).toBeCloseTo(0.12, 9)
})

test("measured samples are priced at their own prefill, not the average", async () => {
  const tiered = {
    ...PRICED_MODEL,
    cost: [
      { input: 1, output: 2, cache: { read: 0.1, write: 1.25 } },
      { tier: { size: 200_000 }, input: 2, output: 4, cache: { read: 0.2, write: 2.5 } },
    ],
  }
  const calibration = {
    models: {
      "deepseek/deepseek-v4-pro": {
        request: {
          samples: 2,
          value: { input: 200_000, output: 0, read: 0, write: 0 },
          recent: [
            { input: 150_000, output: 0, read: 0, write: 0 },
            { input: 250_000, output: 0, read: 0, write: 0 },
          ],
        },
      },
    },
  }
  const { advisory } = await advise({
    config: { compaction: { expectedTurns: 8 }, pin: { cacheHitRatio: 0.8 } },
    model: tiered,
    messages: BOUNDARY,
    measuredTokens: 100_000,
    previousTokens: 60_000,
    calibration,
  })
  // $0.15 at 150k and $0.50 at 250k, averaged as dollars.
  expect(advisory.estimates.summaryCost).toBeCloseTo(0.325, 9)
  expect(advisory.estimates.summaryCostSource).toBe("measured")
})

test("without calibration the summary size and costs are explicitly assumed", async () => {
  const { advisory } = await advise({
    config: { compaction: { expectedTurns: 8, summaryTokens: 1200 }, pin: { cacheHitRatio: 0.8 } },
    model: PRICED_MODEL,
    messages: BOUNDARY,
    measuredTokens: 100_000,
    previousTokens: 60_000,
  })
  expect(advisory.estimates).toMatchObject({
    summaryTokens: 1200,
    summarySource: "assumed",
    summaryCostSource: "modelled",
    rebuildCost: null,
    rebuildSource: "modelled",
    pricing: "priced",
  })
  expect(advisory.estimates.summaryCost).toBeGreaterThan(0)
})

test("a free tier with no reference states no economics instead of inventing zeros", async () => {
  // opencode/iceman-free and friends publish zeros and have no priced sibling.
  const { advisory } = await advise({
    config: { compaction: { expectedTurns: 8, horizons: [3, 8, 15] }, pin: { cacheHitRatio: 0.8 } },
    model: {
      providerID: "opencode",
      id: "iceman-free",
      cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
      limit: { context: 262144, output: 8192 },
    },
    messages: BOUNDARY,
    measuredTokens: 100_000,
    estimatedTokens: 100_000,
    previousTokens: 60_000,
  })
  expect(advisory.pricing).toBe("flat")
  expect(advisory.breakEvenTurns).toBeNull()
  expect(advisory.perTurnSavings).toBeNull()
  expect(advisory.worthIt).toBeNull()
  expect(advisory.moneyBasis).toBe("")
  expect(advisory.estimates.summaryCost).toBeNull()
  expect(advisory.estimates.summaryCostSource).toBe("no reference price · $0 marginal")
  // The horizons survive uncomputed rather than disappearing from the report.
  expect(advisory.projections.map((entry) => entry.turns)).toEqual([3, 8, 15])
  expect(advisory.projections.every((entry) => entry.worthIt === null)).toBe(true)
})

test("a flat-rate pool computes economics at a sibling's list price", async () => {
  // xiaomi-token-plan-sgp/mimo-v2.6-pro publishes zeros; xiaomi/mimo-v2.6-pro
  // is the same model with a real price. The plan charges nothing either way,
  // so the comparison is worth computing and must be labelled as a reference.
  const { advisory } = await advise({
    config: { compaction: { expectedTurns: 8, horizons: [3, 8, 15] }, pin: { cacheHitRatio: 0.95 } },
    model: {
      providerID: "xiaomi-token-plan-sgp",
      id: "mimo-v2.6-pro",
      cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
      limit: { context: 1048576, output: 8192 },
    },
    reference: {
      providerID: "xiaomi",
      id: "mimo-v2.6-pro",
      cost: [{ input: 0.435, output: 0.87, cache: { read: 0.0036, write: 0 } }],
    },
    messages: BOUNDARY,
    measuredTokens: 500_000,
    estimatedTokens: 500_000,
    previousTokens: 400_000,
  })
  expect(advisory.pricing).toBe("flat")
  expect(advisory.moneyBasis).toBe("at list price")
  expect(advisory.priceSource).toBe("list price · xiaomi/mimo-v2.6-pro")
  expect(advisory.worthIt).toBe(true)
  expect(advisory.perTurnSavings).toBeGreaterThan(0.01)
  expect(advisory.breakEvenTurns).toBeLessThanOrEqual(8)
  // The capacity story is what a plan actually makes binding.
  expect(advisory.capacity).toEqual({ size: 500_000, limit: 1048576, headroom: 548576 })
  // A projection must not veto an action whose real marginal cost is zero.
  expect(advisory.verdict).toBe("compact-now")
})

test("a projection at list price never vetoes a structural compaction", async () => {
  // A tiny session at list prices: compaction would cost more than it saves.
  // On a flat plan that must not turn a safe checkpoint into "not-yet".
  const { advisory } = await advise({
    config: { compaction: { expectedTurns: 1, summaryTokens: 4000 }, pin: { cacheHitRatio: 0.95 } },
    model: {
      providerID: "xiaomi-token-plan-sgp",
      id: "mimo-v2.6-pro",
      cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
      limit: { context: 1048576, output: 8192 },
    },
    reference: {
      providerID: "xiaomi",
      id: "mimo-v2.6-pro",
      cost: [{ input: 0.435, output: 0.87, cache: { read: 0.0036, write: 0 } }],
    },
    messages: BOUNDARY,
    measuredTokens: 30_000,
    estimatedTokens: 30_000,
    previousTokens: 10_000,
  })
  expect(advisory.moneyBasis).toBe("at list price")
  expect(advisory.worthIt).toBe(false)
  expect(advisory.verdict).toBe("compact-now")
})

const PLAN = {
  vendor: "xiaomi-mimo",
  tier: "max",
  renewsDay: 1,
}

test("a configured plan prices the economics at the user's own rates", async () => {
  // Plan credits are the user's bill, so no sibling reference is needed and
  // the money is not a projection.
  const { advisory } = await advise({
    config: {
      compaction: { expectedTurns: 8, horizons: [3, 8, 15] },
      pin: { cacheHitRatio: 0.95 },
      billing: PLAN,
    },
    model: {
      providerID: "xiaomi-token-plan-sgp",
      id: "mimo-v2.6-pro",
      cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
      limit: { context: 1048576, output: 8192 },
    },
    messages: BOUNDARY,
    measuredTokens: 500_000,
    estimatedTokens: 500_000,
    previousTokens: 400_000,
  })
  expect(advisory.priceSource).toBe("plan · Xiaomi MiMo Token Plan Max · $100/mo")
  // The user's own prices: empty basis, so they may veto like catalog prices.
  expect(advisory.moneyBasis).toBe("")
  expect(advisory.worthIt).toBe(true)
  expect(advisory.breakEvenTurns).toBeLessThanOrEqual(8)
})

test("plan estimates carry the credit costs and the expiry premium", async () => {
  const { advisory } = await advise({
    config: {
      compaction: { expectedTurns: 8 },
      pin: { cacheHitRatio: 0.95 },
      billing: PLAN,
    },
    model: {
      providerID: "xiaomi-token-plan-sgp",
      id: "mimo-v2.6-pro",
      cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
      limit: { context: 1048576, output: 8192 },
    },
    messages: BOUNDARY,
    measuredTokens: 500_000,
    estimatedTokens: 500_000,
    previousTokens: 400_000,
  })
  const plan = advisory.estimates.plan
  expect(plan.plan).toBe("Xiaomi MiMo Token Plan Max · $100/mo")
  expect(plan.keepCredits).toBe(500_000 * 2.5)
  expect(plan.expiry.cold).toBe(500_000 * 300)
  expect(plan.expiry.ratio).toBe(120)
})

test("plan rates may veto a compaction that does not pay", async () => {
  // Unlike a list-price projection, plan credits are what the user spends, so
  // an unprofitable compaction is vetoed at plan rates too.
  const { advisory } = await advise({
    config: {
      compaction: { expectedTurns: 1, summaryTokens: 4000 },
      pin: { cacheHitRatio: 0.95 },
      billing: PLAN,
    },
    model: {
      providerID: "xiaomi-token-plan-sgp",
      id: "mimo-v2.6-pro",
      cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
      limit: { context: 1048576, output: 8192 },
    },
    messages: BOUNDARY,
    measuredTokens: 30_000,
    estimatedTokens: 30_000,
    previousTokens: 10_000,
  })
  expect(advisory.moneyBasis).toBe("")
  expect(advisory.worthIt).toBe(false)
  expect(advisory.verdict).toBe("not-yet")
  expect(advisory.source).toContain("economics")
})

test("a plan with no weights for this model falls back to the reference", async () => {
  const { advisory } = await advise({
    config: {
      compaction: { expectedTurns: 8 },
      pin: { cacheHitRatio: 0.95 },
      billing: PLAN,
    },
    model: {
      providerID: "xiaomi-token-plan-sgp",
      id: "some-other-model",
      cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
      limit: { context: 1048576, output: 8192 },
    },
    reference: {
      providerID: "xiaomi",
      id: "some-other-model",
      cost: [{ input: 0.435, output: 0.87, cache: { read: 0.0036, write: 0 } }],
    },
    messages: BOUNDARY,
    measuredTokens: 500_000,
    estimatedTokens: 500_000,
    previousTokens: 400_000,
  })
  expect(advisory.moneyBasis).toBe("at list price")
  expect(advisory.priceSource).toBe("list price · xiaomi/some-other-model")
})

test("a model with no price entry is unknown, not free", async () => {
  const { advisory } = await advise({
    config: { compaction: { expectedTurns: 8, horizons: [3, 8] }, pin: { cacheHitRatio: 0.8 } },
    model: { providerID: "openai", id: "gpt-6.2-sol", cost: [], limit: { context: 262144 } },
    messages: BOUNDARY,
    measuredTokens: 100_000,
    estimatedTokens: 100_000,
    previousTokens: 60_000,
  })
  expect(advisory.pricing).toBe("unknown")
  expect(advisory.worthIt).toBeNull()
  expect(advisory.estimates.summaryCostSource).toBe("no price data")
  expect(advisory.estimates.rebuildSource).toBe("no price data")
})

test("missing prices never veto the structural verdict", async () => {
  const { advisory } = await advise({
    config: { compaction: { expectedTurns: 8 } },
    model: { providerID: "local", id: "local-model", cost: [] },
    messages: BOUNDARY,
    measuredTokens: 100_000,
    previousTokens: 60_000,
  })
  expect(advisory.verdict).toBe("compact-now")
})

test("an unprofitable compaction is vetoed by the economics", async () => {
  const { advisory } = await advise({
    config: { compaction: { expectedTurns: 1, summaryTokens: 60_000 }, pin: { cacheHitRatio: 0.95 } },
    model: PRICED_MODEL,
    messages: BOUNDARY,
    measuredTokens: 100_000,
    previousTokens: 60_000,
  })
  expect(advisory.verdict).toBe("not-yet")
})

test("the judge refines an uncertain verdict", async () => {
  const calls = []
  const judge = {
    async chat(prompt, options) {
      calls.push({ prompt, options })
      return '{"action":"compact","confidence":0.9,"reason":"sub-task resolved"}'
    },
    getCached: () => undefined,
    setCached: () => {},
  }
  const messages = [
    message("user", textPart("keep going ".concat("z".repeat(2000)))),
    message("assistant", textPart("working ".concat("w".repeat(2000)))),
  ]
  const { advisory } = await advise({
    config: { compaction: { expectedTurns: 8 } },
    model: PRICED_MODEL,
    messages,
    measuredTokens: 80_000,
    previousTokens: 40_000,
    judge,
  })
  expect(calls.length).toBe(1)
  expect(advisory.verdict).toBe("compact-now")
  expect(advisory.source).toBe("judge")
})

test("judge refinement can be switched off", async () => {
  const judge = {
    async chat() {
      throw new Error("should not be called")
    },
    getCached: () => undefined,
    setCached: () => {},
  }
  const messages = [
    message("user", textPart("keep going ".concat("z".repeat(2000)))),
    message("assistant", textPart("working ".concat("w".repeat(2000)))),
  ]
  const { advisory } = await advise({
    config: { compaction: { expectedTurns: 8, judgeRefine: false } },
    model: PRICED_MODEL,
    messages,
    measuredTokens: 80_000,
    previousTokens: 40_000,
    judge,
  })
  expect(advisory.verdict).toBe("uncertain")
})

test("the guard carries its turn bookkeeping across advisories", () => {
  const first = nextGuard(null, { verdict: "not-yet" })
  expect(first).toEqual({ verdict: "not-yet", turns: 1, changedTurns: 1 })
  const held = nextGuard(first, { verdict: "not-yet" })
  expect(held).toEqual({ verdict: "not-yet", turns: 2, changedTurns: 1 })
  const changed = nextGuard(held, { verdict: "compact-now" })
  expect(changed).toEqual({ verdict: "compact-now", turns: 3, changedTurns: 3 })
})

test("on a plan the credit figures veto, not the near-zero dollars", () => {
  // The dollar ROI can say "worth it" while the credit ROI says the opposite:
  // on a plan the dollar figures are a tiny shadow price times a big token
  // count, so the KV-cache invalidation looks like $0.0172 and trivial. In
  // credits it is the real cost. The verdict must follow the real one.
  const structural = { verdict: "compact-now", confidence: 0.9, signals: { complexity: 2, contextTokens: 500_000, growth: 1000 } }
  const dollars = { perTurnSavings: 0.01, invalidationCost: 0.02, breakEvenTurns: 2, worthIt: true, summaryCost: 0.001 }
  const credits = { perTurnSavings: 1_000, invalidationCost: 2_000_000, breakEvenTurns: 2000, worthIt: false, summaryCost: 720_000 }

  // Dollars say yes, credits say no → the credit verdict wins on a plan.
  const onPlan = composeAdvisory({ structural, roi: dollars, planRoi: credits, moneyBasis: "" })
  expect(onPlan.verdict).toBe("not-yet")

  // No plan: the dollar verdict is the only one, and it stands.
  const noPlan = composeAdvisory({ structural, roi: dollars, planRoi: null, moneyBasis: "" })
  expect(noPlan.verdict).toBe("compact-now")
})

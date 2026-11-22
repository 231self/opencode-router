import { expect, test } from "bun:test"

import { advise, nextGuard } from "../src/advise.js"

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
    summaryCostSource: "estimated",
    rebuildCost: null,
    rebuildSource: "modelled",
  })
  expect(advisory.estimates.summaryCost).toBeGreaterThan(0)
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

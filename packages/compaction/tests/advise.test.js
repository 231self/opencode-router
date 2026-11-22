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

import { expect, test } from "bun:test"

import { composeAdvisory, cooldownTurns, guardAllows } from "../src/advisory.js"
import { instabilityBand, verdictInstability } from "../src/noise.js"
import { refineVerdict, rubricPrompt, validateAction } from "../src/refine.js"

const ROI_WORTH = { perTurnSavings: 0.02, invalidationCost: 0.01, breakEvenTurns: 1, worthIt: true }
const ROI_NOT_WORTH = { perTurnSavings: 0.0001, invalidationCost: 0.5, breakEvenTurns: 5000, worthIt: false }
const COMPACT = { verdict: "compact-now", confidence: 0.8, signals: { boundary: true } }
const UNCERTAIN = { verdict: "uncertain", confidence: 0.5, signals: {} }

test("the cooldown scales with the calibrated instability", () => {
  expect(cooldownTurns({ base: 3, instability: 0 })).toBe(3)
  expect(cooldownTurns({ base: 3, instability: 1 })).toBe(7)
  expect(cooldownTurns({ base: 3, instability: 0.5 })).toBe(5)
})

test("the guard holds the verdict through the cooldown and lets it move after", () => {
  const guard = { verdict: "not-yet", turns: 10, changedTurns: 8 }
  expect(guardAllows({ guard, verdict: "compact-now", confidence: 0.9 })).toBe(false)
  expect(guardAllows({ guard: { ...guard, changedTurns: 7 }, verdict: "compact-now", confidence: 0.9 })).toBe(true)
  expect(guardAllows({ guard: { ...guard, changedTurns: 7 }, verdict: "compact-now", confidence: 0.9, instability: 1 })).toBe(false)
})

test("the guard keeps a low-confidence verdict from moving at all", () => {
  const guard = { verdict: "not-yet", turns: 100, changedTurns: 0 }
  expect(guardAllows({ guard, verdict: "compact-now", confidence: 0.49 })).toBe(false)
  expect(guardAllows({ guard, verdict: "compact-now", confidence: 0.95 })).toBe(true)
})

test("the first verdict just needs to clear the confidence floor", () => {
  expect(guardAllows({ guard: null, verdict: "not-yet", confidence: 0.4 })).toBe(false)
  expect(guardAllows({ guard: null, verdict: "not-yet", confidence: 0.7 })).toBe(true)
})

test("the economics veto turns an unprofitable compaction into not-yet", () => {
  const advisory = composeAdvisory({ structural: COMPACT, roi: ROI_NOT_WORTH, guard: null })
  expect(advisory.verdict).toBe("not-yet")
  expect(advisory.confidence).toBeLessThanOrEqual(0.6)
  const profitable = composeAdvisory({ structural: COMPACT, roi: ROI_WORTH, guard: null })
  expect(profitable.verdict).toBe("compact-now")
  expect(profitable.worthIt).toBe(true)
})

test("the judge refines only an uncertain verdict", () => {
  const refined = composeAdvisory({
    structural: UNCERTAIN,
    roi: ROI_WORTH,
    refined: { action: "compact", confidence: 0.9, reason: "sub-task resolved" },
    guard: null,
  })
  expect(refined.verdict).toBe("compact-now")
  expect(refined.source).toBe("judge")
  const waited = composeAdvisory({
    structural: COMPACT,
    roi: ROI_WORTH,
    refined: { action: "wait", confidence: 0.9, reason: "mid-derivation" },
    guard: null,
  })
  expect(waited.verdict).toBe("compact-now")
  expect(waited.source).toBe("deterministic")
})

test("a blocked change reports the standing verdict", () => {
  const advisory = composeAdvisory({
    structural: COMPACT,
    roi: ROI_WORTH,
    guard: { verdict: "delegate", turns: 5, changedTurns: 4 },
  })
  expect(advisory.verdict).toBe("delegate")
  expect(advisory.source).toBe("guard")
})

test("verdict instability measures self-contradiction", () => {
  expect(verdictInstability(["compact", "compact", "compact"])).toBe(0)
  expect(verdictInstability(["compact", "wait", "compact", "delegate"])).toBeCloseTo(0.5, 6)
  expect(verdictInstability(["a"])).toBe(0)
  expect(instabilityBand([["compact", "compact"], ["wait", "compact", "wait", "compact"]])).toBeCloseTo(0.5, 6)
})

function mockJudge(reply) {
  const calls = []
  return {
    calls,
    async chat(prompt, options) {
      calls.push({ prompt, options })
      return typeof reply === "function" ? reply(calls.length) : reply
    },
    getCached() {
      return undefined
    },
    setCached() {},
  }
}

test("the rubric prompt carries signals and asks for JSON", () => {
  const prompt = rubricPrompt({ promptText: "fix the bug", tailDigest: "tool:bash x3", signals: { contextTokens: 50_000 } })
  expect(prompt).toContain("fix the bug")
  expect(prompt).toContain("tool:bash x3")
  expect(prompt).toContain('"action"')
})

test("refine parses the verdict, repairs once, and never throws", async () => {
  const judge = mockJudge('{"action":"compact","confidence":0.9,"reason":"resolved"}')
  const verdict = await refineVerdict({ judge, signals: {} })
  expect(verdict.action).toBe("compact")
  expect(verdict.cached).toBe(false)

  const repair = mockJudge((n) => (n === 1 ? "not json" : '{"action":"wait","confidence":0.4}'))
  const fixed = await refineVerdict({ judge: repair, signals: {} })
  expect(fixed.action).toBe("wait")

  const broken = mockJudge("not json at all")
  expect(await refineVerdict({ judge: broken, signals: {} })).toBeNull()

  const dead = { chat: async () => { throw new Error("judge down") }, getCached: () => undefined, setCached: () => {} }
  expect(await refineVerdict({ judge: dead, signals: {} })).toBeNull()

  expect(await refineVerdict({ judge: null, signals: {} })).toBeNull()
})

test("validateAction clamps and rejects", () => {
  expect(validateAction({ action: "compact", confidence: 9 })).toEqual({ action: "compact", confidence: 1, reason: "" })
  expect(validateAction({ action: "nonsense" })).toBeNull()
  expect(validateAction(null)).toBeNull()
})

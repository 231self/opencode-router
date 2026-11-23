import { expect, test } from "bun:test"

import {
  DEFAULT_HORIZONS,
  composeAdvisory,
  cooldownTurns,
  guardAllows,
  normaliseHorizons,
  projectHorizons,
} from "../src/advisory.js"
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

test("the economics veto applies after the guard, including a held compact-now", () => {
  const held = composeAdvisory({
    structural: COMPACT,
    roi: ROI_NOT_WORTH,
    guard: { verdict: "compact-now", turns: 10, changedTurns: 10 },
  })
  // The guard allows the standing verdict, then the veto removes it.
  expect(held.verdict).toBe("not-yet")
  expect(held.source).toBe("economics")

  const restored = composeAdvisory({
    structural: { verdict: "not-yet", confidence: 0.7, signals: {} },
    roi: ROI_NOT_WORTH,
    guard: { verdict: "compact-now", turns: 10, changedTurns: 8 },
  })
  expect(restored.verdict).toBe("not-yet")
  expect(restored.source).toBe("guard+economics")
})

test("horizons are sorted, deduped, and bounded", () => {
  expect(normaliseHorizons(undefined)).toEqual(DEFAULT_HORIZONS)
  expect(normaliseHorizons([15, 3, 8, 8, 0, -1, 500])).toEqual([3, 8, 15])
})

test("each horizon reports its own net and worth-it answer", () => {
  const projections = projectHorizons(
    { perTurnSavings: 0.02, invalidationCost: 0.05, breakEvenTurns: 3 },
    [3, 8, 15],
  )
  expect(projections.map((entry) => entry.turns)).toEqual([3, 8, 15])
  expect(projections[0].worthIt).toBe(true)
  expect(projections[0].net).toBeCloseTo(0.01, 9)
  expect(projections[1].net).toBeCloseTo(0.11, 9)
  expect(projections[2].net).toBeCloseTo(0.25, 9)
})

test("an unprofitable compaction is not worth it at any shown horizon", () => {
  const projections = projectHorizons(
    { perTurnSavings: 0.0001, invalidationCost: 0.5, breakEvenTurns: 5000 },
    [3, 8, 15],
  )
  expect(projections.every((entry) => !entry.worthIt)).toBe(true)
  expect(projections[2].net).toBeLessThan(0)
  // Uncomputed horizons keep their rows, so the report never drops a section
  // without saying why.
  expect(projectHorizons(null, [3, 8])).toEqual([
    { turns: 3, net: null, worthIt: null },
    { turns: 8, net: null, worthIt: null },
  ])
})

test("negative savings never make a horizon worth it, even with a credit", () => {
  const projections = projectHorizons(
    { perTurnSavings: -1, invalidationCost: -2, breakEvenTurns: 0 },
    [1, 8],
  )
  expect(projections.every((entry) => !entry.worthIt)).toBe(true)
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

test("the rubric hard-bans compaction mid-derivation and on size alone", () => {
  // Calibration finding (2026-11-22): without these lines the judge called
  // "compact" 3/3 on a mid-debugging trajectory. They are load-bearing.
  const prompt = rubricPrompt({ promptText: "", tailDigest: "", signals: {} })
  expect(prompt).toContain("Partial results must not be discarded.")
  expect(prompt).toContain("never a reason to compact")
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

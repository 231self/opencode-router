import { expect, test } from "bun:test"

import { runAblation, runCase, fixedVerdict } from "../src/ablation.js"
import { degradation, summariseTolerance } from "../src/tolerance.js"

function toolPart(text = "x".repeat(4000)) {
  return { type: "tool", tool: "bash", state: { status: "completed", output: text } }
}
function textPart(text) {
  return { type: "text", text }
}
function message(role, ...parts) {
  return { info: { role }, parts }
}

const BOUNDARY = {
  id: "boundary",
  messages: [
    message("user", textPart("implement the parser change")),
    message("assistant", toolPart(), toolPart(), toolPart()),
    message("assistant", textPart("Changes applied: ".concat("y".repeat(400)))),
  ],
  measuredTokens: 60_000,
  previousTokens: 40_000,
  compactedTokens: 4_300,
  price: { input: 1, output: 2, cache: { read: 0.1, write: 1.25 } },
  cacheHitRatio: 0.8,
  expectedTurns: 6,
  oracle: "compact-now",
}

const MIDFLIGHT = {
  id: "mid-derivation",
  messages: [
    message("user", textPart("trace the race and fix it")),
    message("assistant", textPart("third hypothesis in progress ".concat("z".repeat(3000)))),
  ],
  measuredTokens: 60_000,
  previousTokens: 55_000,
  compactedTokens: 4_300,
  price: { input: 1, output: 2, cache: { read: 0.1, write: 1.25 } },
  cacheHitRatio: 0.8,
  expectedTurns: 6,
  oracle: "not-yet",
}

test("the fixed-threshold baseline compacts over the line whatever the shape", () => {
  expect(fixedVerdict(30_000)).toBe("compact-now")
  expect(fixedVerdict(10_000)).toBe("not-yet")
  // The mid-derivation case is where the baseline is wrong.
  expect(fixedVerdict(MIDFLIGHT.measuredTokens)).toBe("compact-now")
})

test("the ablation counts each strategy against the oracle", async () => {
  const { rows, summary } = await runAblation({
    cases: [BOUNDARY, MIDFLIGHT],
    refine: async () => ({ action: "wait", confidence: 0.9 }),
  })
  const byKey = new Map(rows.map((row) => [`${row.strategy}:${row.case}`, row]))

  // fixed: right on the boundary case, wrong mid-derivation.
  expect(byKey.get("fixed:boundary").correct).toBe(true)
  expect(byKey.get("fixed:mid-derivation").correct).toBe(false)

  // signal: right on both.
  expect(byKey.get("signal:boundary").correct).toBe(true)
  expect(byKey.get("signal:mid-derivation").correct).toBe(true)

  // hybrid: the judge refines the uncertain mid-flight case to wait.
  expect(byKey.get("hybrid:mid-derivation").verdict).toBe("not-yet")
  expect(byKey.get("hybrid:mid-derivation").source).toBe("judge")
  expect(byKey.get("hybrid:mid-derivation").correct).toBe(true)

  const fixed = summary.find((entry) => entry.strategy === "fixed")
  expect(fixed.correct).toBe(1)
  expect(fixed.compactions).toBe(2)
  const hybrid = summary.find((entry) => entry.strategy === "hybrid")
  expect(hybrid.correct).toBe(2)
})

test("degradation measures the compaction loss and clamps nonsense", () => {
  expect(degradation(0.8, 0.6)).toBeCloseTo(0.25, 9)
  expect(degradation(0.5, 0.6)).toBeCloseTo(-0.2, 9)
  expect(degradation(0.01, 10)).toBe(-1)
  expect(degradation(0, 5)).toBe(0)
  expect(degradation(undefined, 5)).toBe(0)
})

test("tolerance folds task pairs per model, worst first", () => {
  const summary = summariseTolerance([
    { model: "steady", task: "a", intact: 0.9, compacted: 0.88 },
    { model: "steady", task: "b", intact: 0.7, compacted: 0.68 },
    { model: "fragile", task: "a", intact: 0.9, compacted: 0.5 },
    { model: "fragile", task: "b", intact: 0.8, compacted: 0.6 },
  ])
  expect(summary.map((entry) => entry.model)).toEqual(["fragile", "steady"])
  expect(summary[0].tasks).toBe(2)
  expect(summary[0].degradation).toBeCloseTo((1.7 - 1.1) / 1.7, 5)
  expect(summary[1].degradation).toBeCloseTo((1.6 - 1.56) / 1.6, 5)
})

test("the ablation runs the production advisory, so the economics veto applies", async () => {
  // A summary that costs about as much as the context it replaces: the
  // structural verdict is still compact-now, but production would veto it.
  const scenario = {
    ...BOUNDARY,
    id: "vetoed",
    summaryTokens: 60_000,
    expectedTurns: 1,
    oracle: "compact-now",
  }
  const signal = await runCase({ strategy: "signal", scenario })
  expect(signal.verdict).toBe("not-yet")
  expect(signal.worthIt).toBe(false)

  const hybrid = await runCase({
    strategy: "hybrid",
    scenario,
    refine: async () => ({ action: "compact", confidence: 1 }),
  })
  expect(hybrid.verdict).toBe("not-yet")
})

test("the ablation honours a stored guard, so a verdict change waits out the cooldown", async () => {
  const scenario = {
    ...BOUNDARY,
    id: "guarded",
    guard: { verdict: "not-yet", turns: 4, changedTurns: 4 },
    oracle: "compact-now",
  }
  const row = await runCase({ strategy: "signal", scenario })
  expect(row.verdict).toBe("not-yet")
  expect(row.source).toBe("guard")
})

test("repeat counts samples instead of pretending each case ran more than once", async () => {
  const { rows, summary } = await runAblation({ cases: [BOUNDARY], samples: 3 })
  expect(rows).toHaveLength(9)
  const fixed = summary.find((entry) => entry.strategy === "fixed")
  expect(fixed.cases).toBe(1)
  expect(fixed.samples).toBe(3)
  expect(fixed.correct).toBe(3)
})

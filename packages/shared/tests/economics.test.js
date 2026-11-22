import { expect, test } from "bun:test"

import { compactionRoi, contextDebt } from "../src/cost.js"
import { measureSessionContext } from "../src/tokens.js"

import {
  RECORDED_COMPACTED_SESSION,
  RECORDED_COST,
  RECORDED_OUTPUT,
  RECORDED_PREFILL,
  RECORDED_PRICES,
  RECORDED_TURN,
} from "./fixtures.js"

// The recorded turn's provider bills cache reads apart from input misses and
// has no separate cache-write price (writes fall back to the input price).
const RECORDED_TIER = {
  input: RECORDED_PRICES.input,
  output: RECORDED_PRICES.output,
  cache: { read: RECORDED_PRICES.cacheRead, write: RECORDED_PRICES.input },
}
const RECORDED_RATIO = RECORDED_TURN.cache.read / RECORDED_PREFILL

test("the recorded turn reconciles through the debt projection", () => {
  const { projectedCost } = contextDebt({
    price: RECORDED_TIER,
    contextTokens: RECORDED_PREFILL,
    prefixTokens: RECORDED_PREFILL,
    cacheHitRatio: RECORDED_RATIO,
    outputTokens: RECORDED_OUTPUT,
    projectedTurns: 1,
  })
  expect(projectedCost).toBeCloseTo(RECORDED_COST, 6)
})

test("the per-turn delta is the prefix carrying cost, not the output", () => {
  const { perTurnDelta, projectedCost } = contextDebt({
    price: RECORDED_TIER,
    contextTokens: RECORDED_PREFILL,
    prefixTokens: RECORDED_PREFILL,
    cacheHitRatio: RECORDED_RATIO,
    outputTokens: RECORDED_OUTPUT,
    projectedTurns: 1,
  })
  const expectedPrefix =
    (RECORDED_TURN.input * RECORDED_PRICES.input + RECORDED_TURN.cache.read * RECORDED_PRICES.cacheRead) / 1_000_000
  expect(perTurnDelta).toBeCloseTo(expectedPrefix, 9)
  const expectedOutput = (RECORDED_OUTPUT * RECORDED_PRICES.output) / 1_000_000
  expect(perTurnDelta + expectedOutput).toBeCloseTo(projectedCost, 9)
})

test("debt projection scales with the horizon and clamps bad inputs", () => {
  const one = contextDebt({
    price: RECORDED_TIER,
    contextTokens: RECORDED_PREFILL,
    prefixTokens: RECORDED_PREFILL,
    cacheHitRatio: RECORDED_RATIO,
    outputTokens: RECORDED_OUTPUT,
    projectedTurns: 1,
  })
  const many = contextDebt({
    price: RECORDED_TIER,
    contextTokens: RECORDED_PREFILL,
    prefixTokens: RECORDED_PREFILL,
    cacheHitRatio: RECORDED_RATIO,
    outputTokens: RECORDED_OUTPUT,
    projectedTurns: 5,
  })
  expect(many.projectedCost).toBeCloseTo(one.projectedCost * 5, 9)
  const clamped = contextDebt({ price: RECORDED_TIER, contextTokens: -5, prefixTokens: 1e12, cacheHitRatio: 7 })
  expect(clamped.perTurnDelta).toBe(0)
  expect(clamped.projectedCost).toBe(0)
})

test("compactionRoi prices the break-even against the cache invalidation", () => {
  const price = { input: 1, output: 2, cache: { read: 0.1, write: 1.25 } }
  const roi = compactionRoi({
    price,
    contextTokens: 100_000,
    compactedTokens: 10_000,
    cacheHitRatio: 0.8,
    outputTokens: 1000,
    expectedTurns: 1,
  })
  // keep = 100k × (0.8×0.1 + 0.2×1)/1M + 1k × 2/1M = 0.030
  // steady compacted = 10k × (0.8×0.1 + 0.2×1)/1M + 1k × 2/1M = 0.0048
  expect(roi.perTurnSavings).toBeCloseTo(0.0252, 9)
  // first compacted turn writes the whole prefill at 1.25: 10k × 1.25/1M + 0.002
  expect(roi.invalidationCost).toBeCloseTo(0.0145 - 0.0048, 9)
  expect(roi.breakEvenTurns).toBe(1)
  expect(roi.worthIt).toBe(true)
  expect(compactionRoi({ price, contextTokens: 100_000, compactedTokens: 10_000, cacheHitRatio: 0.8, outputTokens: 1000, expectedTurns: 0 }).worthIt).toBe(false)
})

test("compaction never pays when the savings vanish and the write is dear", () => {
  const price = { input: 1, output: 1, cache: { read: 1, write: 1.25 } }
  const roi = compactionRoi({
    price,
    contextTokens: 50_000,
    compactedTokens: 50_000,
    cacheHitRatio: 0.9,
    outputTokens: 100,
    expectedTurns: 1_000_000,
  })
  expect(roi.perTurnSavings).toBe(0)
  expect(roi.invalidationCost).toBeGreaterThan(0)
  expect(roi.breakEvenTurns).toBe(Infinity)
  expect(roi.worthIt).toBe(false)
})

test("summary generation and a measured rebuild enter the premium", () => {
  const price = { input: 1, output: 2, cache: { read: 0.1, write: 1.25 } }
  const base = {
    price,
    contextTokens: 100_000,
    compactedTokens: 10_000,
    cacheHitRatio: 0.8,
    expectedTurns: 8,
  }
  const plain = compactionRoi(base)
  const withSummary = compactionRoi({ ...base, summaryCost: 0.01 })
  expect(withSummary.summaryCost).toBe(0.01)
  expect(withSummary.invalidationCost).toBeCloseTo(plain.invalidationCost + 0.01, 9)

  // Steady compacted turn = 10,000 × 0.28 / 1M. A measured rebuild of $0.05
  // replaces the modelled first-turn premium.
  const measured = compactionRoi({ ...base, rebuildCost: 0.05, summaryCost: 0.01 })
  expect(measured.rebuildCost).toBe(0.05)
  expect(measured.invalidationCost).toBeCloseTo(0.05 - 0.0028 + 0.01, 9)
  expect(measured.breakEvenTurns).toBe(3)
})

test("an immediate payback reports zero break-even turns", () => {
  const price = { input: 1, output: 0, cache: { read: 0.1, write: 0.05 } }
  const roi = compactionRoi({
    price,
    contextTokens: 100_000,
    compactedTokens: 10_000,
    cacheHitRatio: 0.8,
    expectedTurns: 0,
  })
  expect(roi.invalidationCost).toBeLessThan(0)
  expect(roi.breakEvenTurns).toBe(0)
  expect(roi.worthIt).toBe(true)
})

test("the measured cache state can supply the hit share", () => {
  const price = { input: 1, output: 2, cache: { read: 0.1, write: 1.25 } }
  const base = { price, contextTokens: 100_000, compactedTokens: 10_000, outputTokens: 1000, expectedTurns: 2 }
  const fromUsage = compactionRoi({ ...base, cacheState: { input: 20, cache: { read: 80, write: 0 } } })
  const explicit = compactionRoi({ ...base, cacheHitRatio: 0.8 })
  expect(fromUsage).toEqual(explicit)
})

test("missing prices read as zero instead of inventing money", () => {
  const roi = compactionRoi({ price: {}, contextTokens: 100_000, compactedTokens: 10_000, expectedTurns: 3 })
  expect(roi.perTurnSavings).toBe(0)
  expect(roi.invalidationCost).toBe(0)
  expect(roi.breakEvenTurns).toBe(0)
  const debt = contextDebt({ price: {}, contextTokens: 100_000, prefixTokens: 90_000, projectedTurns: 2 })
  expect(debt.perTurnDelta).toBe(0)
  expect(debt.projectedCost).toBe(0)
})

test("a recorded compaction checkpoint measures a compacted context the model can price", () => {
  const measured = measureSessionContext(RECORDED_COMPACTED_SESSION)
  expect(measured?.tokens).toBeGreaterThan(0)
  expect(measured.tokens).toBeLessThan(RECORDED_PREFILL)
  const roi = compactionRoi({
    price: RECORDED_TIER,
    contextTokens: RECORDED_PREFILL,
    compactedTokens: measured.tokens,
    cacheState: RECORDED_TURN,
    outputTokens: RECORDED_OUTPUT,
    expectedTurns: 3,
  })
  expect(roi.perTurnSavings).toBeGreaterThan(0)
  expect(Number.isFinite(roi.breakEvenTurns)).toBe(true)
  expect(roi.worthIt).toBe(true)
})

import { expect, test } from "bun:test"

import { cacheHitShare } from "../src/tokens.js"

import { RECORDED_PRICES as PRICES, RECORDED_TURN as TURN } from "./fixtures.js"

test("the cache-hit share divides hits by the full prefill", () => {
  expect(cacheHitShare(TURN)).toBeCloseTo(44928 / (39357 + 44928), 6)
})

test("the recorded turn cost reconciles with the miss/hit price split", () => {
  const cost =
    (TURN.input * PRICES.input +
      TURN.cache.read * PRICES.cacheRead +
      (TURN.output + TURN.reasoning) * PRICES.output) /
    1_000_000
  expect(cost).toBeCloseTo(0.028712, 6)
  // Hits exceed `input`, so `input` cannot be the total prompt.
  expect(TURN.cache.read).toBeGreaterThan(TURN.input)
})

test("a turn without cache activity has no share", () => {
  expect(cacheHitShare({ input: 100, output: 10, cache: { read: 0, write: 0 } })).toBe(0)
  expect(cacheHitShare(undefined)).toBe(0)
})

test("the share is capped at 1", () => {
  expect(cacheHitShare({ input: 0, output: 0, cache: { read: 50, write: 0 } })).toBe(1)
})

import { expect, test } from "bun:test"

import { resolveCost } from "../src/cost-resolution.js"
import { REFERENCE_MIX, blendRate, measureMix, unitPrice } from "../src/unit-price.js"

/** A simple rate card in $/Mtok, the shape `planTiers` returns. */
const TIERS = [
  { input: 2, output: 10, cache: { read: 0.2, write: 2.5 } },
]

/** One turn record, the shape the turn log keeps (`tokens` + `usedModel`). */
function turn(tokens, usedModel = "prov/gpt-x") {
  return { usedModel, tokens }
}

test("the reference mix blends at its published weights", () => {
  // 7 : 2 : 1 cache hits : input : output — writes are not a share of the
  // published blend, so they cost nothing extra here.
  const blended = blendRate(TIERS, REFERENCE_MIX)
  // (7×0.2 + 2×2 + 1×10) / 10 = 1.54
  expect(blended).toBeCloseTo(1.54, 6)
})

test("a measured mix replaces the reference mix and is labelled", () => {
  const turns = [
    turn({ input: 100, output: 50, cache: { read: 700, write: 150 } }),
    turn({ input: 100, output: 50, cache: { read: 700, write: 150 } }),
  ]
  const measured = measureMix(turns)
  expect(measured.turns).toBe(2)
  // Shares of 1000 tokens: 100 in, 50 out, 700 read, 150 write each turn.
  expect(measured.mix.input).toBeCloseTo(0.1, 6)
  expect(measured.mix.output).toBeCloseTo(0.05, 6)
  expect(measured.mix.read).toBeCloseTo(0.7, 6)
  expect(measured.mix.write).toBeCloseTo(0.15, 6)
  // The blend weighs every bucket at its own rate, writes included.
  const blended = blendRate(TIERS, measured.mix)
  // (700×0.2 + 100×2 + 150×2.5 + 50×10) / 1000 = 1.215 $/Mtok
  expect(blended).toBeCloseTo(1.215, 6)
})

test("reasoning tokens bill as output in the measured mix", () => {
  const turns = [turn({ input: 0, output: 100, reasoning: 300, cache: { read: 0, write: 0 } })]
  const measured = measureMix(turns)
  expect(measured.mix.output).toBeCloseTo(1, 6)
})

test("the mix narrows to one model's turns", () => {
  const turns = [
    turn({ input: 100, output: 0, cache: { read: 0, write: 0 } }, "prov/a"),
    turn({ input: 0, output: 100, cache: { read: 0, write: 0 } }, "prov/b"),
  ]
  const measured = measureMix(turns, { modelID: "a" })
  expect(measured.turns).toBe(1)
  expect(measured.mix.input).toBe(1)
  expect(measured.mix.output).toBe(0)
})

test("no turns means no measurement, and the stand-in says so", () => {
  expect(measureMix([])).toBeNull()
  expect(measureMix(undefined)).toBeNull()
  const resolved = resolveCost({
    model: { providerID: "prov", id: "gpt-x", cost: { input: 2, output: 10, cache: { read: 0.2, write: 2.5 } } },
  })
  const price = unitPrice({ resolved })
  expect(price.measured).toBe(false)
  expect(price.basis).toContain("reference mix")
  expect(price.basis).toContain("stand-in")
  expect(price.usdPerMTok).toBeCloseTo(1.54, 6)
})

test("a measured basis carries its turn count", () => {
  const resolved = resolveCost({
    model: { providerID: "prov", id: "gpt-x", cost: { input: 2, output: 10, cache: { read: 0.2, write: 2.5 } } },
  })
  const turns = [
    turn({ input: 100, output: 50, cache: { read: 700, write: 150 } }),
    turn({ input: 100, output: 50, cache: { read: 700, write: 150 } }),
    turn({ input: 100, output: 50, cache: { read: 700, write: 150 } }),
  ]
  const price = unitPrice({ resolved, turns, modelID: "gpt-x" })
  expect(price.measured).toBe(true)
  expect(price.basis).toContain("3 turns")
  expect(price.usdPerMTok).toBeCloseTo(1.215, 6)
})

test("a missing cache rate prices cached tokens at the input rate", () => {
  // A vendor that publishes no cache discount bills reads like input.
  const plain = [{ input: 2, output: 10 }]
  expect(blendRate(plain, REFERENCE_MIX)).toBeCloseTo((7 * 2 + 2 * 2 + 1 * 10) / 10, 6)
  expect(blendRate([{ output: 10 }], REFERENCE_MIX)).toBeNull()
})

test("a plan-covered model prices at the plan's rates, with its label", () => {
  const resolved = resolveCost({
    model: { providerID: "p", id: "mimo-v2.6-pro", cost: { input: 3, output: 15 } },
    billing: { vendor: "xiaomi-mimo", plan: "max" },
    listPrice: [{ input: 3, output: 15 }],
  })
  expect(resolved.origin).toBe("plan")
  const price = unitPrice({ resolved })
  expect(price.origin).toBe("plan")
  expect(price.ownBill).toBe(true)
  // MiMo weights: read 2.5, miss 300, write 300, out 600 credits/Mtok-ish —
  // blended at the reference mix and converted at the Max credit price.
  expect(price.usdPerMTok).toBeGreaterThan(0)
})

test("a local model burns nothing and prices at zero", () => {
  const resolved = resolveCost({
    model: { providerID: "l", id: "local", cost: { input: 2, output: 10 } },
    local: true,
  })
  const price = unitPrice({ resolved, local: true })
  expect(price.usdPerMTok).toBe(0)
})

test("no price anywhere means no unit price, never a guess", () => {
  const resolved = resolveCost({ model: { providerID: "p", id: "m" } })
  expect(unitPrice({ resolved })).toBeNull()
})

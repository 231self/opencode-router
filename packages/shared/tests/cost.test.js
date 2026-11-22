import { expect, test } from "bun:test"

import { costSource, mergeCost, normaliseCost, tiersOf, modelledTurnCost } from "../src/cost.js"

const CATALOG = [{ input: 0.15, output: 0.6, cache: { read: 0.003, write: 0 } }]

// models.dev: flat, per-million, `cache_read` instead of `cache.read`.
const MODELSDEV = { input: 4, output: 20, cache_read: 0.2, cache_write: 5 }

// OpenCode's V2 client catalog, as handed to TUI plugins.
const CLIENT = {
  text: {
    input: {
      price: 4,
      cache: { read: 0.2, write: 5 },
      overrides: [
        { when: { context: { gt: 200000 } }, price: 8, cache: { read: 0.4, write: 10 } },
      ],
    },
    output: {
      price: 20,
      overrides: [{ when: { context: { gt: 200000 } }, price: 40 }],
    },
  },
}

test("catalog tiers keep their numbers", () => {
  expect(normaliseCost(CATALOG)).toEqual([
    { input: 0.15, output: 0.6, cache: { read: 0.003, write: 0 } },
  ])
})

test("models.dev flat cost becomes a tier", () => {
  expect(normaliseCost(MODELSDEV)).toEqual([
    { input: 4, output: 20, cache: { read: 0.2, write: 5 } },
  ])
})

test("models.dev long-context tiers become priced tiers", () => {
  const tiers = normaliseCost({
    input: 1,
    output: 5,
    cache_read: 0.05,
    tiers: [{ input: 2, output: 7.5, cache_read: 0.1, tier: { type: "context", size: 272000 } }],
    context_over_200k: { input: 2, output: 7.5, cache_read: 0.1, cache_write: 2.5 },
  })
  expect(tiers).toHaveLength(3)
  expect(tiers[1]).toEqual({
    input: 2,
    output: 7.5,
    cache: { read: 0.1, write: undefined },
    tier: { type: "context", size: 272000 },
  })
  expect(tiers[2].tier.size).toBe(200000)
  expect(tiers[2].cache.write).toBe(2.5)
})

test("the V2 client cost shape becomes a tier with overrides", () => {
  const tiers = normaliseCost(CLIENT)
  expect(tiers[0]).toEqual({ input: 4, output: 20, cache: { read: 0.2, write: 5 } })
  expect(tiers).toHaveLength(2)
  expect(tiers[1]).toEqual({
    tier: { type: "context", size: 200000, gt: true },
    input: 8,
    output: 40,
    cache: { read: 0.4, write: 10 },
  })
})

test("a strict tier survives a normalisation round trip", () => {
  const once = normaliseCost([
    { input: 1, output: 2 },
    { when: { context: { gt: 200_000 } }, input: 2 },
  ])
  const twice = normaliseCost(once)
  expect(twice[1].tier.gt).toBe(true)
  expect(twice[1].tier.size).toBe(200_000)
})

test("models.dev v1 wrapped prices are read", () => {
  expect(normaliseCost({ input: { price: 1.25 }, output: { price: 5 } })).toEqual([
    { input: 1.25, output: 5, cache: { read: undefined, write: undefined } },
  ])
})

test("a missing price stays missing instead of becoming $0", () => {
  const [tier] = normaliseCost({ input: 4, cache: { read: 0.2 } })
  expect(tier.input).toBe(4)
  expect(tier.cache.read).toBe(0.2)
  expect(tier.output).toBeUndefined()
  expect(tier.cache.write).toBeUndefined()
})

test("a real zero is preserved as a price", () => {
  const [tier] = normaliseCost([{ input: 0, output: 0, cache: { read: 0, write: 0 } }])
  expect(tier.input).toBe(0)
  expect(tier.output).toBe(0)
  expect(tier.cache.read).toBe(0)
})

test("string prices and junk are handled", () => {
  expect(normaliseCost({ input: "0.15", output: "0.6" })[0]).toMatchObject({
    input: 0.15,
    output: 0.6,
  })
  expect(normaliseCost({ input: { nope: 1 }, output: "free" })).toEqual([
    { input: undefined, output: undefined, cache: { read: undefined, write: undefined } },
  ])
  expect(normaliseCost(null)).toEqual([])
  expect(normaliseCost([])).toEqual([])
  expect(normaliseCost("nonsense")).toEqual([])
})

test("tiers of an entry can be read directly", () => {
  expect(tiersOf(undefined)).toEqual([])
  expect(tiersOf(CATALOG[0])).toEqual([CATALOG[0]])
})

test("mergeCost fills only what the catalog is missing", () => {
  const fallback = normaliseCost(MODELSDEV)
  const filled = mergeCost(normaliseCost([{ input: 0, output: 0, cache: { read: 0, write: 0 } }]), fallback)
  expect(filled[0]).toEqual({ input: 4, output: 20, cache: { read: 0.2, write: 5 } })

  // Catalog prices win; only the zero the table has an answer for is filled in.
  const kept = mergeCost(normaliseCost(CATALOG), fallback)
  expect(kept[0]).toEqual({ input: 0.15, output: 0.6, cache: { read: 0.003, write: 5 } })

  // A table with no cache-write price leaves the catalog's zero alone.
  const partial = mergeCost(normaliseCost(CATALOG), normaliseCost({ input: 1, output: 2 }))
  expect(partial[0]).toEqual({ input: 0.15, output: 0.6, cache: { read: 0.003, write: 0 } })

  expect(mergeCost([], fallback)).toEqual(fallback)
  expect(mergeCost(normaliseCost(CATALOG), null)).toEqual(normaliseCost(CATALOG))
})

test("costSource names where the price came from", () => {
  const catalog = normaliseCost(CATALOG)
  const zeros = normaliseCost([{ input: 0, output: 0, cache: { read: 0, write: 0 } }])
  const external = normaliseCost(MODELSDEV)
  expect(costSource(catalog, external)).toBe("catalog")
  expect(costSource(zeros, external)).toBe("modelsdev")
  expect(costSource(normaliseCost([]), external)).toBe("modelsdev")
  expect(costSource(zeros, null)).toBe("catalog")
  expect(costSource(normaliseCost([]), null)).toBe("unknown")
})

test("modelledTurnCost charges the cached prefix at the cache price", () => {
  const price = { input: 2, output: 8, cache: { read: 0.5, write: 2 } }
  // cold turn: all input at full price
  expect(
    modelledTurnCost({ price, inputTokens: 1000, prefixTokens: 0, cacheHitRatio: 0.8, outputTokens: 800 }),
  ).toBeCloseTo((1000 * 2 + 800 * 8) / 1_000_000, 9)
  // warm turn: 80% of the 1000-token prefix at the cache-read price
  expect(
    modelledTurnCost({ price, inputTokens: 2000, prefixTokens: 1000, cacheHitRatio: 0.8, outputTokens: 0 }),
  ).toBeCloseTo((1200 * 2 + 800 * 0.5) / 1_000_000, 9)
})

test("modelledTurnCost clamps the ratio and tolerates missing prices", () => {
  const price = { input: 1 }
  expect(
    modelledTurnCost({ price, inputTokens: 100, prefixTokens: 100, cacheHitRatio: 5, outputTokens: 0 }),
  ).toBeCloseTo(0, 9)
  expect(
    modelledTurnCost({ price: {}, inputTokens: 100, prefixTokens: 100, cacheHitRatio: 0.8, outputTokens: 50 }),
  ).toBe(0)
})

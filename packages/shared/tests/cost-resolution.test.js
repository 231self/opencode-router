import { expect, test } from "bun:test"

import { priceSourceLabel, resolveCost } from "../src/cost-resolution.js"

const PLAN = { vendor: "xiaomi-mimo", tier: "max", renewsDay: 1 }

// A flat-rate pool entry: the catalog publishes zeros because the plan covers
// it, so the user pays $0 marginal and every positive price is a stand-in.
const FLAT_ENTRY = {
  providerID: "xiaomi-token-plan-sgp",
  id: "mimo-v2.6-pro",
  cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
}
// A model with a real catalog price: the user pays per token at this rate.
const PRICED_ENTRY = {
  providerID: "deepseek",
  id: "deepseek-flash",
  cost: [{ input: 0.2, output: 0.8, cache: { read: 0.02, write: 0.2 } }],
}
const SIBLING = {
  providerID: "xiaomi",
  id: "mimo-v2.6-pro",
  cost: [{ input: 0.435, output: 0.87, cache: { read: 0.0036, write: 0 } }],
}
const TABLE = [{ input: 2, output: 10, cache: { read: 0.1, write: 2 } }]

test("a plan that covers the model is the user's own bill", () => {
  const resolved = resolveCost({ model: FLAT_ENTRY, billing: PLAN })
  expect(resolved.origin).toBe("plan")
  expect(resolved.source).toBe("plan")
  expect(resolved.ownBill).toBe(true)
  expect(resolved.moneyBasis).toBe("")
  // Plan shadow prices at Max rates: $0.366/M input, $0.732/M output.
  expect(resolved.tiers[0].input).toBeCloseTo(0.366, 3)
  expect(resolved.tiers[0].output).toBeCloseTo(0.732, 3)
  expect(priceSourceLabel(resolved, FLAT_ENTRY)).toContain("plan ·")
})

test("a plan outranks even a public price table", () => {
  const resolved = resolveCost({ model: FLAT_ENTRY, billing: PLAN, listPrice: TABLE })
  expect(resolved.origin).toBe("plan")
  expect(resolved.tiers[0].input).toBeCloseTo(0.366, 3)
})

test("a local model never takes plan prices", () => {
  const resolved = resolveCost({ model: FLAT_ENTRY, billing: PLAN, local: true })
  expect(resolved.origin).not.toBe("plan")
})

test("a public price table outranks the host catalog", () => {
  // Both speak here: the catalog says $0.2/M, the table says $2/M. The table
  // is a published rate; the catalog is the host's own opinion. Table wins on
  // the number — but since this model is priced, the user pays per token and
  // the shown price is still their bill.
  const resolved = resolveCost({ model: PRICED_ENTRY, listPrice: TABLE })
  expect(resolved.origin).toBe("list")
  expect(resolved.tiers[0].input).toBe(2)
  expect(resolved.ownBill).toBe(true)
  expect(resolved.moneyBasis).toBe("")
  expect(priceSourceLabel(resolved, PRICED_ENTRY)).toBe("list price · deepseek/deepseek-flash")
})

test("the host catalog applies when no table entry exists", () => {
  const resolved = resolveCost({ model: PRICED_ENTRY })
  expect(resolved.origin).toBe("catalog")
  expect(resolved.tiers[0].input).toBe(0.2)
  expect(resolved.ownBill).toBe(true)
  expect(priceSourceLabel(resolved, PRICED_ENTRY)).toBe("catalog · deepseek/deepseek-flash")
})

test("a table price for a flat pool is a stand-in and never the user's bill", () => {
  // The pool publishes zeros: the user pays $0 marginal. The table's $2/M is
  // what it would cost at list, so it may inform the report and must not veto.
  const resolved = resolveCost({ model: FLAT_ENTRY, listPrice: TABLE })
  expect(resolved.origin).toBe("list")
  expect(resolved.ownBill).toBe(false)
  expect(resolved.moneyBasis).toBe("at list price")
})

test("a sibling's list price is a projection and never the user's bill", () => {
  // No table entry; xiaomi/mimo-v2.6-pro is the same model with a real price.
  // Worth computing, but it is a projection: it may inform, never veto.
  const resolved = resolveCost({ model: FLAT_ENTRY, reference: SIBLING })
  expect(resolved.origin).toBe("reference")
  expect(resolved.ownBill).toBe(false)
  expect(resolved.moneyBasis).toBe("at list price")
  expect(resolved.tiers[0].input).toBeCloseTo(0.435, 3)
  expect(priceSourceLabel(resolved, FLAT_ENTRY)).toBe("list price · xiaomi/mimo-v2.6-pro")
})

test("a table entry wins over a sibling entry", () => {
  // Both are stand-ins here, but the table is the published one and the
  // sibling is the host catalog's guess at it.
  const resolved = resolveCost({ model: FLAT_ENTRY, listPrice: TABLE, reference: SIBLING })
  expect(resolved.origin).toBe("list")
  expect(resolved.tiers[0].input).toBe(2)
})

test("a plan that has no weights for the model falls through", () => {
  const resolved = resolveCost({
    model: { ...FLAT_ENTRY, id: "some-other-model" },
    billing: PLAN,
    reference: SIBLING,
  })
  // The plan has weights for mimo-v2.6-pro only, so it does not cover this one.
  expect(resolved.origin).toBe("reference")
  expect(resolved.ownBill).toBe(false)
  expect(resolved.moneyBasis).toBe("at list price")
})

test("a flat pool with no reference is free and says so", () => {
  const resolved = resolveCost({ model: FLAT_ENTRY })
  expect(resolved.origin).toBe("none")
  expect(resolved.pricing).toBe("flat")
  expect(resolved.computed).toBe(false)
  // $0 is the user's real marginal cost, so it is their bill — and there is no
  // money to veto on either way.
  expect(resolved.ownBill).toBe(true)
  expect(resolved.unpricedNote).toBe("no reference price · $0 marginal")
  expect(priceSourceLabel(resolved, FLAT_ENTRY)).toBe("none · no reference price")
})

test("no price anywhere is unknown, never free", () => {
  const resolved = resolveCost({ model: { providerID: "openai", id: "gpt-6.2-sol", cost: [] } })
  expect(resolved.origin).toBe("none")
  expect(resolved.pricing).toBe("unknown")
  expect(resolved.computed).toBe(false)
  expect(resolved.unpricedNote).toBe("no price data")
  expect(priceSourceLabel(resolved, { providerID: "openai", id: "gpt-6.2-sol" })).toBe(
    "none · no price data",
  )
})

test("ownBill tracks whether the user pays per token, not which source spoke", () => {
  // The same table price is the user's bill for a priced model (they pay per
  // token) and a stand-in for a flat pool (they pay $0). One rule, one flag.
  const priced = resolveCost({ model: PRICED_ENTRY, listPrice: TABLE })
  const flat = resolveCost({ model: FLAT_ENTRY, listPrice: TABLE })
  expect(priced.origin).toBe(flat.origin)
  expect(priced.ownBill).toBe(true)
  expect(flat.ownBill).toBe(false)
  // ownBill and moneyBasis are two views of one test; they cannot disagree.
  expect(priced.moneyBasis).toBe(priced.ownBill ? "" : "at list price")
  expect(flat.moneyBasis).toBe(flat.ownBill ? "" : "at list price")
})

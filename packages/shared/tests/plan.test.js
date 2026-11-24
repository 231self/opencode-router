import { expect, test } from "bun:test"

import {
  PLAN_CATALOG,
  cacheExpiryCredits,
  creditCoefficient,
  creditCost,
  creditPrice,
  creditsFromTurns,
  currentPeriodStart,
  planForModel,
  measureTokensPerTurn,
  measureWindow,
  planLabel,
  windowBudgetUsd,
  planTiers,
  pricingBasis,
  projectBurn,
  resolveBilling,
  resolveBillings,
  withPlan,
  weightsFor,
} from "../src/plan.js"

/** The published Max tier, as the wizard would record it. */
const MAX = { vendor: "xiaomi-mimo", tier: "max", renewsDay: 1 }

test("the catalog snapshot carries its source", () => {
  const entry = PLAN_CATALOG["xiaomi-mimo"]
  expect(entry.source.url).toBe("https://mimo.mi.com/docs/en-US/price/token-plan")
  expect(entry.source.checked).toBe("2026-11-24")
  expect(entry.source.status).toBe("official")
  expect(entry.tiers.max.priceUsd).toBe(100)
  expect(entry.tiers.max.allowanceCredits).toBe(82e9)
})

test("a catalog-backed record resolves its published numbers", () => {
  const record = resolveBilling(MAX)
  expect(record.priceUsd).toBe(100)
  expect(record.allowanceCredits).toBe(82e9)
  expect(record.allowanceUnit).toBe("credits")
  expect(record.source.status).toBe("official")
  expect(record.name).toContain("Max")
})

test("a record with no price and no catalog match stays unknown", () => {
  expect(resolveBilling({ vendor: "nobody", tier: "nowhere" })).toBeNull()
  expect(resolveBilling(null)).toBeNull()
  expect(resolveBilling({})).toBeNull()
})

test("credit price is plan price over plan allowance", () => {
  // $100 / 82B credits. The shadow price of one credit.
  expect(creditPrice(MAX)).toBeCloseTo(100 / 82e9, 15)
})

test("plan tiers reproduce the derived $/Mtok at Max rates", () => {
  const [tier] = planTiers(MAX, "mimo-v2.6-pro")
  // 2.5 / 300 / 600 credits per token at $100/82B credits.
  expect(tier.cache.read).toBeCloseTo(0.00305, 5)
  expect(tier.input).toBeCloseTo(0.366, 3)
  expect(tier.output).toBeCloseTo(0.732, 3)
})

test("cache writes are billed at the cache-miss weight, explicitly", () => {
  const [tier] = planTiers(MAX, "mimo-v2.6-pro")
  expect(tier.cache.write).toBe(tier.input)
  expect(resolveBilling(MAX).weightsNote).toContain("cache writes")
})

test("plan tiers for a model with no published weights stay null", () => {
  expect(planTiers(MAX, "some-other-model")).toBeNull()
})

test("weights resolve per model, or from a single configured table", () => {
  expect(weightsFor(MAX, "mimo-v2.6-flash").cacheMissInput).toBe(100)
  expect(weightsFor(MAX, "unknown")).toBeNull()
  const custom = { priceUsd: 20, allowanceTokens: 1e6, weights: { cacheHitInput: 1, cacheMissInput: 10, output: 20 } }
  expect(weightsFor(custom, "anything").output).toBe(20)
})

test("credit cost charges each usage bucket at its own weight", () => {
  const usage = {
    input: 1000,
    output: 500,
    reasoning: 200,
    cache: { read: 10000, write: 2000 },
  }
  // (1000 fresh + 2000 write) * 300 + 10000 * 2.5 + (500 + 200) * 600
  expect(creditCost(usage, MAX, "mimo-v2.6-pro")).toBe(3000 * 300 + 10000 * 2.5 + 700 * 600)
  expect(creditCost(usage, MAX, "no-such-model")).toBeNull()
})

test("cache expiry pricing shows the premium an expiry charges", () => {
  const expiry = cacheExpiryCredits(500_000, MAX, "mimo-v2.6-pro")
  // 500k prefix: hot 1.25M credits, cold 150M credits, 120x ratio.
  expect(expiry.hot).toBe(500_000 * 2.5)
  expect(expiry.cold).toBe(500_000 * 300)
  expect(expiry.premium).toBe(500_000 * 297.5)
  expect(expiry.ratio).toBe(120)
})

test("the off-peak coefficient applies only inside its window", () => {
  expect(creditCoefficient(MAX, new Date("2026-11-24T20:00:00Z"))).toBe(0.8)
  expect(creditCoefficient(MAX, new Date("2026-11-24T08:00:00Z"))).toBe(1)
  const noWindow = { vendor: "custom", priceUsd: 10, allowanceCredits: 1e9 }
  expect(creditCoefficient(noWindow, new Date("2026-11-24T20:00:00Z"))).toBe(1)
})

test("the allowance period starts on the renewal day", () => {
  const start = currentPeriodStart(MAX, new Date("2026-11-24T12:00:00Z"))
  expect(start.toISOString()).toBe("2026-11-01T00:00:00.000Z")
  expect(currentPeriodStart({ priceUsd: 10, allowanceCredits: 1e9 }, new Date())).toBeNull()
})

test("burn projection reports used, free, and the projection basis", () => {
  const burn = projectBurn({
    billing: MAX,
    usedCredits: 12.4e9,
    now: Date.parse("2026-11-24T00:00:00Z"),
    resetsAt: Date.parse("2026-12-01T00:00:00Z"),
    elapsedMs: 24 * 3600 * 1000 * 23,
  })
  expect(burn.used).toBe(12.4e9)
  expect(burn.free).toBeCloseTo(69.6e9, 3)
  expect(burn.percentUsed).toBeCloseTo(15.1, 1)
  expect(burn.daysLeft).toBeCloseTo(7, 1)
  expect(burn.basis).toContain("renews")
  // 23 of 30 days elapsed -> projected = used / (23/30).
  expect(burn.projected).toBeCloseTo(12.4e9 / (23 / 30), 3)
})

test("burn projection with no known reset says so", () => {
  const burn = projectBurn({ billing: { priceUsd: 10, allowanceCredits: 1000 }, usedCredits: 100 })
  expect(burn.basis).toContain("reset date unknown")
  expect(burn.projected).toBeGreaterThan(burn.used)
})

test("credits from turns sum the period and count what they skipped", () => {
  const periodStart = Date.parse("2026-11-01T00:00:00Z")
  const turns = [
    // In period: mimo-v2.6-pro at 2.5/300/600 weights.
    {
      ts: periodStart + 86400000,
      usedModel: "xiaomi-token-plan-sgp/mimo-v2.6-pro",
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 1_000_000, write: 0 } },
    },
    // In period, model with no published weights: skipped, not counted.
    {
      ts: periodStart + 2 * 86400000,
      usedModel: "someone/other-model",
      tokens: { input: 1000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    // Last month: outside the period.
    {
      ts: periodStart - 86400000,
      usedModel: "xiaomi-token-plan-sgp/mimo-v2.6-pro",
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 9_000_000, write: 0 } },
    },
  ]
  const result = creditsFromTurns(turns, MAX, {
    now: Date.parse("2026-11-24T00:00:00Z"),
    modelID: "mimo-v2.6-pro",
  })
  expect(result.credits).toBe(1_000_000 * 2.5)
  expect(result.counted).toBe(1)
  expect(result.skipped).toBe(1)
  expect(creditsFromTurns([], MAX)).toMatchObject({ credits: 0, counted: 0, skipped: 0 })
})

test("the plan label names the plan and its price", () => {
  expect(planLabel(MAX)).toBe("Xiaomi MiMo Token Plan Max · $100/mo")
  expect(planLabel({})).toBeNull()
})

test("a price without a published allowance is recorded but unpriced", () => {
  // Claude Pro: the price is public, the token allowance is not — no quota,
  // no message budget. The record survives so the plan can be shown, but
  // nothing that needs an allowance is allowed to produce a number.
  const record = resolveBilling({ vendor: "anthropic-claude", tier: "pro", renewsDay: 1 })
  expect(record).not.toBeNull()
  expect(record.name).toBe("Claude Pro")
  expect(record.priceUsd).toBe(20)
  expect(record.capType).toBe("usage-window")
  expect(record.unpriced).toBe(true)
  expect(record.allowanceCredits).toBeNull()
  expect(record.weights).toBeNull()

  // Every quantitative helper declines rather than inventing a value.
  expect(creditPrice(record)).toBeNull()
  expect(planTiers(record, "gpt-anything")).toBeNull()
  expect(weightsFor(record, "gpt-anything")).toBeNull()
  expect(creditsFromTurns([], record)).toBeNull()
  expect(cacheExpiryCredits(500_000, record, "gpt-anything")).toBeNull()
  expect(projectBurn({ billing: record, usedCredits: 100 })).toBeNull()

  // The label states the price and the missing allowance in one line.
  const label = planLabel(record)
  expect(label).toContain("$20/mo")
  expect(label).toContain("allowance not published")
})

test("the feed lookup keys are carried on the record", () => {
  const record = resolveBilling({ vendor: "openai-codex", tier: "plus" })
  expect(record.feed).toEqual({ provider: "limitdex", tool: "codex" })
  expect(record.feedPlan).toBe("Plus")
  // A MiMo plan has an official source but no tracker feed.
  expect(resolveBilling(MAX).feed).toBeNull()
})

test("a plan with neither price nor allowance is still not a record", () => {
  expect(resolveBilling({ vendor: "openai-codex", tier: "nope" })).toBeNull()
  expect(resolveBilling({ payg: true })).toBeNull()
})

test("a billing config holds several plans and attributes each model to one", () => {
  const plans = [
    { vendor: "xiaomi-mimo", tier: "max", renewsDay: 1, models: ["mimo-v2.6-pro"] },
    { vendor: "openai-codex", tier: "plus", renewsDay: 1, models: ["gpt-6.1-sol"] },
  ]
  expect(resolveBillings(plans)).toHaveLength(2)
  expect(planForModel(plans, "mimo-v2.6-pro").name).toBe("Xiaomi MiMo Token Plan Max")
  expect(planForModel(plans, "gpt-6.1-sol").name).toBe("ChatGPT Plus")
  // A model neither plan claims has no plan pricing at all.
  expect(planForModel(plans, "claude-opus-5-5")).toBeNull()
  // Each model is priced at its own plan's weights.
  expect(planTiers(plans, "mimo-v2.6-pro")[0].input).toBeCloseTo(0.366, 3)
  expect(planTiers(plans, "gpt-6.1-sol")).toBeNull()
})

test("a single plan still covers every model it prices", () => {
  // The pre-multi-plan shape must behave exactly as before.
  expect(planForModel(MAX, "mimo-v2.6-pro").name).toBe("Xiaomi MiMo Token Plan Max")
  expect(planForModel(MAX, "anything-at-all").name).toBe("Xiaomi MiMo Token Plan Max")
  expect(planTiers(MAX, "mimo-v2.6-pro")[0].input).toBeCloseTo(0.366, 3)
})

test("a weight row beats a catch-all when two plans could claim a model", () => {
  const plans = [
    { vendor: "openai-codex", tier: "plus", renewsDay: 1 },
    { vendor: "xiaomi-mimo", tier: "max", renewsDay: 1 },
  ]
  // The catch-all ChatGPT plan is listed first, but the MiMo plan publishes a
  // weight row for mimo-v2.6-pro, so the vendor's own statement wins.
  expect(planForModel(plans, "mimo-v2.6-pro").name).toBe("Xiaomi MiMo Token Plan Max")
})

test("each plan burns its own allowance, priced at its own model", () => {
  const plans = [
    { vendor: "xiaomi-mimo", tier: "max", renewsDay: 1, models: ["mimo-v2.6-pro"] },
    { vendor: "xiaomi-mimo", tier: "pro", renewsDay: 1, models: ["mimo-v2.6-flash"] },
  ]
  const now = Date.parse("2026-11-24T00:00:00Z")
  const turns = [
    { ts: now + 86400000, usedModel: "sgp/mimo-v2.6-pro",
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 1_000_000, write: 0 } } },
    { ts: now + 86400000, usedModel: "sgp/mimo-v2.6-flash",
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 1_000_000, write: 0 } } },
  ]
  const result = creditsFromTurns(turns, plans, { now })
  expect(result.byPlan).toHaveLength(2)
  // Max prices mimo-v2.6-pro at 2.5 credits per cache read; Pro prices
  // mimo-v2.6-flash at 2. Each plan's share is its own, not blended.
  const max = result.byPlan.find((entry) => entry.record.tier === "max")
  const pro = result.byPlan.find((entry) => entry.record.tier === "pro")
  expect(max.credits).toBe(2_500_000)
  expect(pro.credits).toBe(2_000_000)
  expect(result.credits).toBe(4_500_000)
})

test("a plan with no published window or quota is unpriced, never free", () => {
  // Claude publishes usage multipliers only: no token quota, no message
  // budget. Nothing can be derived, so no shadow price exists.
  const plans = [{ vendor: "anthropic-claude", tier: "pro", renewsDay: 1, models: ["claude-opus-5-5"] }]
  expect(planTiers(plans, "claude-opus-5-5")).toBeNull()
  expect(resolveBillings(plans)[0].unpriced).toBe(true)
})

test("adding a plan accumulates; pay-per-token and skip replace", () => {
  const mimo = { vendor: "xiaomi-mimo", tier: "max", renewsDay: 1 }
  const chatgpt = { vendor: "openai-codex", tier: "plus", renewsDay: 1 }
  // First plan starts the list.
  const one = withPlan(undefined, mimo)
  expect(resolveBillings(one)).toHaveLength(1)
  // A second plan sits beside the first, neither lost.
  const two = withPlan(one, chatgpt)
  expect(resolveBillings(two)).toHaveLength(2)
  expect(two.map((p) => p.vendor)).toEqual(["xiaomi-mimo", "openai-codex"])
  // The config holds what was typed, not what was derived from it.
  expect(two[0]).toEqual(mimo)
  // "Pay per token" says no plan applies and clears them.
  expect(resolveBillings(withPlan(two, { payg: true }))).toHaveLength(0)
  // A plan named later supersedes that marker again.
  expect(resolveBillings(withPlan({ payg: true }, mimo))).toHaveLength(1)
})

test("a dollar budget prices against the model's own list price, not a guess", () => {
  // GitHub Copilot Pro: $10/mo buys $15 of API credits. The token count that
  // $15 buys depends on the model, so N comes from the model's list price.
  // factor = priceUsd / allowanceUsd = 10/15 = 0.667 of list.
  const copilot = { vendor: "github-copilot", tier: "pro", renewsDay: 1 }
  const record = resolveBilling(copilot)
  expect(record.unpriced).toBe(false)
  expect(record.allowanceUnit).toBe("usd")
  expect(record.allowanceUsd).toBe(15)
  expect(record.discountFactor).toBeCloseTo(10 / 15, 3)

  // The model's own list price is the source for N. Effective price is that
  // list price scaled by the discount factor.
  const listPrice = [{ input: 3, output: 15, cache: { read: 0.3, write: 3 } }]
  const tiers = planTiers(copilot, "claude-opus-5-5", { listPrice })
  expect(tiers[0].input).toBeCloseTo(3 * (10 / 15), 3)
  expect(tiers[0].output).toBeCloseTo(15 * (10 / 15), 3)
  expect(tiers[0].cache.read).toBeCloseTo(0.3 * (10 / 15), 3)
})

test("a dollar budget with no list price has no source and prices nothing", () => {
  const copilot = { vendor: "github-codex", tier: "pro", priceUsd: 10, allowanceUsd: 15 }
  // Without a model list price there is no N to divide by, so no price.
  expect(planTiers(copilot, "some-model")).toBeNull()
})

test("a dollar budget burns dollars, not credits", () => {
  const copilot = { vendor: "github-copilot", tier: "pro", renewsDay: 1 }
  // No credit weights exist for a dollar plan, so credit arithmetic is null
  // rather than an invented zero.
  expect(weightsFor(copilot, "any-model")).toBeNull()
  expect(creditPrice(copilot)).toBeNull()
  expect(creditCost({ input: 1000 }, copilot, "any-model")).toBeNull()
})

test("a published token quota prices exactly, with no derivation", () => {
  // Bolt Pro publishes "10M tokens/month, rollover included" — a real N.
  // The shadow price is price ÷ tokens, exact: $25 / 10M = $2.5/M.
  const bolt = { vendor: "bolt", tier: "pro" }
  const record = resolveBilling(bolt)
  expect(record.allowanceUnit).toBe("tokens")
  expect(record.allowanceTokens).toBe(10e6)
  // A plain token quota counts every token once: input, output, cache reads.
  expect(weightsFor(bolt, "any-model")).toEqual({ cacheHitInput: 1, cacheMissInput: 1, output: 1 })
  const tiers = planTiers(bolt, "any-model")
  expect(tiers[0].input).toBeCloseTo(2.5, 10)
  expect(tiers[0].output).toBeCloseTo(2.5, 10)
})

test("the three source qualities stay distinct", () => {
  // Published quota: exact. Dollar budget: derived from the model's list
  // price. Usage window: nothing published, so nothing computed.
  const listPrice = [{ input: 3, output: 15, cache: { read: 0.3, write: 3 } }]
  const quota = resolveBilling({ vendor: "bolt", tier: "pro" })
  const budget = resolveBilling({ vendor: "github-copilot", tier: "pro" })
  const window = resolveBilling({ vendor: "anthropic-claude", tier: "pro" })
  expect(quota.allowanceUnit).toBe("tokens")
  expect(budget.allowanceUnit).toBe("usd")
  expect(window.unpriced).toBe(true)
  // Only the usage window computes nothing at all.
  expect(planTiers({ vendor: "anthropic-claude", tier: "pro" }, "m", { listPrice })).toBeNull()
  // The dollar budget needs a list price to convert; without one, no source.
  expect(planTiers({ vendor: "github-copilot", tier: "pro" }, "m")).toBeNull()
  expect(planTiers({ vendor: "github-copilot", tier: "pro" }, "m", { listPrice })).not.toBeNull()
})

test("tokens per message is measured from turns, never assumed", () => {
  // Three turns of 50K, 60K, 70K total tokens → 60K average. The count
  // travels with the figure so a display can say where it came from.
  const turn = (n) => ({ tokens: { input: n, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
  const m = measureTokensPerTurn([turn(50_000), turn(60_000), turn(70_000)])
  expect(m.tokensPerTurn).toBe(60_000)
  expect(m.turns).toBe(3)
  // No turns to measure: nothing, not a guess.
  expect(measureTokensPerTurn([])).toBeNull()
})

test("a usage window becomes a dollar value from window + plan cost", () => {
  // ChatGPT Plus: 160 messages per 5h of GPT-6.1 Sol. Sol lists at $2/M.
  // If a message is 60K tokens (measured), the window's monthly value is:
  //   160 msgs × 60K tokens × 144 windows × $2/M = $2764.80
  const W = windowBudgetUsd({
    messagesPerWindow: 160,
    windowHours: 5,
    tokensPerMessage: 60_000,
    refPrice: 2,
    daysPerMonth: 30,
  })
  expect(W).toBeCloseTo(2764.8, 3)
  // A missing input means no value — nothing invented.
  expect(windowBudgetUsd({ messagesPerWindow: 160, windowHours: 5, refPrice: 2 })).toBeNull()
})

test("one window prices every model at its own list price, never flat", () => {
  // The window is worth a fixed amount of API, so each model buys a different
  // share of it. Luna at $0.1/M gets 100x the tokens of Astra at $10/M, so
  // Astra's shadow price is 100x Luna's. This is the opposite of flat pooling.
  const chatgpt = { vendor: "openai-codex", tier: "plus", renewsDay: 1 }
  const measured = { tokensPerMessage: 60_000, refPrice: 2 }
  const luna = [{ input: 0.1, output: 0.5, cache: { read: 0.01, write: 0.1 } }]
  const astra = [{ input: 10, output: 50, cache: { read: 1, write: 10 } }]
  const l = planTiers(chatgpt, "gpt-6-luna", { listPrice: luna, ...measured })
  const a = planTiers(chatgpt, "gpt-6-astra", { listPrice: astra, ...measured })
  // Both are priced — the window gives both a shadow price.
  expect(l).not.toBeNull()
  expect(a).not.toBeNull()
  // Per-model, in proportion to their own list prices: 100x apart.
  expect(a[0].input / l[0].input).toBeCloseTo(100, 6)
})

test("measureWindow reports the measured evidence, not a bare number", () => {
  const turn = (n) => ({ tokens: { input: n, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
  const patch = measureWindow(
    { vendor: "openai-codex", tier: "plus" },
    { turns: [turn(50_000), turn(70_000)], refPrice: 2 },
  )
  expect(patch.tokensPerMessage).toBe(60_000)
  expect(patch.measuredTurns).toBe(2)
  expect(patch.allowanceUsd).toBeCloseTo(2764.8, 3)
  // No turns to measure the message size from: no value, not a guess.
  expect(measureWindow({ vendor: "openai-codex", tier: "plus" }, { refPrice: 2 })).toBeNull()
})

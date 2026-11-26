import { expect, test } from "bun:test"

import {
  buildDecisions,
  buildModels,
  buildPlans,
  buildSummary,
  buildTrends,
} from "../src/web-data.js"

/** A rate card for the fixture model, $/Mtok. */
const rates = { input: 2, output: 10, cache: { read: 0.2, write: 2.5 } }
const ratesOf = () => rates

/** Turn records across two sessions. Sensitive-shaped fields ride along to
 * prove the allow-list projection drops them. */
function turn(ts, session, extra = {}) {
  return {
    ts,
    session,
    usedModel: "deepseek/deepseek-flash",
    tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 700, write: 150 } },
    promptText: "SECRET PROMPT",
    toolOutput: "SECRET TOOL OUTPUT",
    ...extra,
  }
}

const TURNS = [
  turn(1_700_000_000_000, "ses_a"),
  turn(1_700_000_100_000, "ses_a"),
  turn(1_700_086_400_000, "ses_b"),
]

const DECISIONS = [
  {
    ts: 1_700_000_000_000,
    session: "ses_a",
    chosen: "deepseek/deepseek-flash",
    source: "core",
    reason: "kept for cache",
    stage: "primary",
    turnClass: "routine",
    apiKey: "SECRET KEY",
  },
  {
    ts: 1_700_086_400_000,
    session: "ses_b",
    chosen: "other/model",
    source: "core",
    reason: "cheaper",
    stage: "primary",
    turnClass: "planning",
  },
]

const POOL = [
  {
    providerID: "deepseek",
    modelID: "deepseek-flash",
    name: "DeepSeek Flash",
    local: false,
    cost: [rates],
    costSource: "catalog",
  },
]

test("decisions: contract, scope filter, and limit", () => {
  const all = buildDecisions({ decisions: DECISIONS })
  expect(all.scope).toBe("all")
  expect(all.items).toHaveLength(2)
  expect(all.items[0].chosen).toBeTruthy()
  const scoped = buildDecisions({ decisions: DECISIONS, scope: "session", session: "ses_a" })
  expect(scoped.items).toHaveLength(1)
  expect(scoped.items[0].reason).toBe("kept for cache")
  const limited = buildDecisions({ decisions: DECISIONS, limit: 1 })
  expect(limited.items).toHaveLength(1)
})

test("trends: daily buckets price the turn's exact buckets at resolved rates", () => {
  const trends = buildTrends({ turns: TURNS, ratesOf, now: 1_700_100_000_000, days: 30 })
  expect(trends.daily.length).toBeGreaterThanOrEqual(2)
  const first = trends.daily[0]
  // Two turns on day one: (700×0.2 + 100×2 + 150×2.5 + 50×10) / 1e6 each.
  expect(first.spendUsd).toBeCloseTo(0.00243, 9)
  expect(first.turns).toBe(2)
  expect(first.cacheReadTokens).toBe(1400)
  const scoped = buildTrends({ turns: TURNS, scope: "session", session: "ses_b", ratesOf, now: 1_700_100_000_000 })
  const totalTurns = scoped.daily.reduce((sum, day) => sum + day.turns, 0)
  expect(totalTurns).toBe(1)
})

test("models: the unit price is scoped, measured or stand-in", () => {
  const scoped = buildModels({ pool: POOL, turns: TURNS, scope: "session", session: "ses_a" })
  const [model] = scoped.models
  expect(model.unitPrice.measured).toBe(true)
  expect(model.unitPrice.basis).toContain("2 turns")
  // The measured mix is 0.1 read / 0.1 in / 0.15 write / 0.05 out:
  // 0.7×0.2 + 0.1×2 + 0.15×2.5 + 0.05×10 = 1.215 $/Mtok
  expect(model.unitPrice.usdPerMTok).toBeCloseTo(1.215, 6)
  // No turns for this model in scope: the published stand-in, labelled.
  const empty = buildModels({ pool: POOL, turns: [], scope: "session", session: "ses_x" })
  expect(empty.models[0].unitPrice.measured).toBe(false)
  expect(empty.models[0].unitPrice.basis).toContain("stand-in")
})

test("models: a local model prices at zero", () => {
  const local = [{ ...POOL[0], modelID: "local-4b", local: true, cost: [{ input: 0, output: 0 }] }]
  const built = buildModels({ pool: local, turns: TURNS })
  expect(built.models[0].unitPrice.usdPerMTok).toBe(0)
})

test("plans: burn where it is computable, the note where it is not", () => {
  const billing = { type: "subscription", vendor: "xiaomi-mimo", plan: "max", renewsDay: 1 }
  const built = buildPlans({ billing, turns: TURNS, now: Date.now() })
  expect(built.plans).toHaveLength(1)
  const [plan] = built.plans
  expect(plan.type).toBe("subscription")
  expect(plan.vendor).toBe("xiaomi-mimo")
  expect(plan.plan).toBe("max")
  expect(plan.burn).toBeTruthy()
  // An unpriced plan (ChatGPT Pro) carries its note and no invented burn.
  const unpriced = buildPlans({
    billing: { vendor: "openai-codex", plan: "pro" },
    turns: [],
    now: Date.now(),
  })
  expect(unpriced.plans[0].burn).toBeNull()
  expect(unpriced.plans[0].allowanceNote).toContain("weekly")
})

test("the allow-list projection drops sensitive fields from every response", () => {
  const billing = { vendor: "xiaomi-mimo", plan: "max", renewsDay: 1, apiKey: "SECRET KEY" }
  const pool = [{ ...POOL[0], apiKey: "SECRET KEY", promptText: "SECRET PROMPT" }]
  const pin = {
    model: { id: "deepseek/deepseek-flash" },
    compaction: {
      advisory: {
        verdict: "compact-now",
        breakEvenTurns: 2,
        perTurnSavings: 0.01,
        invalidationCost: 0.02,
        worthIt: true,
        promptText: "SECRET PROMPT",
        unitPrice: { usdPerMTok: 0.12, basis: "measured mix · 2 turns", measured: true },
      },
    },
  }
  const outputs = [
    buildDecisions({ decisions: DECISIONS }),
    buildTrends({ turns: TURNS, ratesOf, now: Date.now() }),
    buildModels({ pool, turns: TURNS }),
    buildPlans({ billing, turns: TURNS, now: Date.now() }),
    buildSummary({ turns: TURNS, decisions: DECISIONS, pin, billing, pool, ratesOf, now: Date.now() }),
  ]
  const json = JSON.stringify(outputs)
  expect(json).not.toContain("SECRET")
  expect(json).not.toContain("promptText")
  expect(json).not.toContain("toolOutput")
  expect(json).not.toContain("apiKey")
})

test("summary: totals, headline model, and compaction economics", () => {
  const pin = {
    compaction: {
      advisory: {
        verdict: "compact-now",
        breakEvenTurns: 2,
        perTurnSavings: 0.01,
        invalidationCost: 0.02,
        worthIt: true,
        unitPrice: { usdPerMTok: 0.12, basis: "measured mix · 2 turns", measured: true },
      },
    },
  }
  const summary = buildSummary({
    turns: TURNS,
    decisions: DECISIONS,
    pin,
    pool: POOL,
    ratesOf,
    now: 1_700_100_000_000,
  })
  expect(summary.totals.turns).toBe(3)
  expect(summary.totals.spendUsd).toBeGreaterThan(0)
  expect(summary.headline.model).toBe("deepseek/deepseek-flash")
  expect(summary.compaction.verdict).toBe("compact-now")
  expect(summary.compaction.breakEvenTurns).toBe(2)
})

import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { DEFAULT_CONFIG } from "@231self/opencode-shared/config.js"
import { readPin, writePin } from "@231self/opencode-shared/state.js"

import { runContext } from "../src/context.js"
import tui, { advisoryReport } from "../src/tui.js"

const MODELS = [
  {
    providerID: "deepseek",
    id: "deepseek-v4-pro",
    name: "DeepSeek Pro",
    type: "chat",
    cost: [{ input: 1, output: 2, cache: { read: 0.1, write: 1.25 } }],
    limit: { context: 262144, output: 131072 },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    status: "active",
  },
]

function tempEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omlx-compaction-surface-"))
  return {
    OMLX_ROUTER_CONFIG: path.join(dir, "config.json"),
    OMLX_ROUTER_STATE: path.join(dir, "state"),
    OMLX_ROUTER_FAVORITES: path.join(dir, "favorites.json"),
  }
}

function harness({ env, core = {}, compact = async () => {}, config = {} }) {
  // `compact: null` models a host that exposes no session.compact at all.
  const session = { get: async () => ({ id: "ses_1", agent: "build" }) }
  if (compact) session.compact = compact
  const ctx = {
    model: { list: async () => MODELS },
    provider: { list: async () => [] },
    session,
    agent: { get: async () => ({ id: "build", mode: "primary" }) },
  }
  return {
    ctx,
    run: (event) => runContext({ host: "opencode", env, ctx, config, core, event }),
  }
}

test("an accepted /ctx here is recorded as accepted", async () => {
  const env = tempEnv()
  const { run } = harness({ env })
  writePin("opencode", "ses_1", { compaction: { requestedAt: 12345 } }, env)
  await run({ sessionID: "ses_1", model: MODELS[0], system: [], messages: [{ parts: [] }] })
  const result = readPin("opencode", "ses_1", env).compaction.requestedResult
  expect(result.ok).toBe(true)
  expect(result.via).toBe("session.compact")
  expect(result.requestedAt).toBe(12345)
})

test("a failed /ctx here records the failure instead of vanishing", async () => {
  // This path used to swallow every error, which is how /ctx here could look
  // broken forever with no way to tell why.
  const env = tempEnv()
  const { run } = harness({
    env,
    compact: async () => {
      const error = new Error("conflict")
      error.status = 409
      throw error
    },
  })
  writePin("opencode", "ses_1", { compaction: { requestedAt: 1 } }, env)
  await run({ sessionID: "ses_1", model: MODELS[0], system: [], messages: [{ parts: [] }] })
  const result = readPin("opencode", "ses_1", env).compaction.requestedResult
  expect(result.ok).toBe(false)
  // A status code is safe to persist; an error message may echo prompt text.
  expect(result.error).toBe("http 409")
  expect(readPin("opencode", "ses_1", env).compaction.requestedAt).toBeUndefined()
})

test("a host without session.compact is reported, not skipped silently", async () => {
  const env = tempEnv()
  const { run, ctx } = harness({ env, compact: null })
  expect(ctx.session.compact).toBeUndefined()
  writePin("opencode", "ses_1", { compaction: { requestedAt: 1 } }, env)
  await run({ sessionID: "ses_1", model: MODELS[0], system: [], messages: [{ parts: [] }] })
  const result = readPin("opencode", "ses_1", env).compaction.requestedResult
  expect(result.ok).toBe(false)
  expect(result.via).toBe("none")
  expect(result.error).toBe("the host exposes no session.compact")
})

test("the report says what the host did with the last /ctx here", () => {
  const pin = {
    compaction: {
      verdict: "not-yet",
      turns: 3,
      changedTurns: 1,
      requestedResult: { at: 1, requestedAt: 1, ok: false, via: "session.compact", error: "http 409" },
      advisory: {
        verdict: "not-yet",
        source: "deterministic",
        confidence: 0.7,
        breakEvenTurns: null,
        perTurnSavings: null,
        worthIt: null,
        pricing: "unknown",
        cache: { ratio: 0, samples: 0, source: "none" },
        signals: { contextTokens: 30000, growth: 0 },
      },
    },
  }
  const report = advisoryReport(pin, { noise: { instability: 0 }, expectedTurns: 8 })
  for (const line of report.split("\n")) expect(line.length).toBeLessThanOrEqual(72)
  expect(report).toContain("last /ctx here")
  expect(report).toContain("failed · http 409")
})

test("a /ctx here marker is honored once and cleared", async () => {
  const env = tempEnv()
  const compacted = []
  const { run, ctx } = harness({
    env,
    compact: async ({ sessionID }) => compacted.push(sessionID),
  })
  writePin(
    "opencode",
    "ses_1",
    { model: { providerID: "deepseek", id: "deepseek-v4-pro" }, compaction: { requestedAt: 12345 } },
    env,
  )
  await run({ sessionID: "ses_1", model: MODELS[0], system: [], messages: [{ parts: [] }] })
  expect(compacted).toEqual(["ses_1"])
  expect(readPin("opencode", "ses_1", env).compaction.requestedAt).toBeUndefined()

  // The marker is gone: a second turn must not compact again.
  await run({ sessionID: "ses_1", model: MODELS[0], system: [], messages: [{ parts: [] }] })
  expect(compacted).toEqual(["ses_1"])
  expect(ctx.session.compact).toBeDefined()
})

test("a refused compaction clears the marker anyway and never throws", async () => {
  const env = tempEnv()
  const { run } = harness({
    env,
    compact: async () => {
      throw new Error("host refused")
    },
  })
  writePin("opencode", "ses_1", { compaction: { requestedAt: 1 } }, env)
  await run({ sessionID: "ses_1", model: MODELS[0], system: [], messages: [{ parts: [] }] })
  expect(readPin("opencode", "ses_1", env).compaction.requestedAt).toBeUndefined()
})

test("the context hook records the advisory and guard in the pin", async () => {
  const env = tempEnv()
  const messages = [
    { info: { role: "user" }, parts: [{ type: "text", text: "implement the parser change" }] },
    {
      info: { role: "assistant" },
      parts: [
        { type: "tool", tool: "bash", state: { status: "completed", output: "x".repeat(4000) } },
        { type: "tool", tool: "bash", state: { status: "completed", output: "x".repeat(4000) } },
        { type: "tool", tool: "bash", state: { status: "completed", output: "x".repeat(4000) } },
      ],
    },
    { info: { role: "assistant" }, parts: [{ type: "text", text: "Changes applied: y".repeat(40) }] },
  ]
  // The hook measures post-optimise; the mock core reports the real sizes.
  const core = {
    optimise: () => ({
      plan: [],
      stats: { beforeTokens: 60_000, afterTokens: 55_000, partsPruned: 0, overflow: false },
    }),
  }
  const { run } = harness({ env, core, config: { ...DEFAULT_CONFIG } })
  writePin("opencode", "ses_1", { model: { providerID: "deepseek", id: "deepseek-v4-pro" }, lastContextTokens: 30_000 }, env)
  await run({ sessionID: "ses_1", model: MODELS[0], system: [], messages })
  const pin = readPin("opencode", "ses_1", env)
  expect(pin.compaction.advisory.verdict).toBe("compact-now")
  expect(pin.compaction.turns).toBe(1)
  expect(pin.compaction.changedTurns).toBe(1)
})

test("the advisory popup wraps within 80 columns and reports one fact per row", () => {
  const pin = {
    compaction: {
      verdict: "compact-now",
      turns: 5,
      changedTurns: 2,
      advisory: {
        verdict: "compact-now",
        source: "deterministic",
        confidence: 0.72,
        breakEvenTurns: 2,
        perTurnSavings: 0.0123,
        worthIt: true,
        cache: { ratio: 0.82, samples: 6, source: "measured" },
        estimates: {
          summaryTokens: 940,
          summarySource: "measured",
          summaryCost: 0.0041,
          summaryCostSource: "estimated",
          rebuildCost: 0.0012,
          rebuildSource: "measured",
          lastPrediction: { predicted: 4300, actual: 5100, error: 0.186 },
          predictionError: 0.12,
        },
        projections: [
          { turns: 3, net: -0.0041, worthIt: false },
          { turns: 8, net: 0.0524, worthIt: true },
          { turns: 15, net: 0.14, worthIt: true },
        ],
      },
    },
  }
  const report = advisoryReport(pin, { noise: { instability: 0.25 }, expectedTurns: 8 })
  const lines = report.split("\n")
  for (const line of lines) expect(line.length).toBeLessThanOrEqual(72)
  expect(report).toContain("compact-now")
  expect(report).toContain("break-even")
  expect(report).toContain("2 turns")
  expect(report).toContain("/ctx here")
  expect(report).toContain("0.25")
  expect(report).toContain("82%")
  expect(report).toContain("measured")
  expect(report).toContain("horizons")
  expect(report).toContain("3 turns")
  expect(report).toContain("-$0.0041")
  expect(report).toContain("estimation")
  expect(report).toContain("940 tokens (measured)")
  expect(report).toContain("summary cost")
  expect(report).toContain("$0.0012 (measured)")
  expect(report).toContain("4300 → 5100 (+19%)")
  expect(report).toContain("mean error")
  expect(report).toContain("12%")
})

test("an unpriced model never shows invented money in the report", () => {
  const pin = {
    lastContextSource: "billed",
    compaction: {
      verdict: "not-yet",
      turns: 76,
      changedTurns: 1,
      advisory: {
        verdict: "not-yet",
        source: "deterministic",
        confidence: 0.7,
        breakEvenTurns: null,
        perTurnSavings: null,
        worthIt: null,
        pricing: "flat",
        cache: { ratio: 0.95, samples: 5, source: "measured" },
        signals: { contextTokens: 241798, growth: 0 },
        estimates: {
          summaryTokens: 2584,
          summarySource: "measured",
          pricing: "flat",
          summaryCost: null,
          summaryCostSource: "flat plan ($0 marginal)",
          rebuildCost: null,
          rebuildSource: "flat plan ($0 marginal)",
          lastPrediction: { predicted: 5664, actual: 7154, error: 0.263 },
          predictionError: 0.263,
        },
        projections: [
          { turns: 3, net: null, worthIt: null },
          { turns: 8, net: null, worthIt: null },
          { turns: 15, net: null, worthIt: null },
        ],
      },
    },
  }
  const report = advisoryReport(pin, { noise: { instability: 0 }, expectedTurns: 8 })
  for (const line of report.split("\n")) expect(line.length).toBeLessThanOrEqual(72)
  // No placeholder money, and no break-even the code refused to compute.
  expect(report).not.toContain("$0.0000")
  expect(report).not.toContain("never turns")
  expect(report).not.toContain("modelled")
  expect(report).toContain("flat plan")
  // The horizons section survives, saying why it has no numbers.
  expect(report).toContain("horizons")
  expect(report).toContain("3 turns")
  expect(report).toContain("$0 net")
  // The context size and where it came from are the first thing shown.
  expect(report).toContain("241798 tokens (billed)")

  // No price data at all is a different claim from a flat plan, and the
  // report says so instead of repeating the flat answer.
  const unknown = JSON.parse(JSON.stringify(pin))
  unknown.compaction.advisory.pricing = "unknown"
  unknown.compaction.advisory.estimates.pricing = "unknown"
  unknown.compaction.advisory.estimates.summaryCostSource = "no price data"
  unknown.compaction.advisory.estimates.rebuildSource = "no price data"
  const unpriced = advisoryReport(unknown, { noise: { instability: 0 }, expectedTurns: 8 })
  for (const line of unpriced.split("\n")) expect(line.length).toBeLessThanOrEqual(72)
  expect(unpriced).toContain("not computed")
  expect(unpriced).toContain("no price data")
  expect(unpriced).not.toContain("$0.0000")
  expect(unpriced).toContain("worth it     unknown")
})

test("a flat plan shows list-price economics and the capacity, not a dead end", () => {
  const pin = {
    lastContextSource: "billed",
    compaction: {
      verdict: "compact-now",
      turns: 12,
      changedTurns: 11,
      advisory: {
        verdict: "compact-now",
        source: "deterministic",
        confidence: 0.8,
        breakEvenTurns: 1,
        perTurnSavings: 0.0123,
        worthIt: true,
        pricing: "flat",
        priceSource: "list price · xiaomi/mimo-v2.6-pro",
        moneyBasis: "at list price",
        capacity: { size: 500000, limit: 1048576, headroom: 548576 },
        cache: { ratio: 0.95, samples: 5, source: "measured" },
        signals: { contextTokens: 500000, growth: 1200 },
        estimates: {
          summaryTokens: 2584,
          summarySource: "measured",
          pricing: "flat",
          summaryCost: 0.0041,
          summaryCostSource: "modelled · at list price",
          rebuildCost: 0.0012,
          rebuildSource: "measured",
        },
        projections: [
          { turns: 3, net: 0.0328, worthIt: true },
          { turns: 8, net: 0.0943, worthIt: true },
          { turns: 15, net: 0.1804, worthIt: true },
        ],
      },
    },
  }
  const report = advisoryReport(pin, { noise: { instability: 0 }, expectedTurns: 8 })
  for (const line of report.split("\n")) expect(line.length).toBeLessThanOrEqual(72)
  // Capacity first: on a plan this is the constraint that actually binds.
  expect(report).toContain("500000 tokens (billed)")
  expect(report).toContain("1048576 tokens")
  expect(report).toContain("548576 tokens (52% free)")
  // The money is real, and it names the price list it came from.
  expect(report).toContain("flat plan · $0 marginal to you")
  expect(report).toContain("list price · xiaomi/mimo-v2.6-pro")
  expect(report).toContain("1 turn (at list price)")
  expect(report).toContain("$0.0123 (at list price)")
  expect(report).toContain("yes · free on your plan")
  expect(report).not.toContain("$0.0000")
  expect(report).not.toContain("never turns")
})

test("an empty advisory explains itself instead of inventing numbers", () => {
  const report = advisoryReport(null, {})
  expect(report).toContain("No advisory yet")
  for (const line of report.split("\n")) expect(line.length).toBeLessThanOrEqual(72)
})

test("the TUI slash command does not shadow the host's native /compact", () => {
  const layers = []
  const context = {
    data: { on: () => ({ dispose() {} }) },
    keymap: {
      layer: (factory) => {
        layers.push(factory())
        return () => {}
      },
    },
    ui: { toast: { show: async () => {} }, router: { current: () => null } },
  }
  const dispose = tui.setup(context)
  const command = layers[0].commands[0]
  expect(command.slash.name).toBe("ctx")
  expect(command.slash.aliases ?? []).not.toContain("compact")
  expect(command.slash.aliases ?? []).not.toContain("ctx")
  dispose()
})

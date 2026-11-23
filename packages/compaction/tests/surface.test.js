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
  const ctx = {
    model: { list: async () => MODELS },
    provider: { list: async () => [] },
    session: { get: async () => ({ id: "ses_1", agent: "build" }), compact },
    agent: { get: async () => ({ id: "build", mode: "primary" }) },
  }
  return {
    ctx,
    run: (event) => runContext({ host: "opencode", env, ctx, config, core, event }),
  }
}

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

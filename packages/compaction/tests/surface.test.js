import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { DEFAULT_CONFIG, readConfig } from "@231self/opencode-shared/config.js"
import { readPin, writePin } from "@231self/opencode-shared/state.js"

import { runContext } from "../src/context.js"
import tui, { advisoryReport, runPlanRefresh } from "../src/tui.js"

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

test("a plan report shows credits, the expiry premium, and plan-rate economics", () => {
  const pin = {
    compaction: {
      verdict: "compact-now",
      turns: 4,
      changedTurns: 4,
      advisory: {
        verdict: "compact-now",
        source: "deterministic",
        confidence: 0.7,
        breakEvenTurns: 1,
        perTurnSavings: 0.0123,
        worthIt: true,
        pricing: "flat",
        priceSource: "plan · Xiaomi MiMo Token Plan Max · $100/mo",
        moneyBasis: "",
        capacity: { size: 500_000, limit: 1048576, headroom: 548576 },
        cache: { ratio: 0.95, samples: 8, source: "measured" },
        estimates: {
          summaryTokens: 2584,
          summarySource: "measured",
          summaryCost: 0.004,
          summaryCostSource: "measured",
          rebuildCost: null,
          rebuildSource: "modelled · at plan rate",
          plan: {
            plan: "Xiaomi MiMo Token Plan Max · $100/mo",
            atPlanRate: true,
            weightsFor: "mimo-v2.6-pro",
            keepCredits: 1_200_000,
            expiry: { hot: 1_250_000, cold: 150_000_000, premium: 148_750_000, ratio: 120 },
          },
          lastPrediction: null,
          predictionError: 0,
        },
        projections: [{ turns: 3, net: 0.02, worthIt: true }],
      },
    },
  }
  const planBurn = {
    used: 12.4e9,
    allowance: 82e9,
    free: 69.6e9,
    percentUsed: 15.1,
    projected: 16.2e9,
    projectedPercent: 19.8,
    daysLeft: 7,
    basis: "renews monthly on the configured day",
    counted: 42,
    skipped: 0,
  }
  const report = advisoryReport(pin, { noise: { instability: 0 }, expectedTurns: 8, planBurn })
  const lines = report.split("\n")
  for (const line of lines) expect(line.length).toBeLessThanOrEqual(72)
  expect(report).toContain("Xiaomi MiMo Token Plan Max")
  expect(report).toContain("12.4B of 82.0B credits (15%")
  expect(report).toContain("renews monthly on the configured day")
  expect(report).toContain("projection")
  expect(report).toContain("days left")
  expect(report).toContain("per turn")
  expect(report).toContain("1.2M credits of allowance")
  expect(report).toContain("cache expiry")
  expect(report).toContain("150.0M credits to re-bill")
  expect(report).toContain("120x hot")
  expect(report).toContain("plan rate · your own credits")
  expect(report).toContain("in credits")
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

/** A context whose dialog answers are scripted and whose output is captured. */
function scriptedContext(answers = []) {
  // Isolate config/state and pre-answer billing, so the first-init prompt
  // never fires and no test can touch the user's real config.
  const env = tempEnv()
  fs.writeFileSync(env.OMLX_ROUTER_CONFIG, JSON.stringify({ billing: { payg: true } }))
  Object.assign(process.env, env)
  const shown = []
  const layers = []
  const context = {
    data: { on: () => ({ dispose() {} }) },
    keymap: {
      layer: (factory) => {
        layers.push(factory())
        return () => {}
      },
    },
    ui: {
      toast: { show: async (input) => shown.push(input.message ?? input) },
      router: { current: () => ({ type: "session", sessionID: "ses_test" }) },
      dialog: {
        alert: async ({ message }) => {
          shown.push(message)
        },
        select: async ({ title, options }) => {
          shown.push(title)
          return answers.shift()
        },
        prompt: async () => answers.shift(),
        confirm: async () => answers.shift(),
      },
    },
  }
  const dispose = tui.setup(context)
  const run = layers[0].commands[0].run
  return { run, shown, answers, dispose }
}

test("/ctx help lists every command with its usage line", async () => {
  const { run, shown, dispose } = scriptedContext()
  await run("help")
  const text = shown.at(-1)
  for (const name of ["menu", "report", "here", "plan", "help"]) expect(text).toContain(name)
  expect(text).toContain("/ctx help [command]")
  for (const line of text.split("\n")) expect(line.length).toBeLessThanOrEqual(72)
  dispose()
})

test("/ctx help <command> shows usage and detail", async () => {
  const { run, shown, dispose } = scriptedContext()
  await run("help here")
  const text = shown.at(-1)
  expect(text).toContain("/ctx here")
  expect(text).toContain("compact this session now")
  dispose()
})

test("/ctx help with an unknown command falls back to the listing", async () => {
  const { run, shown, dispose } = scriptedContext()
  await run("help frobnicate")
  const text = shown.at(-1)
  expect(text).toContain("unknown command: frobnicate")
  expect(text).toContain("commands")
  dispose()
})

test("an unknown /ctx command points at the help", async () => {
  const { run, shown, dispose } = scriptedContext()
  await run("frobnicate")
  expect(shown.at(-1)).toContain("Try /ctx help")
  dispose()
})

test("/ctx menu routes its choice and its help picker", async () => {
  // First select: menu -> Help. Second select: help picker -> "here".
  const { run, shown, dispose } = scriptedContext(["help", "here"])
  await run("menu")
  expect(shown.at(-1)).toContain("/ctx here")
  dispose()
})

test("bare /ctx opens the menu", async () => {
  // The menu choice routes through runCommand like any other entry.
  const { run, shown, dispose } = scriptedContext(["report"])
  await run("")
  expect(shown.at(-1)).toContain("No advisory yet")
  dispose()
})

test("/ctx report shows the advisory directly", async () => {
  const { run, shown, dispose } = scriptedContext()
  await run("report")
  expect(shown.at(-1)).toContain("No advisory yet")
  dispose()
})

test("/ctx menu closes without running anything", async () => {
  const { run, shown, dispose } = scriptedContext(["close"])
  await run("menu")
  expect(shown.at(-1)).not.toContain("Compaction requested")
  dispose()
})

/** The slice of the LimitDex feed the refresh test replays. */
const FEED = {
  generatedAt: "2026-11-24T06:17:02.446Z",
  tools: [
    {
      id: "codex",
      name: "OpenAI Codex (ChatGPT plans)",
      vendor: "OpenAI",
      weeklyCapPublished: false,
      plans: [
        {
          name: "Plus",
          priceUsdMonthly: 20,
          limitsQuote: "Est. local messages per 5h: GPT-6.1 Sol 15-160",
          lastVerified: "2026-11-24",
        },
      ],
    },
  ],
}

test("/ctx plan refresh copies the feed price and states the missing allowance", async () => {
  const env = tempEnv()
  fs.writeFileSync(env.OMLX_ROUTER_CONFIG, JSON.stringify({ billing: { vendor: "openai-codex", tier: "plus", priceUsd: 19 } }))
  Object.assign(process.env, env)
  const shown = []
  const context = { ui: { toast: { show: async (input) => shown.push(input.message ?? input) } } }
  const config = readConfig({ write: false }).config
  const merged = await runPlanRefresh(context, config, {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => FEED }),
  })
  // The recorded price is replaced by the feed's, with its check date.
  expect(merged.billing.priceUsd).toBe(20)
  expect(merged.billing.source.checked).toBe("2026-11-24")
  // No allowance is written: the vendor publishes none.
  expect(merged.billing.allowanceCredits).toBeUndefined()
  const text = shown.at(-1)
  expect(text).toContain("not published")
  expect(text).toContain("no shadow price")
  expect(text).toContain("Est. local messages")
  for (const line of text.split("\n")) expect(line.length).toBeLessThanOrEqual(72)
})

test("/ctx plan refresh keeps the recorded facts when the feed is down", async () => {
  const env = tempEnv()
  fs.writeFileSync(env.OMLX_ROUTER_CONFIG, JSON.stringify({ billing: { vendor: "openai-codex", tier: "plus" } }))
  Object.assign(process.env, env)
  const shown = []
  const context = { ui: { toast: { show: async (input) => shown.push(input.message ?? input) } } }
  const config = readConfig({ write: false }).config
  const merged = await runPlanRefresh(context, config, {
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  })
  expect(merged).toBeNull()
  expect(shown.at(-1)).toContain("unreachable (HTTP 503)")
  expect(shown.at(-1)).toContain("$20/mo")
})

test("/ctx plan refresh says so when no plan is recorded", async () => {
  const env = tempEnv()
  fs.writeFileSync(env.OMLX_ROUTER_CONFIG, JSON.stringify({}))
  Object.assign(process.env, env)
  const shown = []
  const context = { ui: { toast: { show: async (input) => shown.push(input.message ?? input) } } }
  const merged = await runPlanRefresh(context, readConfig({ write: false }).config, {
    fetchImpl: async () => {
      throw new Error("must not be called")
    },
  })
  expect(merged).toBeNull()
  expect(shown.at(-1)).toContain("No plan recorded")
})

test("a report shows each plan its own burn, never one blended figure", () => {
  const pin = {
    lastContextSource: "billed",
    compaction: {
      verdict: "compact-now",
      turns: 4,
      changedTurns: 4,
      advisory: {
        verdict: "compact-now",
        source: "deterministic",
        confidence: 0.7,
        breakEvenTurns: 1,
        perTurnSavings: 0.0123,
        worthIt: true,
        pricing: "priced",
        priceSource: "plan · Xiaomi MiMo Token Plan Max · $100/mo",
        moneyBasis: "",
        capacity: { size: 500_000, limit: 1048576, headroom: 548576 },
        cache: { ratio: 0.95, samples: 8, source: "measured" },
        estimates: {
          summaryTokens: 2584,
          summarySource: "measured",
          summaryCost: 0.004,
          summaryCostSource: "measured",
          rebuildCost: null,
          rebuildSource: "modelled · at plan rate",
          plan: {
            plan: "Xiaomi MiMo Token Plan Max · $100/mo",
            atPlanRate: true,
            weightsFor: "mimo-v2.6-pro",
            keepCredits: 1_200_000,
            expiry: { hot: 1_250_000, cold: 150_000_000, premium: 148_750_000, ratio: 120 },
          },
          lastPrediction: null,
          predictionError: 0,
        },
        projections: [{ turns: 3, net: 0.02, worthIt: true }],
      },
    },
  }
  const planBurns = [
    { label: "Xiaomi MiMo Token Plan Max · $100/mo", burn: { used: 12.4e9, allowance: 82e9, percentUsed: 15.1, projected: 16.2e9, daysLeft: 7, basis: "renews monthly on the configured day" } },
    { label: "ChatGPT Plus · $20/mo · allowance not published", burn: null },
  ]
  const report = advisoryReport(pin, { noise: { instability: 0 }, expectedTurns: 8, planBurns })
  const lines = report.split("\n")
  for (const line of lines) expect(line.length).toBeLessThanOrEqual(72)
  // Both plans are named.
  expect(report).toContain("Xiaomi MiMo Token Plan Max")
  expect(report).toContain("ChatGPT Plus · $20/mo · allowance not published")
  // Only the priced plan carries a burn figure.
  expect(report).toContain("12.4B of 82.0B credits (15%")
  expect(report).not.toContain("of  credits")
  // The unpriced plan's allowance note is on screen, not silently dropped.
  expect(report).toContain("allowance not published")
})

test("/ctx plan refresh updates each tracked plan in place, never across records", async () => {
  const env = tempEnv()
  fs.writeFileSync(
    env.OMLX_ROUTER_CONFIG,
    JSON.stringify({
      billing: [
        { vendor: "xiaomi-mimo", tier: "max", renewsDay: 1 },
        { vendor: "openai-codex", tier: "plus", renewsDay: 1, priceUsd: 19 },
      ],
    }),
  )
  Object.assign(process.env, env)
  const shown = []
  const context = { ui: { toast: { show: async (input) => shown.push(input.message ?? input) } } }
  const config = readConfig({ write: false }).config
  const merged = await runPlanRefresh(context, config, {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => FEED }),
  })
  const [mimo, chatgpt] = merged.billing
  // ChatGPT's price comes from the feed; MiMo has no feed and keeps its own.
  expect(chatgpt.priceUsd).toBe(20)
  expect(chatgpt.source.checked).toBe("2026-11-24")
  expect(mimo.vendor).toBe("xiaomi-mimo")
  expect(mimo.tier).toBe("max")
  // Both plans survive: one is never replaced by the other.
  expect(merged.billing).toHaveLength(2)
  const text = shown.at(-1)
  expect(text).toContain("ChatGPT Plus")
  expect(text).toContain("not published by the vendor")
})

test("the cost of compacting is named as the KV-cache invalidation", () => {
  // The invalidation dwarfs the summary (20x in the MiMo case), so it is the
  // figure that decides whether a compaction pays — the EOQ setup cost K.
  const pin = {
    lastContextSource: "billed",
    compaction: {
      verdict: "compact-now",
      turns: 4,
      changedTurns: 4,
      advisory: {
        verdict: "compact-now",
        source: "deterministic",
        confidence: 0.7,
        breakEvenTurns: 2,
        perTurnSavings: 0.0115,
        invalidationCost: 0.0172,
        summaryCost: 0.0009,
        worthIt: true,
        pricing: "priced",
        priceSource: "plan · Xiaomi MiMo Token Plan Max · $100/mo",
        moneyBasis: "",
        capacity: { size: 500_000, limit: 1048576, headroom: 548576 },
        cache: { ratio: 0.95, samples: 8, source: "measured" },
        estimates: { summaryTokens: 2584, summarySource: "measured", summaryCost: 0.0009, summaryCostSource: "measured", rebuildCost: null, rebuildSource: "modelled · at plan rate", plan: { plan: "Xiaomi MiMo Token Plan Max · $100/mo", atPlanRate: true }, lastPrediction: null, predictionError: 0 },
        projections: [{ turns: 3, net: 0.02, worthIt: true }],
      },
    },
  }
  const report = advisoryReport(pin, { noise: { instability: 0 }, expectedTurns: 8 })
  // The cost is shown, and named for what it is.
  expect(report).toContain("cost to compact")
  expect(report).toContain("$0.0172")
  expect(report).toContain("KV-cache invalidation")
  // It leads the economics: the cost before the payback.
  const lines = report.split("\n")
  const costLine = lines.findIndex((l) => l.includes("cost to compact"))
  const breakLine = lines.findIndex((l) => l.includes("break-even"))
  expect(costLine).toBeGreaterThan(-1)
  expect(costLine).toBeLessThan(breakLine)
})

test("on a plan the real cost is shown in credits, not hidden in dollars", () => {
  // On a plan the dollar figures are near zero (tiny shadow price × big token
  // count), so the KV-cache invalidation reads as $0.0172 and looks trivial.
  // In credits it is 148.8M — the number that decides whether to compact.
  const pin = {
    lastContextSource: "billed",
    compaction: {
      verdict: "compact-now",
      turns: 4,
      changedTurns: 4,
      advisory: {
        verdict: "compact-now",
        source: "deterministic",
        confidence: 0.7,
        breakEvenTurns: 13,
        perTurnSavings: 0.0115,
        invalidationCost: 0.0172,
        summaryCost: 0.0009,
        worthIt: true,
        planEconomics: {
          unit: "credits",
          invalidationCost: 148_750_000,
          perTurnSavings: 1_125_000,
          breakEvenTurns: 13,
          worthIt: true,
          summaryCost: 720_000,
        },
        pricing: "priced",
        priceSource: "plan · Xiaomi MiMo Token Plan Max · $100/mo",
        moneyBasis: "",
        capacity: { size: 500_000, limit: 1048576, headroom: 548576 },
        cache: { ratio: 0.95, samples: 8, source: "measured" },
        estimates: { summaryTokens: 2584, summarySource: "measured", summaryCost: 0.0009, summaryCostSource: "measured", rebuildCost: null, rebuildSource: "modelled · at plan rate", plan: { plan: "Xiaomi MiMo Token Plan Max · $100/mo", atPlanRate: true }, lastPrediction: null, predictionError: 0 },
        projections: [{ turns: 3, net: 0.02, worthIt: true }],
      },
    },
  }
  const report = advisoryReport(pin, { noise: { instability: 0 }, expectedTurns: 8 })
  for (const line of report.split("\n")) expect(line.length).toBeLessThanOrEqual(72)
  // The credit figures are on screen and named for what they are.
  expect(report).toContain("plan credits")
  expect(report).toContain("148.8M credits · KV-cache invalidation")
  expect(report).toContain("1.1M credits")
  expect(report).toContain("the credits your plan actually burns")
})

test("no plan means no plan-credit section, not a zero one", () => {
  const pin = {
    lastContextSource: "billed",
    compaction: {
      verdict: "compact-now", turns: 4, changedTurns: 4,
      advisory: { verdict: "compact-now", source: "deterministic", confidence: 0.7, breakEvenTurns: 2, perTurnSavings: 0.01, invalidationCost: 0.017, worthIt: true, pricing: "priced", priceSource: "catalog · deepseek/deepseek-flash", moneyBasis: "", capacity: { size: 500_000, limit: 1048576, headroom: 548576 }, cache: { ratio: 0.95, samples: 8, source: "measured" }, estimates: { summaryTokens: 2584, summarySource: "measured", lastPrediction: null, predictionError: 0 }, projections: [] },
    },
  }
  const report = advisoryReport(pin, { noise: { instability: 0 }, expectedTurns: 8 })
  expect(report).not.toContain("plan credits")
})

test("the report shows the unit price and prices context growth at it", () => {
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
        // The same number the router weighs, with its mix basis attached.
        unitPrice: { usdPerMTok: 0.4575, basis: "measured mix · 213 turns", measured: true, projection: false },
        signals: { contextTokens: 120_000, growth: 4_000 },
        projections: [{ turns: 8, net: 0.0524, worthIt: true }],
      },
    },
  }
  const report = advisoryReport(pin, { noise: { instability: 0 }, expectedTurns: 8 })
  for (const line of report.split("\n")) expect(line.length).toBeLessThanOrEqual(72)
  expect(report).toContain("unit price")
  expect(report).toContain("measured mix · 213 turns")
  // The growth of the context is priced at the unit price: the holding cost.
  expect(report).toContain("per turn at unit price")
})

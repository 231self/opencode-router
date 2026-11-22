import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { readPin, writePin } from "@231self/opencode-shared/state.js"

import { readCalibration } from "../src/calibration.js"
import { runContext } from "../src/context.js"
import { UsageTracker } from "../src/usage.js"

const MODELS = [
  {
    providerID: "deepseek",
    id: "deepseek-flash",
    name: "DeepSeek Flash",
    type: "chat",
    cost: [{ input: 0.2, output: 0.8, cache: { read: 0.05, write: 0.2 } }],
    limit: { context: 262144, output: 131072 },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    status: "active",
  },
  {
    providerID: "deepseek",
    id: "deepseek-v4-pro",
    name: "DeepSeek Pro",
    type: "chat",
    cost: [{ input: 2, output: 8, cache: { read: 0.5, write: 2 } }],
    limit: { context: 262144, output: 131072 },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    status: "active",
  },
]

function tempEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omlx-compaction-context-"))
  return {
    OMLX_ROUTER_CONFIG: path.join(dir, "config.json"),
    OMLX_ROUTER_STATE: path.join(dir, "state"),
    OMLX_ROUTER_FAVORITES: path.join(dir, "favorites.json"),
  }
}

function harness({ core, env, usage = null }) {
  const ctx = {
    model: { list: async () => MODELS },
    provider: { list: async () => [] },
    session: { get: async () => ({ id: "ses_1", agent: "build" }) },
    agent: { get: async () => ({ id: "build", mode: "primary" }) },
  }
  return {
    ctx,
    run: (event) => runContext({ host: "opencode", env, ctx, config: {}, core, event, usage }),
  }
}

test("context hook stores the token estimate", async () => {
  const env = tempEnv()
  const { run } = harness({ env, core: {} })
  await run({
    sessionID: "ses_1",
    system: [{ type: "text", text: "system prompt" }],
    messages: [{ parts: [{ type: "text", text: "hello world" }] }],
  })
  expect(readPin("opencode", "ses_1", env).lastContextTokens).toBeGreaterThan(0)
})

test("context hook prices with the measured cache ratio", async () => {
  const env = tempEnv()
  const usage = {
    ratioFor: () => ({ ratio: 0.93, samples: 5, source: "measured", lastAt: 1 }),
  }
  const core = {
    optimise: () => ({
      plan: [],
      stats: { beforeTokens: 60_000, afterTokens: 60_000, partsPruned: 0, overflow: false },
    }),
  }
  const { run } = harness({ env, core, usage })
  await run({
    sessionID: "ses_1",
    model: MODELS[0],
    system: [],
    messages: [{ parts: [] }],
  })
  const advisory = readPin("opencode", "ses_1", env).compaction.advisory
  expect(advisory.cache).toMatchObject({ ratio: 0.93, samples: 5, source: "measured" })
  expect(advisory.projections.map((entry) => entry.turns)).toEqual([3, 8, 15])
})

test("context hook applies the optimiser plan and records the result", async () => {
  const env = tempEnv()
  const core = {
    optimise: () => ({
      plan: [{ message: 0, part: 0, action: "stub", placeholder: "[pruned]" }],
      stats: { beforeTokens: 9000, afterTokens: 20, partsPruned: 1, overflow: false },
    }),
  }
  const { run } = harness({ env, core })
  const messages = [
    {
      info: { role: "assistant" },
      parts: [{ type: "tool", tool: "read", state: { status: "completed", output: "huge output" } }],
    },
  ]
  await run({
    sessionID: "ses_1",
    model: { providerID: "deepseek", id: "deepseek-flash", limit: { context: 100000, output: 8192 } },
    system: [],
    messages,
  })
  expect(messages[0].parts[0].state.output).toBe("[pruned]")
  const pin = readPin("opencode", "ses_1", env)
  expect(pin.lastContextTokens).toBe(20)
  expect(pin.lastOptimiser.overflow).toBe(false)
})

test("context overflow breaks the pin without pruning", async () => {
  const env = tempEnv()
  const core = {
    optimise: () => ({
      plan: [],
      stats: { beforeTokens: 500000, afterTokens: 500000, partsPruned: 0, overflow: true },
    }),
  }
  const { run } = harness({ env, core })
  writePin("opencode", "ses_1", { model: { providerID: "deepseek", id: "deepseek-flash" } }, env)
  const messages = [{ parts: [] }]
  await run({
    sessionID: "ses_1",
    model: { providerID: "deepseek", id: "deepseek-flash", limit: { context: 100000, output: 8192 } },
    system: [],
    messages,
  })
  const pin = readPin("opencode", "ses_1", env)
  expect(pin.model).toBeUndefined()
  expect(pin.lastContextTokens).toBe(500000)
})

test("context hook resolves catalog limits when the event model omits them", async () => {
  const env = tempEnv()
  const seen = []
  const core = {
    optimise: (input) => {
      seen.push(input.model)
      return { plan: [], stats: { beforeTokens: 900, afterTokens: 900, partsPruned: 0, overflow: false } }
    },
  }
  const { run } = harness({ env, core })
  writePin("opencode", "ses_1", { model: { providerID: "deepseek", id: "deepseek-flash" } }, env)
  await run({
    sessionID: "ses_1",
    model: { providerID: "deepseek", id: "deepseek-flash" },
    system: [],
    messages: [{ parts: [] }],
  })
  expect(seen[0].limit.context).toBe(262144)
  expect(readPin("opencode", "ses_1", env).model.id).toBe("deepseek-flash")
})

test("a compaction checkpoint calibrates summary size, request cost, and rebuild", async () => {
  const env = tempEnv()
  const now = 1_800_000_000_000
  const usage = new UsageTracker({ env, now: () => now })
  // The summary request: one step after the /ctx here marker.
  usage.noteStepStart({ sessionID: "ses_1", model: MODELS[0], at: now - 1_000 })
  usage.noteStepEnd({
    sessionID: "ses_1",
    tokens: { input: 100_000, output: 800, cache: { read: 0, write: 0 } },
    at: now - 500,
  })
  const core = {
    optimise: () => ({
      plan: [],
      stats: { beforeTokens: 90_000, afterTokens: 5_000, partsPruned: 0, overflow: false },
    }),
  }
  const { run } = harness({ env, core, usage })
  writePin(
    "opencode",
    "ses_1",
    {
      model: { providerID: "deepseek", id: "deepseek-flash" },
      lastContextTokens: 90_000,
      compaction: { requestedAt: now - 2_000 },
    },
    env,
  )
  const messages = [
    { type: "compaction", status: "completed", id: "cp-1", summary: "parser state: ".concat("x".repeat(400)) },
    { info: { role: "user" }, parts: [{ type: "text", text: "continue" }] },
  ]
  const event = { sessionID: "ses_1", model: MODELS[0], system: [], messages }
  await run(event)

  const pin = readPin("opencode", "ses_1", env)
  expect(pin.compaction.checkpoint).toBe("cp-1")
  expect(pin.compaction.lastRequestAt).toBeUndefined()
  const entry = readCalibration(env).models["deepseek/deepseek-flash"]
  expect(entry.summary.samples).toBe(1)
  expect(entry.summary.value).toBeGreaterThan(100)
  expect(entry.lastPrediction.actual).toBe(5_000)
  expect(entry.lastPrediction.predicted).toBeGreaterThan(0)
  expect(entry.request.samples).toBe(1)
  expect(entry.request.value.output).toBe(800)
  expect(entry.compactions).toBe(1)

  // The resumed turn reports its own usage; the next hook records it as the
  // rebuild cost once, not on every later turn.
  usage.noteStepStart({ sessionID: "ses_1", model: MODELS[0], at: now + 1_000 })
  usage.noteStepEnd({
    sessionID: "ses_1",
    tokens: { input: 1_000, output: 200, cache: { read: 4_000, write: 900 } },
    at: now + 2_000,
  })
  await run(event)
  const rebuilt = readCalibration(env).models["deepseek/deepseek-flash"]
  expect(rebuilt.rebuild.samples).toBe(1)
  expect(rebuilt.rebuild.value.write).toBe(900)
  expect(rebuilt.rebuild.value.output).toBe(200)

  await run(event)
  expect(readCalibration(env).models["deepseek/deepseek-flash"].rebuild.samples).toBe(1)
})

test("a context write cannot clobber a newer routing pin", async () => {
  const env = tempEnv()
  const core = {
    optimise: () => {
      // Simulate the prompt hook writing a new decision while the context hook
      // is measuring (the two hooks are asynchronous in the host).
      writePin(
        "opencode",
        "ses_1",
        { model: { providerID: "deepseek", id: "deepseek-v4-pro", variant: "default" } },
        env,
      )
      return { plan: [], stats: { beforeTokens: 100, afterTokens: 100, partsPruned: 0, overflow: false } }
    },
  }
  const { run } = harness({ env, core })
  writePin("opencode", "ses_1", { model: { providerID: "deepseek", id: "deepseek-flash" } }, env)
  await run({
    sessionID: "ses_1",
    model: { providerID: "deepseek", id: "deepseek-flash", limit: { context: 262144, output: 8192 } },
    system: [],
    messages: [{ parts: [] }],
  })
  expect(readPin("opencode", "ses_1", env).model.id).toBe("deepseek-v4-pro")
})

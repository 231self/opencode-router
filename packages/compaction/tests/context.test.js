import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { clearPin, readPin, writePin } from "@231self/opencode-shared/state.js"

import { calibrationPath, readCalibration, writeCalibration } from "../src/calibration.js"
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

function harness({ core, env, usage = null, judge = null, sessionContext = null }) {
  const ctx = {
    model: { list: async () => MODELS },
    provider: { list: async () => [] },
    session: {
      get: async () => ({ id: "ses_1", agent: "build" }),
      ...(sessionContext ? { context: async () => sessionContext } : {}),
    },
    agent: { get: async () => ({ id: "build", mode: "primary" }) },
  }
  return {
    ctx,
    run: (event) => runContext({ host: "opencode", env, ctx, config: {}, core, event, usage, judge }),
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
    {
      type: "compaction",
      status: "completed",
      id: "cp-1",
      summary: "parser state: ".concat("x".repeat(400)),
      model: { providerID: "anthropic", id: "claude-opus-5-5" },
      tokens: { input: 100_000, output: 800, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    { info: { role: "user" }, parts: [{ type: "text", text: "continue" }] },
  ]
  const event = { sessionID: "ses_1", model: MODELS[0], system: [], messages }
  await run(event)

  const pin = readPin("opencode", "ses_1", env)
  expect(pin.compaction.checkpoint).toBe("cp-1")
  const entry = readCalibration(env).models["deepseek/deepseek-flash"]
  expect(entry.summary.samples).toBe(1)
  expect(entry.summary.value).toBeGreaterThan(100)
  expect(entry.lastPrediction.actual).toBe(5_000)
  expect(entry.lastPrediction.predicted).toBeGreaterThan(0)
  // The summary request belongs to the model that generated it, which may not
  // be the model that resumes the session.
  const requestEntry = readCalibration(env).models["anthropic/claude-opus-5-5"]
  expect(requestEntry.request.samples).toBe(1)
  expect(requestEntry.request.value.output).toBe(800)
  expect(entry.compactions).toBe(1)

  // Clearing the routing pin must not make the same checkpoint count again.
  clearPin("opencode", "ses_1", env)
  await run(event)
  expect(readCalibration(env).models["deepseek/deepseek-flash"].summary.samples).toBe(1)

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

test("a delayed advisory cannot erase a newer request", async () => {
  const env = tempEnv()
  const judge = {
    async chat() {
      writePin(
        "opencode",
        "ses_1",
        {
          model: { providerID: "deepseek", id: "deepseek-flash" },
          lastContextTokens: 30_000,
          compaction: { requestedAt: 999 },
        },
        env,
      )
      return '{"action":"wait","confidence":0.9}'
    },
    getCached: () => undefined,
    setCached: () => {},
  }
  const { run } = harness({ env, core: {}, judge })
  writePin(
    "opencode",
    "ses_1",
    { model: { providerID: "deepseek", id: "deepseek-flash" }, lastContextTokens: 0 },
    env,
  )
  const messages = [
    { info: { role: "user" }, parts: [{ type: "text", text: "keep going ".concat("z".repeat(120000)) }] },
    { info: { role: "assistant" }, parts: [{ type: "text", text: "working ".concat("w".repeat(120000)) }] },
  ]
  await run({ sessionID: "ses_1", model: MODELS[0], system: [], messages })
  const pin = readPin("opencode", "ses_1", env)
  expect(pin.compaction.requestedAt).toBe(999)
  // The newer measurement from the judge-time write is preserved too.
  expect(pin.lastContextTokens).toBe(30_000)
})

test("a model decision that lands during the advisory is not overwritten", async () => {
  const env = tempEnv()
  const judge = {
    async chat() {
      writePin(
        "opencode",
        "ses_1",
        { model: { providerID: "deepseek", id: "deepseek-v4-pro" }, lastContextTokens: 30_000 },
        env,
      )
      return '{"action":"wait","confidence":0.9}'
    },
    getCached: () => undefined,
    setCached: () => {},
  }
  const { run } = harness({ env, core: {}, judge })
  writePin(
    "opencode",
    "ses_1",
    { model: { providerID: "deepseek", id: "deepseek-flash" }, lastContextTokens: 0 },
    env,
  )
  const messages = [
    { info: { role: "user" }, parts: [{ type: "text", text: "keep going ".concat("z".repeat(120000)) }] },
    { info: { role: "assistant" }, parts: [{ type: "text", text: "working ".concat("w".repeat(120000)) }] },
  ]
  await run({ sessionID: "ses_1", model: MODELS[0], system: [], messages })
  expect(readPin("opencode", "ses_1", env).model.id).toBe("deepseek-v4-pro")
})

test("a pin cleared during the advisory is not resurrected", async () => {
  const env = tempEnv()
  const judge = {
    async chat() {
      clearPin("opencode", "ses_1", env)
      return '{"action":"wait","confidence":0.9}'
    },
    getCached: () => undefined,
    setCached: () => {},
  }
  const { run } = harness({ env, core: {}, judge })
  writePin(
    "opencode",
    "ses_1",
    { model: { providerID: "deepseek", id: "deepseek-flash" }, lastContextTokens: 0 },
    env,
  )
  const messages = [
    { info: { role: "user" }, parts: [{ type: "text", text: "keep going ".concat("z".repeat(120000)) }] },
    { info: { role: "assistant" }, parts: [{ type: "text", text: "working ".concat("w".repeat(120000)) }] },
  ]
  await run({ sessionID: "ses_1", model: MODELS[0], system: [], messages })
  expect(readPin("opencode", "ses_1", env)).toBeUndefined()
})

test("a failed calibration commit does not advance the checkpoint or consume the rebuild", async () => {
  const env = tempEnv()
  const now = Date.now()
  const usage = new UsageTracker({ env, now: () => now })
  writeCalibration({ models: {}, sessions: {} }, env)
  usage.markPendingRebuild({ sessionID: "ses_1", checkpoint: "cp-0", at: now })
  usage.noteStepStart({
    sessionID: "ses_1",
    model: MODELS[0],
    at: now + 1,
    assistantMessageID: "step-1",
  })
  usage.noteStepEnd({
    sessionID: "ses_1",
    tokens: { input: 1_000, cache: { read: 4_000 } },
    at: now + 2,
    assistantMessageID: "step-1",
  })
  // A directory at the calibration path makes the atomic rename fail.
  fs.rmSync(calibrationPath(env))
  fs.mkdirSync(calibrationPath(env), { recursive: true })
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
    { model: { providerID: "deepseek", id: "deepseek-flash" }, lastContextTokens: 90_000 },
    env,
  )
  const messages = [
    {
      type: "compaction",
      status: "completed",
      id: "cp-1",
      summary: "state ".repeat(50),
      model: { providerID: "deepseek", id: "deepseek-flash" },
      tokens: { input: 90_000, output: 500, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    { info: { role: "user" }, parts: [{ type: "text", text: "continue" }] },
  ]
  await run({ sessionID: "ses_1", model: MODELS[0], system: [], messages })
  const pin = readPin("opencode", "ses_1", env)
  expect(pin.compaction?.checkpoint).toBeUndefined()
  expect(usage.peekRebuild("ses_1")?.checkpoint).toBe("cp-0")
})

test("overflow does not erase a redirect installed during the advisory", async () => {
  const env = tempEnv()
  const judge = {
    async chat() {
      writePin(
        "opencode",
        "ses_1",
        {
          model: { providerID: "deepseek", id: "deepseek-flash" },
          forced: true,
          redirect: { providerID: "deepseek", id: "deepseek-v4-pro" },
          lastContextTokens: 0,
        },
        env,
      )
      return '{"action":"wait","confidence":0.9}'
    },
    getCached: () => undefined,
    setCached: () => {},
  }
  const core = {
    optimise: () => ({
      plan: [],
      stats: { beforeTokens: 500_000, afterTokens: 500_000, partsPruned: 0, overflow: true },
    }),
  }
  const { run } = harness({ env, core, judge })
  writePin(
    "opencode",
    "ses_1",
    { model: { providerID: "deepseek", id: "deepseek-flash" }, lastContextTokens: 0 },
    env,
  )
  const messages = [
    { info: { role: "user" }, parts: [{ type: "text", text: "keep going ".concat("z".repeat(120000)) }] },
    { info: { role: "assistant" }, parts: [{ type: "text", text: "working ".concat("w".repeat(120000)) }] },
  ]
  await run({
    sessionID: "ses_1",
    model: { ...MODELS[0], limit: { context: 100_000, output: 8192 } },
    system: [],
    messages,
  })
  expect(readPin("opencode", "ses_1", env).redirect).toEqual({
    providerID: "deepseek",
    id: "deepseek-v4-pro",
  })
})

test("an opaque or empty checkpoint is counted but not learned", async () => {
  const env = tempEnv()
  const core = {
    optimise: () => ({
      plan: [],
      stats: { beforeTokens: 60_000, afterTokens: 40_000, partsPruned: 0, overflow: false },
    }),
  }
  const { run } = harness({ env, core })
  writePin(
    "opencode",
    "ses_1",
    { model: { providerID: "deepseek", id: "deepseek-flash" }, lastContextTokens: 60_000 },
    env,
  )
  await run({
    sessionID: "ses_1",
    model: MODELS[0],
    system: [],
    messages: [
      {
        type: "compaction",
        status: "completed",
        id: "cp-native",
        summary: "",
        native: {},
        model: { providerID: "deepseek", id: "deepseek-flash" },
        tokens: { input: 60_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      { info: { role: "user" }, parts: [{ type: "text", text: "continue" }] },
    ],
  })
  const entry = readCalibration(env).models["deepseek/deepseek-flash"]
  expect(entry.summary).toBeUndefined()
  expect(entry.lastPrediction).toBeUndefined()
  expect(entry.compactions).toBe(1)
  expect(entry.request.samples).toBe(1)
})

test("the active session context is measured instead of the hook segment", async () => {
  const env = tempEnv()
  const sessionContext = [{ type: "assistant", text: "x".repeat(120_000) }]
  const core = {
    optimise: () => ({
      plan: [],
      stats: { beforeTokens: 10, afterTokens: 10, partsPruned: 0, overflow: false },
    }),
  }
  const { run } = harness({ env, core, sessionContext })
  writePin(
    "opencode",
    "ses_1",
    { model: { providerID: "deepseek", id: "deepseek-flash" }, lastContextTokens: 0 },
    env,
  )
  await run({
    sessionID: "ses_1",
    model: MODELS[0],
    system: [],
    messages: [{ info: { role: "user" }, parts: [{ type: "text", text: "go" }] }],
  })
  const pin = readPin("opencode", "ses_1", env)
  expect(pin.lastContextTokens).toBeGreaterThan(25_000)
  expect(pin.compaction.advisory.signals.contextTokens).toBe(pin.lastContextTokens)
  expect(pin.compaction.advisory.verdict).toBe("uncertain")
})

test("a checkpoint that was not observed shrinking records no phantom prediction", async () => {
  const env = tempEnv()
  const now = 1_800_000_000_000
  const usage = new UsageTracker({ env, now: () => now })
  usage.noteStepStart({ sessionID: "ses_1", model: MODELS[0], at: now - 1_000 })
  usage.noteStepEnd({
    sessionID: "ses_1",
    tokens: { input: 5_000, output: 800, cache: { read: 0, write: 0 } },
    at: now - 500,
  })
  const core = {
    optimise: () => ({
      plan: [],
      stats: { beforeTokens: 5_000, afterTokens: 5_000, partsPruned: 0, overflow: false },
    }),
  }
  const { run } = harness({ env, core, usage })
  // The context is already at the size it settled at. A checkpoint noticed for
  // the first time here is old history — the same case that recorded a 2,352%
  // phantom error on a session which had grown for two days after compaction.
  writePin(
    "opencode",
    "ses_1",
    { model: { providerID: "deepseek", id: "deepseek-flash" }, lastContextTokens: 5_000 },
    env,
  )
  await run({
    sessionID: "ses_1",
    model: MODELS[0],
    system: [],
    messages: [
      {
        type: "compaction",
        status: "completed",
        id: "cp-1",
        summary: "parser state: ".concat("x".repeat(400)),
        model: { providerID: "anthropic", id: "claude-opus-5-5" },
        tokens: { input: 100_000, output: 800, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      { info: { role: "user" }, parts: [{ type: "text", text: "continue" }] },
    ],
  })
  const entry = readCalibration(env).models["deepseek/deepseek-flash"]
  // The summary's real size is still learned; only the prediction is withheld.
  expect(entry.summary.samples).toBe(1)
  expect(entry.lastPrediction).toBeUndefined()
})

test("the billed prefill is used once a request runs after the checkpoint", async () => {
  const env = tempEnv()
  const now = 1_800_000_000_000
  const usage = new UsageTracker({ env, now: () => now })
  usage.noteStepStart({ sessionID: "ses_1", model: MODELS[0], at: now - 100 })
  usage.noteStepEnd({
    sessionID: "ses_1",
    tokens: { input: 40_000, output: 10, cache: { read: 60_000, write: 0 } },
    at: now - 50,
  })
  const core = {
    optimise: () => ({
      plan: [],
      stats: { beforeTokens: 98_000, afterTokens: 98_000, partsPruned: 0, overflow: false },
    }),
  }
  const { run } = harness({ env, core, usage })
  writePin(
    "opencode",
    "ses_1",
    { model: { providerID: "deepseek", id: "deepseek-flash" }, lastContextTokens: 98_000 },
    env,
  )
  await run({
    sessionID: "ses_1",
    model: MODELS[0],
    system: [],
    messages: [
      {
        type: "compaction",
        status: "completed",
        id: "cp-1",
        time: { created: now - 1_000 },
        summary: "parser state: ".concat("x".repeat(400)),
        model: { providerID: "anthropic", id: "claude-opus-5-5" },
        tokens: { input: 100_000, output: 800, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      { info: { role: "user" }, parts: [{ type: "text", text: "continue" }] },
    ],
  })
  const pin = readPin("opencode", "ses_1", env)
  expect(pin.lastContextSource).toBe("billed")
  expect(pin.lastContextTokens).toBe(100_000)
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

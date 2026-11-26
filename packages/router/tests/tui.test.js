import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import tui from "../src/tui.js"
import { resolveBillings } from "@231self/opencode-shared/plan.js"
import { readConfig, saveConfig } from "@231self/opencode-shared/config.js"
import { writeQualityCache } from "../src/quality.js"
import { writePricingCache } from "../src/pricing.js"
import { appendDecision, appendTurn, listPins, sessionHash, writePin } from "@231self/opencode-shared/state.js"

function environment() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omlx-router-tui-"))
  process.env.OMLX_ROUTER_CONFIG = path.join(dir, "config.json")
  process.env.OMLX_ROUTER_STATE = path.join(dir, "state")
  const favorites = path.join(dir, "model.json")
  fs.writeFileSync(favorites, JSON.stringify({ favorite: [], variant: {} }))
  process.env.OMLX_ROUTER_FAVORITES = favorites
  return { dir }
}

function defaultModels() {
  return [
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
  ]
}

function fakeContext(models = defaultModels()) {
  let layer
  const messages = []
  const handlers = {}
  const synced = []
  let confirmAnswer = true
  let promptAnswer = ""
  let selectAnswers = []
  let lastOptions = []
  const context = {
    location: { directory: "/tmp" },
    ui: {
      router: { current: () => ({ type: "session", sessionID: "ses_1" }) },
      model: { current: () => ({ providerID: "deepseek", id: "deepseek-flash", variant: "default" }) },
      dialog: {
        alert: async ({ title, message }) => messages.push({ kind: "alert", title, message }),
        select: async ({ options }) => {
          lastOptions = options ?? []
          return selectAnswers.length ? selectAnswers.shift() : "quality"
        },
        prompt: async () => promptAnswer,
        confirm: async ({ message } = {}) => {
          if (message) messages.push({ kind: "confirm", message })
          return confirmAnswer
        },
      },
      toast: { show: async ({ title, message }) => messages.push({ kind: "toast", title, message }) },
    },
    data: {
      on: (type, handler) => {
        handlers[type] = handler
        return () => {
          delete handlers[type]
        }
      },
      session: {
        sync: async (sessionID) => {
          synced.push(sessionID)
        },
        invalidate: () => {},
      },
      location: {
        default: () => ({ directory: "/tmp" }),
        model: {
          sync: async () => {},
          list: () => models,
        },
        provider: {
          sync: async () => {},
          list: () => [],
        },
      },
    },
    keymap: {
      layer: (factory) => {
        layer = factory()
      },
    },
  }
  return {
    context,
    messages,
    command: () => layer.commands[0],
    handlers,
    synced,
    options: () => lastOptions,
    setSelect: (...answers) => {
      selectAnswers = answers
    },
    setPrompt: (value) => {
      promptAnswer = value
    },
    setConfirm: (value) => {
      confirmAnswer = value
    },
  }
}

test("tui exposes the router slash command", () => {
  environment()
  const { context, command } = fakeContext()
  tui.setup(context)
  expect(tui.id).toBe("omlx-router.tui")
  expect(command().slash).toEqual({ name: "router", aliases: ["model-router", "route"], arguments: true })
})

test("/router on and /router policy update the shared config", async () => {
  environment()
  const { context, messages, command } = fakeContext()
  tui.setup(context)

  await command().run("on")
  expect(readConfig({ write: false }).config.enabled).toBe(true)

  await command().run("policy")
  expect(readConfig({ write: false }).config.policy).toBe("quality")
  expect(messages.some((entry) => entry.message.includes("policy"))).toBe(true)
})

test("/router status renders a dialog", async () => {
  environment()
  const { context, messages, command } = fakeContext()
  tui.setup(context)
  await command().run("status")
  const alert = messages.find((entry) => entry.kind === "alert")
  expect(alert.message).toContain("OpenCode Router")
  expect(alert.message).toContain("policy")
})

test("/router pins lists automatic routing state and can clear it", async () => {
  environment()
  writePin("opencode", "ses_pin", {
    model: { providerID: "deepseek", id: "deepseek-flash", variant: "default" },
    forced: false,
    source: "judge",
    since: Date.now() - 60_000,
    lastTurnAt: Date.now() - 60_000,
    blocked: [
      {
        providerID: "deepseek",
        id: "deepseek-flash",
        until: Date.now() + 60_000,
        reason: "429",
        providerWide: true,
      },
    ],
  })
  const { context, messages, command } = fakeContext()
  tui.setup(context)
  await command().run("pins")
  const alert = messages.find((entry) => entry.kind === "alert")
  expect(alert.message).toContain("deepseek/deepseek-flash")
  expect(alert.message).toContain("auto")
  expect(alert.message).toContain("blocked deepseek/deepseek-flash (provider)")
  await command().run("pins clear")
  expect(listPins("opencode").length).toBe(0)
})

test("/router pricing lists per-model token prices", async () => {
  environment()
  const { config } = readConfig({ write: true })
  saveConfig({
    ...config,
    pool: { ...config.pool, source: "list", models: ["deepseek/deepseek-flash"] },
  })
  const { context, messages, command } = fakeContext()
  tui.setup(context)
  await command().run("pricing")
  const alert = messages.find((entry) => entry.kind === "alert")
  expect(alert.message).toContain("deepseek/deepseek-flash")
  expect(alert.message).toContain("in $0.2")
  expect(alert.message).toContain("out $0.8")
  expect(alert.message).toContain("cache read $0.05")
})

test("/router pricing fills host gaps from the table and never invents $0", async () => {
  environment()
  const { config } = readConfig({ write: true })
  saveConfig({
    ...config,
    pool: {
      ...config.pool,
      source: "list",
      models: [
        "anthropic/claude-opus-5-5",
        "openai/gpt-6.1-sol",
        "deepseek/deepseek-flash",
        "acme/mystery",
      ],
    },
  })
  writePricingCache({
    source: "modelsdev",
    fetchedAt: Date.now(),
    count: 2,
    prices: {
      "anthropic/claude-opus-5-5": [{ input: 4, output: 20, cache: { read: 0.2, write: 5 } }],
    },
    byId: { gpt61sol: [{ input: 2, output: 10, cache: { read: 0.1, write: undefined } }] },
    sources: {
      modelsdev: { url: "https://models.dev/api.json", fetchedAt: Date.now(), count: 2 },
    },
  })
  const capabilities = { tools: true, input: ["text"], output: ["text"] }
  const models = [
    {
      providerID: "anthropic",
      id: "claude-opus-5-5",
      type: "chat",
      cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
      limit: { context: 200000, output: 8192 },
      capabilities,
      status: "active",
    },
    {
      providerID: "openai",
      id: "gpt-6.1-sol",
      type: "chat",
      cost: [],
      limit: { context: 400000, output: 128000 },
      capabilities,
      status: "active",
    },
    {
      providerID: "acme",
      id: "mystery",
      type: "chat",
      cost: [],
      limit: { context: 128000, output: 8192 },
      capabilities,
      status: "active",
    },
    ...defaultModels(),
  ]
  const { context, messages, command } = fakeContext(models)
  tui.setup(context)
  await command().run("pricing")
  const alert = messages.find((entry) => entry.kind === "alert")
  expect(alert.message).toContain("anthropic/claude-opus-5-5")
  expect(alert.message).toContain("in $4 · out $20")
  expect(alert.message).toContain("cache read $0.2 /M (models.dev)")
  expect(alert.message).toContain("openai/gpt-6.1-sol")
  expect(alert.message).toContain("in $2 · out $10")
  expect(alert.message).toContain("cache read $0.1 /M (models.dev)")
  expect(alert.message).toContain("deepseek/deepseek-flash")
  expect(alert.message).toContain("in $0.2 · out $0.8 · cache read $0.05 /M")
  expect(alert.message).toContain("acme/mystery")
  expect(alert.message).toContain("unknown (no pricing data)")
  expect(alert.message).toContain("2 models · modelsdev")
})

test("/router quality reports the cached score source", async () => {
  environment()
  writeQualityCache(
    { source: "lmarena", config: "webdev", fetchedAt: Date.now(), count: 42, scores: {} },
    process.env,
  )
  const { context, messages, command } = fakeContext()
  tui.setup(context)
  await command().run("quality")
  const alert = messages.find((entry) => entry.kind === "alert")
  expect(alert.message).toContain("lmarena")
  expect(alert.message).toContain("42")
})

test("/router policy custom prints the active weights", async () => {
  environment()
  const { config } = readConfig({ write: true })
  saveConfig({ ...config, policyWeights: { cost: 0.6, quality: 0.35, latency: 0.05 } })
  const { context, messages, command } = fakeContext()
  tui.setup(context)
  await command().run("policy custom")
  const alert = messages.find((entry) => entry.kind === "alert")
  expect(alert.message).toContain("0.35")
  expect(alert.message).toContain("config")
})

test("/router version prints the router version", async () => {
  environment()
  const { context, messages, command } = fakeContext()
  tui.setup(context)
  await command().run("version")
  const alert = messages.find((entry) => entry.kind === "alert")
  expect(alert.message).toContain("OpenCode Router")
  expect(alert.message).toContain("ABI")
  expect(alert.message).toContain("config")
})

test("/router debug renders a diagnostic bundle", async () => {
  environment()
  const { config } = readConfig({ write: true })
  saveConfig({ ...config, judge: { ...config.judge, baseURL: "http://127.0.0.1:9/v1", timeoutMs: 250 } })
  const { context, messages, command } = fakeContext()
  tui.setup(context)
  await command().run("debug")
  const alert = messages.find((entry) => entry.kind === "alert")
  expect(alert.message).toContain("OpenCode Router")
  expect(alert.message).toContain("judge")
  expect(alert.message).toContain("unavailable")
  expect(alert.message).not.toContain("apiKey")
})

function fakeAdminFetch() {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url)
    calls.push({ path: parsed.pathname, method: init.method ?? "GET" })
    const json = (value, headers = {}) =>
      new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json", ...headers } })
    if (parsed.pathname === "/v1/models") {
      return json({ data: [{ id: "Qwen3.8-27B-MLX-4bit" }] })
    }
    if (parsed.pathname === "/admin/api/login") {
      return json({ success: true }, { "set-cookie": "omlx_admin_session=abc; Path=/" })
    }
    if (parsed.pathname === "/admin/api/hf/model-info") {
      return json({
        repo_id: "mlx-community/Qwen3-4B-Instruct-2507-4bit",
        params_formatted: "4.0B",
        tags: ["mlx", "license:apache-2.0"],
        files: [
          { name: "config.json", size: 1000 },
          { name: "model.safetensors", size: 2_254_857_830 },
        ],
      })
    }
    if (parsed.pathname === "/admin/api/hf/download") {
      return json({ task: { task_id: "t1", repo_id: "mlx-community/Qwen3-4B-Instruct-2507-4bit", status: "pending" } })
    }
    if (parsed.pathname === "/admin/api/hf/tasks") {
      return json({ tasks: [{ task_id: "t1", repo_id: "mlx-community/Qwen3-4B-Instruct-2507-4bit", status: "completed" }] })
    }
    return json({ error: "not found" })
  }
  return { fetchImpl, calls }
}

function provisionConfig() {
  environment()
  const config = readConfig({ write: true }).config
  config.judge.baseURL = "http://omlx.test/v1"
  config.judge.provision.adminApiKey = "admin-key"
  config.judge.provision.readSettingsKey = false
  saveConfig(config)
  return config
}

test("/router judge offers a consented download when only a large model exists", async () => {
  provisionConfig()
  const { context, messages, command } = fakeContext()
  tui.setup(context)
  const fake = fakeAdminFetch()
  const original = globalThis.fetch
  globalThis.fetch = fake.fetchImpl
  try {
    await command().run("judge")
  } finally {
    globalThis.fetch = original
  }
  expect(fake.calls.some((call) => call.path === "/admin/api/hf/model-info")).toBe(true)
  expect(fake.calls.some((call) => call.path === "/admin/api/hf/download" && call.method === "POST")).toBe(true)
  expect(messages.some((entry) => String(entry.message).includes("downloading"))).toBe(true)
})

test("/router judge pull does not download when consent is declined", async () => {
  provisionConfig()
  const { context, command, setConfirm } = fakeContext()
  setConfirm(false)
  tui.setup(context)
  const fake = fakeAdminFetch()
  const original = globalThis.fetch
  globalThis.fetch = fake.fetchImpl
  try {
    await command().run("judge pull")
  } finally {
    globalThis.fetch = original
  }
  expect(fake.calls.some((call) => call.path === "/admin/api/hf/download")).toBe(false)
})

test("/router timing reports local judge vs remote model time", async () => {
  const { dir } = environment()
  appendTurn(
    "opencode",
    {
      ts: Date.now(),
      role: "root",
      usedModel: "deepseek/deepseek-flash",
      turnMs: 10_000,
      routeMs: 1_000,
      judgeMs: 800,
      modelMs: 7_000,
      toolMs: 2_000,
    },
    { OMLX_ROUTER_STATE: path.join(dir, "state") },
  )
  const { context, messages, command } = fakeContext()
  tui.setup(context)
  await command().run("timing")
  const text = messages.map((entry) => String(entry.message)).join("\n")
  expect(text).toContain("local judge")
  expect(text).toContain("800ms (8%)")
  expect(text).toContain("remote model")
  expect(text).toContain("7.0s (70%)")
  expect(text).toContain("10.0s")
})

test("tui refreshes the model and shows a switch toast", async () => {
  environment()
  const { context, messages, handlers, synced } = fakeContext()
  tui.setup(context)
  handlers["session.model.selected"]({
    data: {
      sessionID: "ses_1",
      model: { providerID: "deepseek", id: "deepseek-v4-pro" },
      previous: { providerID: "deepseek", id: "deepseek-flash" },
    },
  })
  await Promise.resolve()
  await Promise.resolve()
  expect(synced).toContain("ses_1")
  expect(messages.some((entry) => String(entry.message).includes("deepseek-v4-pro"))).toBe(true)
})

test("/router opens a navigable menu with descriptions", async () => {
  environment()
  const { context, messages, command, options, setSelect } = fakeContext()
  tui.setup(context)
  setSelect("status", "close")
  await command().run("")
  const menu = options()
  expect(menu.length).toBeGreaterThan(5)
  expect(menu.every((option) => option.description)).toBe(true)
  expect(menu.some((option) => option.title === "Status")).toBe(true)
  expect(messages.some((entry) => String(entry.message).includes("OpenCode Router"))).toBe(true)
})

test("tui instructs when no pool is selected", () => {
  environment()
  const { context, messages } = fakeContext()
  tui.setup(context)
  expect(
    messages.some((entry) => String(entry.message).includes("No models selected")),
  ).toBe(true)
})

test("/router pool saves an explicit model list", async () => {
  environment()
  const { context, command, setSelect, setPrompt } = fakeContext()
  tui.setup(context)
  setSelect("list")
  setPrompt("deepseek/deepseek-flash")
  await command().run("pool")
  const config = readConfig({ write: false }).config
  expect(config.pool.source).toBe("list")
  expect(config.pool.models).toEqual(["deepseek/deepseek-flash"])
})

test("/router pool shows each model's unit price and its mix basis", async () => {
  environment()
  fs.writeFileSync(
    process.env.OMLX_ROUTER_CONFIG,
    JSON.stringify({ pool: { source: "list", models: ["deepseek/deepseek-flash"] } }),
  )
  const { context, messages, command, setSelect } = fakeContext()
  tui.setup(context)
  setSelect(undefined)
  await command().run("pool")
  const text = messages.map((entry) => String(entry.message ?? entry)).join("\n")
  expect(text).toContain("unit ")
  expect(text).toContain("/M")
  // A fresh state dir has no turns: the published mix applies and is
  // labelled as the stand-in it is.
  expect(text).toContain("reference mix")
  expect(text).toContain("stand-in")
})

test("/router explain shows the decision, scores, costs, and verdict", async () => {
  environment()
  appendDecision(
    "opencode",
    {
      ts: Date.now(),
      session: sessionHash("ses_1"),
      chosen: "kilo/anthropic/claude-fable-5.2",
      source: "judge",
      reason: "first-turn",
      stage: "judge/cost",
      policy: "cost",
      complexity: 4,
      turnClass: "agentic",
      applied: "same-turn",
      pinned: false,
      judge: { used: true, cached: false, ms: 700 },
      timing: { routeMs: 900, judgeMs: 700, coreMs: 5, switchMs: 2 },
      verdict: {
        task: "edit",
        complexity: 4,
        needsTools: true,
        reasoningNeed: "high",
        contextNeed: "medium",
        confidence: 0.95,
      },
      top: [
        { providerID: "kilo", id: "anthropic/claude-fable-5.2", score: 0.71, costUsd: 0.008 },
        { providerID: "deepseek", id: "deepseek-v4-pro", score: 0.4, costUsd: 0.002 },
      ],
    },
    process.env,
  )
  const { context, messages, command } = fakeContext()
  tui.setup(context)
  await command().run("explain")
  const text = messages.map((entry) => String(entry.message)).join("\n")
  expect(text).toContain("model")
  expect(text).toContain("kilo/anthropic/claude-fable-5.2")
  expect(text).toContain("verdict")
  expect(text).toContain("edit / 4")
  expect(text).toContain("score 0.710")
  expect(text).toContain("cost $0.008000")
})

test("/router retention saves the strategy and keeps the pin-mode alias", async () => {
  environment()
  const { context, command, setSelect } = fakeContext()
  tui.setup(context)
  setSelect("switch")
  await command().run("retention")
  expect(readConfig({ write: false }).config.pin.mode).toBe("switch")
  setSelect("cache")
  await command().run("pin-mode")
  expect(readConfig({ write: false }).config.pin.mode).toBe("cache")
})

test("commands with optional parameters show their usage", async () => {
  environment()
  const { context, messages, command } = fakeContext()
  tui.setup(context)

  await command().run("pricing")
  expect(messages.at(-1).message).toContain("usage: /router pricing [refresh]")

  await command().run("pins")
  expect(messages.at(-1).message).toContain("usage: /router pins [clear]")

  await command().run("quality")
  expect(messages.at(-1).message).toContain("usage: /router quality [refresh]")
})

test("an unknown parameter prints the allowed values instead of being ignored", async () => {
  environment()
  const { context, messages, command } = fakeContext()
  tui.setup(context)

  await command().run("pricing resfresh")
  expect(messages.at(-1).message).toContain('"resfresh" is not a parameter')
  expect(messages.at(-1).message).toContain("usage: /router pricing [refresh]")

  await command().run("pins wipe")
  expect(messages.at(-1).message).toContain("usage: /router pins [clear]")

  await command().run("policy cheapest")
  expect(messages.at(-1).message).toContain('"cheapest" is not a policy')
  expect(messages.at(-1).message).toContain("usage: /router policy [cost|quality|latency|custom]")

  await command().run("history many")
  expect(messages.at(-1).message).toContain("usage: /router history [n]")

  await command().run("subagents maybe")
  expect(messages.at(-1).message).toContain("usage: /router subagents on|off")
  expect(readConfig({ write: false }).config.subagents.enabled).toBe(true)

  // The old pin-mode name still reports the new retention usage.
  await command().run("pin-mode sometimes")
  expect(messages.at(-1).message).toContain("usage: /router retention [cache|balanced|switch]")
})

test("subagents still toggles with an explicit value", async () => {
  environment()
  const { context, command } = fakeContext()
  tui.setup(context)
  await command().run("subagents off")
  expect(readConfig({ write: false }).config.subagents.enabled).toBe(false)
  await command().run("subagents on")
  expect(readConfig({ write: false }).config.subagents.enabled).toBe(true)
})

test("/router help lists every command and can show one", async () => {
  environment()
  const { context, messages, command } = fakeContext()
  tui.setup(context)

  await command().run("help")
  const all = messages.at(-1).message
  for (const line of [
    "/router on | off",
    "/router pricing [refresh]",
    "/router pins [clear]",
    "/router subagents on|off",
    "/router help [command]",
  ]) {
    expect(all).toContain(line)
  }

  await command().run("help pricing")
  const one = messages.at(-1).message
  expect(one).toContain("/router pricing [refresh]")
  expect(one).toContain("Input/output/cache prices")

  await command().run("help nope")
  expect(messages.at(-1).message).toContain("unknown command: nope")
})

test("the main menu reaches every subcommand and the help picker", async () => {
  environment()
  const { context, messages, command, options, setSelect } = fakeContext()
  tui.setup(context)

  // openMenu loops until "close", so every select needs a terminating answer.
  setSelect("status", "close")
  await command().run("menu")
  const values = options().map((entry) => entry.value)
  for (const value of [
    "toggle-routing",
    "toggle-subagents",
    "retention",
    "pins",
    "pricing refresh",
    "quality refresh",
    "pins clear",
    "help",
    "explain",
    "auto",
    "pin",
    "debug",
  ]) {
    expect(values).toContain(value)
  }

  setSelect("help", "subagents", "close")
  await command().run("menu")
  expect(messages.at(-1).message).toContain("/router subagents on|off")
  expect(messages.at(-1).message).toContain("child sessions")
})

/** Value start columns of the fact rows under a section title. */
function valueColumns(text, title) {
  const lines = text.split("\n")
  const start = lines.indexOf(title)
  const columns = []
  for (let index = start + 1; index < lines.length && lines[index] !== ""; index += 1) {
    const match = lines[index].match(/^ {2}\S+( {2,})\S/)
    if (match) columns.push(lines[index].indexOf(match[1]) + match[1].length)
  }
  return columns
}

test("every menu and submenu popup is wrapped, aligned text without long lines", async () => {
  const { dir } = environment()
  const previousHome = process.env.HOME
  process.env.HOME = dir
  try {
    const config = readConfig({ write: true }).config
    saveConfig({
      ...config,
      pool: { ...config.pool, source: "list", models: ["deepseek/deepseek-flash"] },
      judge: {
        ...config.judge,
        baseURL: "http://127.0.0.1:9/v1",
        timeoutMs: 250,
        provision: { ...config.judge.provision, adminApiKey: "test-admin-key", readSettingsKey: false },
      },
    })
    writePin("opencode", "ses_pin", {
      model: { providerID: "deepseek", id: "deepseek-flash", variant: "default" },
      forced: true,
      source: "user",
      since: Date.now() - 60_000,
      lastTurnAt: Date.now() - 60_000,
      blocked: [
        {
          providerID: "deepseek",
          id: "deepseek-flash",
          until: Date.now() + 60_000,
          reason: "429",
          providerWide: true,
        },
      ],
    })
    appendDecision(
      "opencode",
      {
        ts: Date.now(),
        session: sessionHash("ses_1"),
        chosen: "kilo/anthropic/claude-fable-5.2",
        source: "judge",
        reason: "first-turn",
        stage: "judge/cost",
        policy: "cost",
        complexity: 4,
        turnClass: "agentic",
        applied: "same-turn",
        pinned: true,
        judge: { used: true, cached: false, ms: 700 },
        timing: { routeMs: 900, judgeMs: 700, coreMs: 5, switchMs: 2 },
        verdict: {
          task: "edit",
          complexity: 4,
          needsTools: true,
          reasoningNeed: "high",
          contextNeed: "medium",
          confidence: 0.95,
        },
        top: [{ providerID: "kilo", id: "anthropic/claude-fable-5.2", score: 0.71, costUsd: 0.008 }],
      },
      process.env,
    )
    appendTurn(
      "opencode",
      {
        ts: Date.now(),
        role: "root",
        usedModel: "deepseek/deepseek-flash",
        turnMs: 10_000,
        routeMs: 1_000,
        judgeMs: 800,
        modelMs: 7_000,
        toolMs: 2_000,
      },
      process.env,
    )

    const { context, messages, command, setSelect } = fakeContext()
    tui.setup(context)
    for (const input of [
      "status",
      "version",
      "debug",
      "policy custom",
      "pool",
      "pricing",
      "pins",
      "quality",
      "history",
      "timing",
      "explain",
      "judge",
      "judge status",
      "judge cancel",
      "help",
      "help pricing",
      "help nope",
      "history many",
      "pins clear",
    ]) {
      setSelect("close")
      await command().run(input)
    }

    // The consent dialog and the download list share the same layout rules.
    const fake = fakeAdminFetch()
    const original = globalThis.fetch
    globalThis.fetch = fake.fetchImpl
    try {
      await command().run("judge status")
      await command().run("judge pull")
      // The download monitor is background work; let it finish against the
      // fake so its completion toast cannot race the assertions below.
      await new Promise((resolve) => setTimeout(resolve, 50))
    } finally {
      globalThis.fetch = original
    }

    const popups = messages.filter((entry) => typeof entry.message === "string")
    expect(popups.length).toBeGreaterThan(15)
    const overlong = []
    for (const entry of popups) {
      for (const line of String(entry.message).split("\n")) {
        // Fixture paths are long; real ones shorten to ~ under the home dir.
        const trimmed = line.replace(dir, "")
        if (trimmed.length > 80) overlong.push(`${entry.kind}: ${trimmed}`)
      }
    }
    expect(overlong).toEqual([])
    expect(popups.some((entry) => entry.kind === "confirm")).toBe(true)

    // Facts under one section title share a value column.
    const explain = popups.map((entry) => entry.message).find((text) => text.includes("\nverdict\n"))
    expect(explain).toBeDefined()
    for (const title of ["decision", "verdict", "judge", "timing"]) {
      const columns = valueColumns(explain, title)
      expect(columns.length).toBeGreaterThan(1)
      expect(new Set(columns).size).toBe(1)
    }
  } finally {
    process.env.HOME = previousHome
  }
})

test("long error alerts wrap and keep the detail", async () => {
  environment()
  const config = readConfig({ write: true }).config
  saveConfig({
    ...config,
    judge: {
      ...config.judge,
      baseURL: "http://omlx.test/v1",
      // No admin key from any source: the provisioning errors are long text
      // and must still respect the popup width.
      provision: { ...config.judge.provision, adminApiKey: "", readSettingsKey: false },
    },
  })
  const { context, messages, command } = fakeContext()
  tui.setup(context)
  const fake = fakeAdminFetch()
  const original = globalThis.fetch
  globalThis.fetch = fake.fetchImpl
  try {
    await command().run("judge status")
    await command().run("judge pull")
  } finally {
    globalThis.fetch = original
  }
  const alerts = messages.filter((entry) => entry.kind === "alert")
  expect(alerts.length).toBeGreaterThan(1)
  for (const entry of alerts) {
    for (const line of String(entry.message).split("\n")) {
      expect(line.length).toBeLessThanOrEqual(80)
    }
    expect(entry.message).toContain("adminApiKey")
  }
})

test("/router plan records a plan and prices the pool at its rates", async () => {
  environment()
  const { context, messages, command, setSelect, setConfirm } = fakeContext()
  tui.setup(context)

  // Wizard answers: type, then Xiaomi MiMo from the catalog, then Max.
  setSelect("subscription", "xiaomi-mimo", "max")
  setConfirm(true)
  await command().run("plan")

  const config = readConfig({ write: false }).config
  expect(config.billing).toBeTruthy()
  const plans = resolveBillings(config.billing)
  expect(plans).toHaveLength(1)
  expect(plans[0].name).toBe("Xiaomi MiMo Token Plan Max")
  expect(messages.some((entry) => (entry.message ?? "").includes("Xiaomi MiMo Token Plan Max"))).toBe(true)
})

test("/router plan adds a second plan beside the first", async () => {
  environment()
  const { context, command, setSelect, setConfirm } = fakeContext()
  tui.setup(context)

  setSelect("subscription", "xiaomi-mimo", "max")
  setConfirm(true)
  await command().run("plan")
  setSelect("subscription", "github-copilot", "pro")
  setConfirm(true)
  await command().run("plan")

  const plans = resolveBillings(readConfig({ write: false }).config.billing)
  expect(plans).toHaveLength(2)
  expect(plans.map((p) => p.vendor)).toEqual(["xiaomi-mimo", "github-copilot"])
})

test("/router plan backs out and saves nothing when the wizard is escaped", async () => {
  environment()
  const { context, command, setSelect } = fakeContext()
  tui.setup(context)
  setSelect(undefined)
  await command().run("plan")
  expect(readConfig({ write: false }).config.billing ?? null).toBeFalsy()
})

test("/router web starts the dashboard, reports it, and stops it", async () => {
  environment()
  const { context, messages, command } = fakeContext()
  tui.setup(context)
  const text = () => messages.map((entry) => String(entry.message ?? entry)).join("\n")
  try {
    await command().run("web")
    expect(text()).toContain("http://127.0.0.1:")
    expect(text()).toContain("127.0.0.1 only")
    // A second start reports the running server rather than double-binding.
    await command().run("web")
    expect(text()).toContain("already running")
    // The API serves while the command is up.
    const url = text().match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]
    expect(url).toBeTruthy()
    const summary = await (await fetch(`${url}/api/summary.json`)).json()
    expect(summary.totals.turns).toBe(0)
  } finally {
    await command().run("web stop")
  }
  expect(text()).toContain("Dashboard stopped.")
  await command().run("web stop")
  expect(text()).toContain("No dashboard running.")
})

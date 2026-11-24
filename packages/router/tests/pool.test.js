import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { matchesGlob, readHostModelState, resolvePool } from "../src/pool.js"

function catalog() {
  return [
    {
      providerID: "deepseek",
      id: "deepseek-flash",
      name: "DeepSeek Flash",
      type: "chat",
      settings: { baseURL: "https://api.deepseek.com" },
      variants: [{ id: "high" }],
      cost: [{ input: 0.2, output: 0.8, cache: { read: 0.05, write: 0.2 } }],
      limit: { context: 262144, output: 131072 },
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      status: "active",
    },
    {
      providerID: "omlx",
      id: "local-4b",
      name: "Local 4B",
      type: "chat",
      settings: { baseURL: "http://127.0.0.1:1234/v1" },
      cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
      limit: { context: 32768, output: 8192 },
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      status: "active",
    },
    {
      providerID: "acme",
      id: "no-tools",
      name: "No Tools 8B",
      type: "chat",
      cost: [{ input: 1, output: 1, cache: { read: 0, write: 0 } }],
      limit: { context: 128000, output: 8192 },
      capabilities: { tools: false, input: ["text"], output: ["text"] },
      status: "active",
    },
    {
      providerID: "acme",
      id: "old",
      name: "Old 70B",
      type: "chat",
      cost: [{ input: 1, output: 1, cache: { read: 0, write: 0 } }],
      limit: { context: 128000, output: 8192 },
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      status: "deprecated",
    },
  ]
}

function config(overrides = {}) {
  return {
    pool: { source: "favorites", models: [], include: [], exclude: [], maxModels: 8, requireTools: true, minContext: 0 },
    quality: { overrides: { "deepseek/deepseek-flash": 0.8 } },
    latency: { overrides: {}, localProviders: [] },
    ...overrides,
  }
}

function envWithFavorites(favorites, variant = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omlx-router-pool-"))
  const file = path.join(dir, "model.json")
  fs.writeFileSync(file, JSON.stringify({ favorite: favorites, variant }))
  return { OMLX_ROUTER_FAVORITES: file }
}

test("a configured plan prices the models it covers at plan rates", () => {
  const models = [
    ...catalog(),
    {
      providerID: "xiaomi-token-plan-sgp",
      id: "mimo-v2.6-pro",
      name: "MiMo V2.6 Pro",
      type: "chat",
      settings: { baseURL: "https://plan.example.com/v1" },
      cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
      limit: { context: 1048576, output: 8192 },
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      status: "active",
    },
    {
      providerID: "xiaomi-token-plan-sgp",
      id: "uncovered-model",
      name: "Uncovered",
      type: "chat",
      settings: { baseURL: "https://plan.example.com/v1" },
      cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
      limit: { context: 131072, output: 8192 },
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      status: "active",
    },
  ]
  const env = envWithFavorites([
    { providerID: "xiaomi-token-plan-sgp", modelID: "mimo-v2.6-pro" },
    { providerID: "xiaomi-token-plan-sgp", modelID: "uncovered-model" },
    { providerID: "omlx", modelID: "local-4b" },
    { providerID: "deepseek", modelID: "deepseek-flash" },
  ])
  const { pool } = resolvePool({
    models,
    config: config({ billing: { vendor: "xiaomi-mimo", tier: "max" } }),
    env,
  })
  const mimo = pool.find((model) => model.modelID === "mimo-v2.6-pro")
  // Plan shadow prices at Max rates: $0.366/M input, $0.732/M output.
  expect(mimo.costSource).toBe("plan")
  expect(mimo.cost[0].input).toBeCloseTo(0.366, 3)
  expect(mimo.cost[0].output).toBeCloseTo(0.732, 3)
  // The plan has no weights for this model: it keeps catalog prices.
  const uncovered = pool.find((model) => model.modelID === "uncovered-model")
  expect(uncovered.costSource).toBe("catalog")
  expect(uncovered.cost[0].input).toBe(0)
  // A local model burns no allowance and stays free.
  const local = pool.find((model) => model.modelID === "local-4b")
  expect(local.costSource).not.toBe("plan")
  // A model outside the plan keeps its catalog prices.
  const flash = pool.find((model) => model.modelID === "deepseek-flash")
  expect(flash.costSource).toBe("catalog")
  expect(flash.cost[0].input).toBe(0.2)
})

test("favorites resolve against the catalog with variant and local flag", () => {
  const env = envWithFavorites(
    [
      { providerID: "deepseek", modelID: "deepseek-flash" },
      { providerID: "omlx", modelID: "local-4b" },
    ],
    { "deepseek/deepseek-flash": "high" },
  )
  const { pool, warnings } = resolvePool({ models: catalog(), config: config(), env })
  expect(warnings).toEqual([])
  expect(pool.map((model) => model.modelID)).toEqual(["deepseek-flash", "local-4b"])
  const flash = pool.find((model) => model.modelID === "deepseek-flash")
  expect(flash.variant).toBe("high")
  expect(flash.local).toBe(false)
  expect(flash.qualityOverride).toBe(0.8)
  const local = pool.find((model) => model.modelID === "local-4b")
  expect(local.local).toBe(true)
})

test("empty favorites do not expand to all available models", () => {
  const env = envWithFavorites([])
  const { pool, warnings } = resolvePool({ models: catalog(), config: config(), env })
  expect(warnings[0]).toContain("favorites-empty")
  expect(pool).toEqual([])
})

test("source available is the explicit opt-in to every eligible model", () => {
  const env = envWithFavorites([])
  const { pool } = resolvePool({
    models: catalog(),
    config: config({
      pool: {
        source: "available",
        models: [],
        include: [],
        exclude: [],
        maxModels: 8,
        requireTools: true,
        minContext: 0,
      },
    }),
    env,
  })
  expect(pool.map((model) => model.modelID)).toContain("deepseek-flash")
  expect(pool.map((model) => model.modelID)).not.toContain("no-tools")
  expect(pool.map((model) => model.modelID)).not.toContain("old")
})

test("an unknown pool source selects nothing", () => {
  const env = envWithFavorites([])
  const { pool, warnings } = resolvePool({
    models: catalog(),
    config: config({
      pool: {
        source: "typo",
        models: [],
        include: [],
        exclude: [],
        maxModels: 8,
        requireTools: true,
        minContext: 0,
      },
    }),
    env,
  })
  expect(pool).toEqual([])
  expect(warnings[0]).toContain("unknown pool.source")
})

test("explicit list reports missing entries and respects exclusions", () => {
  const env = envWithFavorites([])
  const { pool, warnings } = resolvePool({
    models: catalog(),
    config: config({
      pool: {
        source: "list",
        models: ["deepseek/deepseek-flash#high", "acme/missing"],
        include: [],
        exclude: ["omlx/*"],
        maxModels: 8,
        requireTools: true,
        minContext: 0,
      },
    }),
    env,
  })
  expect(warnings).toContain("missing: acme/missing")
  expect(pool.length).toBe(1)
  expect(pool[0].variant).toBe("high")
})

test("minContext filters and include can force-add", () => {
  const env = envWithFavorites([{ providerID: "omlx", modelID: "local-4b" }])
  const { pool } = resolvePool({
    models: catalog(),
    config: config({
      pool: {
        source: "favorites",
        models: [],
        include: ["deepseek/*"],
        exclude: [],
        maxModels: 8,
        requireTools: true,
        minContext: 100000,
      },
    }),
    env,
  })
  expect(pool.map((model) => model.modelID)).toEqual(["deepseek-flash"])
})

test("host model state tolerates a missing file", () => {
  const state = readHostModelState("opencode", { OMLX_ROUTER_FAVORITES: "/definitely/missing" })
  expect(state).toEqual({ favorite: [], variant: {} })
})

test("glob matching is anchored and case-insensitive", () => {
  expect(matchesGlob("deepseek/*", "deepseek/deepseek-flash")).toBe(true)
  expect(matchesGlob("*/flash", "deepseek/deepseek-flash")).toBe(false)
  expect(matchesGlob("*flash", "deepseek/deepseek-flash")).toBe(true)
  expect(matchesGlob("deepseek", "deepseek/deepseek-flash")).toBe(false)
  expect(matchesGlob("DEEPSEEK/*", "deepseek/deepseek-flash")).toBe(true)
})

test("the pricing table fills host gaps without overriding real prices", () => {
  const env = envWithFavorites([
    { providerID: "anthropic", modelID: "claude-opus-5-5" },
    { providerID: "openai", modelID: "gpt-6.1-sol" },
    { providerID: "deepseek", modelID: "deepseek-flash" },
    { providerID: "acme", modelID: "mystery" },
  ])
  const capabilities = { tools: true, input: ["text"], output: ["text"] }
  const models = [
    {
      providerID: "anthropic",
      id: "claude-opus-5-5",
      type: "chat",
      settings: { baseURL: "https://api.anthropic.com" },
      cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
      limit: { context: 200000, output: 8192 },
      capabilities,
      status: "active",
    },
    {
      providerID: "openai",
      id: "gpt-6.1-sol",
      type: "chat",
      settings: { baseURL: "https://api.openai.com" },
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
    catalog()[0],
  ]
  const prices = {
    prices: {
      "anthropic/claude-opus-5-5": [{ input: 4, output: 20, cache: { read: 0.2, write: 5 } }],
    },
    byId: {
      gpt61sol: [{ input: 2, output: 10, cache: { read: 0.1, write: undefined } }],
    },
  }
  const { pool } = resolvePool({ models, config: config(), env, prices })
  const byId = Object.fromEntries(pool.map((model) => [model.modelID, model]))

  expect(byId["claude-opus-5-5"].cost[0]).toMatchObject({ input: 4, output: 20 })
  expect(byId["claude-opus-5-5"].costSource).toBe("modelsdev")

  expect(byId["gpt-6.1-sol"].cost[0]).toMatchObject({ input: 2, output: 10 })
  expect(byId["gpt-6.1-sol"].costSource).toBe("modelsdev")

  // A model the host prices correctly keeps its own numbers.
  expect(byId["deepseek-flash"].cost[0]).toMatchObject({ input: 0.2, output: 0.8 })
  expect(byId["deepseek-flash"].costSource).toBe("catalog")

  // No price anywhere is reported as unknown rather than zero.
  expect(byId.mystery.cost).toEqual([])
  expect(byId.mystery.costSource).toBe("unknown")
})

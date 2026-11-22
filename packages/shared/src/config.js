import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { writeJsonAtomic } from "./state.js"

export const DEFAULT_CONFIG = {
  enabled: true,
  policy: "cost",
  policyWeights: null,
  policyByClass: {},
  pool: {
    source: "favorites",
    models: [],
    include: [],
    exclude: [],
    maxModels: 8,
    requireTools: true,
    minContext: 32000,
    localCostZero: true,
  },
  judge: {
    enabled: true,
    baseURL: "http://127.0.0.1:1234/v1",
    model: "auto",
    apiKey: "{env:OMLX_API_KEY}",
    timeoutMs: 5000,
    cacheTtlMs: 600000,
    cacheSize: 128,
    provision: {
      enabled: true,
      backend: "auto",
      repo: "mlx-community/Qwen3-4B-Instruct-2507-4bit",
      adminApiKey: "{env:OMLX_ADMIN_API_KEY}",
      readSettingsKey: true,
      hfToken: "{env:HF_TOKEN}",
      allowNonMlx: false,
    },
  },
  pin: {
    mode: "balanced",
    switchThreshold: 0.12,
    idleTtlMs: 300000,
    maxAgeMs: 1800000,
    maxTurns: 8,
    costSwitchRatio: 4.0,
    flipFlopTurns: 3,
    cacheHitRatio: 0.8,
  },
  optimiser: {
    enabled: true,
    reserveOutputTokens: 8192,
    safetyTokens: 1024,
    maxToolTokens: 2000,
    keepRecentToolOutputs: 3,
    keepRecentTurns: 2,
  },
  compaction: {
    enabled: true,
    expectedTurns: 8,
    baseCooldown: 3,
    judgeRefine: true,
    summaryTokens: 1200,
  },
  limits: {
    shortfallTolerance: 0.2,
    allowLocalForComplexity: 2,
    expectedOutputTokens: 1200,
    contextFitRatio: 0.9,
  },
  quality: {
    overrides: {},
    source: "auto",
    sources: ["epoch", "lmarena"],
    refreshHours: 24,
    timeoutMs: 20000,
    lmarena: {
      dataset: "lmarena-ai/leaderboard-dataset",
      config: "webdev",
      split: "latest",
    },
    epoch: {
      eciURL: "https://epoch.ai/data/eci_scores.csv",
      benchmarksURL: "https://epoch.ai/data/benchmarks.csv",
      coding: true,
    },
  },
  latency: { overrides: {}, localProviders: [] },
  pricing: {
    source: "modelsdev",
    sources: ["modelsdev", "litellm"],
    refreshHours: 24,
    timeoutMs: 20000,
  },
  subagents: {
    enabled: true,
    overrideExplicitModel: false,
    default: { policy: "cost", qualityFloor: 0.0 },
    agents: {
      explore: { policy: "latency", qualityFloor: 0.45, minContext: 128000 },
      general: { policy: "cost", qualityFloor: 0.55 },
      review: { policy: "quality", qualityFloor: 0.75 },
      plan: { policy: "quality", qualityFloor: 0.8 },
    },
  },
  telemetry: { enabled: true },
  failover: {
    enabled: true,
    cooldownMs: 300000,
    serverCooldownMs: 60000,
    authCooldownMs: 300000,
    redirectTtlMs: 60000,
    retryDelayMs: 1000,
  },
  debug: false,
}

export function configPath(env = process.env) {
  return env.OMLX_ROUTER_CONFIG || path.join(os.homedir(), ".config", "omlx-router", "config.json")
}

export const POLICY_PRESETS = {
  cost: { cost: 0.6, quality: 0.3, latency: 0.1 },
  quality: { cost: 0.1, quality: 0.8, latency: 0.1 },
  latency: { cost: 0.2, quality: 0.2, latency: 0.6 },
}

/**
 * Resolve policy weights the same way the WASM core does: preset, then
 * `policyWeights`, then the `policyByClass` entry for the turn class.
 */
export function resolvePolicyWeights(config = {}, turnClass = "") {
  const base = { ...(POLICY_PRESETS[config?.policy] ?? POLICY_PRESETS.cost) }
  for (const source of [config?.policyWeights, config?.policyByClass?.[turnClass]]) {
    if (!source || typeof source !== "object") continue
    for (const key of ["cost", "quality", "latency"]) {
      const value = Number(source[key])
      if (Number.isFinite(value)) base[key] = Math.max(0, value)
    }
  }
  const total = base.cost + base.quality + base.latency
  return total > 0 ? base : { ...(POLICY_PRESETS[config?.policy] ?? POLICY_PRESETS.cost) }
}

export function formatWeights(weights) {
  const value = weights ?? POLICY_PRESETS.cost
  return `cost ${value.cost} · quality ${value.quality} · latency ${value.latency}`
}

/** Expand a `{env:NAME}` reference; an empty value means "no credential". */
export function resolveSecret(value, env = process.env) {
  if (typeof value !== "string") return undefined
  const match = value.match(/^\{env:([A-Z0-9_]+)\}$/i)
  if (match) return env[match[1]]
  return value || undefined
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

/** Recursive merge where `override` wins; arrays and scalars replace. */
export function mergeConfig(base, override) {
  if (!isPlainObject(override)) return override === undefined ? structuredClone(base) : override
  // Deep-copy `base` so the result never shares references with the defaults:
  // callers may mutate their config (e.g. config.judge.baseURL = ...) and must
  // not corrupt DEFAULT_CONFIG for the rest of the process.
  const out = structuredClone(base)
  for (const [key, value] of Object.entries(override)) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? mergeConfig(out[key], value) : value
  }
  return out
}

/**
 * Read the shared config, seeding it from plugin options on first run.
 *
 * The file is the source of truth afterwards; `seed` is ignored when it exists.
 */
export function readConfig({ env = process.env, seed, write = true } = {}) {
  const file = configPath(env)
  let raw
  let existed = false
  let error = null
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"))
    existed = true
  } catch (cause) {
    if (cause.code !== "ENOENT") error = `invalid config: ${cause.message}`
  }

  if (!existed && !error) {
    const config = mergeConfig(DEFAULT_CONFIG, seed ?? {})
    if (write) {
      try {
        writeJsonAtomic(file, config)
      } catch (cause) {
        error = `cannot write config: ${cause.message}`
      }
    }
    return { config, path: file, existed: false, seeded: write && !error, error }
  }

  const config = mergeConfig(DEFAULT_CONFIG, isPlainObject(raw) ? raw : {})
  return { config, path: file, existed, seeded: false, error }
}

export function saveConfig(config, { env = process.env } = {}) {
  const file = configPath(env)
  const merged = mergeConfig(DEFAULT_CONFIG, config)
  writeJsonAtomic(file, merged)
  return merged
}

export function getConfigValue(config, key) {
  return key.split(".").reduce((value, part) => (value == null ? undefined : value[part]), config)
}

export function setConfigValue(config, key, value) {
  const merged = mergeConfig(DEFAULT_CONFIG, config)
  const parts = key.split(".")
  let cursor = merged
  for (const part of parts.slice(0, -1)) {
    if (!isPlainObject(cursor[part])) cursor[part] = {}
    cursor = cursor[part]
  }
  cursor[parts.at(-1)] = value
  return merged
}

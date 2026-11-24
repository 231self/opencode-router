import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { resolveCost } from "@231self/opencode-shared/cost-resolution.js"
import { priceForModel } from "./pricing.js"
import { qualityForModel } from "./quality.js"

export function favoritesPath(host, env = process.env) {
  return env.OMLX_ROUTER_FAVORITES || path.join(os.homedir(), ".local", "state", host, "model.json")
}

/** Read the host's model state (`favorite`, `variant`); tolerate anything. */
export function readHostModelState(host, env = process.env) {
  try {
    const raw = JSON.parse(fs.readFileSync(favoritesPath(host, env), "utf8"))
    return {
      favorite: Array.isArray(raw?.favorite) ? raw.favorite : [],
      variant: raw?.variant && typeof raw.variant === "object" ? raw.variant : {},
    }
  } catch {
    return { favorite: [], variant: {} }
  }
}

export function matchesGlob(pattern, value) {
  const escaped = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
  return new RegExp(`^${escaped}$`, "i").test(value)
}

function isLoopback(baseURL) {
  if (!baseURL) return false
  try {
    const hostname = new URL(baseURL).hostname
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "0.0.0.0"
  } catch {
    return false
  }
}

function providerBaseURLs(providers) {
  const map = new Map()
  for (const entry of providers ?? []) {
    const info = entry?.info ?? entry
    const id = info?.id ?? info?.providerID
    if (id) map.set(id, info?.settings?.baseURL ?? info?.api?.url)
  }
  return map
}

function hasReasoning(model) {
  if (model?.compatibility?.supportsEffortUpdates || model?.compatibility?.requireReasoning) return true
  return Array.isArray(model?.variants) && model.variants.some((variant) => ["high", "medium", "low"].includes(variant?.id))
}

function catalogKey(model) {
  return `${model.providerID}/${model.id ?? model.modelID}`
}

/** Resolve a configured pool source against the live model catalog. */
export function resolvePool({
  models = [],
  providers = [],
  config,
  host = "opencode",
  env = process.env,
  qualityScores = null,
  prices = null,
} = {}) {
  const warnings = []
  const state = readHostModelState(host, env)
  const baseURLs = providerBaseURLs(providers)
  const byKey = new Map()
  for (const model of models) {
    const id = model?.id ?? model?.modelID
    if (!id || !model?.providerID) continue
    byKey.set(`${model.providerID}/${id}`, model)
  }

  const selected = []
  const add = (model, variant) => {
    if (!model) return
    const id = model.id ?? model.modelID
    const key = catalogKey(model)
    if (selected.some((entry) => entry.key === key)) return
    const baseURL = model.settings?.baseURL ?? model.api?.url ?? baseURLs.get(model.providerID)
    const local =
      isLoopback(baseURL) || (config?.latency?.localProviders ?? []).includes(model.providerID)
    const variantId =
      variant ??
      state.variant?.[key] ??
      state.variant?.[`${model.providerID}/${id}`] ??
      "default"
    selected.push({
      key,
      model,
      variant: variantId,
      local,
    })
  }

  const source = config?.pool?.source ?? "favorites"
  if (source === "favorites") {
    const seen = new Set()
    for (const favorite of state.favorite) {
      const key = `${favorite?.providerID}/${favorite?.modelID}`
      const model = byKey.get(key)
      if (model && !seen.has(key)) {
        seen.add(key)
        add(model)
      }
    }
    if (selected.length === 0) {
      warnings.push(
        "favorites-empty: no models selected; set pool.models, source=available, or favorite a model",
      )
    }
  } else if (source === "list") {
    for (const entry of config?.pool?.models ?? []) {
      const [reference, variant] = String(entry).split("#")
      const model = byKey.get(reference)
      if (model) add(model, variant)
      else if (reference) warnings.push(`missing: ${reference}`)
    }
  } else if (source === "available") {
    for (const model of byKey.values()) add(model)
  } else {
    warnings.push(`unknown pool.source: ${source}`)
  }

  for (const pattern of config?.pool?.include ?? []) {
    for (const [key, model] of byKey) {
      if (matchesGlob(pattern, key) || matchesGlob(pattern, model.id ?? model.modelID)) add(model)
    }
  }

  const includeAll = [...selected]
  const filtered = includeAll.filter(({ key, model }) => {
    const id = model.id ?? model.modelID
    const excluded = (config?.pool?.exclude ?? []).some(
      (pattern) => matchesGlob(pattern, key) || matchesGlob(pattern, id),
    )
    if (excluded) return false
    if ((model.type ?? "chat") !== "chat") return false
    if (model.enabled === false) return false
    if (model.status === "deprecated") return false
    if ((config?.pool?.requireTools ?? true) && !model.capabilities?.tools) return false
    const context = Number(model.limit?.context) || 0
    if (context < (config?.pool?.minContext ?? 0)) return false
    return true
  })

  const pool = filtered.map(({ key, model, variant, local }) => {
    const id = model.id ?? model.modelID
    const qualityKey = `${model.providerID}/${id}`
    const manual = config?.quality?.overrides?.[qualityKey]
    const scored = qualityForModel(qualityScores, {
      providerID: model.providerID,
      id,
      name: model.name,
    })
    const externalCost = priceForModel(prices, { providerID: model.providerID, id, name: model.name })
    // One shared rule decides whose prices apply: a configured plan (the
    // user's own bill) comes first, then the public price table, then the
    // host catalog. Local models burn no allowance and stay free.
    const resolved = resolveCost({
      model,
      billing: config?.billing,
      listPrice: externalCost,
      local,
    })
    const cost = resolved.tiers
    return {
      providerID: model.providerID,
      modelID: id,
      name: model.name ?? id,
      variant,
      local,
      cost,
      costSource: resolved.source,
      limit: {
        context: Number(model.limit?.context) || 0,
        ...(Number(model.limit?.input) > 0 ? { input: Number(model.limit.input) } : {}),
        output: Number(model.limit?.output) || 0,
      },
      capabilities: {
        tools: Boolean(model.capabilities?.tools),
        input: Array.isArray(model.capabilities?.input) ? model.capabilities.input : [],
        output: Array.isArray(model.capabilities?.output) ? model.capabilities.output : [],
      },
      reasoning: hasReasoning(model),
      status: model.status ?? "active",
      qualityOverride: manual ?? scored?.quality ?? null,
      qualitySource: manual != null ? "override" : scored ? scored.source ?? "scores" : null,
      latencyOverrideMs: config?.latency?.overrides?.[qualityKey] ?? null,
    }
  })

  return { pool, source, warnings, candidates: byKey.size, favorites: state.favorite.length }
}

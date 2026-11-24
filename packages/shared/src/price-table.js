/**
 * The public price table, read side.
 *
 * The table is written by whoever refreshes it (the router does), and read by
 * anyone who needs a price: both plugins. Splitting the read side from the
 * fetch side is what lets the compaction advisory see the same public prices
 * the router sees, instead of falling back to the host catalog it has no
 * reason to trust.
 *
 * Sources are public price lists — models.dev and LiteLLM — so no access
 * token is involved and nothing here can leak a credential.
 */
import fs from "node:fs"
import path from "node:path"

import { stateRoot } from "./state.js"

/** Normalise a model name for matching: drop qualifiers and punctuation. */
export function normalizeModelName(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/^[^/]+\//, "")
    .replace(/[^a-z0-9]+/g, "")
}

/** Where the cached table lives. Overridable so tests can isolate it. */
export function pricingCachePath(env = process.env) {
  return env.OMLX_ROUTER_PRICING_CACHE || path.join(stateRoot(env), "pricing.json")
}

/** "modelsdev" or "off". Anything else reads as the default. */
export function pricingSource(config) {
  const source = config?.pricing?.source ?? "modelsdev"
  return ["modelsdev", "off"].includes(source) ? source : "modelsdev"
}

export function readPricingCache(env = process.env) {
  try {
    const raw = JSON.parse(fs.readFileSync(pricingCachePath(env), "utf8"))
    if (!raw || typeof raw !== "object" || !raw.prices) return null
    return raw
  } catch {
    return null
  }
}

/** The cached table for pricing lookups; null when disabled or absent. */
export function loadPricing({ config, env = process.env } = {}) {
  if (pricingSource(config) === "off") return null
  return readPricingCache(env)
}

/**
 * External tiers for one catalog model, or null when the table has none.
 * Matched by exact `providerID/id` first, then by normalised model id.
 */
export function priceForModel(prices, model) {
  if (!prices) return null
  const id = model?.id ?? model?.modelID
  if (!id) return null
  const key = model?.providerID ? `${model.providerID}/${id}` : ""
  return (key && prices.prices?.[key]) || prices.byId?.[normalizeModelName(id)] || null
}

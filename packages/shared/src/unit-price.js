/**
 * The unit price of one model: what 1M tokens of a typical turn on it cost
 * the user. One number per model, weighed by the router's decisions and the
 * compaction advisory, so the two can never disagree about what a token
 * costs.
 *
 * It blends the model's resolved rate card — `resolveCost` in
 * cost-resolution.js: the plan's rates first, then the public price list,
 * then the host catalog — with the token mix of a typical turn. The mix is
 * measured from the user's own turn log where turns exist. A model with no
 * turns falls back to `REFERENCE_MIX`, a published blend, and is labelled a
 * stand-in: it may inform a decision and never vetoes one.
 *
 * Everything is dollars per 1M tokens. The rate card is already in $/Mtok
 * for every billing type (planTiers converts credit weights and dollar
 * budgets), so the blend is a pure weighted average over the four billed
 * buckets: uncached input, cache reads, cache writes, and output. Reasoning
 * tokens bill as output, so they weigh as output.
 */
import { tierAt } from "./cost.js"

/**
 * The stand-in mix for a model with no measured turns, as share weights over
 * the four billed buckets.
 *
 * Published blends differ. llm-stats blends 20 parts input to 1 part output
 * with no cache split (llm-stats.com/ai-models, checked 2026-11-26).
 * Artificial Analysis blends 7 : 2 : 1 cache hits : input : output (via the
 * blended-rate glossary at aicost.tools, checked 2026-11-26). The second is
 * used here because cache dominates agent traffic and the first ignores it.
 * Published blends do not separate cache writes, so the write share is 0:
 * inside the stand-in only, writes cost input price. The measured mix prices
 * writes at their own rate.
 */
export const REFERENCE_MIX = { read: 7, input: 2, write: 0, output: 1 }

/**
 * The billed-bucket mix of the given turns — shares summing to 1 — with the
 * number of turns it was measured from. `modelID` narrows to one model's
 * turns. Null when there is nothing to measure: no measurement, no mix.
 */
export function measureMix(turns, { modelID = "" } = {}) {
  const sum = { input: 0, output: 0, read: 0, write: 0 }
  let counted = 0
  for (const turn of turns ?? []) {
    const tokens = turn?.tokens
    if (!tokens) continue
    if (modelID) {
      const used = turn?.usedModel
      const turnModel =
        typeof used === "string" ? used.split("/").at(-1) : (used?.id ?? used?.modelID ?? "")
      if (turnModel && turnModel !== modelID) continue
    }
    sum.input += Number(tokens.input) || 0
    // Reasoning tokens are billed as output, so they weigh as output.
    sum.output += (Number(tokens.output) || 0) + (Number(tokens.reasoning) || 0)
    sum.read += Number(tokens.cache?.read) || 0
    sum.write += Number(tokens.cache?.write) || 0
    counted += 1
  }
  const total = sum.input + sum.output + sum.read + sum.write
  if (counted === 0 || !(total > 0)) return null
  return {
    turns: counted,
    mix: {
      input: sum.input / total,
      output: sum.output / total,
      read: sum.read / total,
      write: sum.write / total,
    },
  }
}

/**
 * Dollars one million tokens of `mix` cost at the rate card, or null when
 * the card cannot say. `tiers` is the `resolveCost` tier list ($/Mtok).
 *
 * Uncached input is the anchor: a vendor that publishes no cache rate bills
 * reads and writes like input, and a card without an input (or output) rate
 * cannot say what a token costs at all.
 */
export function blendRate(tiers, mix) {
  const shares = mix ?? REFERENCE_MIX
  const read = Number(shares.read) || 0
  const input = Number(shares.input) || 0
  const write = Number(shares.write) || 0
  const output = Number(shares.output) || 0
  const total = read + input + write + output
  if (!(total > 0)) return null
  const tier = tierAt(tiers, 0)
  const inputPrice = Number(tier?.input)
  const outputPrice = Number(tier?.output)
  if (!Number.isFinite(inputPrice) || !Number.isFinite(outputPrice)) return null
  const readPrice = Number.isFinite(Number(tier?.cache?.read)) ? Number(tier.cache.read) : inputPrice
  const writePrice = Number.isFinite(Number(tier?.cache?.write)) ? Number(tier.cache.write) : inputPrice
  return (read * readPrice + input * inputPrice + write * writePrice + output * outputPrice) / total
}

/**
 * The unit price for one resolved model. `resolved` is the output of
 * `resolveCost` — callers resolve once and pass the record, so the unit
 * price and the rest of the display cannot come from different precedence.
 * `turns` is the turn log, `modelID` narrows the measurement to one model,
 * `local` marks a model that burns no allowance.
 *
 * Null when no price exists in the record — a unit price is never invented.
 */
export function unitPrice({ resolved, turns = null, modelID = "", local = false } = {}) {
  if (!resolved) return null
  // A local model burns no allowance and no money: the price is zero, and no
  // mix changes that.
  if (local) {
    return {
      usdPerMTok: 0,
      basis: "local · burns no allowance",
      mix: null,
      measured: true,
      projection: false,
      origin: resolved.origin,
      source: resolved.source,
      ownBill: true,
      moneySuffix: "",
      planName: resolved.planName ?? null,
    }
  }
  const measured = measureMix(turns, { modelID })
  const mix = measured ? measured.mix : REFERENCE_MIX
  const usdPerMTok = blendRate(resolved.tiers, mix)
  if (usdPerMTok == null) return null
  return {
    usdPerMTok,
    basis: measured
      ? `measured mix · ${measured.turns} turn${measured.turns === 1 ? "" : "s"}`
      : "reference mix · stand-in",
    mix,
    measured: Boolean(measured),
    // A stand-in mix or a stand-in price makes the number a projection: it
    // may inform a decision and never vetoes one.
    projection: Boolean(!measured || !resolved.ownBill),
    origin: resolved.origin,
    source: resolved.source,
    ownBill: Boolean(resolved.ownBill),
    moneySuffix: resolved.moneySuffix ?? "",
    planName: resolved.planName ?? null,
  }
}

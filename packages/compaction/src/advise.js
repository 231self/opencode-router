import { compactionRoi, costState, modelledTurnCost, normaliseCost, tierAt } from "@231self/opencode-shared/cost.js"
import { contextMessageTokens, promptPartTokens } from "@231self/opencode-shared/tokens.js"

import { composeAdvisory, guardAllows, normaliseHorizons, projectHorizons } from "./advisory.js"
import { bucketCost, calibrationFor } from "./calibration.js"
import { refineVerdict } from "./refine.js"
import { extractSignals, scoreSignals } from "./trigger.js"

export { guardAllows }

/**
 * The advisory turn: structural scoring, optional judge refinement, and the
 * compaction economics, held steady by the flip-flop guard. Pure except for
 * the judge call (pass `judge: null` for the deterministic-only path).
 *
 * `refine` replaces the judge call with another refiner (the ablation harness
 * uses it to play the judge offline); without it, a `judge` client drives
 * `refineVerdict` as usual.
 *
 * The compacted size estimate is the configured summary size plus the recent
 * tail (`summaryTokens` defaults to 1,200 — typical checkpoint summaries are
 * small; the tail is what survives a compaction untouched).
 */
export async function advise({
  config = {},
  model = null,
  reference = null,
  messages = [],
  tailMessages = null,
  measuredTokens = 0,
  estimatedTokens = 0,
  previousTokens = 0,
  systemTokens = 0,
  guard = null,
  judge = null,
  refine = null,
  cache = null,
  calibration = null,
  noise = null,
}) {
  const settings = config?.compaction ?? {}
  const structural = scoreSignals(extractSignals({ messages, measuredTokens, previousTokens }), settings)

  let refined = null
  const refiner =
    refine ??
    (judge ? (input) => refineVerdict({ judge, ...input }) : null)
  if (structural.verdict === "uncertain" && settings.judgeRefine !== false && refiner) {
    refined = await refiner({
      promptText: lastUserText(messages),
      tailDigest: tailDigest(messages),
      signals: structural.signals,
    })
  }

  // The economics layer needs real prices; without them the advisory stands
  // on structure alone (no veto from invented zeros). The hit rate is the
  // measured share when the host reported usage, and the configured fallback
  // only when nothing has been observed.
  //
  // Three states for the model's own entry: priced, flat (the pool publishes
  // explicit zeros), unknown (no entry at all). A flat-rate pool's list price
  // is usually published by a sibling entry for the same model ID, so the
  // comparison is computed at those prices — labelled as a reference, because
  // a sibling's prices are not the user's bill.
  const ownTiers = normaliseCost(model?.cost)
  const pricing = costState(ownTiers)
  const referenceTiers = normaliseCost(reference?.cost)
  const pricedHere = pricing === "priced"
  const tiers = pricedHere ? ownTiers : referenceTiers
  const priceSource = pricedHere
    ? `catalog · ${model?.providerID ?? "?"}/${model?.id ?? model?.modelID ?? "?"}`
    : referenceTiers.length > 0
      ? `list price · ${reference.providerID}/${reference.id}`
      : pricing === "flat"
        ? "none · no reference price"
        : "none · no price data"
  // Whether the money below was actually computed, and at whose prices.
  const moneyComputed = tiers.some(
    (tier) => Number(tier?.input) > 0 || Number(tier?.output) > 0,
  )
  // Non-empty when the money is a projection at a sibling's list price rather
  // than the user's own bill. Only claim it when money was actually computed.
  const moneyBasis = pricedHere || !moneyComputed ? "" : "at list price"
  const moneySuffix = moneyBasis ? ` · ${moneyBasis}` : ""
  const unpricedNote =
    pricing === "flat" ? "no reference price · $0 marginal" : "no price data"
  const ratio = cache?.ratio ?? (Number(config?.pin?.cacheHitRatio) || 0)
  const calibrated = calibrationFor(calibration, model)
  const measuredSummary = Number(calibrated?.summary?.value)
  const summaryTokens =
    Number.isFinite(measuredSummary) && measuredSummary > 0
      ? measuredSummary
      : Math.max(0, Number(settings.summaryTokens) || 0)
  // The system prompt survives a compaction, so it belongs on both sides of
  // the comparison; the summary and the recent tail are what change.
  const system = Math.max(0, Number(systemTokens) || 0)
  const tail = tailTokens(tailMessages ?? messages)
  const compactedTokens = system + summaryTokens + tail
  // The compacted shape is estimated in message tokens. Scaling it by the
  // observed ratio to the measured size keeps the prediction and the actual
  // recorded against it on one scale, so a prediction error means something.
  const estimatorTokens = Math.max(0, Number(estimatedTokens) || 0)
  const predictedCompacted =
    estimatorTokens > 0 ? measuredTokens * (compactedTokens / estimatorTokens) : compactedTokens
  // Capacity is what actually forces a compaction when the tokens are free:
  // a plan makes cost irrelevant but the window finite.
  const contextLimit = Math.max(0, Number(model?.limit?.context) || 0)
  const capacity = {
    size: Math.max(0, Number(measuredTokens) || 0),
    limit: contextLimit > 0 ? contextLimit : null,
    headroom: contextLimit > 0 ? Math.max(0, contextLimit - (Number(measuredTokens) || 0)) : null,
  }
  const summaryMeasured = Number(calibrated?.summary?.samples) > 0
  const requestMeasured = Number(calibrated?.request?.samples) > 0
  const rebuildMeasured = Number(calibrated?.rebuild?.samples) > 0
  const keepTier = pricedTierAt(tiers, measuredTokens)
  const compactedTier = pricedTierAt(tiers, compactedTokens)
  const summaryCostMeasured = requestMeasured
    ? meanBucketCost(tiers, calibrated.request)
    : null
  const rebuildCost = rebuildMeasured
    ? meanBucketCost(tiers, calibrated.rebuild, { output: false })
    : null
  let summaryCost = null
  let summaryCostSource = unpricedNote
  let keepCost = null
  let steadyCost = null
  let firstTurnCost = null
  if (keepTier && compactedTier) {
    if (summaryCostMeasured == null) {
      summaryCost = modelledTurnCost({
        price: keepTier,
        inputTokens: measuredTokens,
        prefixTokens: measuredTokens,
        cacheHitRatio: ratio,
        outputTokens: summaryTokens,
      })
      summaryCostSource = `modelled${moneySuffix}`
    } else {
      summaryCost = summaryCostMeasured
      summaryCostSource = "measured"
    }
    keepCost = modelledTurnCost({
      price: keepTier,
      inputTokens: measuredTokens,
      prefixTokens: measuredTokens,
      cacheHitRatio: ratio,
      outputTokens: 0,
    })
    steadyCost = modelledTurnCost({
      price: compactedTier,
      inputTokens: compactedTokens,
      prefixTokens: compactedTokens,
      cacheHitRatio: ratio,
      outputTokens: 0,
    })
    const writePrice = compactedTier.cache?.write ?? compactedTier.input ?? 0
    firstTurnCost = (compactedTokens / 1_000_000) * writePrice
  }
  const roi =
    keepTier && compactedTier
      ? compactionRoi({
          price: compactedTier,
          contextTokens: measuredTokens,
          compactedTokens,
          cacheState: null,
          cacheHitRatio: ratio,
          outputTokens: 0,
          expectedTurns: Number(settings.expectedTurns) || 0,
          summaryCost,
          rebuildCost,
          keepCost,
          steadyCost,
          firstTurnCost,
        })
      : null
  const horizons = normaliseHorizons(settings.horizons)

  const advisory = composeAdvisory({
    structural,
    roi,
    refined,
    guard,
    instability: Number(noise?.instability) || 0,
    baseCooldown: Number(settings.baseCooldown) || 3,
    pricing,
    priceSource,
    moneyBasis,
    capacity,
    cache: cache ?? { ratio, samples: 0, source: "fallback" },
    projections: projectHorizons(roi, horizons),
    estimates: {
      summaryTokens,
      summarySource: summaryMeasured ? "measured" : "assumed",
      pricing,
      predictedTotal: predictedCompacted,
      predictedModel: model ? `${model.providerID}/${model.id ?? model.modelID}` : null,
      summaryCost,
      summaryCostSource,
      rebuildCost,
      rebuildSource:
        rebuildCost != null ? "measured" : moneyComputed ? `modelled${moneySuffix}` : unpricedNote,
      lastPrediction: calibrated?.lastPrediction ?? null,
      predictionError: Number(calibrated?.error?.value) || 0,
    },
  })
  return { advisory, guard: nextGuard(guard, advisory) }
}

/** Guard state after one advisory turn. */
export function nextGuard(guard, advisory) {
  const rawTurns = Number(guard?.turns)
  const turns = (Number.isFinite(rawTurns) ? rawTurns : 0) + 1
  const previous = guard?.verdict ?? null
  const rawChanged = Number(guard?.changedTurns)
  const changedTurns =
    previous === advisory.verdict
      ? (Number.isFinite(rawChanged) ? rawChanged : turns)
      : turns
  return { verdict: advisory.verdict, turns, changedTurns }
}

function pricedTierAt(tiers, tokens) {
  const tier = tierAt(tiers, tokens)
  const priced = Number(tier?.input) > 0 || Number(tier?.output) > 0
  return priced ? tier : null
}

/**
 * Price each observed bucket set at the tier its own prefill reaches, then
 * average the dollars. Pricing an averaged prefill would underbill samples
 * that crossed a tier boundary.
 */
function meanBucketCost(tiers, entry, { output = true } = {}) {
  const observations =
    Array.isArray(entry?.recent) && entry.recent.length > 0
      ? entry.recent
      : entry?.value
        ? [entry.value]
        : []
  const costs = []
  for (const buckets of observations) {
    const prefill =
      (Number(buckets.input) || 0) +
      (Number(buckets.read) || 0) +
      (Number(buckets.write) || 0)
    const tier = prefill > 0 ? pricedTierAt(tiers, prefill) : null
    if (!tier) continue
    costs.push(bucketCost(tier, output ? buckets : { ...buckets, output: 0 }))
  }
  return costs.length > 0 ? costs.reduce((total, value) => total + value, 0) / costs.length : null
}

/** Tokens the host keeps untouched across a compaction: the recent tail. */
export function tailTokens(messages) {
  const plain = (messages ?? []).filter((message) => message?.type !== "compaction")
  return plain.slice(-2).reduce((total, message) => {
    if (message?.type && !Array.isArray(message.parts)) {
      const count = contextMessageTokens(message)
      return total + (count == null ? 0 : count)
    }
    const parts = message?.parts ?? []
    return total + parts.reduce((sum, part) => sum + promptPartTokens(part), 0)
  }, 0)
}

function lastUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const role = messages[index]?.info?.role ?? messages[index]?.role ?? ""
    if (role !== "user") continue
    return (messages[index]?.parts ?? [])
      .filter((part) => part?.type === "text")
      .map((part) => part?.text ?? "")
      .join(" ")
  }
  return ""
}

/** Content-free trajectory digest for the judge: roles and tool names only. */
function tailDigest(messages) {
  return messages
    .slice(-8)
    .map((message) => {
      const role = message?.info?.role ?? message?.role ?? "?"
      const parts = message?.parts ?? []
      const tools = parts.filter((part) => part?.type === "tool").map((part) => part?.tool ?? "tool")
      return tools.length > 0 ? `${role}:${tools.join("+")}` : role
    })
    .join(" > ")
}

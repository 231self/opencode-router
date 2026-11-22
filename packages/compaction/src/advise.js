import { compactionRoi, modelledTurnCost, normaliseCost, tierAt } from "@231self/opencode-shared/cost.js"
import { partTokens } from "@231self/opencode-shared/tokens.js"

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
  messages = [],
  measuredTokens = 0,
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
  const tiers = normaliseCost(model?.cost)
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
  const tail = tailTokens(messages)
  const compactedTokens = system + summaryTokens + tail
  const summaryMeasured = Number(calibrated?.summary?.samples) > 0
  const requestMeasured = Number(calibrated?.request?.samples) > 0
  const rebuildMeasured = Number(calibrated?.rebuild?.samples) > 0
  const keepTier = pricedTierAt(tiers, measuredTokens)
  const compactedTier = pricedTierAt(tiers, compactedTokens)
  const requestPrefill = requestMeasured
    ? (Number(calibrated.request.value.input) || 0) +
      (Number(calibrated.request.value.read) || 0) +
      (Number(calibrated.request.value.write) || 0)
    : 0
  const rebuildPrefill = rebuildMeasured
    ? (Number(calibrated.rebuild.value.input) || 0) +
      (Number(calibrated.rebuild.value.read) || 0) +
      (Number(calibrated.rebuild.value.write) || 0)
    : 0
  const requestTier = requestPrefill > 0 ? pricedTierAt(tiers, requestPrefill) : null
  const rebuildTier = rebuildPrefill > 0 ? pricedTierAt(tiers, rebuildPrefill) : null
  let summaryCost = 0
  let keepCost = null
  let steadyCost = null
  let firstTurnCost = null
  if (keepTier && compactedTier) {
    summaryCost =
      requestMeasured && requestTier
        ? bucketCost(requestTier, calibrated.request.value)
        : modelledTurnCost({
            price: keepTier,
            inputTokens: measuredTokens,
            prefixTokens: measuredTokens,
            cacheHitRatio: ratio,
            outputTokens: summaryTokens,
          })
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
  const rebuildCost =
    compactedTier && rebuildMeasured && rebuildTier
      ? bucketCost(rebuildTier, { ...calibrated.rebuild.value, output: 0 })
      : null
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
    cache: cache ?? { ratio, samples: 0, source: "fallback" },
    projections: projectHorizons(roi, horizons),
    estimates: {
      summaryTokens,
      summarySource: summaryMeasured ? "measured" : "assumed",
      predictedTotal: compactedTokens,
      summaryCost,
      summaryCostSource: requestMeasured ? "measured" : "estimated",
      rebuildCost,
      rebuildSource: rebuildMeasured ? "measured" : "modelled",
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

/** Tokens the host keeps untouched across a compaction: the recent tail. */
export function tailTokens(messages) {
  const plain = (messages ?? []).filter((message) => message?.type !== "compaction")
  return plain.slice(-2).reduce((total, message) => {
    const parts = message?.parts ?? []
    return total + parts.reduce((sum, part) => sum + partTokens(part), 0)
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

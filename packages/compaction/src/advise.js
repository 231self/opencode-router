import { compactionRoi, normaliseCost } from "@231self/opencode-shared/cost.js"
import { partTokens } from "@231self/opencode-shared/tokens.js"

import { composeAdvisory, guardAllows } from "./advisory.js"
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
  guard = null,
  judge = null,
  refine = null,
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
  // on structure alone (no veto from invented zeros).
  const tier = pricedTier(model)
  const roi = tier
    ? compactionRoi({
        price: tier,
        contextTokens: measuredTokens,
        compactedTokens: compactedEstimate(messages, settings),
        cacheState: null,
        cacheHitRatio: config?.pin?.cacheHitRatio,
        outputTokens: 0,
        expectedTurns: Number(settings.expectedTurns) || 0,
      })
    : null

  const advisory = composeAdvisory({
    structural,
    roi,
    refined,
    guard,
    instability: Number(noise?.instability) || 0,
    baseCooldown: Number(settings.baseCooldown) || 3,
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

function pricedTier(model) {
  const tiers = normaliseCost(model?.cost)
  const tier = tiers[0] ?? null
  if (!tier) return null
  const priced = Number(tier.input) > 0 || Number(tier.output) > 0
  return priced ? tier : null
}

function compactedEstimate(messages, settings) {
  const summary = Math.max(0, Number(settings.summaryTokens) || 0)
  const tail = messages.slice(-2).reduce((total, message) => {
    const parts = message?.parts ?? []
    return total + parts.reduce((sum, part) => sum + partTokens(part), 0)
  }, 0)
  return summary + tail
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

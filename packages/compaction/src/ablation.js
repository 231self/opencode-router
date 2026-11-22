/**
 * The paper's ablation: the same trajectories through three compaction
 * strategies.
 *
 * - "fixed"   — compact whenever the context crosses a token threshold,
 *               ignoring trajectory structure (the common scaffold default
 *               and the SelfCompact baseline).
 * - "signal"  — the deterministic trigger only.
 * - "hybrid"  — the deterministic trigger with judge refinement at
 *               uncertain candidates (the shipped design).
 *
 * Every case carries an oracle verdict (what should happen) and a price
 * tier so the report can count both verdict quality and realized
 * economics. Pure functions; the CLI and tests feed it fixtures.
 */
import { compactionRoi } from "@231self/opencode-shared/cost.js"

import { extractSignals, scoreSignals } from "./trigger.js"

export const STRATEGIES = ["fixed", "signal", "hybrid"]

const THRESHOLD_DEFAULT = 24_000

/** The fixed-threshold baseline: compact over the threshold, whatever the shape. */
export function fixedVerdict(measuredTokens, threshold = THRESHOLD_DEFAULT) {
  return measuredTokens >= threshold ? "compact-now" : "not-yet"
}

function normalise(verdict) {
  return verdict === "delegate" ? "delegate" : verdict === "compact-now" ? "compact-now" : "not-yet"
}

/**
 * Run one case through one strategy. `refine` (optional) plays the judge's
 * role for the hybrid strategy at uncertain candidates.
 */
export async function runCase({ strategy, scenario, refine = null, threshold = THRESHOLD_DEFAULT }) {
  const signals = extractSignals(scenario)
  let verdict
  let source = strategy
  if (strategy === "fixed") {
    verdict = fixedVerdict(scenario.measuredTokens, threshold)
  } else {
    const structural = scoreSignals(signals, scenario.settings ?? {})
    verdict = structural.verdict
    if (strategy === "hybrid" && structural.verdict === "uncertain" && refine) {
      const refined = await refine({ signals, promptText: scenario.promptText ?? "", tailDigest: scenario.tailDigest ?? "" })
      if (refined) {
        verdict = refined.action === "compact" ? "compact-now" : refined.action === "delegate" ? "delegate" : "not-yet"
        source = "judge"
      }
    }
    verdict = normalise(verdict)
  }

  const roi = scenario.price
    ? compactionRoi({
        price: scenario.price,
        contextTokens: scenario.measuredTokens,
        compactedTokens: scenario.compactedTokens ?? 0,
        cacheHitRatio: scenario.cacheHitRatio ?? 0,
        expectedTurns: scenario.expectedTurns ?? 0,
      })
    : null

  return {
    case: scenario.id,
    strategy,
    verdict,
    source,
    oracle: scenario.oracle,
    correct: normalise(scenario.oracle) === verdict,
    worthIt: roi?.worthIt ?? null,
  }
}

/** Run every case through every strategy and fold the report. */
export async function runAblation({ cases, refine = null, threshold = THRESHOLD_DEFAULT }) {
  const rows = []
  for (const scenario of cases) {
    for (const strategy of STRATEGIES) {
      rows.push(await runCase({ strategy, scenario, refine, threshold }))
    }
  }
  const summary = STRATEGIES.map((strategy) => {
    const mine = rows.filter((row) => row.strategy === strategy)
    return {
      strategy,
      correct: mine.filter((row) => row.correct).length,
      cases: mine.length,
      compactions: mine.filter((row) => row.verdict === "compact-now").length,
      delegates: mine.filter((row) => row.verdict === "delegate").length,
    }
  })
  return { rows, summary }
}

/**
 * The paper's ablation: the same trajectories through three compaction
 * strategies.
 *
 * - "fixed"   — compact whenever the context crosses a token threshold,
 *               ignoring trajectory structure (the common scaffold default
 *               and the SelfCompact baseline).
 * - "signal"  — the deterministic trigger only.
 * - "hybrid"  — the shipped advisory: deterministic trigger, judge refinement
 *               at uncertain candidates, the economics veto, and the guard.
 *
 * The signal and hybrid arms call the production `advise` path, so a verdict
 * the economics would veto or the guard would hold is reported exactly as the
 * plugin would emit it. Only the judge call is replaceable (`refine`), which
 * is what lets the fixtures run offline.
 *
 * Every case carries an oracle verdict (what should happen) and a price tier
 * so the report can count both verdict quality and realized economics.
 * `uncertain` is operationally "do nothing", so it is compared as "not-yet".
 */
import { compactionRoi } from "@231self/opencode-shared/cost.js"

import { advise } from "./advise.js"

export const STRATEGIES = ["fixed", "signal", "hybrid"]

const THRESHOLD_DEFAULT = 24_000

/** The fixed-threshold baseline: compact over the threshold, whatever the shape. */
export function fixedVerdict(measuredTokens, threshold = THRESHOLD_DEFAULT) {
  return measuredTokens >= threshold ? "compact-now" : "not-yet"
}

function normalise(verdict) {
  return verdict === "delegate" ? "delegate" : verdict === "compact-now" ? "compact-now" : "not-yet"
}

function scenarioModel(scenario) {
  if (scenario.model) return scenario.model
  return scenario.price ? { cost: [scenario.price] } : { cost: [] }
}

/** The fixed arm's economics, for the report. Not a decision input. */
function fixedEconomics(scenario) {
  if (!scenario.price) return null
  return compactionRoi({
    price: scenario.price,
    contextTokens: scenario.measuredTokens,
    compactedTokens: scenario.compactedTokens ?? 0,
    cacheHitRatio: scenario.cacheHitRatio ?? 0,
    expectedTurns: scenario.expectedTurns ?? 0,
  })
}

/**
 * Run one case through one strategy. `refine` (optional) plays the judge's
 * role for the hybrid strategy at uncertain candidates. `scenario.guard`,
 * when present, is the advisory state the plugin would have stored; it lets a
 * test exercise the cooldown inside the ablation.
 */
export async function runCase({ strategy, scenario, refine = null, threshold = THRESHOLD_DEFAULT }) {
  if (strategy === "fixed") {
    const verdict = fixedVerdict(scenario.measuredTokens, threshold)
    const roi = fixedEconomics(scenario)
    return {
      case: scenario.id,
      strategy,
      verdict,
      source: "fixed",
      oracle: scenario.oracle,
      correct: normalise(scenario.oracle) === verdict,
      worthIt: roi?.worthIt ?? null,
      breakEvenTurns: roi?.breakEvenTurns ?? Infinity,
    }
  }

  const { advisory } = await advise({
    config: {
      compaction: {
        ...(scenario.settings ?? {}),
        ...(scenario.expectedTurns != null ? { expectedTurns: scenario.expectedTurns } : {}),
        ...(scenario.summaryTokens != null ? { summaryTokens: scenario.summaryTokens } : {}),
        ...(scenario.compaction ?? {}),
      },
      pin: { cacheHitRatio: scenario.cacheHitRatio ?? 0 },
    },
    model: scenarioModel(scenario),
    messages: scenario.messages ?? [],
    measuredTokens: scenario.measuredTokens,
    previousTokens: scenario.previousTokens ?? 0,
    guard: scenario.guard ?? null,
    // The signal arm is the deterministic trigger with judge refinement off.
    refine: strategy === "hybrid" ? refine : null,
  })

  const verdict = normalise(advisory.verdict)
  return {
    case: scenario.id,
    strategy,
    verdict,
    source: advisory.source,
    oracle: scenario.oracle,
    correct: normalise(scenario.oracle) === verdict,
    worthIt: advisory.worthIt,
    breakEvenTurns: advisory.breakEvenTurns,
  }
}

/**
 * Run every case through every strategy. `samples > 1` repeats each case
 * (judge calls are not deterministic); rows carry their sample index and the
 * summary reports the real row count, never a case count dressed up as one.
 */
export async function runAblation({
  cases,
  refine = null,
  threshold = THRESHOLD_DEFAULT,
  samples = 1,
}) {
  const rows = []
  const repeats = Math.max(1, Number(samples) || 1)
  for (const scenario of cases) {
    for (const strategy of STRATEGIES) {
      for (let sample = 0; sample < repeats; sample += 1) {
        rows.push({ sample, ...(await runCase({ strategy, scenario, refine, threshold })) })
      }
    }
  }
  const summary = STRATEGIES.map((strategy) => {
    const mine = rows.filter((row) => row.strategy === strategy)
    return {
      strategy,
      correct: mine.filter((row) => row.correct).length,
      cases: new Set(mine.map((row) => row.case)).size,
      samples: mine.length,
      compactions: mine.filter((row) => row.verdict === "compact-now").length,
      delegates: mine.filter((row) => row.verdict === "delegate").length,
    }
  })
  return { rows, summary }
}

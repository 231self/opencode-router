/**
 * The advisory: structural verdict + compaction economics + judge refinement,
 * held steady by the flip-flop guard. Pure functions; the caller owns state.
 */

/** Horizons shown in the report; the middle one is not special. */
export const DEFAULT_HORIZONS = [3, 8, 15]

/** Sort, dedupe, and bound a configured horizon list. */
export function normaliseHorizons(value) {
  const list = Array.isArray(value) && value.length > 0 ? value : DEFAULT_HORIZONS
  const cleaned = list
    .map(Number)
    .filter((turns) => Number.isFinite(turns) && turns > 0 && turns <= 100)
  return [...new Set(cleaned)].sort((left, right) => left - right)
}

/**
 * Net dollars for each horizon: savings per turn times the remaining turns,
 * minus the one-time invalidation cost. `worthIt` uses the same break-even
 * rule as `compactionRoi`, so a horizon table cannot disagree with the
 * verdict's own economics.
 */
export function projectHorizons(roi, horizons = DEFAULT_HORIZONS) {
  if (!roi) return []
  const savings = Number(roi.perTurnSavings) || 0
  const premium = Number(roi.invalidationCost) || 0
  const breakEven = Number(roi.breakEvenTurns)
  return normaliseHorizons(horizons).map((turns) => ({
    turns,
    net: savings * turns - premium,
    worthIt: Number.isFinite(breakEven) && breakEven <= turns,
  }))
}

/** Turns a verdict change must wait out, scaled by the calibrated instability. */
export function cooldownTurns({ base = 3, instability = 0 } = {}) {
  const extra = Math.ceil(Math.min(1, Math.max(0, Number(instability) || 0)) * 4)
  return Math.max(1, base + extra)
}

/**
 * May the advisory change its verdict this turn?
 *
 * A change needs the cooldown to have elapsed since the last change and the
 * incoming verdict to clear a confidence floor that rises with the judge's
 * calibrated instability. Everything else keeps the standing verdict.
 */
export function guardAllows({ guard, verdict, confidence, instability = 0, baseCooldown = 3 }) {
  const previous = guard?.verdict ?? null
  const turns = Number.isFinite(Number(guard?.turns)) ? Math.max(0, Number(guard.turns)) : 0
  const rawChanged = Number(guard?.changedTurns)
  const changedTurns = Number.isFinite(rawChanged) ? rawChanged : -1
  if (verdict === previous) return true
  const cooldown = cooldownTurns({ base: baseCooldown, instability })
  const floor = 0.5 + 0.4 * Math.min(1, Math.max(0, Number(instability) || 0))
  if (changedTurns < 0) return confidence >= floor
  return turns - changedTurns >= cooldown && confidence >= floor
}

/**
 * Compose the advisory record. `structural` comes from scoreSignals, `roi`
 * from compactionRoi, `refined` from refineVerdict (or null). The
 * deterministic verdict stands unless the judge refined an "uncertain".
 */
export function composeAdvisory({
  structural,
  roi,
  refined = null,
  guard = null,
  instability = 0,
  baseCooldown = 3,
  cache = null,
  projections = [],
  estimates = null,
}) {
  let verdict = structural.verdict
  let confidence = structural.confidence
  let source = "deterministic"
  if (structural.verdict === "uncertain" && refined) {
    verdict = refined.action === "compact" ? "compact-now" : refined.action === "delegate" ? "delegate" : "not-yet"
    confidence = refined.confidence
    source = "judge"
  }

  // The economics veto: compaction is only advised when it pays. A structural
  // "compact-now" with no break-even becomes "not-yet"; "delegate" needs no
  // economics (it spends nothing on the current context).
  if (verdict === "compact-now" && roi && !roi.worthIt) {
    verdict = "not-yet"
    confidence = Math.min(confidence, 0.6)
  }

  const allowed = guardAllows({ guard, verdict, confidence, instability, baseCooldown })
  if (!allowed) {
    verdict = guard?.verdict ?? "not-yet"
    confidence = Math.min(confidence, 0.5)
    source = "guard"
  }

  return {
    verdict,
    confidence,
    source,
    breakEvenTurns: roi?.breakEvenTurns ?? Infinity,
    perTurnSavings: roi?.perTurnSavings ?? 0,
    worthIt: roi?.worthIt ?? false,
    cache: cache ?? { ratio: 0, samples: 0, source: "none" },
    projections,
    estimates: estimates ?? null,
    signals: structural.signals,
  }
}

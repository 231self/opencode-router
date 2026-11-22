import fs from "node:fs"
import path from "node:path"

import { stateRoot, writeJsonAtomic } from "@231self/opencode-shared/state.js"

/**
 * Compaction-verdict noise calibration: how stable the judge's
 * when-to-compact verdict is when the same case is re-sampled. Measured by
 * `bun run compaction:calibrate` and stored beside the router's
 * `judge-noise.json`. The advisory's flip-flop guard scales its cooldown with
 * the measured instability — a judge that contradicts itself must not move
 * the verdict on every turn.
 */
export function compactionNoisePath(env = process.env) {
  return env.OMLX_ROUTER_COMPACTION_NOISE || path.join(stateRoot(env), "compaction-noise.json")
}

export function readCompactionNoise(env = process.env) {
  try {
    return JSON.parse(fs.readFileSync(compactionNoisePath(env), "utf8"))
  } catch {
    return null
  }
}

export function writeCompactionNoise(value, env = process.env) {
  writeJsonAtomic(compactionNoisePath(env), value)
  return value
}

/** Instability of one case's re-sampled verdicts: 1 - majority share. */
export function verdictInstability(verdicts) {
  const values = (Array.isArray(verdicts) ? verdicts : []).filter((value) => typeof value === "string")
  if (values.length < 2) return 0
  const counts = new Map()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  const majority = Math.max(...counts.values())
  return Math.round((1 - majority / values.length) * 1e6) / 1e6
}

/** The band from per-case instability: the worst case, clamped to [0, 1]. */
export function instabilityBand(caseVerdicts) {
  let band = 0
  for (const verdicts of caseVerdicts ?? []) band = Math.max(band, verdictInstability(verdicts))
  return Math.min(1, Math.round(band * 1e6) / 1e6)
}

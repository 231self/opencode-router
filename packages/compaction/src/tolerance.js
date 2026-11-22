import fs from "node:fs"
import path from "node:path"

import { stateRoot, writeJsonAtomic } from "@231self/opencode-shared/state.js"

/**
 * Per-pin compaction tolerance: how much a model's task quality degrades
 * when its context is compacted mid-task. Measured per model by
 * `bun run tolerance:eval` (each task runs twice — intact and compacted),
 * stored beside the other calibration artifacts, and available to routing
 * as a signal.
 *
 * The SAC finding this encodes (NVIDIA, arXiv:2611.05306): compaction
 * tolerance is a model property — one model stays flat, another loses
 * points. Models should not be treated as interchangeable under
 * compaction.
 */

export function tolerancePath(env = process.env) {
  return env.OMLX_ROUTER_COMPACTION_TOLERANCE || path.join(stateRoot(env), "compaction-tolerance.json")
}

export function readTolerance(env = process.env) {
  try {
    return JSON.parse(fs.readFileSync(tolerancePath(env), "utf8"))
  } catch {
    return null
  }
}

export function writeTolerance(value, env = process.env) {
  writeJsonAtomic(tolerancePath(env), value)
  return value
}

/**
 * Relative quality loss between the intact and compacted runs of one task.
 * Negative values mean compaction helped (clamped at -1 for sanity).
 */
export function degradation(intact, compacted) {
  const base = Number(intact)
  const after = Number(compacted)
  if (!Number.isFinite(base) || !Number.isFinite(after) || base <= 0) return 0
  return Math.max(-1, (base - after) / base)
}

/**
 * Fold task pairs into one tolerance record per model:
 * `{ model: { degradation, tasks, intact, compacted } }`, sorted worst
 * first when listed. `results` are `{ model, task, intact, compacted }`.
 */
export function summariseTolerance(results) {
  const byModel = new Map()
  for (const result of results ?? []) {
    const model = String(result?.model ?? "unknown")
    const entry = byModel.get(model) ?? { model, tasks: 0, intact: 0, compacted: 0, degradation: 0 }
    entry.tasks += 1
    entry.intact += Number(result.intact) || 0
    entry.compacted += Number(result.compacted) || 0
    byModel.set(model, entry)
  }
  for (const entry of byModel.values()) {
    entry.degradation = degradation(entry.intact, entry.compacted)
    entry.intact = Math.round(entry.intact * 1e6) / 1e6
    entry.compacted = Math.round(entry.compacted * 1e6) / 1e6
    entry.degradation = Math.round(entry.degradation * 1e6) / 1e6
  }
  return [...byModel.values()].sort((left, right) => right.degradation - left.degradation)
}

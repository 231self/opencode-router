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
 * Split a `provider/model` pool label at the first slash. Model ids may
 * contain slashes (`openrouter/meta-llama/llama-3.1-70b`), so splitting on
 * every slash would silently attribute results to the wrong model.
 * Labels without a provider return null; the caller decides the fallback.
 */
export function parseModelLabel(label) {
  const text = String(label ?? "").trim()
  const slash = text.indexOf("/")
  if (slash <= 0 || slash === text.length - 1) return null
  return { providerID: text.slice(0, slash), id: text.slice(slash + 1) }
}

/**
 * Judge settings for a run: the configured endpoint by default, or an
 * explicit override. Credentials stay with the origin they were configured
 * for; an override to a different origin never receives the configured key.
 */
export function judgeTarget({ configured = {}, overrideURL = null } = {}) {
  const fallback = "http://127.0.0.1:1234/v1"
  const baseURL = overrideURL ?? configured.baseURL ?? fallback
  const sameOrigin = originOf(baseURL) === originOf(configured.baseURL ?? fallback)
  return { ...configured, baseURL, ...(sameOrigin ? {} : { apiKey: undefined }) }
}

function originOf(value) {
  try {
    return new URL(String(value)).origin
  } catch {
    return String(value)
  }
}

/**
 * Fold task pairs into one tolerance record per model:
 * `{ model: { degradation, tasks, intact, compacted, invalid } }`, sorted
 * worst first when listed. `results` are
 * `{ model, task, intact, compacted, control? }`.
 *
 * Unparseable grader output arrives as `null` (never as a genuine zero) and
 * is counted as `invalid` instead of being averaged into the score. Control
 * rows deliberately drop evidence from the compacted prompt; they are
 * reported by the runner but excluded here, because their scores measure
 * hallucination under missing information, not compaction tolerance.
 */
export function summariseTolerance(results) {
  const byModel = new Map()
  for (const result of results ?? []) {
    if (result?.control) continue
    const model = String(result?.model ?? "unknown")
    const entry =
      byModel.get(model) ?? { model, tasks: 0, intact: 0, compacted: 0, degradation: 0, invalid: 0 }
    const intact = result?.intact == null ? null : Number(result.intact)
    const compacted = result?.compacted == null ? null : Number(result.compacted)
    byModel.set(model, entry)
    if (!Number.isFinite(intact) || !Number.isFinite(compacted)) {
      entry.invalid += 1
      continue
    }
    entry.tasks += 1
    entry.intact += intact
    entry.compacted += compacted
  }
  for (const entry of byModel.values()) {
    entry.degradation = degradation(entry.intact, entry.compacted)
    entry.intact = Math.round(entry.intact * 1e6) / 1e6
    entry.compacted = Math.round(entry.compacted * 1e6) / 1e6
    entry.degradation = Math.round(entry.degradation * 1e6) / 1e6
  }
  return [...byModel.values()].sort((left, right) => right.degradation - left.degradation)
}

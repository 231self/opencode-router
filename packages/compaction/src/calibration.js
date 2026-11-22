import fs from "node:fs"
import path from "node:path"

import { readJson, stateRoot, writeJsonAtomic } from "@231self/opencode-shared/state.js"

/**
 * Rolling observations from real compactions:
 *
 * - `summary` — the post-compaction context size the host actually produced,
 *   minus the retained tail. This replaces the configured `summaryTokens`
 *   guess for the next decision.
 * - `request` — token buckets of the step(s) that generated the summary, when
 *   an explicit `/ctx here` request makes the boundary known.
 * - `rebuild` — token buckets of the first post-compaction turn, which is the
 *   real cache-invalidation cost.
 *
 * Values are exponential means over the last observations, not a full history:
 * the point is a better next estimate, not an audit log.
 */
export const MAX_SAMPLES = 20

export function calibrationPath(env = process.env) {
  return (
    env.OMLX_ROUTER_COMPACTION_CALIBRATION ||
    path.join(stateRoot(env), "compaction-calibration.json")
  )
}

export function readCalibration(env = process.env) {
  try {
    const value = readJson(calibrationPath(env))
    if (!value || typeof value !== "object" || typeof value.models !== "object") {
      return { at: 0, models: {} }
    }
    return value
  } catch {
    return { at: 0, models: {} }
  }
}

export function writeCalibration(value, env = process.env) {
  writeJsonAtomic(calibrationPath(env), value)
  return value
}

/**
 * Read-modify-write under a small file lock. Two OpenCode processes can share
 * the state root; an atomic rename prevents torn JSON but not lost updates.
 * `mutate` receives the freshest document and returns the next one.
 */
export function updateCalibration(env = process.env, mutate = (value) => value) {
  const file = calibrationPath(env)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const lock = `${file}.lock`
  const wait = new Int32Array(new SharedArrayBuffer(4))
  const deadline = Date.now() + 200
  let fd = null
  for (;;) {
    try {
      fd = fs.openSync(lock, "wx")
      break
    } catch (error) {
      if (error.code !== "EEXIST") throw error
      if (Date.now() > deadline) {
        // Never unlink a lock we did not create: a slow writer may still own
        // it. A crashed writer's lock needs manual removal; the advisory
        // continues with its in-memory calibration.
        throw new Error("compaction calibration lock is busy")
      }
      Atomics.wait(wait, 0, 0, 5)
    }
  }
  try {
    const current = readCalibration(env)
    const next = mutate(current) ?? current
    next.at = Date.now()
    writeJsonAtomic(file, next)
    return next
  } finally {
    try {
      fs.closeSync(fd)
    } catch {
      // The lock file is removed next.
    }
    try {
      fs.unlinkSync(lock)
    } catch {
      // A failed unlink leaves a stale lock; do not retry indefinitely.
    }
  }
}

/** `provider/id`, matching the router's turn and pin labels. */
export function modelKey(model) {
  if (!model?.providerID) return null
  const id = model.id ?? model.modelID
  if (!id) return null
  return `${model.providerID}/${id}`
}

export function calibrationFor(calibration, model) {
  const key = modelKey(model)
  if (!key) return null
  return calibration?.models?.[key] ?? null
}

function foldNumber(previous, value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return previous
  const samples = Math.min(MAX_SAMPLES, (Number(previous?.samples) || 0) + 1)
  const previousValue = Number(previous?.value)
  const mean =
    Number.isFinite(previousValue) && (Number(previous?.samples) || 0) > 0
      ? previousValue + (number - previousValue) / samples
      : number
  return { value: mean, samples, at: Date.now() }
}

function foldBuckets(previous, value) {
  if (!value || typeof value !== "object") return previous
  const buckets = {
    input: Number(value.input) || 0,
    read: Number(value.read ?? value.cache?.read) || 0,
    write: Number(value.write ?? value.cache?.write) || 0,
    output: Number(value.output) || 0,
  }
  const prev = previous?.value ?? {}
  const samples = Math.min(MAX_SAMPLES, (Number(previous?.samples) || 0) + 1)
  const mean = (key) =>
    (Number(prev[key]) || 0) +
    (buckets[key] - (Number(prev[key]) || 0)) / samples
  const recent = [...(previous?.recent ?? []), buckets].slice(-5)
  return {
    value: { input: mean("input"), read: mean("read"), write: mean("write"), output: mean("output") },
    recent,
    samples,
    at: Date.now(),
  }
}

/**
 * Add one observation to a model's calibration and return a new document.
 * `kind` is `summary` | `request` | `rebuild` | `compaction`.
 */
export function recordObservation(calibration, { model, kind, value, at = Date.now() } = {}) {
  const key = modelKey(model)
  if (!key) return calibration
  // Preserve document metadata such as `sessions`: dropping it would let an
  // already-calibrated checkpoint count again after a rebuild-only update.
  const next = {
    ...(calibration ?? {}),
    at,
    models: { ...(calibration?.models ?? {}) },
  }
  const entry = { ...(next.models[key] ?? {}) }
  if (kind === "summary") {
    const folded = foldNumber(entry.summary, value)
    if (folded) entry.summary = folded
  } else if (kind === "request" || kind === "rebuild") {
    const folded = foldBuckets(entry[kind], value)
    if (folded) entry[kind] = folded
  } else if (kind === "prediction") {
    const predicted = Number(value?.predicted) || 0
    const actual = Number(value?.actual) || 0
    if (predicted > 0) {
      const error = (actual - predicted) / predicted
      entry.error = foldNumber(entry.error, Math.abs(error))
      entry.lastPrediction = { predicted, actual, error, at }
    }
  } else if (kind === "compaction") {
    entry.compactions = (Number(entry.compactions) || 0) + 1
    entry.at = at
  }
  next.models[key] = entry
  return next
}

/** Cost of a bucket set at one price tier, in dollars. */
export function bucketCost(price, buckets) {
  if (!price || !buckets) return 0
  const writePrice =
    price.cache?.write !== undefined
      ? Number(price.cache.write) || 0
      : Number(price.input) || 0
  return (
    ((Number(buckets.input) || 0) * (Number(price.input) || 0) +
      (Number(buckets.read) || 0) * (Number(price.cache?.read) || 0) +
      (Number(buckets.write) || 0) * writePrice +
      (Number(buckets.output) || 0) * (Number(price.output) || 0)) /
    1_000_000
  )
}

import { refOf, sameModel } from "@231self/opencode-shared/refs.js"
import { readTurns, sessionHash } from "@231self/opencode-shared/state.js"

/**
 * Cache-hit accounting from provider-reported usage.
 *
 * Both plugins see the same `session.step.*` events. The router persists a
 * turn log, but the compaction plugin must work without it, so usage is kept
 * in memory per session and the router's turn log is only a restart seed.
 *
 * Providers document different cache lifetimes. Only providers with a known
 * short-lived cache expire by time; an unknown provider is assumed to keep
 * serving until the model changes, which is the safer error for a cost
 * estimate (it does not invent a cold cache).
 */
export const DEFAULT_CACHE_TTL_MS = {
  anthropic: 300_000,
  openai: 300_000,
}

export const DEFAULT_CACHE_WINDOW = 5

const RATIO_CAP = 0.95
const MAX_SESSIONS = 32
const MAX_STEPS = 20

function tokensOf(value) {
  return {
    input: Number(value?.input) || 0,
    read: Number(value?.cache?.read ?? value?.cache_read) || 0,
    write: Number(value?.cache?.write ?? value?.cache_write) || 0,
  }
}

/** The cache lifetime that applies to one provider. 0 means no expiry. */
export function ttlForProvider(providerID, { ttlByProvider = {}, ttlMs = 0 } = {}) {
  const global = Number(ttlMs)
  if (Number.isFinite(global) && global > 0) return global
  const key = String(providerID ?? "").toLowerCase()
  const configured = Number(ttlByProvider?.[key])
  if (Number.isFinite(configured) && configured >= 0) return configured
  return Number(DEFAULT_CACHE_TTL_MS[key]) || 0
}

/**
 * Cache-read share over a set of steps. Returns `expired: true` with ratio 0
 * when the newest step is older than the provider's cache lifetime.
 */
export function cacheRatio(steps, { ttlMs = 0, now = Date.now() } = {}) {
  const usable = (steps ?? []).filter((step) => step && Number.isFinite(step.at))
  if (usable.length === 0) return null
  const lastAt = Math.max(...usable.map((step) => step.at))
  if (ttlMs > 0 && now - lastAt > ttlMs) {
    return { ratio: 0, samples: usable.length, lastAt, expired: true }
  }
  let input = 0
  let read = 0
  let write = 0
  for (const step of usable) {
    input += step.tokens.input
    read += step.tokens.read
    write += step.tokens.write
  }
  const prefill = input + read + write
  return {
    ratio: prefill > 0 ? Math.min(RATIO_CAP, read / prefill) : 0,
    samples: usable.length,
    lastAt,
    expired: false,
  }
}

export class UsageTracker {
  constructor({ host = "opencode", env = process.env, now = () => Date.now() } = {}) {
    this.host = host
    this.env = env
    this.now = now
    this.sessions = new Map()
  }

  state(sessionID) {
    const key = String(sessionID)
    let state = this.sessions.get(key)
    if (!state) {
      state = { steps: [], current: null }
      this.sessions.set(key, state)
      if (this.sessions.size > MAX_SESSIONS) {
        const oldest = this.sessions.keys().next().value
        if (oldest !== undefined && oldest !== key) this.sessions.delete(oldest)
      }
    }
    return state
  }

  /** `session.step.started`: the model is known here, the usage is not. */
  noteStepStart({ sessionID, model, at } = {}) {
    if (!sessionID) return
    const state = this.state(sessionID)
    state.current = { model: refOf(model), at: Number(at) || this.now() }
  }

  /** `session.step.ended`: attach the reported usage to the step's model. */
  noteStepEnd({ sessionID, tokens, at } = {}) {
    if (!sessionID) return
    const state = this.state(sessionID)
    const stamp = Number(at) || this.now()
    state.steps.push({
      at: stamp,
      model: state.current?.model ?? null,
      tokens: tokensOf(tokens),
    })
    if (state.steps.length > MAX_STEPS) state.steps.splice(0, state.steps.length - MAX_STEPS)
    state.current = null
  }

  /**
   * Steps for one session and model. In-memory samples win; when the plugin
   * restarted, the router's persisted turns stand in for them.
   */
  stepsFor({ sessionID, model } = {}) {
    if (!sessionID) return []
    const memory = this.state(sessionID).steps.filter(
      (step) => step.model && (!model || sameModel(step.model, model)),
    )
    if (memory.length > 0) return memory

    const target = model ? `${model.providerID}/${model.id}` : null
    try {
      return readTurns(this.host, 1000, this.env)
        .filter((turn) => turn?.session === sessionHash(sessionID))
        .filter((turn) => !target || turn?.usedModel === target)
        .map((turn) => ({
          at: Number(turn.ts) || 0,
          model: model ? refOf(model) : null,
          tokens: tokensOf(turn.tokens),
        }))
    } catch {
      return []
    }
  }

  /**
   * The ratio to price with, plus where it came from:
   * `measured`, `expired`, or `fallback`.
   */
  ratioFor({
    sessionID,
    model,
    fallback = 0,
    window = DEFAULT_CACHE_WINDOW,
    ttlByProvider = {},
    ttlMs = 0,
  } = {}) {
    const size = Math.max(1, Number(window) || DEFAULT_CACHE_WINDOW)
    const steps = this.stepsFor({ sessionID, model }).slice(-size)
    const computed = cacheRatio(steps, {
      ttlMs: ttlForProvider(model?.providerID, { ttlByProvider, ttlMs }),
      now: this.now(),
    })
    if (!computed) {
      return { ratio: Number(fallback) || 0, samples: 0, source: "fallback", lastAt: 0 }
    }
    return { ...computed, source: computed.expired ? "expired" : "measured" }
  }
}

import { clearPin, readPin, sessionHash, writePin } from "@231self/opencode-shared/state.js"
import { sameModel, refOf } from "@231self/opencode-shared/refs.js"
import { countContextTokens, estimateTokens } from "@231self/opencode-shared/tokens.js"

import { advise, tailTokens } from "./advise.js"
import {
  calibrationFor,
  readCalibration,
  recordObservation,
  updateCalibration,
} from "./calibration.js"
import { applyPlan, buildOptimiseRequest } from "./optimiser.js"
import { readCompactionNoise } from "./noise.js"

/**
 * The V2 context hook reports only provider/id, not limits. Fill in the
 * catalog entry so the optimiser sees the real context budget instead of
 * treating every turn as an overflow.
 */
export async function modelFor(ctx, contextModel) {
  if (!contextModel) return null
  if (Number(contextModel.limit?.context) > 0) return contextModel
  let models = []
  try {
    const value = await ctx?.model?.list()
    models = Array.isArray(value) ? value : (value?.data ?? [])
  } catch {
    models = []
  }
  const found = models.find(
    (model) =>
      String(model?.providerID) === String(contextModel.providerID) &&
      String(model?.id ?? model?.modelID) === String(contextModel.id),
  )
  return found ? { ...found, providerID: found.providerID, id: found.id ?? found.modelID } : contextModel
}

/** Apply the optimiser to a message list without session state (Kilo transform). */
export function contextMessages({ core, config, model, messages, system = [] }) {
  try {
    if (config.optimiser?.enabled === false || !core?.optimise || !model) return null
    const request = buildOptimiseRequest({ model, config, system, messages })
    const result = core.optimise(request)
    if (!result?.stats || result.stats.overflow) return result?.stats ?? null
    applyPlan(messages, result.plan)
    return result.stats
  } catch {
    return null
  }
}

/** The newest completed compaction checkpoint in the active context. */
function checkpointOf(messages) {
  for (let index = (messages?.length ?? 0) - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.type === "compaction" && message.status === "completed" && typeof message.summary === "string") {
      return message
    }
  }
  return null
}

/**
 * The V2 `context` hook: optimise the live context and record its measurement
 * in the session pin. A failed measurement or prune must never break a turn.
 */
export async function runContext({ host, env, ctx, config, core, event, judge = null, usage = null }) {
  try {
    const sessionID = event?.sessionID
    if (!sessionID) return
    await honorCompactRequest({ host, env, ctx, sessionID })
    const model = await modelFor(ctx, event?.model)
    let tokens = null
    let optimiser = null
    let overflow = false

    if (config.optimiser?.enabled !== false && core?.optimise && model) {
      const request = buildOptimiseRequest({
        model,
        config,
        system: event.system,
        messages: event.messages,
      })
      const result = core.optimise(request)
      if (result?.stats) {
        optimiser = result.stats
        if (result.stats.overflow) {
          overflow = true
          tokens = Number(result.stats.beforeTokens) || 0
        } else {
          applyPlan(event.messages, result.plan)
          tokens = Number(result.stats.afterTokens) || 0
        }
      }
    }

    if (tokens == null) tokens = countContextTokens(event)
    const latest = readPin(host, sessionID, env) ?? {}
    const target = refOf(model)
    // A newer prompt may have chosen a different model while this hook was
    // measuring. Never overwrite that decision with stale context state.
    if (latest.model && target && !sameModel(latest.model, target)) return

    // Calibration from real compactions. OpenCode puts the compaction request's
    // model and token usage on the completed checkpoint, so nothing is inferred
    // from timestamps. Summary size comes from the context the host actually
    // sends; rebuild usage comes from the first model step after the checkpoint.
    const settings = config.compaction ?? {}
    const systemTokens = countContextTokens({ system: event.system, messages: [] })
    const hash = sessionHash(sessionID)
    let calibration = readCalibration(env)
    let checkpointID = String(
      calibration?.sessions?.[hash]?.checkpoint ?? latest.compaction?.checkpoint ?? "",
    )
    const checkpoint = checkpointOf(event.messages)
    const newCheckpoint = Boolean(checkpoint?.id && checkpoint.id !== checkpointID)
    const rebuild = checkpointID && usage ? usage.takeRebuild(sessionID) : null
    const usableRebuild = Boolean(rebuild?.tokens && rebuild.checkpoint === checkpointID)
    if (config.compaction?.enabled !== false && target && (newCheckpoint || usableRebuild)) {
      const prior = calibrationFor(calibration, target)
      const priorSummary = Number(prior?.summary?.value)
      const predictedSummary =
        Number.isFinite(priorSummary) && priorSummary > 0
          ? priorSummary
          : Math.max(0, Number(settings.summaryTokens) || 0)
      try {
        calibration = updateCalibration(env, (doc) => {
          let next = doc
          if (usableRebuild) {
            next = recordObservation(next, {
              model: rebuild.model ?? target,
              kind: "rebuild",
              value: rebuild.tokens,
            })
          }
          if (newCheckpoint) {
            const actualContext = Math.max(0, tokens - systemTokens)
            const tail = tailTokens(event.messages)
            next = recordObservation(next, {
              model: target,
              kind: "prediction",
              value: { predicted: systemTokens + predictedSummary + tail, actual: tokens },
            })
            const summaryText = estimateTokens(checkpoint.summary) + 16
            const implied = Math.max(summaryText, actualContext - tail)
            next = recordObservation(next, { model: target, kind: "summary", value: implied })
            next = recordObservation(next, { model: target, kind: "compaction" })

            const request = checkpoint.tokens
              ? {
                  input: Number(checkpoint.tokens.input) || 0,
                  output:
                    (Number(checkpoint.tokens.output) || 0) +
                    (Number(checkpoint.tokens.reasoning) || 0),
                  read: Number(checkpoint.tokens.cache?.read) || 0,
                  write: Number(checkpoint.tokens.cache?.write) || 0,
                }
              : null
            if (request && (request.input || request.output || request.read || request.write)) {
              next = recordObservation(next, {
                model: checkpoint.model ?? target,
                kind: "request",
                value: request,
              })
            }
            next = {
              ...next,
              sessions: {
                ...(next.sessions ?? {}),
                [hash]: { checkpoint: checkpoint.id, at: Date.now() },
              },
            }
          }
          return next
        })
      } catch {
        // A failed calibration write must not block the advisory.
      }
      if (newCheckpoint) {
        checkpointID = checkpoint.id
        usage?.markPendingRebuild({ sessionID, checkpoint: checkpoint.id, at: Date.now() })
      }
    }

    // The advisory (structure + compaction economics + optional judge) with
    // its flip-flop guard state, stored beside the routing state.
    let compactionState = latest.compaction ?? null
    if (config.compaction?.enabled !== false) {
      try {
        let cache = null
        try {
          cache = usage
            ? usage.ratioFor({
                sessionID,
                model: target,
                fallback: Number(config.pin?.cacheHitRatio ?? 0.8),
                window: settings.cacheWindow,
                ttlByProvider: settings.cacheTtlByProvider,
                ttlMs: settings.cacheTtlMs,
              })
            : null
        } catch {
          // A missing measurement falls back to the configured ratio.
        }
        const { advisory, guard } = await advise({
          config,
          model,
          messages: event.messages ?? [],
          measuredTokens: tokens,
          previousTokens: Number(latest.lastContextTokens) || 0,
          systemTokens,
          guard: latest.compaction ?? null,
          judge,
          cache,
          calibration,
          noise: readCompactionNoise(env),
        })
        compactionState = { ...guard, advisory }
      } catch {
        // A failed advisory must never break a turn.
      }
    }

    // Re-read after the last await: a routing decision or a new /ctx request
    // may have landed while the judge was running. Do not overwrite it.
    let fresh = latest
    try {
      fresh = readPin(host, sessionID, env) ?? latest
    } catch {
      fresh = latest
    }
    if (fresh.model && target && !sameModel(fresh.model, target)) return

    if (checkpointID) compactionState = { ...(compactionState ?? {}), checkpoint: checkpointID }
    const requestedAt = fresh.compaction?.requestedAt ?? compactionState?.requestedAt
    if (requestedAt) compactionState = { ...(compactionState ?? {}), requestedAt }

    const clearStale =
      overflow &&
      !fresh.compaction?.requestedAt &&
      (!fresh.model || sameModel(fresh.model, latest.model))
    if (clearStale) clearPin(host, sessionID, env)

    const next = {
      ...fresh,
      lastOptimiser: optimiser,
      compaction: compactionState,
      ...(clearStale ? { model: undefined, forced: false, redirect: null } : {}),
    }
    if (
      !fresh.lastContextTokens ||
      Number(fresh.lastContextTokens) === Number(latest.lastContextTokens)
    ) {
      next.lastContextTokens = tokens
    }
    writePin(host, sessionID, next, env)
  } catch {
    // A failed measurement or prune must never break a turn.
  }
}

/**
 * Honor a `/ctx here` request from the TUI. The marker is cleared before
 * the host call so a failed or refused compaction never loops.
 */
export async function honorCompactRequest({ host, env, ctx, sessionID }) {
  try {
    const pin = readPin(host, sessionID, env) ?? {}
    if (!pin.compaction?.requestedAt) return
    writePin(host, sessionID, { ...pin, compaction: { ...pin.compaction, requestedAt: undefined } }, env)
    if (typeof ctx?.session?.compact === "function") {
      await ctx.session.compact({ sessionID })
    }
  } catch {
    // A refused compaction must never break a turn.
  }
}

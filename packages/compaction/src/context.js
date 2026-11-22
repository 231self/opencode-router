import { clearPin, readPin, writePin } from "@231self/opencode-shared/state.js"
import { sameModel, refOf } from "@231self/opencode-shared/refs.js"
import { countContextTokens, estimateTokens, partTokens } from "@231self/opencode-shared/tokens.js"

import { advise, tailTokens } from "./advise.js"
import { readCalibration, recordObservation, writeCalibration } from "./calibration.js"
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

/** Sum the token buckets of one or more steps. */
function aggregateSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return null
  const total = { input: 0, read: 0, write: 0, output: 0 }
  for (const step of steps) {
    total.input += Number(step?.tokens?.input) || 0
    total.read += Number(step?.tokens?.read) || 0
    total.write += Number(step?.tokens?.write) || 0
    total.output += Number(step?.tokens?.output) || 0
  }
  return total.input || total.read || total.write || total.output ? total : null
}

/**
 * The V2 `context` hook: optimise the live context and record its measurement
 * in the session pin. A failed measurement or prune must never break a turn.
 */
export async function runContext({ host, env, ctx, config, core, event, judge = null, usage = null }) {
  try {
    const sessionID = event?.sessionID
    if (!sessionID) return
    const before = readPin(host, sessionID, env) ?? {}
    const pendingRequest = Number(before.compaction?.requestedAt) || 0
    const requestedAt = pendingRequest || Number(before.compaction?.lastRequestAt) || 0
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

    // Calibration from real compactions. Summary size comes from comparing
    // the predicted checkpoint with the context the host actually sends;
    // rebuild usage comes from the first step after the checkpoint; summary
    // cost is only attributed when an explicit request marks the boundary.
    const settings = config.compaction ?? {}
    let calibration = readCalibration(env)
    let calibrationChanged = false
    let checkpointID = latest.compaction?.checkpoint ?? null
    let lastRequestAt = Number(latest.compaction?.lastRequestAt) || 0
    let checkpointSeen = false
    if (config.compaction?.enabled !== false && target) {
      const rebuild = checkpointID && usage ? usage.takeRebuild(sessionID) : null
      if (rebuild?.tokens && rebuild.checkpoint === checkpointID) {
        calibration = recordObservation(calibration, { model: target, kind: "rebuild", value: rebuild.tokens })
        calibrationChanged = true
      }

      const checkpoint = checkpointOf(event.messages)
      if (checkpoint?.id && checkpoint.id !== checkpointID) {
        const systemTokens = countContextTokens({ system: event.system, messages: [] })
        const actual = Math.max(0, tokens - systemTokens)
        const summaryText = estimateTokens(checkpoint.summary) + 16
        const implied = Math.max(summaryText, actual - tailTokens(event.messages))
        calibration = recordObservation(calibration, { model: target, kind: "summary", value: implied })
        calibration = recordObservation(calibration, { model: target, kind: "compaction" })
        const since = lastRequestAt || requestedAt
        const steps = since > 0 && usage ? usage.stepsSince({ sessionID, model: target, at: since }) : []
        const request = aggregateSteps(steps)
        if (request) {
          calibration = recordObservation(calibration, { model: target, kind: "request", value: request })
        }
        checkpointID = checkpoint.id
        lastRequestAt = 0
        checkpointSeen = true
        calibrationChanged = true
        usage?.markPendingRebuild({ sessionID, checkpoint: checkpoint.id })
      }
      if (calibrationChanged) writeCalibration(calibration, env)
    }
    // A refused request must not leave a stale cutoff that later attributes an
    // unrelated compaction's steps. Keep it for the turn the host was asked.
    if (!checkpointSeen && !pendingRequest) lastRequestAt = 0

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

    if (compactionState && (checkpointID || lastRequestAt)) {
      compactionState = {
        ...compactionState,
        ...(checkpointID ? { checkpoint: checkpointID } : {}),
      }
      if (lastRequestAt) compactionState.lastRequestAt = lastRequestAt
      else delete compactionState.lastRequestAt
    }

    if (overflow) clearPin(host, sessionID, env)
    writePin(
      host,
      sessionID,
      {
        ...latest,
        ...(overflow ? { model: undefined, forced: false, redirect: null } : {}),
        lastContextTokens: tokens,
        lastOptimiser: optimiser,
        compaction: compactionState,
      },
      env,
    )
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
    const requestedAt = Number(pin.compaction.requestedAt) || 0
    // Keep the request time for summary-cost attribution, but never keep the
    // request marker itself: a refused host must not be asked again.
    writePin(
      host,
      sessionID,
      {
        ...pin,
        compaction: {
          ...pin.compaction,
          requestedAt: undefined,
          ...(requestedAt ? { lastRequestAt: requestedAt } : {}),
        },
      },
      env,
    )
    if (typeof ctx?.session?.compact === "function") {
      await ctx.session.compact({ sessionID })
    }
  } catch {
    // A refused compaction must never break a turn.
  }
}

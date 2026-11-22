import { clearPin, readPin, writePin } from "@231self/opencode-shared/state.js"
import { sameModel, refOf } from "@231self/opencode-shared/refs.js"
import { countContextTokens } from "@231self/opencode-shared/tokens.js"

import { advise } from "./advise.js"
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

/**
 * The V2 `context` hook: optimise the live context and record its measurement
 * in the session pin. A failed measurement or prune must never break a turn.
 */
export async function runContext({ host, env, ctx, config, core, event, judge = null }) {
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

    // The advisory (structure + compaction economics + optional judge) with
    // its flip-flop guard state, stored beside the routing state.
    let compactionState = latest.compaction ?? null
    if (config.compaction?.enabled !== false) {
      try {
        const { advisory, guard } = await advise({
          config,
          model,
          messages: event.messages ?? [],
          measuredTokens: tokens,
          previousTokens: Number(latest.lastContextTokens) || 0,
          guard: latest.compaction ?? null,
          judge,
          noise: readCompactionNoise(env),
        })
        compactionState = { ...guard, advisory }
      } catch {
        // A failed advisory must never break a turn.
      }
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
    writePin(host, sessionID, { ...pin, compaction: { ...pin.compaction, requestedAt: undefined } }, env)
    if (typeof ctx?.session?.compact === "function") {
      await ctx.session.compact({ sessionID })
    }
  } catch {
    // A refused compaction must never break a turn.
  }
}

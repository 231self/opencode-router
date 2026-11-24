import { readPin, sessionHash, writePin } from "@231self/opencode-shared/state.js"
import { referencePrice } from "@231self/opencode-shared/cost.js"
import { loadPricing, priceForModel } from "@231self/opencode-shared/price-table.js"
import { sameModel, refOf } from "@231self/opencode-shared/refs.js"
import {
  countContextTokens,
  estimateTokens,
  measureSessionContext,
} from "@231self/opencode-shared/tokens.js"

import { advise, tailTokens } from "./advise.js"
import {
  calibrationFor,
  readCalibration,
  recordObservation,
  updateCalibration,
} from "./calibration.js"
import { applyPlan, buildOptimiseRequest } from "./optimiser.js"
import { readCompactionNoise } from "./noise.js"

/** Every model the host knows, across providers. Never throws. */
export async function catalogModels(ctx) {
  try {
    const value = await ctx?.model?.list()
    return Array.isArray(value) ? value : (value?.data ?? [])
  } catch {
    return []
  }
}

/**
 * The V2 context hook reports only provider/id, not limits. Fill in the
 * catalog entry so the optimiser sees the real context budget instead of
 * treating every turn as an overflow.
 */
export async function modelFor(ctx, contextModel, catalog = null) {
  if (!contextModel) return null
  if (Number(contextModel.limit?.context) > 0) return contextModel
  const models = catalog ?? (await catalogModels(ctx))
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
    let activeMessages = null
    let activeTokens = null
    try {
      const active = await ctx?.session?.context?.({ sessionID })
      if (Array.isArray(active)) {
        const measured = measureSessionContext(active)
        if (measured) {
          activeMessages = active
          activeTokens = measured.tokens
        }
      }
    } catch {
      // The hook's own messages remain the fallback measurement.
    }
    const catalog = await catalogModels(ctx)
    const model = await modelFor(ctx, event?.model, catalog)
    // A flat-rate pool publishes zeros for a model whose list price lives in a
    // sibling entry. That reference lets the economics still speak; the report
    // names the provider so it is never read as the user's own bill.
    const reference = referencePrice(model, catalog)
    // A public price table ranks above the host catalog: it is a published
    // rate, where the catalog is the host's own opinion. Read-only here; the
    // router is what refreshes the cache.
    const priceTable = loadPricing({ config })
    const listPrice = priceForModel(priceTable, model)
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
    // Two numbers, one report. `estimatedTokens` is the message counter;
    // `measuredTokens` is the prompt the provider billed, which is what the
    // cost arithmetic and the context pressure must be driven by.
    const estimatedTokens = activeTokens ?? tokens
    const tailMessages = activeMessages ?? event.messages ?? []
    const checkpoint = checkpointOf(tailMessages)
    const billed = usage?.lastPrefill ? usage.lastPrefill({ sessionID, model: refOf(model) }) : null
    // A step's billed prefill measures the context as of that request. The
    // summary request that produced a checkpoint saw the *pre*-compaction
    // context, so only a request that ran after the checkpoint may stand in.
    // A checkpoint with no timestamp leaves the ordering unprovable, and the
    // estimate is the safer fallback.
    const checkpointAt = checkpoint?.time?.created
    const billedIsCurrent = Boolean(
      billed &&
        (checkpointAt == null
          ? checkpoint == null
          : Number(billed.at) >= Number(checkpointAt)),
    )
    const measuredTokens = billedIsCurrent ? billed.prefill : estimatedTokens
    const contextSource = billedIsCurrent ? "billed" : "estimated"
    const latest = readPin(host, sessionID, env) ?? {}
    const previousTokens = Number(latest.lastContextTokens) || 0
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
    const rebuild = checkpointID && usage ? usage.peekRebuild(sessionID) : null
    const usableRebuild = Boolean(rebuild?.tokens && rebuild.checkpoint === checkpointID)
    const alreadyCalibrated = Boolean(
      checkpoint?.id && calibration?.sessions?.[hash]?.checkpoint === checkpoint.id,
    )
    if (
      config.compaction?.enabled !== false &&
      target &&
      (usableRebuild || (checkpoint?.id && !alreadyCalibrated))
    ) {
      const tail = tailTokens(tailMessages)
      let committed = null
      try {
        committed = updateCalibration(env, (doc) => {
          let next = doc
          if (usableRebuild) {
            next = recordObservation(next, {
              model: rebuild.model ?? target,
              kind: "rebuild",
              value: rebuild.tokens,
            })
          }
          if (checkpoint?.id && doc.sessions?.[hash]?.checkpoint !== checkpoint.id) {
            // Learn the textual summary's size, not whatever else survived.
            // Opaque/native checkpoints have no comparable summary text.
            const summaryText =
              typeof checkpoint.summary === "string" &&
              Boolean(checkpoint.summary.trim()) &&
              !checkpoint.native
                ? estimateTokens(checkpoint.summary) + 16
                : 0
            if (summaryText > 0) {
              const prior = calibrationFor(doc, target)
              const priorSummary = Number(prior?.summary?.value)
              const predictedSummary =
                Number.isFinite(priorSummary) && priorSummary > 0
                  ? priorSummary
                  : Math.max(0, Number(settings.summaryTokens) || 0)
              // Prefer the prediction stored by the last advisory for this
              // model; fall back to reconstructing it for old pins.
              const targetKey = `${target.providerID}/${target.id}`
              const saved = latest.compaction?.advisory?.estimates
              const savedPrediction =
                saved?.predictedModel === targetKey ? Number(saved?.predictedTotal) : NaN
              // A prediction is only worth recording for a compaction observed
              // as it happens. A checkpoint first noticed after a restart or an
              // install is old history: its "post-compaction size" would be the
              // context as it stands now, and a session that had grown for two
              // days recorded a 2,352% phantom error that way.
              const observedBefore = previousTokens > 0
              const shrank = measuredTokens < previousTokens
              if (observedBefore && shrank) {
                const fallbackShape = systemTokens + predictedSummary + tail
                next = recordObservation(next, {
                  model: target,
                  kind: "prediction",
                  value: {
                    predicted:
                      Number.isFinite(savedPrediction) && savedPrediction > 0
                        ? savedPrediction
                        : estimatedTokens > 0
                          ? measuredTokens * (fallbackShape / estimatedTokens)
                          : fallbackShape,
                    actual: measuredTokens,
                  },
                })
              }
              next = recordObservation(next, { model: target, kind: "summary", value: summaryText })
            }
            next = recordObservation(next, { model: target, kind: "compaction" })

            // Only a known producer model can price a measured summary request.
            if (checkpoint.model && checkpoint.tokens) {
              const request = {
                input: Number(checkpoint.tokens.input) || 0,
                output:
                  (Number(checkpoint.tokens.output) || 0) +
                  (Number(checkpoint.tokens.reasoning) || 0),
                read: Number(checkpoint.tokens.cache?.read) || 0,
                write: Number(checkpoint.tokens.cache?.write) || 0,
              }
              if (request.input || request.output || request.read || request.write) {
                next = recordObservation(next, {
                  model: checkpoint.model,
                  kind: "request",
                  value: request,
                })
              }
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
        calibration = committed
      } catch {
        // A failed calibration write must not block the advisory, advance the
        // pin mirror, or consume the rebuild sample.
      }
      if (checkpoint?.id && committed?.sessions?.[hash]?.checkpoint === checkpoint.id) {
        checkpointID = checkpoint.id
        usage?.markPendingRebuild({ sessionID, checkpoint: checkpoint.id, at: Date.now() })
      }
      if (committed && usableRebuild) usage?.clearRebuild(sessionID)
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
          reference,
          listPrice,
          messages: event.messages ?? [],
          measuredTokens,
          estimatedTokens,
          tailMessages,
          previousTokens,
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

    // Re-read after the last await: a routing decision, a cleared pin, or a
    // new /ctx request may have landed while the judge was running. Never
    // resurrect state that was deleted during the wait.
    let fresh
    try {
      fresh = readPin(host, sessionID, env)
    } catch {
      return
    }
    if (fresh == null) {
      if (latest && (latest.model || latest.compaction || latest.lastContextTokens)) return
      fresh = {}
    }
    if (fresh.model && target && !sameModel(fresh.model, target)) return

    // Overflow may only clear the pin this hook measured. A same-model update
    // with a different variant, force flag, or redirect is newer state.
    const sameRouting =
      JSON.stringify(fresh.model ?? null) === JSON.stringify(latest.model ?? null) &&
      Boolean(fresh.forced) === Boolean(latest.forced) &&
      JSON.stringify(fresh.redirect ?? null) === JSON.stringify(latest.redirect ?? null) &&
      (Number(fresh.since) || 0) === (Number(latest.since) || 0)
    const compactionUnchanged =
      JSON.stringify(fresh.compaction ?? null) === JSON.stringify(latest.compaction ?? null)

    let nextCompaction
    if (!compactionUnchanged) {
      // Another writer produced a newer advisory while the judge ran.
      nextCompaction = { ...(fresh.compaction ?? {}) }
    } else {
      nextCompaction = { ...(compactionState ?? {}) }
      if (fresh.compaction?.requestedAt) nextCompaction.requestedAt = fresh.compaction.requestedAt
      if (fresh.compaction?.requestedResult) {
        nextCompaction.requestedResult = fresh.compaction.requestedResult
      }
    }
    if (checkpointID) nextCompaction.checkpoint = checkpointID

    const clearStale = overflow && sameRouting && !fresh.compaction?.requestedAt

    const next = {
      ...fresh,
      lastOptimiser: optimiser,
      compaction: nextCompaction,
      ...(clearStale ? { model: undefined, forced: false, redirect: null } : {}),
    }
    if (
      !fresh.lastContextTokens ||
      Number(fresh.lastContextTokens) === Number(latest.lastContextTokens)
    ) {
      next.lastContextTokens = measuredTokens
      next.lastContextSource = contextSource
    }
    writePin(host, sessionID, next, env)
  } catch {
    // A failed measurement or prune must never break a turn.
  }
}

/** A failure kind safe to persist: a status or an error name, never a message. */
function errorKind(error) {
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status)
  if (Number.isFinite(status) && status > 0) return `http ${status}`
  return String(error?.name ?? "error").slice(0, 40)
}

/**
 * Honor a `/ctx here` request from the TUI.
 *
 * The marker is cleared before the host call so a refused compaction never
 * loops, and the outcome is written back so `/ctx` can report it. This path
 * used to swallow everything: `/ctx here` could fail every time with no way to
 * tell whether the call was skipped, refused, or thrown. A recorded outcome
 * turns that into a diagnosis. Returns the outcome, or null when there was no
 * request to honor.
 */
export async function honorCompactRequest({ host, env, ctx, sessionID }) {
  let pin
  try {
    pin = readPin(host, sessionID, env) ?? {}
  } catch {
    return null
  }
  const requestedAt = Number(pin.compaction?.requestedAt) || 0
  if (!requestedAt) return null

  const outcome = { at: Date.now(), requestedAt, ok: true, via: "session.compact" }
  try {
    writePin(host, sessionID, { ...pin, compaction: { ...pin.compaction, requestedAt: undefined } }, env)
    const compact = ctx?.session?.compact
    if (typeof compact !== "function") {
      outcome.ok = false
      outcome.via = "none"
      outcome.error = "the host exposes no session.compact"
    } else {
      await compact.call(ctx.session, { sessionID, delivery: "steer" })
    }
  } catch (error) {
    outcome.ok = false
    outcome.error = errorKind(error)
  }

  try {
    const fresh = readPin(host, sessionID, env) ?? pin
    writePin(
      host,
      sessionID,
      { ...fresh, compaction: { ...(fresh.compaction ?? {}), requestedResult: outcome } },
      env,
    )
  } catch {
    // A lost result must never break a turn.
  }
  return outcome
}

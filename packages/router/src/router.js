import { readConfig } from "@231self/opencode-shared/config.js"
import { Judge, readJudgeNoise } from "./judge.js"
import { resolvePool } from "./pool.js"
import { loadPricing } from "./pricing.js"
import { loadQualityScores } from "./quality.js"
import {
  appendDecision,
  clearPin,
  latestTurnFor,
  readDecisions,
  readPin,
  readStats,
  readTurns,
  sessionHash,
  writePin,
  writeStats,
} from "@231self/opencode-shared/state.js"
import { cacheHitShare, countContextTokens, estimateTokens, measureSessionContext } from "@231self/opencode-shared/tokens.js"
import { measureMix } from "@231self/opencode-shared/unit-price.js"
import { measureTokensPerTurn } from "@231self/opencode-shared/plan.js"

import { decisionRef, refOf, sameModel, sameModelAndVariant } from "@231self/opencode-shared/refs.js"

export { refOf }

function label(reference) {
  if (!reference) return "unknown"
  return `${reference.providerID}/${reference.id ?? reference.modelID}`
}

const FAILOVER_STATUS = new Set([401, 402, 403, 408, 429])
const FAILOVER_TEXT =
  /rate.?limit|overload|timeout|quota|unavailable|capacity|credit|billing|balance|insufficient|usage.?limit|exhaust|no more tokens/i
const PROVIDER_WIDE_TEXT = /credit|billing|balance|insufficient|quota|usage.?limit|exhaust|account|organization/i
function inputBudget(model, config) {
  const context = Number(model?.limit?.context) || 0
  const output = Number(model?.limit?.output) || Infinity
  const reserve = Math.min(output, Number(config.optimiser?.reserveOutputTokens) || 8192)
  const safety = Number(config.optimiser?.safetyTokens) || 1024
  const ratio = Number(config.limits?.contextFitRatio) || 0.9
  return Math.max(0, Math.min(context * ratio, context - reserve - safety, model?.limit?.input || Infinity))
}

/** Provider failures worth routing around, not merely retrying. */
export function isFailoverError(error) {
  const status = Number(error?.status) || 0
  const type = String(error?.type ?? "")
  if (FAILOVER_STATUS.has(status) || status >= 500) return true
  return FAILOVER_TEXT.test(`${type} ${error?.message ?? ""}`)
}

/** Auth, billing, and quota failures usually affect the whole provider. */
export function isProviderWide(error) {
  const status = Number(error?.status) || 0
  if ([401, 402, 403].includes(status)) return true
  const type = String(error?.type ?? "")
  return PROVIDER_WIDE_TEXT.test(`${type} ${error?.message ?? ""}`)
}

export function cooldownFor(config, error) {
  const failover = config?.failover ?? {}
  const status = Number(error?.status) || 0
  if (status === 401 || status === 402 || status === 403) {
    return Number(failover.authCooldownMs) || 1_800_000
  }
  if (status === 429) return Number(failover.cooldownMs) || 300_000
  return Number(failover.serverCooldownMs) || 60_000
}

/** Unexpired blocks from a session pin. */
export function activeBlocks(pin, now = Date.now()) {
  if (!Array.isArray(pin?.blocked)) return []
  return pin.blocked.filter(
    (block) => block && Number(block.until) > now && block.providerID && block.id,
  )
}

function blockedModel(blocked, reference) {
  if (!reference) return false
  return blocked.some((block) => {
    if (String(block.providerID) !== String(reference.providerID)) return false
    return block.providerWide
      ? true
      : String(block.id) === String(reference.id ?? reference.modelID)
  })
}

function upsertBlock(blocked, reference, until, reason, now, providerWide = false) {
  const keep = (Array.isArray(blocked) ? blocked : [])
    .filter((block) => block && Number(block.until) > now)
    .filter((block) => {
      if (String(block.providerID) !== String(reference.providerID)) return true
      return providerWide
        ? false
        : String(block.id) !== String(reference.id ?? reference.modelID)
    })
  keep.push({
    providerID: reference.providerID,
    id: reference.id ?? reference.modelID,
    until,
    reason,
    ...(providerWide ? { providerWide: true } : {}),
  })
  return keep.slice(-8)
}

/** Pick the next candidate below the failed model from the last decision. */
function nextCandidate(last, failed, blocked) {
  const top = Array.isArray(last?.top) ? last.top : []
  for (const entry of top) {
    const reference = {
      providerID: entry.providerID,
      id: entry.id ?? entry.modelID,
      variant: entry.variant ?? "default",
    }
    if (!reference.providerID || !reference.id) continue
    if (blockedModel(blocked, reference)) continue
    if (
      String(reference.providerID) === String(failed?.providerID) &&
      String(reference.id) === String(failed?.id)
    ) {
      continue
    }
    return reference
  }
  return null
}

function countImages(files) {
  if (!Array.isArray(files)) return 0
  return files.filter((file) => {
    const media = String(file?.mediaType ?? file?.mime ?? file?.media ?? "")
    return media.startsWith("image/") || file?.type === "image"
  }).length
}

function pinForRequest(pin) {
  if (!pin?.model) return null
  return {
    model: pin.model,
    since: Number(pin.since) || 0,
    lastTurnAt: Number(pin.lastTurnAt) || 0,
    lastTurnClass: pin.lastTurnClass ?? "",
    lastComplexity: Number(pin.lastComplexity) || 0,
    switchCount: Number(pin.switchCount) || 0,
    away: Array.isArray(pin.away) ? pin.away : [],
    source: pin.source ?? "",
    forced: Boolean(pin.forced),
  }
}

/**
 * The cache-read share used to price the incumbent.
 *
 * When the pinned model served the session's last turn, its measured share
 * applies; a pin that has not earned a cache (another model served the last
 * turn) is priced cold. With no turn to measure, the measured share of the
 * user's own log prices the horizon before the configured assumption does —
 * measured, not assumed. The configured value applies when nothing is
 * measurable, and when it is 0 (discount off) it applies unchanged.
 */
function cacheHitRatioFor({ host, env, hash, pin, fallback, turns = null }) {
  if (!(fallback > 0)) return fallback
  if (pin?.model) {
    const last = latestTurnFor(host, hash, env)
    if (last) {
      const pinned = `${pin.model.providerID}/${pin.model.id ?? pin.model.modelID}`
      if (last.usedModel !== pinned) return 0
      return Math.min(0.95, cacheHitShare(last.tokens))
    }
  }
  const measured = measureMix(turns ?? readTurns(host, 1000, env))
  return measured ? Math.min(0.95, measured.mix.read) : fallback
}

/** A calibration only speaks for the judge it was measured against. */
function judgeNoiseMatches(noise, judgeConfig) {
  if (!noise?.band) return false
  const base = (value) => String(value ?? "").replace(/\/+$/, "")
  return (
    base(noise.baseURL) === base(judgeConfig?.baseURL) &&
    (noise.requested ?? "auto") === (judgeConfig?.model ?? "auto")
  )
}

/**
 * Host-independent routing orchestration: reads host state, applies the core
 * decision, persists pins/decisions, and drives the judge.
 */
export class Router {
  constructor({
    ctx,
    host = "opencode",
    env = process.env,
    core = null,
    judge = null,
    telemetry = null,
    configOptions = {},
    appliedMode = "same-turn",
  } = {}) {
    this.ctx = ctx
    this.host = host
    this.env = env
    this.core = core
    this.judge = judge ?? new Judge({ config: {}, env })
    this.telemetry = telemetry
    this.configOptions = configOptions
    this.appliedMode = appliedMode
    this.failures = new Map()
    this.lastJudgeError = null
  }

  config() {
    return readConfig({ env: this.env, seed: this.configOptions, write: true }).config
  }

  async session(sessionID) {
    try {
      return await this.ctx.session.get({ sessionID })
    } catch {
      return null
    }
  }

  async agent(agentID) {
    if (!agentID || !this.ctx.agent?.get) return null
    try {
      return await this.ctx.agent.get({ agentID })
    } catch {
      return null
    }
  }

  async catalog() {
    const now = Date.now()
    if (this.catalogCache && now - this.catalogCache.at < 2000) return this.catalogCache.value
    let models = []
    let providers = []
    try {
      const value = await this.ctx.model?.list()
      models = Array.isArray(value) ? value : (value?.data ?? [])
    } catch {
      models = []
    }
    try {
      const value = await this.ctx.provider?.list()
      providers = Array.isArray(value) ? value : (value?.data ?? [])
    } catch {
      providers = []
    }
    const value = { models, providers }
    this.catalogCache = { at: now, value }
    return value
  }

  qualityScores(config) {
    const now = Date.now()
    if (this.qualityCache && now - this.qualityCache.at < 60_000) return this.qualityCache.value
    const value = loadQualityScores({ config, env: this.env })
    this.qualityCache = { at: now, value }
    return value
  }

  pricing(config) {
    const now = Date.now()
    if (this.pricingCache && now - this.pricingCache.at < 60_000) return this.pricingCache.value
    const value = loadPricing({ config, env: this.env })
    this.pricingCache = { at: now, value }
    return value
  }

  async measureContext(sessionID) {
    try {
      return measureSessionContext(await this.ctx.session.context?.({ sessionID }))
    } catch {
      return null
    }
  }

  async prompt(event) {
    const promptStarted = Date.now()
    try {
      const config = this.config()
      if (!config.enabled || !this.core) return
      const sessionID = event?.sessionID
      if (!sessionID) return

      const info = await this.session(sessionID)
      const agent = await this.agent(info?.agent)
      const parent = info?.parentID ? await this.session(info.parentID) : null
      let pin = readPin(this.host, sessionID, this.env)
      const current = refOf(info?.model)

      if (pin?.model && pin.lastApplied && current && !sameModel(current, pin.lastApplied)) {
        pin = { ...pin, forced: true, source: "user", model: current }
      }
      const blocked = activeBlocks(pin)
      if (pin?.model && blockedModel(blocked, pin.model)) {
        pin = { ...pin, model: null, forced: false, source: "" }
      }

      const { models, providers } = await this.catalog()
      const resolved = resolvePool({
        models,
        providers,
        config,
        host: this.host,
        env: this.env,
        qualityScores: this.qualityScores(config),
        prices: this.pricing(config),
      })
      const pool = blocked.length
        ? resolved.pool.filter(
            (model) =>
              !blockedModel(blocked, { providerID: model.providerID, id: model.modelID }),
          )
        : resolved.pool
      if (config.debug) {
        console.log("[omlx-router] pool", {
          host: this.host,
          source: resolved.source,
          models: models.length,
          providers: providers.length,
          size: resolved.pool.length,
          warnings: resolved.warnings,
        })
      }
      const promptText = String(event?.prompt?.text ?? "")
      const promptTokens = estimateTokens(promptText)
      const currentModel = models.find((model) => sameModel(refOf(model), current))
      const currentBudget = inputBudget(currentModel, config)
      const smaller = (model) => !sameModel(refOf(model), current) && inputBudget(model, config) < currentBudget
      const pending = pin?.downgradeCompaction
      const differentWindows = currentBudget > 0 && pool.some((model) => inputBudget(model, config) !== currentBudget)
      const measured = pending || differentWindows ? await this.measureContext(sessionID) : null
      const checkpoint = measured?.checkpoint
      const completed = Boolean(pending && checkpoint?.id && checkpoint.id !== pending.checkpoint &&
        Number(checkpoint.time?.created) >= pending.at)
      const lastContextTokens = measured?.tokens ?? (Number(pin?.lastContextTokens) || 0)
      const totalInput = lastContextTokens + promptTokens
      const sizedPrompt = !event?.prompt?.files?.length && !event?.prompt?.skills?.length
      const needsVerification = (model) => smaller(model) || (pending && !currentBudget)
      const eligible = pool.filter((model) => !needsVerification(model) ||
        (measured && sizedPrompt && (!pending || completed) && totalInput <= inputBudget(model, config)))
      const stats = readStats(this.host, this.env) ?? { decisions: 0, switches: 0 }

      const hash = sessionHash(sessionID)
      // The turn log is the one source for the projection's assumptions: the
      // cache-read share and the output size are measured from it where
      // turns exist, and fall back to the configured estimates otherwise.
      const turns = readTurns(this.host, 1000, this.env)
      const cacheHitRatio = cacheHitRatioFor({
        host: this.host,
        env: this.env,
        hash,
        pin,
        turns,
        fallback: Number.isFinite(Number(config.pin?.cacheHitRatio)) ? Number(config.pin.cacheHitRatio) : 0.8,
      })
      const measuredMix = measureMix(turns)
      const perTurn = measureTokensPerTurn(turns)
      const measuredOutput =
        measuredMix && perTurn ? Math.round(measuredMix.mix.output * perTurn.tokensPerTurn) : 0
      // A score gap inside the judge's calibrated spread is verdict noise, not
      // a reason to switch: floor the hysteresis at the measured band.
      const noise = readJudgeNoise(this.env)
      const noiseBand = judgeNoiseMatches(noise, config.judge) ? Number(noise.band) || 0 : 0
      const switchThreshold = Math.max(Number(config.pin?.switchThreshold) || 0, noiseBand)
      const request = {
        abi: 1,
        nowMs: Date.now(),
        host: this.host,
        kind: "primary",
        role: info?.parentID ? "subagent" : "root",
        session: {
          hash,
          parentHash: info?.parentID ? sessionHash(info.parentID) : null,
          agentID: info?.agent ?? "",
          agentMode: agent?.mode ?? "",
          agentModel: refOf(agent?.model),
          currentModel: current,
          parentModel: refOf(parent?.model),
        },
        turn: {
          promptText,
          promptTokens,
          images: countImages(event?.prompt?.files),
          lastContextTokens,
          toolFailures: this.failures.get(sessionID)?.count ?? 0,
          turnClassHint: null,
        },
        pool: eligible,
        settings: {
          ...config,
          limits: {
            ...(config.limits ?? {}),
            ...(measuredOutput > 0 ? { expectedOutputTokens: measuredOutput } : {}),
          },
          pin: { ...config.pin, cacheHitRatio, switchThreshold },
        },
        pin: completed && !pin?.forced ? null : pinForRequest(pin),
        judge: { verdict: null, cached: false, unavailable: false },
        stats,
      }

      let coreMs = 0
      let coreStarted = Date.now()
      let result = this.core.route(request)
      coreMs += Date.now() - coreStarted
      let judgeMs = null
      if (result.action === "need_judge" && result.judgeRequest) {
        this.judge.configure(config.judge)
        const judgeStarted = Date.now()
        try {
          const judged = await this.judge.verdict({
            prompt: result.judgeRequest.prompt,
            cacheKey: result.judgeRequest.cacheKey,
          })
          request.judge = { verdict: judged.verdict, cached: Boolean(judged.cached), unavailable: false }
          judgeMs = judged.ms ?? Date.now() - judgeStarted
        } catch (error) {
          request.judge = { verdict: null, cached: false, unavailable: true }
          judgeMs = Date.now() - judgeStarted
          this.lastJudgeError = String(error?.message ?? error)
        }
        coreStarted = Date.now()
        result = this.core.route(request)
        coreMs += Date.now() - coreStarted
      }

      // This counterfactual is only a reason to compact, never a routable decision.
      if (measured && sizedPrompt && currentBudget >= totalInput &&
          typeof this.ctx.session.compact === "function" && config.limits?.compactOnDowngrade !== false &&
          !pending && !request.pin?.forced && !info?.parentID &&
          pool.some((model) => smaller(model) && inputBudget(model, config) < totalInput)) {
        const probe = this.core.route({
          ...request,
          pool,
          turn: { ...request.turn, lastContextTokens: 0 },
          judge: { ...request.judge, unavailable: true },
        })
        const wanted = probe.decision && pool.find((model) => sameModel(refOf(model), decisionRef(probe.decision)))
        if (wanted && smaller(wanted) && totalInput > inputBudget(wanted, config) &&
            promptTokens <= inputBudget(wanted, config)) {
          const latest = readPin(this.host, sessionID, this.env) ?? {}
          if (!latest.downgradeCompaction) {
            writePin(this.host, sessionID, {
              ...latest,
              downgradeCompaction: { at: Date.now(), checkpoint: checkpoint?.id ?? null },
            }, this.env)
            try {
              await this.ctx.session.compact({ sessionID })
              this.record({ action: "skip", log: {
                ...result.log,
                ts: Date.now(), host: this.host, session: sessionHash(sessionID),
                stage: "compact/deferred", reason: "context-too-large", chosen: label(current),
              } }, config)
              return
            } catch {
              // Retain the attempt marker: don't repeatedly queue a failed compaction.
              this.record({ action: "skip", log: {
                ...result.log,
                ts: Date.now(), host: this.host, session: sessionHash(sessionID),
                stage: "compact/failed", reason: "compaction-request-failed", chosen: label(current),
              } }, config)
            }
          }
          return
        }
      }

      if (result.action !== "decide" || !result.decision) {
        this.record(result, config)
        return
      }

      const target = decisionRef(result.decision)
      const targetModel = models.find((model) => sameModel(refOf(model), target))
      if (!sameModel(current, target) && targetModel && needsVerification(targetModel)) {
        if (!eligible.some((model) => sameModel(refOf(model), target))) return
        // The judge may have taken time. Check the active context and model again.
        const latest = await this.session(sessionID)
        const fresh = await this.measureContext(sessionID)
        const latestPending = readPin(this.host, sessionID, this.env)?.downgradeCompaction
        if (!fresh || !sameModelAndVariant(current, refOf(latest?.model)) ||
            latestPending?.at !== pending?.at ||
            fresh.checkpoint?.id !== checkpoint?.id ||
            fresh.tokens + promptTokens > inputBudget(targetModel, config)) return
      }

      let switched = false
      let switchError = null
      let switchMs = 0
      if (!sameModelAndVariant(current, decisionRef(result.decision))) {
        const switchStarted = Date.now()
        try {
          const model = { providerID: result.decision.providerID, id: result.decision.id }
          if (result.decision.variant) model.variant = result.decision.variant
          await this.ctx.session.switchModel({ sessionID, model })
          switched = true
        } catch (error) {
          switchError = String(error?.message ?? error)
        } finally {
          switchMs = Date.now() - switchStarted
        }
      }

      const applied = switchError ? current : decisionRef(result.decision)
      const nextPin = {
        ...(result.pin ?? {}),
        lastApplied: applied,
        lastContextTokens,
        ...(switched && targetModel && needsVerification(targetModel) ? { downgradeCompaction: null } : {}),
      }
      if (nextPin.model) {
        // The context hook also writes this file. Merge with the latest pin so
        // a concurrent context write cannot drop the model or routing state.
        const latest = readPin(this.host, sessionID, this.env) ?? {}
        const merged = { ...latest, ...nextPin }
        if (!nextPin.lastContextTokens) merged.lastContextTokens = Number(latest.lastContextTokens) || 0
        writePin(this.host, sessionID, merged, this.env)
      }
      if (result.state) writeStats(this.host, result.state, this.env)
      const routeMs = Date.now() - promptStarted
      this.record(result, config, {
        switched,
        switchError,
        judgeMs,
        routeMs,
        coreMs,
        switchMs,
      })
      this.telemetry?.notePrompt(sessionID, {
        at: promptStarted,
        routeMs,
        judgeMs: judgeMs ?? 0,
        coreMs,
        switchMs,
        chosen: result.action === "decide" ? decisionRef(result.decision) : current,
        role: request.role,
        agent: request.session.agentID,
        complexity: result.decision?.complexity ?? result.log?.complexity,
        turnClass: result.log?.turnClass,
        promptTokens: request.turn.promptTokens,
      })
    } catch (error) {
      if (this.config().debug) console.error("[omlx-router] prompt failed:", String(error?.message ?? error))
    }
  }

  /**
   * Provider failure: block the model for a cooldown, clear the pin, and queue
   * a same-turn redirect to the next candidate from the last decision.
   */
  retry(event) {
    try {
      const config = this.config()
      if (config.failover?.enabled === false) return
      const sessionID = event?.sessionID
      const failed = refOf(event?.model)
      if (!sessionID || !failed) return
      if (!isFailoverError(event?.error)) return

      const now = Date.now()
      const cooldown = cooldownFor(config, event?.error)
      const pin = readPin(this.host, sessionID, this.env) ?? {}
      const providerWide = isProviderWide(event?.error)
      const blocked = upsertBlock(
        pin.blocked,
        failed,
        now + cooldown,
        String(event?.error?.status ?? event?.error?.type ?? "error"),
        now,
        providerWide,
      )
      const last = readDecisions(this.host, 1, this.env)[0] ?? null
      const to = nextCandidate(last, failed, blocked)
      writePin(
        this.host,
        sessionID,
        {
          ...pin,
          blocked,
          redirect: to ? { from: failed, to, at: now } : null,
          model: null,
          forced: false,
          source: "failover",
        },
        this.env,
      )
      appendDecision(
        this.host,
        {
          ts: now,
          host: this.host,
          role: pin.role ?? "root",
          agent: "",
          session: sessionHash(sessionID),
          kind: "primary",
          stage: to ? "failover/redirect" : "failover/blocked",
          reason: "provider-error",
          poolSize: 0,
          chosen: label(to ?? failed),
          pinned: false,
          source: "failover",
          judge: { used: false, cached: false },
          applied: to ? "same-turn" : "none",
          error: String(event?.error?.message ?? event?.error?.type ?? "provider error"),
          top: [],
          turnClass: "",
          complexity: 0,
          failover: {
            from: label(failed),
            to: to ? label(to) : null,
            status: Number(event?.error?.status) || null,
            until: now + cooldown,
            providerWide,
          },
        },
        this.env,
      )
      // Keep the host's own retry policy unless it gave up and we have a
      // different model to try.
      if (!event.decision?.retry && to) {
        event.decision = { retry: true, delay: Number(config.failover?.retryDelayMs) || 1000 }
      }
    } catch (error) {
      if (this.config().debug) console.error("[omlx-router] failover failed:", String(error?.message ?? error))
    }
  }

  /** Swap the failed model for the queued redirect at request resolution. */
  resolveModel(event) {
    try {
      const config = this.config()
      if (config.failover?.enabled === false) return
      const sessionID = event?.sessionID
      if (!sessionID) return
      if (event?.kind && event.kind !== "primary") return
      const current = refOf(event?.model)
      if (!current) return

      const pin = readPin(this.host, sessionID, this.env) ?? {}
      const redirect = pin.redirect
      if (!redirect?.from || !redirect?.to) return
      const ttl = Number(config.failover?.redirectTtlMs) || 60_000
      if (Date.now() - Number(redirect.at ?? 0) > ttl) {
        writePin(this.host, sessionID, { ...pin, redirect: null }, this.env)
        return
      }
      if (!sameModel(current, redirect.from)) return
      if (blockedModel(activeBlocks(pin), redirect.to)) return

      event.model = {
        providerID: redirect.to.providerID,
        id: redirect.to.id,
        ...(redirect.to.variant && redirect.to.variant !== "default"
          ? { variant: redirect.to.variant }
          : {}),
      }
      writePin(
        this.host,
        sessionID,
        {
          ...pin,
          redirect: null,
          model: redirect.to,
          lastApplied: redirect.to,
          forced: false,
          source: "failover",
        },
        this.env,
      )
    } catch (error) {
      if (this.config().debug) console.error("[omlx-router] failover resolve failed:", String(error?.message ?? error))
    }
  }

  record(result, config, extra = {}) {
    const log = result.log ?? null
    if (!log) return
    if (log.reason === "disabled" || log.reason === "subagents_disabled") return
    const record = {
      ...log,
      ...(log.reason === "no_pool"
        ? {
            hint: "No models selected. Open /router pool to choose favorites or an explicit list.",
          }
        : {}),
      applied: result.action === "decide" ? (extra.switchError ? "none" : this.appliedMode) : "none",
      error: extra.switchError ?? null,
      timing: {
        routeMs: Number(extra.routeMs) || 0,
        judgeMs: Number(extra.judgeMs) || 0,
        coreMs: Number(extra.coreMs) || 0,
        switchMs: Number(extra.switchMs) || 0,
      },
      judge: {
        ...(log.judge ?? {}),
        cached: Boolean(result.action === "need_judge" ? false : log.judge?.cached),
        ...(extra.judgeMs != null ? { ms: extra.judgeMs } : {}),
      },
    }
    try {
      appendDecision(this.host, record, this.env)
    } catch (error) {
      if (config?.debug) console.error("[omlx-router] cannot write decision:", String(error?.message ?? error))
    }
  }

  compaction(event) {
    const sessionID = event?.sessionID
    if (!sessionID) return
    try {
      // This hook runs before summarization, not after a checkpoint is applied.
      const pin = readPin(this.host, sessionID, this.env)
      if (!pin?.downgradeCompaction) clearPin(this.host, sessionID, this.env)
    } catch {
      // ignore
    }
    this.failures.delete(sessionID)
  }

  toolAfter(event) {
    const sessionID = event?.sessionID
    if (!sessionID) return
    if (event?.status === "error") {
      const previous = this.failures.get(sessionID)
      const tool = String(event?.tool ?? "")
      const count = previous && previous.tool === tool ? previous.count + 1 : 1
      this.failures.set(sessionID, { tool, count })
    } else {
      this.failures.delete(sessionID)
    }
  }
}

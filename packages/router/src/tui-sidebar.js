import { readConfig } from "@231self/opencode-shared/config.js"
import { registerSidebarBlock } from "@231self/opencode-shared/sidebar.js"
import { readDecisions, readPin, sessionHash } from "@231self/opencode-shared/state.js"

import { readQualityCache } from "./quality.js"

const HOST = "opencode"

/**
 * The router's sidebar block: which model this session is running and why.
 * Bold title, then one bullet per fact — short enough for a narrow sidebar.
 * Pure — the TUI part gathers the state and passes it in.
 *
 * The decision leads, same as the compaction block leads with its verdict:
 * the point of the block is to say, at a glance, what the router chose and
 * why. Policy, pin, quality, and judge are the evidence for that choice, so
 * they follow it. A block that listed only the evidence would make you read
 * the decision out of the state yourself.
 */
export function routerSidebarBlock({
  enabled = true,
  policy = "cost",
  model = null,
  decision = null,
  pin = null,
  quality = null,
  judge = null,
} = {}) {
  const items = []
  if (!enabled) {
    // With routing off no decision is being made, so the state is the news.
    items.push("router off")
    items.push(model ? `running ${modelRef(model)}` : "no model selected")
  } else {
    items.push(decisionLine(decision, model))
    items.push(`policy ${policy}`)
  }
  if (pin?.model) {
    const source = pin.forced ? "forced" : (pin.source ?? "auto")
    items.push(`pin ${source}`)
  }
  if (quality?.value != null) {
    const age = quality.checkedAt ? ` · ${ago(quality.checkedAt)}` : ""
    items.push(`quality ${Number(quality.value).toFixed(2)}${age}`)
  }
  if (judge?.model) {
    items.push(`judge ${judge.model}`)
  }
  return { title: "Router", items }
}

/** A model as `provider/id`, the label the decision log uses. */
export function modelRef(model) {
  if (!model) return null
  return `${model.providerID}/${model.id ?? model.modelID}`
}

/**
 * The router's decision as one short line: which model, and why. Null when no
 * decision exists yet, in which case the model alone is shown — never a reason
 * the log does not contain.
 */
export function decisionLine(decision, model) {
  const ref = modelRef(model)
  if (!ref) return "no model selected"
  const why = reasonPhrase(decision?.reason)
  return why ? `running ${ref} · ${why}` : `running ${ref}`
}

/**
 * The decision log's `reason` as a phrase a person reads. Unknown reasons are
 * passed through rather than dropped, so a new one is visible instead of
 * silently vanishing from the sidebar.
 */
export function reasonPhrase(reason) {
  switch (reason) {
    case "pin-kept":
      return "kept for cache"
    case "best-model":
      return "first pick"
    case "better-model":
      return "switched · better model"
    case "cheaper-model":
      return "switched · cheaper"
    case "quality-gate":
      return "switched · quality gate"
    case "idle-switch":
      return "switched · idle"
    case "complexity-jump":
      return "switched · complexity jump"
    case "pin-age":
      return "switched · pin aged"
    case "pin-turns":
      return "switched · pin turns"
    case "forced":
      return "pinned by you"
    case "provider-error":
      return "failover"
    case "no_pool":
      return "no models in pool"
    default:
      return reason ? String(reason) : null
  }
}

/** A compact age phrase: `42m`, `3h`, `2d`. */
export function ago(timestamp, now = Date.now()) {
  const minutes = Math.max(0, (now - Number(timestamp)) / 60000)
  if (minutes < 60) return `${Math.round(minutes)}m`
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`
  return `${Math.round(minutes / 1440)}d`
}

/**
 * Register the router block in the host sidebar. Reads its state fresh on
 * every refresh; every read is best-effort so the block survives a missing
 * config or state directory.
 */
export function registerRouterSidebar(context, options = {}) {
  return registerSidebarBlock(context, {
    ...options,
    compute: () => {
      const config = readConfig({ write: false }).config
      const sessionID = context.ui?.router?.current?.()?.sessionID
      const pin = sessionID ? readPin(HOST, sessionID) : null
      const last = readDecisions(HOST, 1)[0] ?? null
      let quality = null
      try {
        const cache = readQualityCache()
        const scores = cache?.scores ?? null
        const model = pin?.model ?? last?.model ?? null
        const key = model ? `${model.providerID}/${model.id ?? model.modelID}` : null
        const value = key ? scores?.[key] : null
        if (value != null) quality = { value, checkedAt: cache?.checkedAt ?? null }
      } catch {
        // No quality cache: the block simply omits the line.
      }
      return routerSidebarBlock({
        enabled: Boolean(config.enabled),
        policy: config.policy,
        model: pin?.model ?? last?.model ?? null,
        // The last decision is the router's verdict: which model and why.
        decision: last,
        pin,
        quality,
        judge: config.judge?.enabled ? { model: config.judge.model } : null,
      })
    },
  })
}

/** Session hash helper re-exported for tests that build pins. */
export { sessionHash }

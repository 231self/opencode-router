import { readConfig } from "@231self/opencode-shared/config.js"
import { creditsFromTurns, planLabel, projectBurn, resolveBillings } from "@231self/opencode-shared/plan.js"
import { registerSidebarBlock } from "@231self/opencode-shared/sidebar.js"
import { readPin, readTurns } from "@231self/opencode-shared/state.js"

const HOST = "opencode"

/**
 * The compaction plugin's sidebar block: the verdict, then the numbers behind
 * it. Bold title, then one bullet per fact. Pure — the TUI part gathers the
 * state and passes it in. Lines stay short for a narrow sidebar; the full
 * numbers live in /ctx report.
 *
 * The verdict comes first because it is the point: the sidebar exists to tell
 * you, at a glance, whether to compact now, keep working, or hand the step to
 * a fresh subagent. The window use and the plan burn are the evidence for it,
 * so they follow. A block that showed only the evidence would make you do the
 * judgement yourself.
 *
 * `plans` is one entry per recorded plan, each with its own burn: with more
 * than one plan a single blended figure would hide which allowance is the
 * one running out. An unpriced plan carries no burn and says so.
 */
export function compactionSidebarBlock({
  verdict = null,
  capacity = null,
  plans = null,
  plan = null,
  burn = null,
  expiry = null,
  unitPrice = null,
} = {}) {
  const items = []
  const headline = verdictLine(verdict)
  if (headline) items.push(headline)
  if (capacity?.limit) {
    const free = Math.round((capacity.headroom / capacity.limit) * 100)
    items.push(`ctx ${short(capacity.size)}/${short(capacity.limit)} · ${free}% free`)
  } else if (capacity?.size) {
    items.push(`ctx ${short(capacity.size)}`)
  }
  // The price of one token on this model — the same number the router weighs
  // — with its mix basis: measured from turns, or the published stand-in.
  if (unitPrice && Number(unitPrice.usdPerMTok) > 0) {
    items.push(
      `unit $${Number(unitPrice.usdPerMTok).toPrecision(2)}/M · ${unitPrice.measured ? "measured mix" : "stand-in mix"}`,
    )
  }
  // One plan: the single-line form. Several: one burn line each.
  const entries = Array.isArray(plans) && plans.length > 0 ? plans : (plan ? [{ label: plan, burn }] : [])
  for (const entry of entries) {
    items.push(`plan ${entry.label}`)
    if (entry.burn) {
      items.push(`burn ${short(entry.burn.used)}/${short(entry.burn.allowance)} credits (${Math.round(entry.burn.percentUsed)}%)`)
      if (entry.burn.daysLeft != null) {
        items.push(`reset ${Math.round(entry.burn.daysLeft)}d · proj ${short(entry.burn.projected)}`)
      }
    }
  }
  if (expiry) {
    items.push(`expiry ${short(expiry.cold)} credits (${Math.round(expiry.ratio)}x hot)`)
  }
  return { title: "Context", items }
}

/**
 * The verdict as one short line: what to do, and why in a few words. Null when
 * there is no advisory yet, so the block shows its numbers without inventing a
 * recommendation.
 */
export function verdictLine(verdict) {
  if (!verdict || !verdict.verdict) return null
  const action =
    verdict.verdict === "compact-now"
      ? "compact now"
      : verdict.verdict === "delegate"
        ? "delegate"
        : verdict.verdict === "not-yet"
          ? "keep working"
          : "uncertain"
  // A short reason, only when the numbers support one.
  const turns = Number(verdict.breakEvenTurns)
  let reason = null
  if (verdict.verdict === "compact-now" && Number.isFinite(turns) && turns > 0) {
    reason = `pays back in ${turns === 1 ? "1 turn" : `${Math.round(turns)} turns`}`
  } else if (verdict.verdict === "delegate") {
    reason = "looks like review"
  } else if (verdict.verdict === "compact-now") {
    reason = "safe checkpoint"
  }
  return reason ? `verdict ${action} · ${reason}` : `verdict ${action}`
}

/** Compact token/credit counts: `500K`, `12.4B`, `1.2M`. */
export function short(value) {
  const number = Number(value) || 0
  if (number >= 1e9) return `${(number / 1e9).toFixed(1)}B`
  if (number >= 1e6) return `${(number / 1e6).toFixed(1)}M`
  if (number >= 1e3) return `${(number / 1e3).toFixed(0)}K`
  return String(Math.round(number))
}

/**
 * Register the compaction block in the host sidebar. Reads its state fresh
 * on every refresh: the pin (context size, plan estimates) and the turn log
 * (allowance burn). Every read is best-effort.
 */
export function registerCompactionSidebar(context, options = {}) {
  return registerSidebarBlock(context, {
    ...options,
    compute: () => {
      const config = readConfig({ write: false }).config
      const sessionID = context.ui?.router?.current?.()?.sessionID
      const pin = sessionID ? readPin(HOST, sessionID) : null
      const advisory = pin?.compaction?.advisory ?? null
      const planEstimates = advisory?.estimates?.plan ?? null
      const billing = config?.billing

      // One entry per recorded plan, each with its own burn. A plan with no
      // published allowance (ChatGPT) shows its name and no burn rather than
      // a number that would have to be invented.
      let plans = null
      const records = resolveBillings(billing)
      if (records.length > 0) {
        let usage = null
        try {
          // The resolved records keep their identity through `creditsFromTurns`,
          // which is what the burn buckets match on below.
          usage = creditsFromTurns(readTurns(HOST, 500), records, { modelID: "" })
        } catch {
          // No turn log: the plan lines show without burn rather than guessing.
        }
        plans = records.map((record) => ({
          label: planLabel(record),
          burn: usage ? projectBurn({ billing: record, usedCredits: usage.byPlan.find((entry) => entry.record === record)?.credits ?? 0, now: Date.now() }) : null,
        }))
      }

      return compactionSidebarBlock({
        // The verdict the sidebar exists to show. `advisory` carries it along
        // with the numbers; the block renders the conclusion first.
        verdict: advisory,
        capacity: advisory?.capacity ?? null,
        plans,
        expiry: planEstimates?.expiry ?? null,
        unitPrice: advisory?.unitPrice ?? null,
      })
    },
  })
}

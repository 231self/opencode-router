/**
 * The web dashboard's JSON builders: pure functions over state records.
 *
 * Everything a response may carry is built here from an allow-list
 * projection — counts, sizes, prices, labels, and identifiers only. Prompt
 * text, tool output, and credentials cannot appear in any response even
 * when the underlying state records carry them, because no builder ever
 * copies a field the projection did not pick.
 *
 * Scope is a filter over existing records, never new persistence:
 * `scope=session` narrows turns and decisions to one session hash (the one
 * the dashboard was launched from); `scope=all` is the whole state dir.
 * Plan burn is account-wide and does not narrow — its card says so.
 */
import {
  creditsFromTurns,
  planLabel,
  projectBurn,
  resolveBillings,
} from "@231self/opencode-shared/plan.js"
import { REFERENCE_MIX, blendRate, measureMix } from "@231self/opencode-shared/unit-price.js"

/** The fields one turn may contribute to any response. */
function pickTurn(turn) {
  const used = turn?.usedModel
  return {
    ts: Number(turn?.ts) || 0,
    session: String(turn?.session ?? ""),
    usedModel:
      typeof used === "string"
        ? used
        : String(used?.id ?? used?.modelID ?? turn?.model ?? ""),
    tokens: {
      input: Number(turn?.tokens?.input) || 0,
      output: Number(turn?.tokens?.output) || 0,
      reasoning: Number(turn?.tokens?.reasoning) || 0,
      cache: {
        read: Number(turn?.tokens?.cache?.read) || 0,
        write: Number(turn?.tokens?.cache?.write) || 0,
      },
    },
  }
}

/** The fields one decision may contribute to any response. */
function pickDecision(decision) {
  return {
    ts: Number(decision?.ts) || 0,
    session: String(decision?.session ?? ""),
    chosen: String(decision?.chosen ?? ""),
    source: String(decision?.source ?? ""),
    reason: String(decision?.reason ?? ""),
    stage: String(decision?.stage ?? ""),
    turnClass: String(decision?.turnClass ?? ""),
    policy: String(decision?.policy ?? ""),
    complexity: Number(decision?.complexity) || 0,
    applied: String(decision?.applied ?? ""),
    error: String(decision?.error ?? "").slice(0, 200),
  }
}

/** The fields one advisory may contribute to any response. */
function pickAdvisory(advisory) {
  const unit = advisory?.unitPrice
  return {
    verdict: String(advisory?.verdict ?? ""),
    breakEvenTurns: advisory?.breakEvenTurns ?? null,
    perTurnSavings: advisory?.perTurnSavings ?? null,
    invalidationCost: advisory?.invalidationCost ?? null,
    worthIt: advisory?.worthIt ?? null,
    unitPrice: unit
      ? {
          usdPerMTok: Number(unit.usdPerMTok) || 0,
          basis: String(unit.basis ?? ""),
          measured: Boolean(unit.measured),
        }
      : null,
  }
}

/** Turns in scope, projected. Session scope narrows; anything else is all. */
function scopedTurns(turns, scope, session) {
  const list = (turns ?? []).map(pickTurn)
  return scope === "session" && session ? list.filter((turn) => turn.session === session) : list
}

/** Dollars one picked turn costs at a rate card, or null without rates. */
function turnSpendUsd(turn, rates) {
  const input = Number(rates?.input)
  const output = Number(rates?.output)
  if (!rates || !Number.isFinite(input) || !Number.isFinite(output)) return null
  const read = Number.isFinite(Number(rates?.cache?.read)) ? Number(rates.cache.read) : input
  const write = Number.isFinite(Number(rates?.cache?.write)) ? Number(rates.cache.write) : input
  const tokens = turn.tokens
  return (
    (tokens.cache.read * read +
      tokens.input * input +
      tokens.cache.write * write +
      (tokens.output + tokens.reasoning) * output) /
    1e6
  )
}

/**
 * The unit-price record for one pool entry over the scoped turns: the entry's
 * resolved provenance (origin, source, ownBill — scope-independent) with the
 * scoped mix and blend on top. The same record shape `unit-price.js` returns.
 */
function unitRecord(entry, turns) {
  const base = entry.unitPrice ?? {}
  if (entry.local) {
    return {
      ...base,
      usdPerMTok: 0,
      basis: "local · burns no allowance",
      mix: null,
      measured: true,
      projection: false,
    }
  }
  const measured = measureMix(turns, { modelID: entry.modelID })
  const mix = measured ? measured.mix : REFERENCE_MIX
  const usdPerMTok = blendRate(entry.cost, mix)
  if (usdPerMTok == null) return null
  return {
    ...base,
    usdPerMTok,
    basis: measured
      ? `measured mix · ${measured.turns} turn${measured.turns === 1 ? "" : "s"}`
      : "reference mix · stand-in",
    mix,
    measured: Boolean(measured),
    projection: Boolean(!measured || base.ownBill === false),
  }
}

/** Recent decisions, newest first. */
export function buildDecisions({ decisions = [], scope = "all", session = null, limit = 20 } = {}) {
  const list = (decisions ?? []).map(pickDecision)
  const scoped =
    scope === "session" && session ? list.filter((entry) => entry.session === session) : list
  const items = scoped.sort((a, b) => b.ts - a.ts).slice(0, Math.max(0, Number(limit) || 0))
  return { scope, items }
}

/**
 * Consumption over time, as buckets and the totals per bucket: turns, the
 * billed token buckets, and spend at resolved rates. `bucket` is `day`
 * (the trailing `days` window) or `hour` (the trailing 48 hours) — the
 * hourly view is for the bar chart's fine grain.
 */
export function buildTrends({
  turns = [],
  ratesOf = () => null,
  scope = "all",
  session = null,
  days = 30,
  bucket = "day",
  now = Date.now(),
} = {}) {
  const hourly = bucket === "hour"
  const spanMs = hourly ? 48 * 3600000 : Math.max(1, Number(days) || 30) * 86400000
  const cutoff = Number(now) - spanMs
  const byKey = new Map()
  let unpricedTurns = 0
  for (const turn of scopedTurns(turns, scope, session)) {
    if (!(turn.ts >= cutoff)) continue
    const key = hourly
      ? `${new Date(turn.ts).toISOString().slice(0, 13)}:00`
      : new Date(turn.ts).toISOString().slice(0, 10)
    let entry = byKey.get(key)
    if (!entry) {
      entry = {
        at: key,
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        spendUsd: 0,
      }
      byKey.set(key, entry)
    }
    const tokens = turn.tokens
    entry.turns += 1
    entry.inputTokens += tokens.input
    entry.outputTokens += tokens.output + tokens.reasoning
    entry.cacheReadTokens += tokens.cache.read
    entry.cacheWriteTokens += tokens.cache.write
    const spend = turnSpendUsd(turn, ratesOf(turn.usedModel))
    if (spend == null) unpricedTurns += 1
    else entry.spendUsd += spend
  }
  const buckets = [...byKey.values()].sort((a, b) => (a.at < b.at ? -1 : 1))
  return {
    scope,
    bucket: hourly ? "hour" : "day",
    window: hourly ? 48 : Math.max(1, Number(days) || 30),
    buckets,
    unpricedTurns,
  }
}

/** Pool models with their scoped unit price. */
export function buildModels({ pool = [], turns = [], scope = "all", session = null } = {}) {
  const scoped = scopedTurns(turns, scope, session)
  return {
    scope,
    models: (pool ?? []).map((entry) => ({
      providerID: entry.providerID,
      modelID: entry.modelID,
      name: entry.name,
      local: Boolean(entry.local),
      cost: entry.cost ?? null,
      costSource: entry.costSource ?? null,
      unitPrice: unitRecord(entry, scoped),
    })),
  }
}

/**
 * Plans in the billing schema with their burn. Burn is measured in credits
 * where the plan prices in credits (the resource its allowance burns);
 * every other plan carries its allowance note instead of a burn in a unit
 * it does not use. Account-wide in every scope.
 */
export function buildPlans({ billing = null, turns = [], now = Date.now() } = {}) {
  const records = resolveBillings(billing)
  let usage = null
  try {
    // Passing the resolved records keeps their identity: the burn buckets
    // below match records by `===`.
    usage = creditsFromTurns(turns ?? [], records, { modelID: "", now })
  } catch {
    // No usable turn log: plans show without burn rather than a guess.
  }
  return {
    scope: "all",
    plans: records.map((record) => {
      const share = usage?.byPlan?.find((entry) => entry.record === record)?.credits ?? 0
      const burn =
        record.allowanceCredits != null
          ? (projectBurn({ billing: record, usedCredits: share, now }) ?? null)
          : null
      return {
        type: record.type ?? "subscription",
        vendor: record.vendor,
        plan: record.plan ?? record.tier,
        name: record.name ?? planLabel(record) ?? "",
        priceUsd: record.priceUsd ?? null,
        allowanceUnit: record.allowanceUnit ?? null,
        allowanceNote: record.allowanceNote ?? null,
        burn,
      }
    }),
  }
}

/**
 * The page's headline block: totals for the scope, the highest-spend model
 * with its unit price (the session's current model under `scope=session`),
 * and the compaction economics pinned on the session.
 */
export function buildSummary({
  turns = [],
  decisions = [],
  pin = null,
  billing = null,
  pool = [],
  ratesOf = () => null,
  scope = "all",
  session = null,
  now = Date.now(),
} = {}) {
  const scoped = scopedTurns(turns, scope, session)
  const spendByModel = new Map()
  const totals = { turns: scoped.length, tokens: 0, spendUsd: 0 }
  let unpricedTurns = 0
  for (const turn of scoped) {
    const tokens = turn.tokens
    totals.tokens += tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
    const spend = turnSpendUsd(turn, ratesOf(turn.usedModel))
    if (spend == null) {
      unpricedTurns += 1
      continue
    }
    totals.spendUsd += spend
    spendByModel.set(turn.usedModel, (spendByModel.get(turn.usedModel) ?? 0) + spend)
  }
  totals.unpricedTurns = unpricedTurns

  // The headline model: the session's current one when scoped to a session,
  // the highest-spend one across everything.
  let headlineModel = null
  if (scope === "session" && scoped.length > 0) {
    headlineModel = scoped[scoped.length - 1].usedModel
  } else if (spendByModel.size > 0) {
    headlineModel = [...spendByModel.entries()].sort((a, b) => b[1] - a[1])[0][0]
  }
  const entry = (pool ?? []).find(
    (candidate) => `${candidate.providerID}/${candidate.modelID}` === headlineModel,
  )

  return {
    scope,
    generatedAt: Number(now) || Date.now(),
    session: session ? { hash: String(session) } : null,
    headline: {
      model: headlineModel,
      decision: (decisions ?? [])
        .map(pickDecision)
        .filter((d) => scope !== "session" || !session || d.session === session)
        .sort((a, b) => b.ts - a.ts)[0] ?? null,
    },
    totals,
    unitPrice: entry ? unitRecord(entry, scoped) : null,
    compaction: pin?.compaction?.advisory ? pickAdvisory(pin.compaction.advisory) : null,
  }
}

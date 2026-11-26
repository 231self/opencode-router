/**
 * Plan facts from a public tracker feed.
 *
 * The rule the rest of the package follows: every value carries a source, and
 * a value the vendor never published stays unknown. A tracker can supply a
 * price and the vendor's exact limit wording with a check date. It cannot
 * supply a token allowance that does not exist in public — for those plans the
 * feed reports `weeklyCapPublished: false` and this module keeps the
 * allowance unknown.
 *
 * Nothing here runs on a turn. `fetchLimitDex` is called only from an explicit
 * user action (`/ctx plan refresh`), with a short timeout. A failure is a
 * result to display, never an exception into the TUI.
 */

/** LimitDex publishes its whole dataset as free JSON, refreshed daily. */
export const LIMITDEX_URL = "https://limitdex.com/data/plans.json"

function positive(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

function text(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null
}

/**
 * Normalise a LimitDex payload into the small shape the planner needs.
 * Unknown fields are dropped rather than guessed; a missing price stays null.
 */
export function parseLimitDex(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.tools)) return null
  const tools = {}
  for (const tool of raw.tools) {
    const id = text(tool?.id)
    if (!id) continue
    const plans = Array.isArray(tool.plans)
      ? tool.plans
          .map((plan) => {
            const name = text(plan?.name)
            if (!name) return null
            return {
              name,
              priceUsdMonthly: positive(plan.priceUsdMonthly),
              unit: text(plan.unit),
              note: text(plan.note),
              limitsQuote: text(plan.limitsQuote),
              limitsSource: text(plan.limitsSource),
              lastVerified: text(plan.lastVerified),
              limitsStale: plan.limitsStale === true,
            }
          })
          .filter(Boolean)
      : []
    tools[id] = {
      id,
      name: text(tool.name) ?? id,
      vendor: text(tool.vendor),
      // The one bit that decides whether a shadow price can exist at all.
      allowancePublished: tool.weeklyCapPublished === true,
      generalLimitsQuote: text(tool.generalLimitsQuote),
      generalLimitsSource: text(tool.generalLimitsSource),
      plans,
    }
  }
  return { generatedAt: text(raw.generatedAt), tools }
}

/**
 * The facts the feed holds for one (tool, plan) pair, or null. Matching is
 * case-insensitive on the plan name; a tool the feed does not track yields
 * null, which the caller reports as "not in the feed" rather than inventing
 * a price.
 */
export function planFacts(feed, { tool, plan } = {}) {
  const entry = feed?.tools?.[String(tool ?? "")]
  if (!entry) return null
  const wanted = String(plan ?? "").toLowerCase()
  const match = entry.plans.find((candidate) => candidate.name.toLowerCase() === wanted)
  if (!match) return null
  return {
    tool: entry.id,
    plan: match.name,
    vendor: entry.vendor,
    priceUsdMonthly: match.priceUsdMonthly,
    allowancePublished: entry.allowancePublished,
    limitsQuote: match.limitsQuote,
    limitsSource: match.limitsSource,
    generalLimitsQuote: entry.generalLimitsQuote,
    generalLimitsSource: entry.generalLimitsSource,
    lastVerified: match.lastVerified,
    limitsStale: match.limitsStale,
    feedUrl: LIMITDEX_URL,
    generatedAt: feed.generatedAt ?? null,
  }
}

/**
 * Copy the feed's price and provenance onto a billing record. It copies a
 * price and nothing else about quantity: the allowance stays exactly as the
 * record had it, missing if missing. Returns a new object; the input is not
 * mutated.
 */
/**
 * Copy the feed's price and provenance onto a billing record. It copies a
 * price and nothing else about quantity: the allowance stays exactly as the
 * record had it, missing if missing. Returns a new object; the input is not
 * mutated.
 *
 * `billing` may be one record or a list of them. With a list the facts are
 * applied to the plan the feed named (`facts.plan` matching the record's
 * `feedPlan`), so refreshing updates each plan in place and never one plan's
 * price onto another's record.
 */
export function applyPlanFacts(billing, facts) {
  if (!billing || typeof billing !== "object" || !facts) return billing
  const price = positive(facts.priceUsdMonthly)
  const patch = {
    ...(price != null ? { priceUsd: price } : {}),
    source: {
      url: facts.feedUrl ?? null,
      checked: facts.lastVerified ?? facts.generatedAt ?? null,
      status: facts.limitsStale === true ? "stale" : "verified",
    },
  }
  // A record names its feed plan as `feedPlan` ("Plus") or as the catalog
  // plan key ("plus"); the feed reports the display name. Match either,
  // case-insensitively, so a raw config entry and a resolved record both find
  // their own row and no plan's price lands on another's record. `tier` is
  // the legacy name of `plan` and is still read.
  const matches = (record, plan) => {
    const name = String(plan ?? "").toLowerCase()
    return (
      String(record?.feedPlan ?? "").toLowerCase() === name ||
      String(record?.plan ?? record?.tier ?? "").toLowerCase() === name
    )
  }
  if (Array.isArray(billing)) {
    return billing.map((record) => (matches(record, facts.plan) ? { ...record, ...patch } : record))
  }
  return matches(billing, facts.plan) ? { ...billing, ...patch } : billing
}

/**
 * Fetch the feed. Returns `{ ok: true, feed }` or `{ ok: false, reason }`;
 * never throws. `reason` is short and safe to show: a status code or an error
 * name, never a response body.
 */
export async function fetchLimitDex({
  url = LIMITDEX_URL,
  timeoutMs = 5000,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== "function") return { ok: false, reason: "no fetch in this runtime" }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || 5000))
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    })
    if (!response?.ok) return { ok: false, reason: `HTTP ${response?.status ?? "?"}` }
    const body = await response.json()
    const feed = parseLimitDex(body)
    if (!feed) return { ok: false, reason: "feed shape not recognised" }
    return { ok: true, feed }
  } catch (error) {
    return { ok: false, reason: error?.name === "AbortError" ? "timed out" : (error?.name ?? "fetch failed") }
  } finally {
    clearTimeout(timer)
  }
}

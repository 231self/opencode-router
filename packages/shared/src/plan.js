/**
 * Plan billing facts and the shadow prices they imply.
 *
 * A flat-rate plan charges no cash per token, but every token burns a share
 * of a finite allowance. The price of one more token is the shadow price:
 * plan price divided by plan allowance, scaled by the plan's own credit
 * weights. This module holds the published plan facts and the pure math;
 * nothing here reads files, clocks, or the network — callers pass `now` and
 * usage records in.
 *
 * Honesty rules, same as the rest of the pricing code:
 * - Every record carries `source: { url, checked, status }`. A fact without
 *   a source is not a fact.
 * - A plan that publishes no cache-write row charges writes as cache-miss
 *   input (the only published bucket they fit). That mapping is explicit
 *   here, never silent.
 * - Missing numbers stay missing: `planTiers` returns null rather than
 *   inventing zeros, so displays say "unknown" instead of "$0".
 */

/**
 * Built-in catalog of published plan facts. Snapshot of the vendor pages,
 * with the URL and the date each number was checked. Hand-written config
 * entries may carry their own numbers and sources instead.
 */
export const PLAN_CATALOG = {
  "xiaomi-mimo": {
    name: "Xiaomi MiMo Token Plan",
    // Prepaid credits: the vendor publishes both the price and the quota, so
    // a shadow price exists and every credit figure below is exact.
    capType: "prepaid-credits",
    allowancePublished: true,
    source: {
      url: "https://mimo.mi.com/docs/en-US/price/token-plan",
      checked: "2026-11-24",
      status: "official",
    },
    // Credit weights per token. `cacheWrite` is not a published column on
    // the vendor's table; writes fall under cache-miss input (documented in
    // resolveBilling's output as `weightsNote`).
    weights: {
      "mimo-v2.6-pro": { cacheHitInput: 2.5, cacheMissInput: 300, output: 600 },
      "mimo-v2.6-flash": { cacheHitInput: 2, cacheMissInput: 100, output: 200 },
      "mimo-v2.6-pro-ultraspeed": { cacheHitInput: 25, cacheMissInput: 3000, output: 6000 },
    },
    offPeak: { coefficient: 0.8, windowUtcHourFrom: 16, windowUtcHourTo: 24 },
    overage: "pause",
    tiers: {
      lite: { name: "Lite", priceUsd: 6, allowanceCredits: 4.1e9 },
      standard: { name: "Standard", priceUsd: 16, allowanceCredits: 11e9 },
      pro: { name: "Pro", priceUsd: 50, allowanceCredits: 38e9 },
      max: { name: "Max", priceUsd: 100, allowanceCredits: 82e9 },
    },
  },
  "openai-codex": {
    name: "ChatGPT plans (via Codex)",
    // Tier names already carry the product name ("ChatGPT Plus"), so the
    // record label uses the tier alone rather than stacking two names.
    nameFrom: "plan",
    // Usage allowances, consumed on use. Plus and Standard Business carry a
    // 5-hour window *and* a weekly allowance; Pro (100/200/500) has no
    // five-hour limit but a weekly one; Go has a monthly one. The vendor
    // publishes message estimates only for the 5-hour window ("GPT-6.1 Sol
    // 15-160" per 5h) and no size at all for the weekly or monthly
    // allowance ("does not correspond to a fixed number of messages or
    // tasks"). Where no size is published no shadow price is computed, and
    // the display names the allowance that is consumed rather than implying
    // there is none. A user-stated allowance is the only route to a number,
    // and that is labelled as the user's estimate.
    capType: "usage-window",
    allowancePublished: false,
    // Tracker feed: prices and the vendor's exact limit wording, with a
    // check date. See plan-feed.js. The feed publishes no *size* for the
    // weekly allowance (`weeklyCapPublished: false`), so it cannot
    // supply `N`.
    feed: { provider: "limitdex", tool: "codex" },
    source: {
      url: "https://developers.openai.com/codex/pricing/",
      checked: "2026-11-25",
      status: "official",
    },
    noWeightsNote: "a usage allowance is consumed · its size is not published by the vendor",
    overage: "pause",
    tiers: {
      go: {
        name: "ChatGPT Go",
        priceUsd: 8,
        feedPlan: "Go",
        allowanceNote:
          "a monthly usage allowance is consumed · size not published by the vendor · resets monthly",
      },
      // The vendor publishes the window as a message budget per 5h for one
      // reference model: "Est. local messages per 5h: GPT-6.1 Sol 15-160".
      // That is the published part; the size of a message is measured from
      // the user's own turns. Together they give the window a dollar value,
      // and each model is priced at its own list share of it. A weekly
      // allowance binds beside the window — whichever runs out first stops
      // the user — and the vendor publishes no size for that one.
      plus: {
        name: "ChatGPT Plus",
        priceUsd: 20,
        feedPlan: "Plus",
        window: { messagesPerWindow: 160, windowHours: 5, refModel: "gpt-6.1-sol" },
        allowanceNote:
          "a weekly allowance also binds (size not published) — whichever limit runs out first stops you · resets weekly (rolling)",
      },
      // Pro consumes a weekly Work/Codex allowance and has no five-hour
      // limit ("Pro plans currently have no five-hour limit"). OpenAI
      // publishes no size for the weekly allowance — "does not correspond
      // to a fixed number of messages or tasks" — so there is nothing to
      // convert into a token count and no shadow price is derived. The tier
      // is recorded unpriced and named as the consumed weekly allowance,
      // not as an absence. From December 2026 the allowance becomes
      // token-measured and shared across ChatGPT and Codex; the sizes are
      // not published yet.
      pro: {
        name: "ChatGPT Pro",
        priceUsd: 100,
        feedPlan: "Pro",
        allowanceNote:
          "a weekly Work/Codex allowance is consumed · no five-hour limit (vendor, checked 2026-11-25) · size not published: 'not a fixed number of messages or tasks' · resets weekly (rolling · see Settings → Usage)",
      },
      business: {
        name: "ChatGPT Business",
        priceUsd: 25,
        feedPlan: "Business",
        allowanceNote:
          "a 5-hour window and a weekly allowance are consumed · message counts not published for this tier at this check · resets weekly (rolling)",
      },
    },
  },
  "github-copilot": {
    name: "GitHub Copilot",
    nameFrom: "plan",
    // Dollar budget: the plan hands back a fixed dollar value of API usage
    // ("Total monthly AI credits: $15 per month", 1 credit = $0.01). No token
    // count is published, but one is implied by any model's own list price —
    // the budget buys `allowanceUsd / listPrice` tokens. So these are priced
    // against list, at the discount factor `priceUsd / allowanceUsd`.
    //
    // That factor is what you get *at full use of the budget*. Spend less and
    // your effective price per token is worse; Copilot Pro at $10 for $15 is
    // two-thirds of list only if you use all $15. The figure is a ceiling on
    // your saving, not a promise.
    capType: "dollar-budget",
    allowancePublished: true,
    source: {
      url: "https://github.com/features/copilot/plans",
      checked: "2026-11-24",
      status: "official",
    },
    noWeightsNote: "dollar budget of API credits · priced against the model's list price at full use of the budget",
    overage: "pause",
    tiers: {
      pro: { name: "Copilot Pro", priceUsd: 10, allowanceUsd: 15, feedPlan: "Pro" },
      "pro-plus": { name: "Copilot Pro+", priceUsd: 39, allowanceUsd: 70, feedPlan: "Pro+" },
      max: { name: "Copilot Max", priceUsd: 100, allowanceUsd: 200, feedPlan: "Max" },
    },
  },
  "bolt": {
    name: "Bolt",
    nameFrom: "plan",
    // A real published token quota: "10M tokens/month, rollover included".
    // This is the best kind of allowance — the vendor states N outright, so
    // the shadow price is exact (price ÷ tokens) with no derivation and no
    // assumption about how the budget is spent.
    capType: "token-allowance",
    allowancePublished: true,
    source: {
      url: "https://bolt.new/pricing",
      checked: "2026-11-24",
      status: "official",
    },
    noWeightsNote: null,
    overage: "pause",
    tiers: {
      free: { name: "Bolt Free", priceUsd: 0.01, allowanceTokens: 1e6, feedPlan: "Free" },
      pro: { name: "Bolt Pro", priceUsd: 25, allowanceTokens: 10e6, feedPlan: "Pro" },
    },
  },
  "replit": {
    name: "Replit",
    nameFrom: "plan",
    capType: "dollar-budget",
    allowancePublished: true,
    source: {
      url: "https://replit.com/pricing",
      checked: "2026-11-24",
      status: "official",
    },
    noWeightsNote: "dollar budget toward models · priced against the model's list price",
    overage: "pause",
    tiers: {
      core: { name: "Replit Core", priceUsd: 20, allowanceUsd: 20, feedPlan: "Core" },
      pro: { name: "Replit Pro", priceUsd: 100, allowanceUsd: 100, feedPlan: "Pro" },
    },
  },
  "cursor": {
    name: "Cursor",
    nameFrom: "plan",
    // Usage windows in relative terms ("4x more usage compared to Plus"):
    // no token allowance is published, so no shadow price exists.
    capType: "usage-window",
    allowancePublished: false,
    source: {
      url: "https://cursor.com/pricing",
      checked: "2026-11-24",
      status: "official",
    },
    noWeightsNote: "a usage window is consumed · size not published as token counts",
    overage: "pause",
    tiers: {
      plus: { name: "Cursor Plus", priceUsd: 8, feedPlan: "Plus" },
      premium: { name: "Cursor Premium", priceUsd: 30, feedPlan: "Premium" },
      super: { name: "Cursor Super", priceUsd: 100, feedPlan: "Super" },
      ultra: { name: "Cursor Ultra", priceUsd: 200, feedPlan: "Ultra" },
    },
  },
  "anthropic-claude": {
    name: "Claude",
    nameFrom: "plan",
    capType: "usage-window",
    allowancePublished: false,
    source: {
      url: "https://claude.com/pricing",
      checked: "2026-11-24",
      status: "official",
    },
    noWeightsNote: "a usage window is consumed · size not published as token counts",
    overage: "pause",
    tiers: {
      pro: { name: "Claude Pro", priceUsd: 20, feedPlan: "Pro" },
      max: { name: "Claude Max", priceUsd: 100, feedPlan: "Max" },
      ultra: { name: "Claude Ultra", priceUsd: 200, feedPlan: "Ultra" },
    },
  },
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

/**
 * The active plan catalog. Starts as the built-in set; `setPlanCatalog`
 * swaps in a merged catalog (built-in plus the user's `plans.json`), so a
 * user can add or correct a plan without waiting for a release. Resolution
 * always reads the active catalog, never the built-in constant directly.
 */
let activeCatalog = PLAN_CATALOG

/** Make `catalog` the set of plans resolution reads. Returns it unchanged. */
export function setPlanCatalog(catalog) {
  activeCatalog = catalog && typeof catalog === "object" ? catalog : PLAN_CATALOG
  return activeCatalog
}

/** The catalog resolution currently reads. */
export function getPlanCatalog() {
  return activeCatalog
}

function positive(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

/**
 * The models a record covers: `models` limits the record when set, and a
 * weights table with exactly one entry covers that model only when `models`
 * is absent. Null means "no limit stated" — coverage is then decided by the
 * weights lookup alone.
 */
function coversModel(record, modelID) {
  if (!record) return false
  if (Array.isArray(record.models) && record.models.length > 0) {
    return record.models.includes(modelID)
  }
  return true
}

/**
 * Normalise a billing record, filling published numbers from the catalog
 * when the record names `vendor` and `tier` but omits them.
 *
 * A record is usable when it has `priceUsd` and `allowanceCredits` (or
 * `allowanceTokens` — a token allowance converts at 1 token = 1 credit only
 * when the plan has no credit scale, flagged as `allowanceUnit: "tokens"`).
 * Returns null when the record cannot support a price; the caller shows
 * "unknown" rather than a number.
 *
 * Accepts a single record or a list of them. A list resolves to its primary
 * plan — the first that supports a price — so single-plan callers read the
 * same either way. Use `resolveBillings` for every plan, and `planForModel`
 * to price one model at the plan that covers it.
 */
export function resolveBilling(raw) {
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const record = resolveBilling(entry)
      if (record) return record
    }
    return null
  }
  if (!isPlainObject(raw)) return null
  // Already resolved: return it unchanged rather than rebuilding an equal
  // record. Callers match records by identity (per-plan burn buckets), so
  // re-resolving here would hand back a copy that never matches.
  if (typeof raw.unpriced === "boolean") return raw
  const catalog = typeof raw.vendor === "string" ? activeCatalog[raw.vendor] : null
  // The schema is type (payg/subscription) → vendor → plan. `tier` is the
  // legacy key for `plan`; both are read and resolve to the same catalog
  // plan, so a config written either way prices identically.
  const planKey = typeof raw.plan === "string" ? raw.plan : (typeof raw.tier === "string" ? raw.tier : null)
  const tier = tiersOf(catalog)[planKey]
  const priceUsd = positive(raw.priceUsd) ?? positive(tier?.priceUsd)
  const allowanceCredits = positive(raw.allowanceCredits) ?? positive(tier?.allowanceCredits)
  // A token quota (Bolt: 10M tokens/month) reads from the record or its
  // catalog tier, same as credits.
  const allowanceTokens = positive(raw.allowanceTokens) ?? positive(tier?.allowanceTokens)
  // A dollar budget: the plan hands back `allowanceUsd` of API usage at list
  // price (GitHub Copilot: $10/mo buys $15 of API credits). There is no token
  // count in the announcement, but there is one implied by any model's own
  // list price: the budget buys `allowanceUsd / listPrice` tokens. That price
  // is the source for N, so these plans are priced — at a discount factor
  // against list — rather than left unpriced.
  const allowanceUsd = positive(raw.allowanceUsd) ?? positive(tier?.allowanceUsd)
  // A usage window (ChatGPT: "15-160 messages per 5h of GPT-6.1 Sol") is a
  // dollar budget in disguise: the window is worth a fixed amount of API, so
  // each model consumes it at its own list price. The descriptor carries the
  // published parts; `measureWindow` turns it into `allowanceUsd` by
  // measuring the one number no vendor publishes — the size of a message.
  const window = isPlainObject(raw.window) ? raw.window : (tier?.window ?? null)
  const allowance = allowanceCredits ?? (allowanceTokens != null ? allowanceTokens : null)
  if (priceUsd == null) return null

  const weights = isPlainObject(raw.weights) ? normaliseWeights(raw.weights) : null
  const catalogWeights = catalog?.weights ?? null
  const capType = typeof raw.capType === "string" ? raw.capType : (catalog?.capType ?? "prepaid-credits")
  const common = {
    // type → vendor → plan: how the user pays, whose plan it is, which one.
    type: "subscription",
    vendor: typeof raw.vendor === "string" ? raw.vendor : "custom",
    plan: planKey ?? "custom",
    // `tier` is the legacy name of `plan`, kept so configs and callers
    // written against it keep matching.
    tier: planKey ?? "custom",
    name:
      typeof raw.name === "string" && raw.name.length > 0
        ? raw.name
        : (catalog?.nameFrom === "plan" || catalog?.nameFrom === "tier") && tier?.name
          ? tier.name
          : [catalog?.name, tier?.name ?? planKey].filter(Boolean).join(" "),
    priceUsd,
    capType,
    models: Array.isArray(raw.models) ? raw.models.filter((id) => typeof id === "string") : null,
    renewsDay: positive(raw.renewsDay) && Number(raw.renewsDay) <= 28 ? Number(raw.renewsDay) : null,
    offPeak: isPlainObject(raw.offPeak) ? raw.offPeak : (catalog?.offPeak ?? null),
    overage: typeof raw.overage === "string" ? raw.overage : (catalog?.overage ?? null),
    source: isPlainObject(raw.source)
      ? raw.source
      : (catalog?.source ?? { url: null, checked: null, status: "configured" }),
    // What the tracker feed should look up for this record, when it has one.
    feed: catalog?.feed ?? null,
    feedPlan: tier?.feedPlan ?? null,
    // The published window descriptor, when the plan states one. Priced into
    // `allowanceUsd` by `measureWindow`, never on its own.
    window,
  }

  // Price known, allowance not, and no window to derive one from: a usage
  // plan that publishes neither tokens nor a message budget. The record is
  // kept so the plan can be shown by name and price, but it is marked
  // `unpriced` — no shadow price exists, and every helper returns null rather
  // than a guess. A plan that publishes a window is *not* in this case: its
  // budget is derivable, so it is priced below.
  if (allowance == null && allowanceUsd == null && !window) {
    return {
      ...common,
      allowanceCredits: null,
      allowanceTokens: null,
      allowanceUsd: null,
      allowanceUnit: null,
      discountFactor: null,
      unpriced: true,
      // The note names what the vendor actually said, not a generic line.
      // "no five-hour limit" is a different fact from "15-160 messages per
      // 5h", and the reader should see which one applies to their plan.
      allowanceNote:
        typeof raw.allowanceNote === "string"
          ? raw.allowanceNote
          : (tier?.allowanceNote ?? catalog?.noWeightsNote ?? "not published by the vendor"),
      weights: null,
      catalogWeights: null,
      weightsNote: null,
    }
  }

  // A usage window, priced once its message size is measured. The window's
  // dollar value is `allowanceUsd` (see `measureWindow`), so a window plan is
  // a dollar budget with an extra derivation step. Until it is measured,
  // `allowanceUsd` is null and `planTiers` derives it from `window` and the
  // caller's measured message size.
  if (allowance == null && allowanceUsd == null && window) {
    return {
      ...common,
      unpriced: false,
      allowanceCredits: null,
      allowanceTokens: null,
      allowanceUsd: null,
      allowanceUnit: "window",
      discountFactor: null,
      allowanceNote:
        typeof raw.allowanceNote === "string"
          ? raw.allowanceNote
          : (tier?.allowanceNote ?? "priced against the model's own list price"),
      weights: null,
      catalogWeights: null,
      weightsNote: null,
    }
  }

  // A dollar budget: `priceUsd` buys `allowanceUsd` of API usage at list
  // price. The token count that budget buys depends on the model — `N =
  // allowanceUsd / listPrice` — so the shadow price is a discount factor
  // against list rather than a fixed $/Mtok. `discountFactor` is that
  // multiplier: effective price = list price × factor. Copilot Pro is
  // $10 for $15, a factor of 0.667 — two-thirds of list.
  if (allowanceUsd != null) {
    return {
      ...common,
      unpriced: false,
      allowanceCredits: null,
      allowanceTokens: null,
      allowanceUsd,
      allowanceUnit: "usd",
      discountFactor: priceUsd / allowanceUsd,
      allowanceNote:
        typeof raw.allowanceNote === "string"
          ? raw.allowanceNote
          : "dollar budget · priced against the model's own list price",
      weights: null,
      catalogWeights: null,
      weightsNote: null,
    }
  }

  return {
    ...common,
    unpriced: false,
    allowanceCredits: allowance,
    allowanceTokens: allowanceCredits == null ? allowance : null,
    allowanceUsd: null,
    allowanceUnit: allowanceCredits != null ? "credits" : "tokens",
    discountFactor: null,
    // A flat token quota ("10M tokens/month") counts every token as one
    // token — input, output, and cache reads alike. With no weight table
    // published, equal weights are the honest reading, not a guess: the
    // vendor's own figure is a plain token count. A credit plan keeps its
    // published per-token weights, or none at all.
    weights: weights ?? (allowanceCredits == null ? FLAT_TOKEN_WEIGHTS : null),
    catalogWeights,
    weightsNote: raw.weights
      ? "configured"
      : allowanceCredits == null
        ? "flat token quota · every token counts once"
        : catalog
          ? (catalog.weights ? "cache writes billed as cache-miss input (no published cache-write rate)" : null)
          : null,
  }
}

/**
 * Equal weights: one token is one token. The honest reading of a plain token
 * quota, where the vendor publishes a count and no per-type split.
 */
const FLAT_TOKEN_WEIGHTS = { cacheHitInput: 1, cacheMissInput: 1, output: 1 }

function normaliseWeights(raw) {
  const cacheHitInput = positive(raw.cacheHitInput)
  const cacheMissInput = positive(raw.cacheMissInput)
  const output = positive(raw.output)
  if (cacheHitInput == null || cacheMissInput == null || output == null) return null
  return { cacheHitInput, cacheMissInput, output }
}

/**
 * A vendor's plan table from the catalog — "a vendor has plans". `tiers` is
 * the earlier name for the same table and is still read, so catalogs
 * written before the rename keep working unchanged.
 */
export function tiersOf(entry) {
  return entry?.tiers ?? entry?.plans ?? {}
}

/**
 * Normalise a billing config into a list of resolved records. Takes one
 * record — the original single-plan shape — or an array of them, so a config
 * written before multi-plan kept working unchanged. Records that cannot
 * support a price are dropped rather than padded with guesses.
 */
export function resolveBillings(raw) {
  const list = Array.isArray(raw) ? raw : isPlainObject(raw) ? [raw] : []
  return list.map((entry) => resolveBilling(entry)).filter(Boolean)
}

/**
 * The plan that covers `modelID`, or null when none does.
 *
 * With one plan, that plan covers every model it has prices for. With
 * several, attribution has to be decided, and it is decided in this order so
 * the router and the report can both say which plan priced what:
 *
 *   1. a plan that names the model in `models` — the user said so
 *   2. a plan with a published weight row for the model — the vendor said so
 *   3. a plan that limits itself to no models at all — the catch-all
 *
 * Ties go to the plan declared first, so the answer is deterministic. A model
 * no plan claims is priced at catalog rates, never at a plan's credits.
 */
export function planForModel(billing, modelID = "") {
  const records = resolveBillings(billing)
  if (records.length === 0) return null
  if (records.length === 1) return records[0]
  const named = records.find((record) => Array.isArray(record.models) && record.models.includes(modelID))
  if (named) return named
  const weighted = records.find((record) => record.catalogWeights?.[modelID])
  if (weighted) return weighted
  return records.find((record) => !Array.isArray(record.models) || record.models.length === 0) ?? null
}

/**
 * Add one plan to a billing config, returning the new config to persist.
 *
 * Plans accumulate: running setup again adds a second plan rather than
 * replacing the first. A config that held one record becomes a list of two,
 * so nothing already recorded is lost. The two non-plan answers —
 * `{ payg: true }` and `{ skipped: true }` — are not plans and are not kept:
 * naming a plan supersedes "pay per token", and "skip" is not a fact about
 * money. Returns the plan alone when there was nothing before.
 */
export function withPlan(billing, record) {
  if (!record || typeof record !== "object") return billing
  // "Pay as you go" and "skip" are not plans. They replace whatever was
  // recorded: saying you pay per token means no plan applies, and adding a
  // plan later supersedes that in turn (resolveBillings drops these markers).
  // Payg is a billing *type* with no vendor and no plan; `payg: true` is its
  // legacy marker and both spellings are accepted.
  if (record.payg === true || record.type === "payg" || record.skipped === true) return record
  // Keep what is already recorded verbatim — it is the user's own config
  // shape. Only the new record is normalised, so nothing typed is replaced by
  // a derived equivalent.
  const plans = Array.isArray(billing)
    ? billing.filter(isPlainObject)
    : isPlainObject(billing) && billing.payg !== true && billing.type !== "payg" && billing.skipped !== true
      ? [billing]
      : []
  return [...plans, asConfig(record)]
}

/**
 * A record's config shape: the fields a user wrote, without the derived ones
 * `resolveBilling` adds. Round-tripping through this keeps the config file
 * readable — it holds what was typed, not what was computed from it.
 */
function asConfig(record) {
  const config = {}
  for (const key of [
    "type",
    "vendor",
    "plan",
    "tier",
    "name",
    "priceUsd",
    "allowanceCredits",
    "allowanceTokens",
    "allowanceNote",
    "capType",
    "models",
    "weights",
    "renewsDay",
    "offPeak",
    "overage",
    "source",
  ]) {
    if (record[key] !== undefined && record[key] !== null) config[key] = record[key]
  }
  return config
}

/**
 * The credit weights that apply to `modelID`, from the plan that covers it,
 * or null when that plan publishes none. Attribution goes through
 * `planForModel`, so with several plans each model is priced at its own.
 */
export function weightsFor(billing, modelID = "") {
  const record = planForModel(billing, modelID)
  if (!record || !coversModel(record, modelID)) return null
  if (record.weights) return record.weights
  const table = record.catalogWeights
  if (!table) return null
  return table[modelID] ?? (Object.keys(table).length === 1 ? Object.values(table)[0] : null)
}

/**
 * Dollars one credit costs on this plan: `priceUsd / allowanceCredits`.
 * A token allowance is 1 token = 1 credit only for plans without a credit
 * scale; the caller sees `allowanceUnit` and labels the figure accordingly.
 * A dollar budget has no per-credit price — its unit is the dollar — so this
 * returns null and `planTiers` prices it against the model's list price.
 */
export function creditPrice(billing) {
  const record = resolveBilling(billing)
  if (!record || record.unpriced) return null
  if (record.allowanceUnit === "usd" || !record.allowanceCredits) return null
  return record.priceUsd / record.allowanceCredits
}

/**
 * Plan prices as a cost tier (`$/Mtok`, same shape the pricing code takes),
 * so every existing economics helper works on plan prices unchanged.
 *
 * cache.read at the cache-hit weight, cache.write at the cache-miss weight
 * (no published write rate), input at cache-miss, output at output. Null
 * when the plan publishes no weights for this model — never invented zeros.
 *
 * A dollar-budget plan (Copilot: $10/mo for $15 of API credits) carries no
 * token count of its own. Its token count comes from the model's own list
 * price: the budget buys `allowanceUsd / listPrice` tokens. Pass `listPrice`
 * — the model's published tier — and the result is that list price scaled by
 * the discount factor (`priceUsd / allowanceUsd`): what the model really
 * costs you through the plan. Without a list price the conversion has no
 * source, so it returns null rather than guessing.
 */
export function planTiers(billing, modelID = "", { listPrice = null, tokensPerMessage = null, refPrice = null } = {}) {
  const record = planForModel(billing, modelID)
  if (!record || record.unpriced) return null

  // A dollar budget, or a usage window priced into one. Either way the model
  // is priced at its own list price scaled by `priceUsd / budget`: the budget
  // buys `budget / listPrice` tokens of this model, so a model that costs more
  // per token gets fewer of them. That is what makes one plan's models differ
  // — Astra at $10/M burns the window 100x faster than Luna at $0.1/M.
  const budget =
    record.allowanceUsd ??
    (record.window
      ? windowBudgetUsd({
          messagesPerWindow: record.window.messagesPerWindow,
          windowHours: record.window.windowHours,
          tokensPerMessage: record.window.tokensPerMessage ?? tokensPerMessage,
          refPrice: record.window.refPrice ?? refPrice,
        })
      : null)
  if (budget != null) {
    const reference = Array.isArray(listPrice) ? listPrice[0] : listPrice
    const factor = budget > 0 ? record.priceUsd / budget : null
    if (!reference || !factor) return null
    const scale = (value) => (Number.isFinite(Number(value)) ? Number(value) * factor : value)
    return [
      {
        input: scale(reference.input),
        output: scale(reference.output),
        cache: {
          read: scale(reference.cache?.read),
          write: scale(reference.cache?.write),
        },
      },
    ]
  }

  const weights = weightsFor(record, modelID)
  const perCredit = creditPrice(record)
  if (!weights || perCredit == null) return null
  const perMillion = (creditsPerToken) => creditsPerToken * perCredit * 1_000_000
  return [
    {
      input: perMillion(weights.cacheMissInput),
      output: perMillion(weights.output),
      cache: {
        read: perMillion(weights.cacheHitInput),
        write: perMillion(weights.cacheMissInput),
      },
    },
  ]
}

/**
 * A plan's credit weights shaped as a cost tier, so the same ROI maths that
 * works in dollars works in credits — the unit the allowance actually burns.
 * cache.read at the cache-hit weight, input and cache.write at the cache-miss
 * weight (the published mapping), output at output: the same layout
 * `planTiers` uses, without the conversion to dollars. Null when the plan
 * publishes no weights for the model.
 *
 * This is what makes a plan's compaction economics real. On a flat or window
 * plan the dollar figures are near zero — a tiny shadow price times a big
 * token count — so the KV-cache invalidation reads as `$0.0172`, which looks
 * trivial. In credits it is `148.8M`, which is the number that decides
 * whether to compact. Credits are the resource being spent.
 */
export function creditTier(billing, modelID = "") {
  const weights = weightsFor(billing, modelID)
  if (!weights) return null
  return {
    input: weights.cacheMissInput,
    output: weights.output,
    cache: { read: weights.cacheHitInput, write: weights.cacheMissInput },
  }
}

/**
 * Credits one usage record burns: fresh input and cache writes at the
 * cache-miss weight, cache reads at the cache-hit weight, output and
 * reasoning at the output weight. Usage shape is OpenCode's
 * `{ input, output, reasoning, cache: { read, write } }`, where `input`
 * covers only uncached input. Returns null when weights are unknown.
 */
export function creditCost(usage, billing, modelID = "") {
  const weights = weightsFor(billing, modelID)
  if (!weights) return null
  const input = Math.max(0, Number(usage?.input) || 0)
  const output = Math.max(0, Number(usage?.output) || 0)
  const reasoning = Math.max(0, Number(usage?.reasoning) || 0)
  const read = Math.max(0, Number(usage?.cache?.read) || 0)
  const write = Math.max(0, Number(usage?.cache?.write) || 0)
  return (
    (input + write) * weights.cacheMissInput +
    read * weights.cacheHitInput +
    (output + reasoning) * weights.output
  )
}

/**
 * What a cache expiry costs at `prefixTokens`: the hot re-read, the cold
 * re-bill, and the premium an expiry charges over staying hot. The premium
 * is the insurance value of compaction (a compacted summary is small and
 * stays cheap to re-bill). Null when weights are unknown.
 */
export function cacheExpiryCredits(prefixTokens, billing, modelID = "") {
  const weights = weightsFor(billing, modelID)
  const prefix = positive(prefixTokens)
  if (!weights || prefix == null) return null
  const hot = prefix * weights.cacheHitInput
  const cold = prefix * weights.cacheMissInput
  return { hot, cold, premium: cold - hot, ratio: cold / hot }
}

/** The credit coefficient at `now`: the off-peak discount, else 1. */
export function creditCoefficient(billing, now = new Date()) {
  const record = resolveBilling(billing)
  const window = record?.offPeak
  if (!window || !positive(window.coefficient)) return 1
  const hour = now.getUTCHours()
  const from = Number(window.windowUtcHourFrom ?? 16)
  const to = Number(window.windowUtcHourTo ?? 24)
  return hour >= from && hour < to ? Number(window.coefficient) : 1
}

/**
 * Start of the current allowance period: the `renewsDay` of this month, or
 * last month's, at midnight UTC. Null when the renewal day is unknown —
 * the display then says "reset: unknown" instead of guessing a date.
 */
export function currentPeriodStart(billing, now = new Date()) {
  const record = resolveBilling(billing)
  const day = record?.renewsDay
  if (!day) return null
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day))
  if (start.getTime() > now.getTime()) start.setUTCMonth(start.getUTCMonth() - 1)
  return start
}

/**
 * Allowance burn projection from used credits and elapsed time.
 *
 * `resetsAt` (ms epoch) or `renewsDay` bound the period when known; without
 * either, the projection is a flat 30-day rate and `basis` says so. The
 * projection is arithmetic on measured burn — never a claim about future
 * behaviour beyond "at this rate".
 */
export function projectBurn({
  billing,
  usedCredits = 0,
  now = Date.now(),
  resetsAt = null,
  elapsedMs = null,
} = {}) {
  const record = resolveBilling(billing)
  if (!record) return null
  // An unpriced plan has a price but no allowance, so a burn percentage
  // would be invented. Return null and let the display say "not published".
  if (record.unpriced) return null
  const used = Math.max(0, Number(usedCredits) || 0)
  const allowance = record.allowanceCredits
  const nowMs = Number(now) || Date.now()
  const reset = positive(resetsAt)
  const periodStart = currentPeriodStart(record, new Date(nowMs))
  let elapsed = positive(elapsedMs)
  let daysLeft = null
  let basis = "configured allowance"
  if (reset != null) {
    elapsed ??= Math.max(1, nowMs - (periodStart?.getTime() ?? nowMs - 30 * 86400000))
    daysLeft = Math.max(0, (reset - nowMs) / 86400000)
    basis = "renews on the configured date"
  } else if (periodStart) {
    elapsed ??= Math.max(1, nowMs - periodStart.getTime())
    const next = new Date(periodStart.getTime())
    next.setUTCMonth(next.getUTCMonth() + 1)
    daysLeft = Math.max(0, (next.getTime() - nowMs) / 86400000)
    basis = "renews monthly on the configured day"
  } else {
    // No reset date: measure a 30-day rate (or the given window) and
    // project over the next 30 days. The basis says exactly that.
    elapsed ??= 30 * 86400000
    daysLeft = 30
    basis = "30-day rate · reset date unknown"
  }
  const fraction = Math.min(1, elapsed / (elapsed + daysLeft * 86400000))
  const projected = fraction > 0 ? used / fraction : used
  return {
    used,
    allowance,
    free: Math.max(0, allowance - used),
    percentUsed: allowance > 0 ? (used / allowance) * 100 : 0,
    projected,
    projectedPercent: allowance > 0 ? (projected / allowance) * 100 : 0,
    daysLeft,
    basis,
    resetsAt:
      reset ??
      (() => {
        if (!periodStart) return null
        const next = new Date(periodStart.getTime())
        next.setUTCMonth(next.getUTCMonth() + 1)
        return next.getTime()
      })(),
  }
}

/**
 * Average tokens in one turn, measured from turn records — the token size of
 * a "message", which no vendor publishes. `modelID` narrows to one model's
 * turns; without it every turn counts. Returns the average and how many turns
 * went into it, so a display can say "measured from 214 turns" rather than
 * presenting the number as a fact from nowhere. Null when there is nothing to
 * measure.
 *
 * The sum is a turn's full throughput: fresh input, output, reasoning, and
 * cache activity. That is what one turn costs the plan in capacity, which is
 * the thing a message budget is a proxy for.
 */
export function measureTokensPerTurn(turns, { modelID = "" } = {}) {
  let sum = 0
  let counted = 0
  for (const turn of turns ?? []) {
    const tokens = turn?.tokens
    if (!tokens) continue
    if (modelID) {
      const used = turn?.usedModel
      const turnModel =
        typeof used === "string" ? used.split("/").at(-1) : (used?.id ?? used?.modelID ?? "")
      if (turnModel && turnModel !== modelID) continue
    }
    sum +=
      (Number(tokens.input) || 0) +
      (Number(tokens.output) || 0) +
      (Number(tokens.reasoning) || 0) +
      (Number(tokens.cache?.read) || 0) +
      (Number(tokens.cache?.write) || 0)
    counted += 1
  }
  return counted > 0 ? { tokensPerTurn: sum / counted, turns: counted } : null
}

/**
 * The monthly dollar value of a usage window.
 *
 * A window plan publishes a message budget per window — "15-160 messages per
 * 5h of GPT-6.1 Sol" — not a token count. Its dollar value follows from
 * three things: how many messages fit in a window (published), how many
 * tokens a message costs (measured from the user's own turns), and the
 * reference model's own list price (the public price table).
 *
 *   W = messages/window × tokens/message × windows/month × p(ref)
 *
 * Each input's origin is named, so the figure can be argued with rather than
 * trusted blindly. Null when any input is missing: a window with no measured
 * message size has no dollar value, and none is invented.
 */
export function windowBudgetUsd({
  messagesPerWindow,
  windowHours,
  tokensPerMessage,
  refPrice,
  daysPerMonth = 30,
} = {}) {
  const messages = positive(messagesPerWindow)
  const hours = positive(windowHours)
  const tokens = positive(tokensPerMessage)
  const price = positive(refPrice)
  if (messages == null || hours == null || tokens == null || price == null) return null
  const windowsPerMonth = (daysPerMonth * 24) / hours
  return (messages * tokens * windowsPerMonth * price) / 1e6
}

/**
 * Turn a usage window into a priced budget, by measuring the one number the
 * vendor does not publish. Returns the fields to record on the plan:
 * `allowanceUsd` (the window's monthly dollar value) and the evidence behind
 * it. The plan's `window` descriptor supplies the published parts; `turns`
 * supplies the measured message size; `refPrice` is the reference model's
 * list price in $/Mtok.
 *
 * Null when the measurement or a published input is missing — the caller
 * keeps the plan unpriced rather than guessing a message size.
 */
export function measureWindow(record, { turns = null, refPrice = null, modelID = "" } = {}) {
  const window = resolveBilling(record)?.window
  if (!window) return null
  const measured = measureTokensPerTurn(turns, { modelID: window.refModel ?? modelID })
  const tokensPerMessage = Number(window.tokensPerMessage) > 0 ? Number(window.tokensPerMessage) : measured?.tokensPerTurn
  const budget = windowBudgetUsd({
    messagesPerWindow: window.messagesPerWindow,
    windowHours: window.windowHours,
    tokensPerMessage,
    refPrice,
  })
  if (budget == null) return null
  return {
    allowanceUsd: budget,
    tokensPerMessage: tokensPerMessage ?? null,
    measuredTurns: measured?.turns ?? null,
  }
}

/** Short label naming the plan and its price, for report headers. */
export function planLabel(billing) {
  const record = resolveBilling(billing)
  if (!record) return null
  if (record.unpriced) return `${record.name} · $${record.priceUsd}/mo · allowance not published`
  return `${record.name} · $${record.priceUsd}/mo`
}

/**
 * Whether a plan can yield a shadow price at all, and why not when it
 * cannot. `s = P/N` needs a published `N`; a usage-window plan has none.
 */
export function pricingBasis(billing) {
  const record = resolveBilling(billing)
  if (!record) return null
  if (record.unpriced) {
    return {
      priced: false,
      capType: record.capType,
      reason: record.allowanceNote ?? "allowance not published by the vendor",
    }
  }
  return { priced: true, capType: record.capType, reason: null }
}

/**
 * Credits burned across turn records since each plan's current period start.
 *
 * Each turn is priced at the weights of the plan that covers its model
 * (`usedModel` — a ref string `provider/id` or `{ providerID, id }`), falling
 * back to `modelID` when the turn names no model. With several plans a turn
 * bills to its own plan, and `byPlan` reports each plan's share so a display
 * can show every plan's burn rather than one blended number. Turns whose
 * model no plan covers are not counted; `skipped` reports how many, so the
 * display can say the total is partial instead of implying completeness.
 * Returns null when no plan has any weights at all.
 */
export function creditsFromTurns(turns, billing, { modelID = "", now = Date.now() } = {}) {
  const records = resolveBillings(billing).filter((r) => r.weights || r.catalogWeights)
  if (records.length === 0) return null
  const byPlan = records.map((record) => ({
    record,
    credits: 0,
    counted: 0,
    skipped: 0,
    start: currentPeriodStart(record, new Date(now))?.getTime() ?? 0,
  }))
  let credits = 0
  let counted = 0
  let skipped = 0
  for (const turn of turns ?? []) {
    const used = turn?.usedModel
    const turnModel =
      typeof used === "string" ? used.split("/").at(-1) : (used?.id ?? used?.modelID ?? "")
    const model = turnModel || modelID
    const record = planForModel(records, model)
    const cost = creditCost(turn?.tokens, record, model)
    if (cost == null) {
      skipped += 1
      continue
    }
    const ts = Number(turn?.ts)
    const entry = byPlan.find((item) => item.record === record)
    if (entry && Number.isFinite(ts) && entry.start && ts < entry.start) continue
    credits += cost
    counted += 1
    if (entry) {
      entry.credits += cost
      entry.counted += 1
    }
  }
  return {
    credits,
    counted,
    skipped,
    byPlan: byPlan.map(({ record, credits: planCredits, counted: planCounted, skipped: planSkipped }) => ({
      record,
      credits: planCredits,
      counted: planCounted,
      skipped: planSkipped,
    })),
  }
}

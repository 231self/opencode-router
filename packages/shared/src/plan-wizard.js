/**
 * The plan-setup wizard: a pure flow over an injected dialog adapter, so the
 * TUI parts of both plugins can run it and tests can script it without a
 * terminal. The wizard records what the user says and nothing else — no
 * prompt text, no credentials, just plan numbers with their source.
 *
 * `ask` is `{ select, text, confirm }` where each returns the answer or
 * undefined on escape:
 *   select({ title, options, current? }) -> option value | undefined
 *   text({ title, placeholder? })        -> string | undefined
 *   confirm({ title, message })          -> boolean | undefined
 */

import { getPlanCatalog, resolveBilling } from "./plan.js"

/** Parse a human number: `82B`, `4.1b`, `16`, `1,000,000`. Null on junk. */
export function parseAmount(raw) {
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? raw : null
  const text = String(raw ?? "").trim().toLowerCase().replaceAll(",", "").replaceAll("_", "")
  const match = text.match(/^(\d+(?:\.\d+)?)\s*([kmb])?$/)
  if (!match) return null
  const scale = { k: 1e3, m: 1e6, b: 1e9 }[match[2] ?? ""] ?? 1
  const value = Number(match[1]) * scale
  return Number.isFinite(value) && value > 0 ? value : null
}

/**
 * Whether the first-init prompt should fire: no billing record yet, and the
 * model in use has no real prices (a flat pool or no price data). A priced
 * model means pay-per-token already, and prompting would be noise.
 */
export function shouldPromptPlanSetup(config, pricingState) {
  if (config?.billing) return false
  return pricingState !== "priced"
}

/**
 * One prompt per process. Both plugins' TUI parts call this from `setup`;
 * the module flag (same module instance in one process) stops the second
 * one, and the returned state is persisted so later restarts stay quiet.
 */
let promptedThisProcess = false

export function claimPlanPrompt() {
  if (promptedThisProcess) return false
  promptedThisProcess = true
  return true
}

/** Test hook: forget that a prompt ran. */
export function resetPlanPromptClaim() {
  promptedThisProcess = false
}

/** A positive number, or null. Used to read optional catalog figures. */
function positive(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

/**
 * Adapt an OpenCode TUI `context.ui.dialog` to the wizard's `ask` shape.
 * Escape resolves undefined on every prompt, which the wizard reads as
 * "back out, save nothing". The dialog object is injected, so this stays
 * testable and the shared package keeps no host dependency.
 */
export function dialogAdapter(dialog) {
  return {
    select: ({ title, options, current }) =>
      dialog.select({ title, options: options.map((option) => option), ...(current ? { current } : {}) }),
    text: ({ title, placeholder }) => dialog.prompt({ title, placeholder: placeholder ?? "" }),
    confirm: ({ title, message }) => dialog.confirm({ title, message }),
  }
}

function formatCredits(value) {
  if (value >= 1e9) return `${Number((value / 1e9).toFixed(1))}B`
  if (value >= 1e6) return `${Number((value / 1e6).toFixed(1))}M`
  return String(value)
}

/** One row per catalog vendor, for the provider picker. */
export function vendorOptions(catalog = getPlanCatalog()) {
  return Object.entries(catalog ?? {}).map(([value, entry]) => {
    const tiers = Object.values(entry.tiers ?? {})
    const priced = tiers.filter((tier) => positive(tier.priceUsd) != null).length
    const allowance = tiers.filter(
      (tier) =>
        positive(tier.allowanceCredits) != null ||
        positive(tier.allowanceTokens) != null ||
        positive(tier.allowanceUsd) != null,
    ).length
    const note =
      allowance > 0
        ? `${priced} tier${priced === 1 ? "" : "s"} · allowance published`
        : `${priced} tier${priced === 1 ? "" : "s"} · no published token allowance`
    return {
      value,
      title: entry.name ?? value,
      description: note,
    }
  })
}

/** The tier rows for one catalog vendor. */
export function tierOptions(vendor, catalog = getPlanCatalog()) {
  const entry = catalog?.[vendor]
  if (!entry) return []
  return Object.entries(entry.tiers ?? {}).map(([value, tier]) => {
    const price = positive(tier.priceUsd)
    const credits = positive(tier.allowanceCredits)
    const tokens = positive(tier.allowanceTokens)
    const usd = positive(tier.allowanceUsd)
    const detail = credits
      ? `${formatCredits(credits)} credits per month`
      : tokens
        ? `${formatCredits(tokens)} tokens per month`
        : usd
          ? `$${price}/mo buys $${usd} of API usage`
          : "Usage windows · token allowance not published"
    return {
      value,
      title: `${tier.name ?? value}${price != null ? ` — $${price}/mo` : ""}`,
      description: detail,
    }
  })
}

/**
 * Run the wizard. Returns the billing record to persist, or null when the
 * user backed out (nothing saved, prompt may fire again) — an explicit
 * "pay per token" or "skip" answer is a record, so it never nags again.
 *
 * Providers come from the active plan catalog, so a plan added to
 * `plans.json` shows up here without a code change. "Other subscription"
 * is always there for a plan the catalog does not hold.
 */
export async function runPlanWizard({ ask, modelLabel = "your model", catalog = getPlanCatalog() } = {}) {
  const vendors = vendorOptions(catalog)
  const kind = await ask.select({
    title: `Plan setup — how do you pay for ${modelLabel}?`,
    options: [
      ...vendors,
      { value: "other", title: "Other subscription", description: "A monthly price and allowance to record" },
      { value: "payg", title: "Pay per token", description: "No plan — keep list prices" },
      { value: "skip", title: "Skip", description: "Do not ask again" },
    ],
  })
  if (kind === undefined) return null
  if (kind === "payg") return { payg: true, source: { url: null, checked: null, status: "user" } }
  if (kind === "skip") return { skipped: true, source: { url: null, checked: null, status: "user" } }

  // A catalog vendor: pick its tier. The record is the vendor/tier pair, and
  // every published number (price, allowance, weights, source) is filled from
  // the catalog at resolution — nothing is retyped here.
  if (catalog?.[kind]) {
    const options = tierOptions(kind, catalog)
    const tier = await ask.select({
      title: `Which ${catalog[kind].name ?? kind} plan?`,
      options,
    })
    if (tier === undefined) return null
    return summariseAndConfirm(ask, {
      vendor: kind,
      tier,
      renewsDay: 1,
    })
  }

  // Other subscription: record only what the user states. Missing pieces
  // (credit weights, reset date) stay missing and display as "unknown".
  const name = await ask.text({ title: "Plan name", placeholder: "e.g. Acme Coding Plan" })
  if (name === undefined) return null
  const price = await ask.text({ title: "Price per month (USD)", placeholder: "e.g. 16" })
  if (price === undefined) return null
  const priceUsd = parseAmount(price)
  if (priceUsd == null) {
    await ask.confirm({
      title: "Plan setup",
      message: "The price must be a positive number. Nothing was saved.",
    })
    return null
  }
  const allowance = await ask.text({
    title: "Allowance per month",
    placeholder: "e.g. 82B or 1000000 — empty if the vendor does not publish one",
  })
  if (allowance === undefined) return null
  const allowanceAmount = parseAmount(allowance)

  // An empty allowance is a real answer for usage-window plans: the plan is
  // recorded by name and price, and marked unpriced. No shadow price is
  // invented for it.
  if (allowanceAmount == null) {
    return summariseAndConfirm(ask, {
      name,
      priceUsd,
      capType: "usage-window",
      allowanceNote: "allowance not published by the vendor — recorded from your answers",
    })
  }

  const unit = await ask.select({
    title: "Allowance unit",
    options: [
      { value: "credits", title: "Credits", description: "The plan counts credits, not tokens" },
      { value: "tokens", title: "Tokens", description: "The plan counts tokens directly" },
    ],
  })
  if (unit === undefined) return null
  const renewsDay = await ask.text({
    title: "Renewal day of month (1–28)",
    placeholder: "empty if unknown",
  })
  if (renewsDay === undefined) return null

  return summariseAndConfirm(ask, {
    name,
    priceUsd,
    [unit === "tokens" ? "allowanceTokens" : "allowanceCredits"]: allowanceAmount,
    renewsDay: parseAmount(renewsDay) && Number(renewsDay) <= 28 ? Number(renewsDay) : null,
  })
}

/** Show every number with its source before saving. Decline saves nothing. */
async function summariseAndConfirm(ask, draft) {
  const record = resolveBilling(draft)
  if (!record) return null
  // Each allowance type reads as what the vendor actually published. A
  // window is a message budget, a dollar plan is a budget of API credits, a
  // quota is a count. None is described as a number it is not.
  const allowance = record.unpriced
    ? `Allowance: not published · ${record.allowanceNote}`
    : record.allowanceUnit === "window"
      ? `Allowance: usage window · ${record.window?.messagesPerWindow} messages per ${record.window?.windowHours}h (vendor estimate)`
      : record.allowanceUnit === "usd"
        ? `Allowance: $${record.priceUsd}/mo buys $${record.allowanceUsd} of API usage`
        : `Allowance: ${formatCredits(record.allowanceCredits)} ${record.allowanceUnit}/mo`
  const lines = [
    `Plan: ${record.name}`,
    `Price: $${record.priceUsd}/mo`,
    allowance,
    record.unpriced ? "Shadow price: not computable from published facts" : null,
    record.allowanceUnit === "window"
      ? "Shadow price: per model, from the window's value — message size measured from your turns"
      : null,
    record.renewsDay ? `Renews: day ${record.renewsDay} of each month` : "Renews: unknown",
    record.weightsNote
      ? `Cache writes: ${record.weightsNote}`
      : record.unpriced
        ? "Credit weights: none — this plan is not a credit plan"
        : record.allowanceUnit === "credits"
          ? "Credit weights: not recorded — plan prices stay unknown"
          : null,
    `Source: ${record.source?.url ?? "(none — recorded from your answers)"} · checked ${record.source?.checked ?? "today"}`,
  ].filter(Boolean)
  const ok = await ask.confirm({
    title: "Save these plan facts?",
    message: lines.join("\n"),
  })
  return ok ? draft : null
}

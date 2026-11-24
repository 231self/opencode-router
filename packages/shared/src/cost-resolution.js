/**
 * Whose prices apply to a model — one decision, made in one place.
 *
 * Two consumers need the same answer: the router prices a turn to rank
 * models, the compaction advisory prices a trade-off to say whether
 * compacting pays. Both used to write this precedence themselves and had
 * already drifted apart, so the rule lives here and both call it.
 *
 * The precedence, highest first:
 *
 *   1. a configured plan that covers the model — the user's own bill
 *   2. a public price table (models.dev, LiteLLM) — a published rate
 *   3. the model's own entry in the host catalog
 *   4. a sibling entry in the host catalog for the same model
 *   5. nothing at all
 *
 * The host catalog sits below the public table on purpose: the catalog is the
 * host's own opinion of a price, and it is not always right. A published rate
 * from a public price list is checkable, so it wins whenever both speak. This
 * is a rule about *which number to show*, not about whose money it is.
 *
 * The load-bearing part is `ownBill`, and it turns on a different question:
 * does the user actually pay per token here? When a plan covers the model they
 * pay credits; when the model is priced they pay per token; either way the
 * shown price is their bill and may veto an action that does not pay. When the
 * pool is flat ($0 marginal) any positive price shown is a stand-in — what it
 * would cost at list — and a projection must never veto. `ownBill` and
 * `moneyBasis` are both derived from that one test so they cannot disagree,
 * and the two consumers cannot disagree about whose money they show.
 */
import { costState, mergeCost, normaliseCost } from "./cost.js"
import { planForModel, planLabel, planTiers } from "./plan.js"

/** True when a tier set carries a real, positive price. */
function priced(tiers) {
  return (tiers ?? []).some((tier) => Number(tier?.input) > 0 || Number(tier?.output) > 0)
}

/**
 * The display flags for one resolution. `projection` means the shown price is
 * a stand-in rather than the user's own marginal cost: it may inform a report
 * and must never veto. Both `ownBill` and `moneyBasis` read from this one
 * test, so the two can never disagree about whether money may say no.
 */
function flags({ origin, planTierList, pricedHere }) {
  const paysPerToken = Boolean(planTierList) || pricedHere
  const standIn = (origin === "list" || origin === "reference") && !paysPerToken
  return {
    ownBill: !standIn,
    moneyBasis: standIn ? "at list price" : "",
    moneySuffix: standIn ? " · at list price" : "",
  }
}

/**
 * Resolve the prices for one model.
 *
 * `model` is the catalog entry (`{ providerID, id, cost }`), `billing` the raw
 * plan record. `listPrice` is a tier set from a public price table, and
 * `reference` a sibling catalog entry (`{ providerID, id, cost }`) — its
 * identity is only used for the label. `local` marks a model that burns no
 * allowance.
 *
 * Returns the tiers to price with, where they came from, whether they are the
 * user's own bill, and the pieces a display needs to say so.
 */
export function resolveCost({
  model = null,
  billing = null,
  listPrice = null,
  reference = null,
  local = false,
} = {}) {
  const modelID = model?.id ?? model?.modelID ?? ""
  const catalogTiers = normaliseCost(model?.cost)
  const tableTiers = normaliseCost(listPrice)
  const referenceTiers = normaliseCost(reference?.cost)
  const pricing = costState(catalogTiers)
  const pricedHere = pricing === "priced"

  // 1. Plan prices, when the plan covers this model and it is not local.
  //    A dollar-budget plan needs the model's own list price to convert its
  //    budget into a token count, so the table entry is passed along.
  const planTierList = local ? null : planTiers(billing, modelID, { listPrice: tableTiers })
  if (planTierList) {
    return {
      tiers: planTierList,
      origin: "plan",
      source: "plan",
      pricing,
      pricedHere,
      planName: planLabel(planForModel(billing, modelID)),
      reference: null,
      computed: true,
      unpricedNote: "no price data",
      ...flags({ origin: "plan", planTierList, pricedHere }),
    }
  }

  // 2. A public price table: a published rate, so it outranks the catalog.
  if (priced(tableTiers)) {
    return {
      tiers: tableTiers,
      origin: "list",
      source: "modelsdev",
      pricing,
      pricedHere,
      planName: null,
      reference: null,
      computed: true,
      unpricedNote: "no price data",
      ...flags({ origin: "list", planTierList, pricedHere }),
    }
  }

  // 3. The model's own catalog entry, with gaps filled from the reference. A
  //    reference with a real price stands in for an entry that has none; that
  //    case falls through to 4 so it is labelled as the projection it is.
  const merged = mergeCost(catalogTiers, referenceTiers)
  if (pricedHere || !priced(merged)) {
    return {
      tiers: merged,
      origin: pricedHere ? "catalog" : "none",
      source: pricedHere ? "catalog" : pricing === "flat" ? "catalog" : "unknown",
      pricing,
      pricedHere,
      planName: null,
      reference: null,
      computed: priced(merged),
      unpricedNote: pricing === "flat" ? "no reference price · $0 marginal" : "no price data",
      ...flags({ origin: pricedHere ? "catalog" : "none", planTierList, pricedHere }),
    }
  }

  // 4. A sibling catalog entry, and only when nothing better exists.
  return {
    tiers: referenceTiers,
    origin: "reference",
    source: "catalog",
    pricing,
    pricedHere,
    planName: null,
    reference:
      reference && reference.providerID
        ? { providerID: reference.providerID, id: reference.id }
        : null,
    computed: true,
    unpricedNote: pricing === "flat" ? "no reference price · $0 marginal" : "no price data",
    ...flags({ origin: "reference", planTierList, pricedHere }),
  }
}

/**
 * A one-line label naming where the prices came from, for a report header.
 * Built from `resolveCost`'s output so the wording cannot drift between the
 * two consumers.
 */
export function priceSourceLabel(resolution, model = null) {
  const { origin, planName, reference } = resolution ?? {}
  const id = model?.id ?? model?.modelID ?? ""
  const providerID = model?.providerID ?? "?"
  if (origin === "plan") return `plan · ${planName}`
  if (origin === "list") return `list price · ${providerID}/${id}`
  if (origin === "catalog") return `catalog · ${providerID}/${id}`
  if (origin === "reference" && reference) {
    return `list price · ${reference.providerID}/${reference.id}`
  }
  return resolution?.pricing === "flat" ? "none · no reference price" : "none · no price data"
}

/**
 * The plan catalog, as a file a user can edit.
 *
 * `PLAN_CATALOG` in `plan.js` is the built-in set of published plans. This
 * module layers a user file over it: `~/.config/omlx-router/plans.json` may
 * add vendors, add tiers, or override any number in the built-in set. The
 * shape of a vendor entry is the same as `PLAN_CATALOG`'s, so moving this
 * catalog to a shared public file later is a copy, not a rewrite.
 *
 * Honesty rules are unchanged and enforced at resolution, not here: a fact
 * without a source is not a fact, and a missing allowance stays missing.
 * The loader only merges what is present — it never fills a number the file
 * left out, and a malformed file is ignored rather than half-applied.
 *
 * Nothing here reaches the network. The file is the user's; fetching a
 * shared catalog is a separate concern that would write the same file.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { PLAN_CATALOG, setPlanCatalog } from "./plan.js"

/** Where the user's plan catalog lives. Overridable so tests can isolate it. */
export function planCatalogPath(env = process.env) {
  return env.OMLX_ROUTER_PLANS || path.join(os.homedir(), ".config", "omlx-router", "plans.json")
}

/**
 * Merge a user catalog over the built-in one. Per vendor, the user's keys
 * win; tiers merge the same way so a user can add one tier without retyping
 * the rest. Anything absent from the user's file keeps its built-in value.
 * An empty or malformed user catalog yields the built-in set unchanged.
 */
export function mergePlanCatalog(user, base = PLAN_CATALOG) {
  const merged = {}
  for (const [vendor, entry] of Object.entries(base ?? {})) {
    merged[vendor] = { ...entry, tiers: { ...(entry.tiers ?? {}) } }
  }
  if (!user || typeof user !== "object" || Array.isArray(user)) return merged
  for (const [vendor, entry] of Object.entries(user)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue
    const prior = merged[vendor] ?? { tiers: {} }
    merged[vendor] = {
      ...prior,
      ...entry,
      tiers: { ...(prior.tiers ?? {}), ...(entry.tiers ?? {}) },
    }
  }
  return merged
}

/**
 * Read the user's plan catalog and make it the active one. Returns the merged
 * catalog that `resolveBilling` will use. A missing or unreadable file is not
 * an error: the built-in set stands and the caller keeps working.
 */
export function loadPlanCatalog({ env = process.env, file = null } = {}) {
  const target = file ?? planCatalogPath(env)
  let user = null
  try {
    const raw = fs.readFileSync(target, "utf8")
    user = JSON.parse(raw)
  } catch {
    // No file, or one that is not valid JSON: use the built-in catalog.
    user = null
  }
  const merged = mergePlanCatalog(user)
  setPlanCatalog(merged)
  return merged
}

import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { getPlanCatalog, resolveBilling, setPlanCatalog } from "../src/plan.js"
import { loadPlanCatalog, mergePlanCatalog, planCatalogPath } from "../src/plan-catalog.js"

/** Restore the built-in catalog after a test that swaps it out. */
function restore() {
  setPlanCatalog(null)
}

test("a user catalog adds a vendor and a tier without disturbing the rest", () => {
  const merged = mergePlanCatalog({
    "acme-plan": {
      name: "Acme Coding",
      capType: "prepaid-credits",
      source: { url: "https://acme.example/pricing", checked: "2026-11-25", status: "official" },
      tiers: { pro: { name: "Pro", priceUsd: 30, allowanceCredits: 10e9 } },
    },
    "xiaomi-mimo": { tiers: { ultra: { name: "Ultra", priceUsd: 200, allowanceCredits: 200e9 } } },
  })
  // The new vendor stands beside the built-in ones.
  expect(merged["acme-plan"].name).toBe("Acme Coding")
  expect(merged["xiaomi-mimo"]).toBeTruthy()
  // A user tier adds to the built-in tiers rather than replacing them.
  expect(Object.keys(merged["xiaomi-mimo"].tiers).sort()).toEqual([
    "lite",
    "max",
    "pro",
    "standard",
    "ultra",
  ])
  // A user number overrides the built-in one for the same tier.
  const override = mergePlanCatalog({ "xiaomi-mimo": { tiers: { max: { name: "Max", priceUsd: 999 } } } })
  expect(override["xiaomi-mimo"].tiers.max.priceUsd).toBe(999)
})

test("a malformed user catalog falls back to the built-in set", () => {
  expect(mergePlanCatalog(null)["xiaomi-mimo"]).toBeTruthy()
  expect(mergePlanCatalog("nonsense")["xiaomi-mimo"]).toBeTruthy()
  expect(mergePlanCatalog([1, 2, 3])["xiaomi-mimo"]).toBeTruthy()
})

test("loadPlanCatalog reads a file and makes it the active catalog", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omlx-plans-"))
  const file = path.join(dir, "plans.json")
  fs.writeFileSync(
    file,
    JSON.stringify({
      "acme-plan": {
        name: "Acme Coding",
        source: { url: "https://acme.example/pricing", checked: "2026-11-25", status: "official" },
        tiers: { pro: { name: "Pro", priceUsd: 30, allowanceCredits: 10e9 } },
      },
    }),
  )
  const catalog = loadPlanCatalog({ file })
  try {
    expect(catalog["acme-plan"].name).toBe("Acme Coding")
    // The active catalog now resolves the user's vendor.
    const record = resolveBilling({ vendor: "acme-plan", tier: "pro" })
    expect(record.name).toBe("Acme Coding Pro")
    expect(record.priceUsd).toBe(30)
  } finally {
    restore()
  }
})

test("a missing or unreadable catalog file is not an error", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omlx-plans-"))
  const catalog = loadPlanCatalog({ file: path.join(dir, "absent.json") })
  try {
    // The built-in set stands and resolution keeps working.
    expect(catalog["xiaomi-mimo"]).toBeTruthy()
    expect(resolveBilling({ vendor: "xiaomi-mimo", tier: "max" }).priceUsd).toBe(100)
  } finally {
    restore()
  }
})

test("the catalog path is overridable for tests and reads from the config dir", () => {
  expect(planCatalogPath({})).toContain(path.join(".config", "omlx-router", "plans.json"))
  expect(planCatalogPath({ OMLX_ROUTER_PLANS: "/tmp/x.json" })).toBe("/tmp/x.json")
})

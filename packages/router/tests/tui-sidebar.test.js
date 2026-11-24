import { expect, test } from "bun:test"

import { ago, routerSidebarBlock } from "../src/tui-sidebar.js"

test("the router block leads with the decision, then the evidence", () => {
  const block = routerSidebarBlock({
    enabled: true,
    policy: "cost",
    model: { providerID: "xiaomi-token-plan-sgp", id: "mimo-v2.6-pro" },
    decision: { reason: "pin-kept", model: { providerID: "xiaomi-token-plan-sgp", id: "mimo-v2.6-pro" } },
    pin: { model: { providerID: "xiaomi-token-plan-sgp", id: "mimo-v2.6-pro" }, source: "auto" },
    quality: { value: 0.83, checkedAt: Date.now() - 30 * 60000 },
    judge: { model: "auto" },
  })
  expect(block.title).toBe("Router")
  for (const item of block.items) expect(item.length).toBeLessThanOrEqual(72)
  // The conclusion comes first: what the router chose and why.
  expect(block.items[0]).toBe("running xiaomi-token-plan-sgp/mimo-v2.6-pro · kept for cache")
  // Then the policy that decided it, and the evidence behind it.
  expect(block.items[1]).toBe("policy cost")
  expect(block.items[2]).toBe("pin auto")
  expect(block.items[3]).toContain("quality 0.83")
  expect(block.items[4]).toBe("judge auto")
})

test("a forced pin says forced, and a disabled router says off", () => {
  const block = routerSidebarBlock({
    enabled: false,
    policy: "quality",
    model: null,
    pin: { model: { providerID: "a", id: "b" }, forced: true },
  })
  expect(block.items[0]).toBe("router off")
  expect(block.items[1]).toBe("no model selected")
  expect(block.items[2]).toBe("pin forced")
})

test("ages read as minutes, hours, days", () => {
  const now = Date.now()
  expect(ago(now - 5 * 60000, now)).toBe("5m")
  expect(ago(now - 3 * 3600000, now)).toBe("3h")
  expect(ago(now - 2 * 86400000, now)).toBe("2d")
})

test("each decision reason reads as an action, not a code", () => {
  const model = { providerID: "deepseek", id: "deepseek-flash" }
  const line = (reason) => routerSidebarBlock({ model, decision: { reason } }).items[0]
  expect(line("pin-kept")).toBe("running deepseek/deepseek-flash · kept for cache")
  expect(line("best-model")).toBe("running deepseek/deepseek-flash · first pick")
  expect(line("cheaper-model")).toBe("running deepseek/deepseek-flash · switched · cheaper")
  expect(line("quality-gate")).toBe("running deepseek/deepseek-flash · switched · quality gate")
  expect(line("forced")).toBe("running deepseek/deepseek-flash · pinned by you")
  // An unknown reason is shown rather than dropped, so a new one stays visible.
  expect(line("something-new")).toContain("something-new")
})

test("no decision yet shows the model without inventing a reason", () => {
  const block = routerSidebarBlock({ model: { providerID: "deepseek", id: "deepseek-flash" } })
  expect(block.items[0]).toBe("running deepseek/deepseek-flash")
})

test("a disabled router reports state, not a decision it is not making", () => {
  const block = routerSidebarBlock({
    enabled: false,
    model: { providerID: "deepseek", id: "deepseek-flash" },
    decision: { reason: "pin-kept" },
    pin: { model: { providerID: "a", id: "b" }, forced: true },
  })
  expect(block.items[0]).toBe("router off")
  expect(block.items[1]).toBe("running deepseek/deepseek-flash")
  // No "kept for cache": nothing is deciding while the router is off.
  expect(block.items.some((item) => item.includes("kept for cache"))).toBe(false)
})

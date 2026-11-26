import { expect, test } from "bun:test"

import { compactionSidebarBlock, short } from "../src/tui-sidebar.js"

test("the compaction block shows window use, plan, burn, and expiry", () => {
  const block = compactionSidebarBlock({
    capacity: { size: 500_000, limit: 1_048_576, headroom: 548_576 },
    plan: "Xiaomi MiMo Token Plan Max · $100/mo",
    burn: {
      used: 12.4e9,
      allowance: 82e9,
      percentUsed: 15.1,
      projected: 16.2e9,
      daysLeft: 7,
    },
    expiry: { cold: 150e6, ratio: 120 },
  })
  expect(block.title).toBe("Context")
  for (const item of block.items) expect(item.length).toBeLessThanOrEqual(72)
  expect(block.items[0]).toBe("ctx 500K/1.0M · 52% free")
  expect(block.items[1]).toBe("plan Xiaomi MiMo Token Plan Max · $100/mo")
  expect(block.items[2]).toBe("burn 12.4B/82.0B credits (15%)")
  expect(block.items[3]).toBe("reset 7d · proj 16.2B")
  expect(block.items[4]).toBe("expiry 150.0M credits (120x hot)")
})

test("a session with no plan shows just the window", () => {
  const block = compactionSidebarBlock({
    capacity: { size: 30_000, limit: 262_144, headroom: 232_144 },
  })
  expect(block.items).toEqual(["ctx 30K/262K · 89% free"])
})

test("counts compress the way the report reads them", () => {
  expect(short(150_000_000)).toBe("150.0M")
  expect(short(82e9)).toBe("82.0B")
  expect(short(2584)).toBe("3K")
})

test("several plans each show their own burn, never one blended figure", () => {
  const block = compactionSidebarBlock({
    capacity: { size: 500_000, limit: 1_048_576, headroom: 548_576 },
    plans: [
      { label: "Xiaomi MiMo Token Plan Max · $100/mo", burn: { used: 12.4e9, allowance: 82e9, percentUsed: 15.1, projected: 16.2e9, daysLeft: 7 } },
      { label: "ChatGPT Plus · $20/mo · allowance not published", burn: null },
    ],
    expiry: { cold: 150e6, ratio: 120 },
  })
  for (const item of block.items) expect(item.length).toBeLessThanOrEqual(72)
  const text = block.items.join("\n")
  // Each plan names itself and carries its own burn.
  expect(text).toContain("plan Xiaomi MiMo Token Plan Max · $100/mo")
  expect(text).toContain("burn 12.4B/82.0B credits (15%)")
  expect(text).toContain("plan ChatGPT Plus · $20/mo · allowance not published")
  // The unpriced plan shows its name but no burn: there is no allowance to
  // measure against, so the figure would have to be invented.
  expect(block.items.filter((item) => item.startsWith("burn"))).toHaveLength(1)
})

test("the verdict leads the block, before the numbers behind it", () => {
  const block = compactionSidebarBlock({
    verdict: { verdict: "compact-now", breakEvenTurns: 3 },
    capacity: { size: 500_000, limit: 1_048_576, headroom: 548_576 },
  })
  // The conclusion comes first: it is the point of the block.
  expect(block.items[0]).toBe("verdict compact now · pays back in 3 turns")
  expect(block.items[1]).toContain("ctx 500K/1.0M")
  for (const item of block.items) expect(item.length).toBeLessThanOrEqual(72)
})

test("each verdict reads as an action, not a code", () => {
  const line = (verdict, extra = {}) => compactionSidebarBlock({ verdict: { verdict, ...extra } }).items[0]
  expect(line("compact-now")).toBe("verdict compact now · safe checkpoint")
  expect(line("compact-now", { breakEvenTurns: 1 })).toBe("verdict compact now · pays back in 1 turn")
  expect(line("not-yet")).toBe("verdict keep working")
  expect(line("delegate")).toBe("verdict delegate · looks like review")
  expect(line("uncertain")).toBe("verdict uncertain")
})

test("no advisory yet means no invented verdict", () => {
  // The block shows its numbers but never a recommendation it cannot support.
  const block = compactionSidebarBlock({ capacity: { size: 30_000, limit: 262_144, headroom: 232_144 } })
  expect(block.items[0]).toBe("ctx 30K/262K · 89% free")
  expect(block.items.some((item) => item.startsWith("verdict"))).toBe(false)
})

test("the block shows the unit price with its mix basis", () => {
  const measured = compactionSidebarBlock({
    unitPrice: { usdPerMTok: 0.4575, measured: true, basis: "measured mix · 213 turns" },
  })
  expect(measured.items.join("\n")).toContain("unit $0.46/M · measured mix")
  const stand = compactionSidebarBlock({
    unitPrice: { usdPerMTok: 0.0012, measured: false, basis: "reference mix · stand-in" },
  })
  expect(stand.items.join("\n")).toContain("unit $0.0012/M · stand-in mix")
  // No unit price, or a free one: the line is left out, not printed as zero.
  const none = compactionSidebarBlock({ unitPrice: { usdPerMTok: 0, measured: true } })
  expect(none.items.join("\n")).not.toContain("unit ")
})

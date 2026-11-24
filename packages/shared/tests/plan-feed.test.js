import { expect, test } from "bun:test"

import {
  applyPlanFacts,
  fetchLimitDex,
  parseLimitDex,
  planFacts,
} from "../src/plan-feed.js"

/** A slice of the real LimitDex payload (2026-11-24), trimmed to two tools. */
const FEED = {
  generatedAt: "2026-11-24T06:17:02.446Z",
  tools: [
    {
      id: "codex",
      name: "OpenAI Codex (ChatGPT plans)",
      vendor: "OpenAI",
      weeklyCapPublished: false,
      generalLimitsQuote:
        "These estimates are not fixed message limits; check your usage dashboard for current limits and reset times.",
      generalLimitsSource: "https://developers.openai.com/codex/pricing/",
      plans: [
        {
          name: "Plus",
          priceUsdMonthly: 20,
          unit: "per month",
          limitsQuote: "Est. local messages per 5h: GPT-6.1 Sol 15-160",
          limitsSource: "https://developers.openai.com/codex/pricing/",
          status: "verified",
          lastVerified: "2026-11-24",
        },
        { name: "Pro", priceUsdMonthly: 100, lastVerified: "2026-11-24" },
      ],
    },
    {
      id: "copilot",
      name: "GitHub Copilot",
      vendor: "GitHub",
      weeklyCapPublished: true,
      plans: [{ name: "Pro", priceUsdMonthly: 10, limitsQuote: "Total monthly AI credits: $15 per month" }],
    },
  ],
}

test("the feed parses into tools with the allowance flag kept", () => {
  const feed = parseLimitDex(FEED)
  expect(feed.generatedAt).toBe("2026-11-24T06:17:02.446Z")
  expect(feed.tools.codex.allowancePublished).toBe(false)
  expect(feed.tools.copilot.allowancePublished).toBe(true)
  expect(feed.tools.codex.plans).toHaveLength(2)
  // Junk shapes are rejected, not half-parsed.
  expect(parseLimitDex(null)).toBeNull()
  expect(parseLimitDex({ tools: "nope" })).toBeNull()
})

test("plan facts match by tool and plan name, case-insensitively", () => {
  const feed = parseLimitDex(FEED)
  const facts = planFacts(feed, { tool: "codex", plan: "plus" })
  expect(facts.plan).toBe("Plus")
  expect(facts.priceUsdMonthly).toBe(20)
  expect(facts.allowancePublished).toBe(false)
  expect(facts.limitsQuote).toContain("Est. local messages")
  expect(facts.lastVerified).toBe("2026-11-24")
  // Not in the feed: null, so the caller can say so instead of guessing.
  expect(planFacts(feed, { tool: "codex", plan: "Ultra" })).toBeNull()
  expect(planFacts(feed, { tool: "xiaomi", plan: "Max" })).toBeNull()
})

test("applying facts copies the price and a source, never an allowance", () => {
  const feed = parseLimitDex(FEED)
  const facts = planFacts(feed, { tool: "codex", plan: "Plus" })
  const billing = { vendor: "openai-codex", tier: "plus", priceUsd: 19, renewsDay: 1 }
  const patched = applyPlanFacts(billing, facts)
  expect(patched.priceUsd).toBe(20)
  expect(patched.renewsDay).toBe(1)
  expect(patched.source.status).toBe("verified")
  expect(patched.source.checked).toBe("2026-11-24")
  // The feed cannot supply what the vendor never published.
  expect(patched.allowanceCredits).toBeUndefined()
  expect(patched.allowanceTokens).toBeUndefined()
  // The input record is not mutated.
  expect(billing.priceUsd).toBe(19)
})

test("a fetch returns the parsed feed, or a short reason — never a throw", async () => {
  const ok = await fetchLimitDex({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => FEED }),
  })
  expect(ok.ok).toBe(true)
  expect(ok.feed.tools.codex.plans).toHaveLength(2)

  const http = await fetchLimitDex({
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  })
  expect(http).toEqual({ ok: false, reason: "HTTP 503" })

  const badShape = await fetchLimitDex({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ nope: true }) }),
  })
  expect(badShape).toEqual({ ok: false, reason: "feed shape not recognised" })

  const offline = await fetchLimitDex({
    fetchImpl: async () => {
      throw new TypeError("fetch failed")
    },
  })
  expect(offline).toEqual({ ok: false, reason: "TypeError" })

  expect(await fetchLimitDex({ fetchImpl: null })).toEqual({
    ok: false,
    reason: "no fetch in this runtime",
  })
})

test("a fetch that hangs is cut off by the timeout", async () => {
  const hang = (url, { signal }) =>
    new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => {
        const error = new Error("aborted")
        error.name = "AbortError"
        reject(error)
      })
    })
  const result = await fetchLimitDex({ fetchImpl: hang, timeoutMs: 10 })
  expect(result).toEqual({ ok: false, reason: "timed out" })
})

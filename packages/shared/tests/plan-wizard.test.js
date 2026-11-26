import { expect, test } from "bun:test"

import { parseAmount, resetPlanPromptClaim, claimPlanPrompt, runPlanWizard, shouldPromptPlanSetup } from "../src/plan-wizard.js"
import { resolveBilling } from "../src/plan.js"

/** A scripted dialog adapter: answers in order, recording every question. */
function scripted(answers) {
  const asked = []
  const take = (kind) => (input) => {
    asked.push({ kind, ...input })
    return answers.shift()
  }
  return { asked, select: take("select"), text: take("text"), confirm: take("confirm") }
}

test("human amounts parse with suffixes and separators", () => {
  expect(parseAmount("82B")).toBe(82e9)
  expect(parseAmount("4.1b")).toBeCloseTo(4.1e9, 0)
  expect(parseAmount("16")).toBe(16)
  expect(parseAmount("1,000,000")).toBe(1e6)
  expect(parseAmount("0")).toBeNull()
  expect(parseAmount("lots")).toBeNull()
  expect(parseAmount(undefined)).toBeNull()
})

test("the MiMo path records a catalog-backed record", async () => {
  const ask = scripted(["subscription", "xiaomi-mimo", "max", true])
  const record = await runPlanWizard({ ask, modelLabel: "xiaomi-token-plan-sgp/mimo-v2.6-pro" })
  expect(record.vendor).toBe("xiaomi-mimo")
  expect(record.plan).toBe("max")
  expect(record.renewsDay).toBe(1)
  // The confirmation lists the source before saving.
  const confirm = ask.asked.find((q) => q.kind === "confirm")
  expect(confirm.message).toContain("mimo.mi.com")
  expect(confirm.message).toContain("$100/mo")
})

test("declining the confirmation saves nothing", async () => {
  const ask = scripted(["subscription", "xiaomi-mimo", "max", false])
  expect(await runPlanWizard({ ask })).toBeNull()
})

test("escaping anywhere saves nothing", async () => {
  expect(await runPlanWizard({ ask: scripted([undefined]) })).toBeNull()
  expect(await runPlanWizard({ ask: scripted(["subscription", "xiaomi-mimo", undefined]) })).toBeNull()
})

test("pay as you go and skip are records, so they never nag again", async () => {
  expect(await runPlanWizard({ ask: scripted(["payg"]) })).toEqual({
    type: "payg",
    payg: true,
    source: { url: null, checked: null, status: "user" },
  })
  expect(await runPlanWizard({ ask: scripted(["skip"]) })).toEqual({
    skipped: true,
    source: { url: null, checked: null, status: "user" },
  })
})

test("the custom path records only stated facts", async () => {
  const ask = scripted(["subscription", "other", "Acme Plan", "16", "82B", "credits", "5", true])
  const record = await runPlanWizard({ ask })
  expect(record.name).toBe("Acme Plan")
  expect(record.priceUsd).toBe(16)
  expect(record.allowanceCredits).toBe(82e9)
  expect(record.renewsDay).toBe(5)
})

test("the custom path rejects junk numbers instead of saving them", async () => {
  const ask = scripted(["subscription", "other", "Acme", "cheap", "82B", "credits", "5", undefined])
  expect(await runPlanWizard({ ask })).toBeNull()
  const confirm = ask.asked.find((q) => q.kind === "confirm")
  expect(confirm.message).toContain("positive number")
})

test("the first-init prompt fires once per process", () => {
  resetPlanPromptClaim()
  expect(claimPlanPrompt()).toBe(true)
  expect(claimPlanPrompt()).toBe(false)
})

test("a priced model or an existing record suppresses the prompt", () => {
  expect(shouldPromptPlanSetup({ billing: { payg: true } }, "flat")).toBe(false)
  expect(shouldPromptPlanSetup({ billing: null }, "priced")).toBe(false)
  expect(shouldPromptPlanSetup({ billing: null }, "flat")).toBe(true)
  expect(shouldPromptPlanSetup({ billing: null }, "unknown")).toBe(true)
})

test("a ChatGPT tier with a published window is priced from it, not left unpriced", async () => {
  const ask = scripted(["subscription", "openai-codex", "plus", true])
  const record = await runPlanWizard({ ask })
  expect(record.vendor).toBe("openai-codex")
  expect(record.plan).toBe("plus")
  // The wizard records the vendor/plan; the window comes from the catalog at
  // resolution. No credit quota exists, but the window does — so this is a
  // window plan, priced per model once the message size is measured.
  const resolved = resolveBilling(record)
  expect(resolved.allowanceCredits).toBeNull()
  expect(resolved.window.messagesPerWindow).toBe(160)
  const confirm = ask.asked.find((q) => q.kind === "confirm")
  expect(confirm.message).toContain("$20/mo")
  expect(confirm.message).toContain("usage window")
  expect(confirm.message).toContain("160 messages per 5h")
})

test("a ChatGPT tier with no published window is unpriced and says so", async () => {
  const ask = scripted(["subscription", "openai-codex", "business", true])
  const record = await runPlanWizard({ ask })
  expect(record.plan).toBe("business")
  const confirm = ask.asked.find((q) => q.kind === "confirm")
  expect(confirm.message).toContain("not published")
  expect(confirm.message).toContain("not computable")
})

test("an empty allowance is a recorded usage-window plan, not an error", async () => {
  const ask = scripted(["subscription", "other", "Acme Windows", "20", "", true])
  const record = await runPlanWizard({ ask })
  expect(record.name).toBe("Acme Windows")
  expect(record.priceUsd).toBe(20)
  expect(record.capType).toBe("usage-window")
  expect(record.allowanceCredits).toBeUndefined()
})

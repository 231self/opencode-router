import { expect, test } from "bun:test"
import fs from "node:fs"

import { startWebServer } from "../src/web.js"

/** The same fixture shape the builders take. Sensitive-shaped fields ride
 * along to prove the projection drops them at the HTTP edge too. */
const rates = { input: 2, output: 10, cache: { read: 0.2, write: 2.5 } }

function fixture() {
  return {
    turns: [
      {
        ts: 1_700_000_000_000,
        session: "ses_a",
        usedModel: "deepseek/deepseek-flash",
        tokens: { input: 100, output: 50, cache: { read: 700, write: 150 } },
        promptText: "SECRET PROMPT",
      },
    ],
    decisions: [
      { ts: 1_700_000_000_000, session: "ses_a", chosen: "deepseek/deepseek-flash", reason: "kept for cache" },
    ],
    pin: {
      compaction: {
        advisory: {
          verdict: "compact-now",
          breakEvenTurns: 2,
          perTurnSavings: 0.01,
          invalidationCost: 0.02,
          worthIt: true,
          toolOutput: "SECRET TOOL OUTPUT",
        },
      },
    },
    billing: { vendor: "xiaomi-mimo", plan: "max", renewsDay: 1 },
    pool: [
      {
        providerID: "deepseek",
        modelID: "deepseek-flash",
        name: "DeepSeek Flash",
        local: false,
        cost: [rates],
        costSource: "catalog",
      },
    ],
    ratesOf: () => rates,
  }
}

test("the server binds loopback and serves the API", async () => {
  const server = await startWebServer({ config: { web: { port: 0 } }, data: fixture, session: "ses_a" })
  try {
    expect(server.url).toStartWith("http://127.0.0.1:")
    for (const route of [
      "/api/summary.json",
      "/api/models.json",
      "/api/plans.json",
      "/api/trends.json",
      "/api/decisions.json",
    ]) {
      const response = await fetch(`${server.url}${route}`)
      expect(response.status).toBe(200)
    }
    const summary = await (await fetch(`${server.url}/api/summary.json`)).json()
    expect(summary.totals.turns).toBe(1)
    // Unknown paths and traversal attempts are refused, not served.
    expect((await fetch(`${server.url}/api/nope.json`)).status).toBe(404)
    expect((await fetch(`${server.url}/../../etc/passwd`)).status).toBe(404)
    // The HTTP edge carries no sensitive fields either.
    const text = await (await fetch(`${server.url}/api/summary.json`)).text()
    expect(text).not.toContain("SECRET")
    expect(text).not.toContain("promptText")
  } finally {
    await server.close()
  }
})

test("scope=session narrows through the query string", async () => {
  const data = () => ({
    ...fixture(),
    turns: [
      ...fixture().turns,
      {
        ts: 1_700_086_400_000,
        session: "ses_b",
        usedModel: "deepseek/deepseek-flash",
        tokens: { input: 10, output: 10, cache: { read: 0, write: 0 } },
      },
    ],
  })
  const server = await startWebServer({ config: { web: { port: 0 } }, data, session: "ses_a" })
  try {
    const all = await (await fetch(`${server.url}/api/summary.json?scope=all`)).json()
    expect(all.totals.turns).toBe(2)
    const scoped = await (await fetch(`${server.url}/api/summary.json?scope=session`)).json()
    expect(scoped.totals.turns).toBe(1)
    expect(scoped.session.hash).toBe("ses_a")
  } finally {
    await server.close()
  }
})

test("a failing builder answers 503 and the server keeps serving", async () => {
  let fail = true
  const server = await startWebServer({
    config: { web: { port: 0 } },
    data: () => {
      if (fail) throw new Error("boom")
      return fixture()
    },
    session: "ses_a",
  })
  try {
    expect((await fetch(`${server.url}/api/summary.json`)).status).toBe(503)
    fail = false
    expect((await fetch(`${server.url}/api/summary.json`)).status).toBe(200)
  } finally {
    await server.close()
  }
})

test("a busy configured port falls back to an ephemeral one", async () => {
  const first = await startWebServer({ config: { web: { port: 0 } }, data: fixture })
  try {
    const second = await startWebServer({ config: { web: { port: first.port } }, data: fixture })
    try {
      expect(second.port).not.toBe(first.port)
    } finally {
      await second.close()
    }
  } finally {
    await first.close()
  }
})

test("the server serves the dashboard page and its assets", async () => {
  const server = await startWebServer({ config: { web: { port: 0 } }, data: fixture, session: "ses_a" })
  try {
    const page = await fetch(`${server.url}/`)
    expect(page.status).toBe(200)
    expect(page.headers.get("content-type")).toContain("text/html")
    const html = await page.text()
    for (const id of ["verdict", "models", "plans", "compaction", "trends", "decisions"]) {
      expect(html).toContain(`id="${id}"`)
    }
    const script = await fetch(`${server.url}/app.js`)
    expect(script.status).toBe(200)
    expect(script.headers.get("content-type")).toContain("text/javascript")
    const style = await fetch(`${server.url}/style.css`)
    expect(style.status).toBe(200)
    expect(style.headers.get("content-type")).toContain("text/css")
  } finally {
    await server.close()
  }
})

test("the package ships the web assets", () => {
  // The dashboard is part of the published package: a tarball without its
  // page would serve 503s at `/`.
  const pkg = JSON.parse(
    fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  )
  expect(pkg.files).toContain("web")
})

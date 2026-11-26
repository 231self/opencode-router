/**
 * The dashboard page. Vanilla JS over the JSON API: every value shown here
 * is rendered with `textContent`, so nothing from state can become markup.
 * The scope switcher refetches; the rest is a ~10s poll.
 */
(() => {
  const POLL_MS = 10000
  let scope = "all"

  // ---- formatting -------------------------------------------------------

  /** Dollars, at the honesty floor the TUI uses: never a printed zero. */
  function dollars(value) {
    const v = Number(value)
    if (!Number.isFinite(v)) return "—"
    if (v === 0) return "$0"
    if (v < 0.0001) return "<$0.0001"
    return `$${v < 0.01 ? v.toFixed(5).replace(/0+$/, "") : v.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`
  }

  /** A per-Mtok price, compact like the TUI's unit rows. */
  function perM(value) {
    const v = Number(value)
    if (!Number.isFinite(v)) return "—"
    return `$${Number(v.toPrecision(2))}/M`
  }

  function short(value) {
    const v = Number(value)
    if (!Number.isFinite(v)) return "—"
    if (v >= 1e9) return `${Number((v / 1e9).toPrecision(3))}B`
    if (v >= 1e6) return `${Number((v / 1e6).toPrecision(3))}M`
    if (v >= 1e3) return `${Number((v / 1e3).toPrecision(3))}K`
    return String(Math.round(v))
  }

  function when(ts) {
    const d = new Date(Number(ts))
    return Number.isFinite(d.getTime()) ? d.toLocaleString() : ""
  }

  // ---- tiny DOM builder -------------------------------------------------

  function el(tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text != null) node.textContent = String(text)
    return node
  }

  /** One label/value line — the row shape every section uses. */
  function row(label, value, strong) {
    const line = el("div", "row")
    line.append(el("div", "label", label))
    const val = el("div", "value")
    if (strong) val.append(el("strong", null, value))
    else val.append(document.createTextNode(String(value)))
    line.append(val)
    return line
  }

  // ---- sections ---------------------------------------------------------

  function renderHeader(summary) {
    const decision = summary.headline?.decision
    const compaction = summary.compaction
    const parts = []
    if (decision?.chosen) parts.push(`running ${decision.chosen}${decision.reason ? ` · ${decision.reason}` : ""}`)
    if (compaction?.verdict) {
      parts.push(
        compaction.verdict === "compact-now" && compaction.breakEvenTurns != null
          ? `compact now · pays back in ${compaction.breakEvenTurns} turns`
          : compaction.verdict,
      )
    }
    document.getElementById("verdict").textContent =
      parts.length > 0 ? parts.join(" · ") : "No decisions recorded yet"
    const bits = []
    if (summary.session?.hash) bits.push(`session ${String(summary.session.hash).slice(0, 12)}`)
    bits.push(scope === "session" ? "showing this session" : "showing every session")
    document.getElementById("session").textContent = bits.join(" · ")
    for (const button of document.querySelectorAll("#scope button")) {
      button.setAttribute("aria-pressed", String(button.dataset.scope === scope))
    }
  }

  function renderModels(summary) {
    const root = document.getElementById("models")
    root.replaceChildren()
    const models = summary.models ?? []
    if (models.length === 0) {
      root.append(el("p", "empty", "No models in the pool."))
      return
    }
    for (const model of models) {
      const unit = model.unitPrice
      root.append(
        row(
          `${model.providerID}/${model.modelID}${model.local ? " · local" : ""}`,
          unit ? `${perM(unit.usdPerMTok)} · ${unit.basis}` : "no price data",
        ),
      )
    }
    const unit = summary.headlineUnitPrice
    if (unit) {
      root.append(el("p", "note", `Headline model priced at ${perM(unit.usdPerMTok)} per Mtok · ${unit.basis}`))
    }
  }

  function renderPlans(plans) {
    const root = document.getElementById("plans")
    root.replaceChildren()
    if (plans.length === 0) {
      root.append(el("p", "empty", "No plan recorded — list prices apply."))
      return
    }
    for (const plan of plans) {
      const card = el("div")
      card.append(row(`${plan.type} · ${plan.vendor} · ${plan.plan}`, plan.priceUsd != null ? `$${plan.priceUsd}/mo` : "—", true))
      if (plan.burn && plan.burn.allowance != null) {
        const pct = Math.min(100, Math.round((plan.burn.used / plan.burn.allowance) * 100))
        const bar = el("div", "bar")
        const fill = el("span")
        fill.style.width = `${pct}%`
        bar.append(fill)
        card.append(bar)
        card.append(
          row(
            "burn",
            `${short(plan.burn.used)} of ${short(plan.burn.allowance)} credits (${pct}%)${
              plan.burn.daysLeft != null ? ` · ${Math.round(plan.burn.daysLeft)}d left` : ""
            }`,
          ),
        )
      } else if (plan.allowanceNote) {
        card.append(el("p", "note", plan.allowanceNote))
      }
      root.append(card)
    }
    root.append(el("p", "note", "Allowances are account-wide: the same in every scope."))
  }

  function renderCompaction(compaction) {
    const root = document.getElementById("compaction")
    root.replaceChildren()
    if (!compaction || !compaction.verdict) {
      root.append(el("p", "empty", "Nothing recorded for this session yet."))
      return
    }
    root.append(row("verdict", compaction.verdict, true))
    if (compaction.invalidationCost != null) {
      root.append(row("cost to compact", `${dollars(compaction.invalidationCost)} · mostly KV-cache invalidation`))
    }
    if (compaction.breakEvenTurns != null) {
      root.append(row("break-even", `${compaction.breakEvenTurns} turns`))
    }
    if (compaction.perTurnSavings != null) {
      root.append(row("per turn saved", dollars(compaction.perTurnSavings)))
    }
    if (compaction.worthIt != null) {
      root.append(row("worth it", compaction.worthIt ? "yes" : "no"))
    }
  }

  /** An inline SVG sparkline — the only chart in the app. */
  function spark(values) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
    svg.setAttribute("class", "spark")
    svg.setAttribute("viewBox", "0 0 100 42")
    svg.setAttribute("preserveAspectRatio", "none")
    const points = values.map((value, index) => {
      const x = values.length > 1 ? (index / (values.length - 1)) * 100 : 0
      const max = Math.max(...values, 1e-12)
      const y = 40 - (Math.max(0, value) / max) * 38
      return `${x.toFixed(2)},${y.toFixed(2)}`
    })
    const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline")
    line.setAttribute("points", points.join(" "))
    line.setAttribute("fill", "none")
    line.setAttribute("stroke", "var(--accent)")
    line.setAttribute("stroke-width", "1.5")
    line.setAttribute("vector-effect", "non-scaling-stroke")
    svg.append(line)
    return svg
  }

  function renderTrends(trends) {
    const root = document.getElementById("trends")
    root.replaceChildren()
    const daily = trends.daily ?? []
    if (daily.length === 0) {
      root.append(el("p", "empty", "No turns in this scope yet."))
      return
    }
    const series = [
      ["spend per day", daily.map((d) => d.spendUsd), (total) => dollars(total)],
      ["turns per day", daily.map((d) => d.turns), (total) => short(total)],
      ["tokens per day", daily.map((d) => d.inputTokens + d.outputTokens + d.cacheReadTokens + d.cacheWriteTokens), short],
    ]
    for (const [label, values, format] of series) {
      const block = el("div")
      const total = values.reduce((sum, value) => sum + value, 0)
      block.append(row(label, `${format(total)} over ${daily.length}d`))
      block.append(spark(values))
      root.append(block)
    }
    if (trends.unpricedTurns > 0) {
      root.append(el("p", "note", `${trends.unpricedTurns} turns have no price data and are left out of spend.`))
    }
  }

  function renderDecisions(items) {
    const root = document.getElementById("decisions")
    root.replaceChildren()
    if (items.length === 0) {
      root.append(el("p", "empty", "No decisions recorded."))
      return
    }
    for (const item of items) {
      root.append(row(when(item.ts), `${item.chosen || "?"}${item.reason ? ` · ${item.reason}` : ""}`))
    }
  }

  // ---- data loop --------------------------------------------------------

  async function json(route) {
    const response = await fetch(route)
    if (!response.ok) throw new Error(`${route} → ${response.status}`)
    return response.json()
  }

  async function refresh() {
    try {
      const q = `scope=${scope}`
      const [summary, models, plans, trends, decisions] = await Promise.all([
        json(`/api/summary.json?${q}`),
        json(`/api/models.json?${q}`),
        json(`/api/plans.json`),
        json(`/api/trends.json?${q}&days=30`),
        json(`/api/decisions.json?${q}`),
      ])
      renderHeader(summary)
      renderModels({ ...models, headlineUnitPrice: summary.unitPrice })
      renderPlans(plans.plans ?? [])
      renderCompaction(summary.compaction)
      renderTrends(trends)
      renderDecisions(decisions.items ?? [])
    } catch (error) {
      document.getElementById("verdict").textContent = `Dashboard unavailable — ${error.message}`
    }
  }

  for (const button of document.querySelectorAll("#scope button")) {
    button.addEventListener("click", () => {
      scope = button.dataset.scope
      refresh()
    })
  }

  refresh()
  setInterval(refresh, POLL_MS)
})()

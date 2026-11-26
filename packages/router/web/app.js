/**
 * The dashboard page. Vanilla JS over the JSON API: tables with sorting,
 * per-column filters and search; consumption bars with hover figures in the
 * DeepSeek-dashboard habit; decisions that expand to their reason. Every
 * value is rendered with `textContent`, so nothing from state can become
 * markup. The scope switcher refetches; the rest is a ~10s poll.
 */
(() => {
  const POLL_MS = 10000
  let scope = "all"
  let trendMetric = "spendUsd"
  let trendBucket = "day"
  let trendsCache = { day: { buckets: [] }, hour: { buckets: [] } }

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

  /** Bucket keys are ISO day (`2026-11-26`) or ISO hour (`2026-11-26T12:00`). */
  function at(bucket) {
    return bucket.length > 10 ? bucket.replace("T", " ") : bucket
  }

  // ---- tiny DOM builder -------------------------------------------------

  function el(tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text != null) node.textContent = String(text)
    return node
  }

  /** One label/value line — the row shape every detail panel uses. */
  function row(label, value, strong) {
    const line = el("div", "row")
    line.append(el("div", "label", label))
    const val = el("div", "value")
    if (strong) val.append(el("strong", null, value))
    else val.append(document.createTextNode(String(value)))
    line.append(val)
    return line
  }

  // ---- the table engine -------------------------------------------------

  /**
   * A data table with sortable columns, a search box over all columns, and a
   * per-column filter input. With `expand`, rows are clickable and open a
   * detail panel beneath them. Sorting and filtering survive `setRows`, so
   * the poll does not disturb what the reader arranged.
   */
  function dataTable({ columns, rows = [], expand = null, placeholder = "Search…" }) {
    let sortKey = null
    let sortDir = 1
    let query = ""
    const filters = {}

    const wrap = el("div", "table-wrap")
    const tools = el("div", "table-tools")
    const search = el("input")
    search.type = "search"
    search.placeholder = placeholder
    search.addEventListener("input", () => {
      query = search.value.trim().toLowerCase()
      render()
    })
    tools.append(search)
    wrap.append(tools)

    const table = document.createElement("table")
    const thead = document.createElement("thead")
    const headRow = el("tr")
    const filterRow = el("tr", "filter-row")
    const ths = {}
    for (const col of columns) {
      const th = document.createElement("th")
      th.textContent = col.label
      if (col.right) th.classList.add("right")
      if (col.sortable !== false) {
        th.classList.add("sortable")
        th.addEventListener("click", () => {
          if (sortKey === col.key) sortDir = -sortDir
          else {
            sortKey = col.key
            sortDir = 1
          }
          render()
        })
      }
      ths[col.key] = th
      headRow.append(th)
      const fh = document.createElement("th")
      if (col.filter !== false) {
        const input = el("input")
        input.placeholder = "filter"
        input.addEventListener("input", () => {
          filters[col.key] = input.value.trim().toLowerCase()
          render()
        })
        fh.append(input)
      }
      filterRow.append(fh)
    }
    thead.append(headRow, filterRow)
    const tbody = document.createElement("tbody")
    table.append(thead, tbody)
    wrap.append(table)

    const text = (col, value) => String(col.text?.(value) ?? value[col.key] ?? "")
    const rank = (col, value) => {
      const raw = col.sortValue ? col.sortValue(value) : text(col, value)
      const num = Number(raw)
      return raw === "" || !Number.isFinite(num) ? String(raw) : num
    }

    function visible() {
      let out = rows.slice()
      if (query) out = out.filter((value) => columns.some((col) => text(col, value).toLowerCase().includes(query)))
      for (const col of columns) {
        const needle = filters[col.key]
        if (needle) out = out.filter((value) => text(col, value).toLowerCase().includes(needle))
      }
      if (sortKey) {
        const col = columns.find((candidate) => candidate.key === sortKey)
        out.sort((a, b) => {
          const left = rank(col, a)
          const right = rank(col, b)
          const cmp = typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right))
          return cmp * sortDir
        })
      }
      return out
    }

    function render() {
      for (const [key, th] of Object.entries(ths)) {
        th.classList.toggle("sort-asc", sortKey === key && sortDir === 1)
        th.classList.toggle("sort-desc", sortKey === key && sortDir === -1)
      }
      tbody.replaceChildren()
      const list = visible()
      if (list.length === 0) {
        const tr = el("tr")
        const td = document.createElement("td")
        td.colSpan = columns.length
        td.className = "empty"
        td.textContent = "No rows"
        tr.append(td)
        tbody.append(tr)
        return
      }
      for (const value of list) {
        const tr = el("tr", expand ? "expandable" : null)
        for (const col of columns) {
          const td = document.createElement("td")
          if (col.right) td.classList.add("right")
          const cell = col.render ? col.render(value) : text(col, value)
          if (cell instanceof Node) td.append(cell)
          else td.textContent = cell
          tr.append(td)
        }
        if (expand) {
          let detail = null
          tr.addEventListener("click", () => {
            if (detail) {
              detail.remove()
              detail = null
              return
            }
            detail = el("tr", "detail")
            const td = document.createElement("td")
            td.colSpan = columns.length
            td.append(expand(value))
            detail.append(td)
            tr.after(detail)
          })
        }
        tbody.append(tr)
      }
    }

    render()
    return {
      element: wrap,
      setRows(next) {
        rows = next
        render()
      },
    }
  }

  // ---- the consumption chart --------------------------------------------

  function metricValue(bucket) {
    if (trendMetric === "spendUsd") return bucket.spendUsd
    if (trendMetric === "turns") return bucket.turns
    return bucket.inputTokens + bucket.outputTokens + bucket.cacheReadTokens + bucket.cacheWriteTokens
  }

  /** One bar per period, hover for the exact figure. */
  function barChart(buckets) {
    const format = trendMetric === "spendUsd" ? dollars : short
    const chart = el("div", "chart")
    const values = buckets.map(metricValue)
    const max = Math.max(...values, 1e-12)
    buckets.forEach((bucket, index) => {
      const col = el("div", "chart-col")
      const tip = el(
        "div",
        "chart-tip",
        `${at(bucket.at)} · ${format(values[index])} · ${short(bucket.turns)} turns`,
      )
      const bar = el("div", "chart-bar")
      bar.style.height = `${Math.max(1.5, (values[index] / max) * 100)}%`
      col.append(tip, bar)
      chart.append(col)
    })
    return chart
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
    if (compaction.breakEvenTurns != null) root.append(row("break-even", `${compaction.breakEvenTurns} turns`))
    if (compaction.perTurnSavings != null) root.append(row("per turn saved", dollars(compaction.perTurnSavings)))
    if (compaction.worthIt != null) root.append(row("worth it", compaction.worthIt ? "yes" : "no"))
  }

  function renderChart() {
    const root = document.getElementById("chart")
    root.replaceChildren()
    const data = trendBucket === "hour" ? trendsCache.hour : trendsCache.day
    const buckets = data.buckets ?? []
    for (const button of document.querySelectorAll("#trend-metric button")) {
      button.setAttribute("aria-pressed", String(button.dataset.metric === trendMetric))
    }
    for (const button of document.querySelectorAll("#trend-bucket button")) {
      button.setAttribute("aria-pressed", String(button.dataset.bucket === trendBucket))
    }
    if (buckets.length === 0) {
      root.append(el("p", "empty", "No consumption in this window."))
      return
    }
    root.append(barChart(buckets))
    const format = trendMetric === "spendUsd" ? dollars : short
    const peak = Math.max(...buckets.map(metricValue))
    const axis = el("div", "chart-axis")
    axis.append(el("span", null, at(buckets[0].at)))
    axis.append(el("span", null, `peak ${format(peak)}`))
    axis.append(el("span", null, at(buckets[buckets.length - 1].at)))
    root.append(axis)
  }

  // ---- the tables -------------------------------------------------------

  const plansTable = dataTable({
    placeholder: "Search plans…",
    columns: [
      { key: "name", label: "Plan", text: (p) => p.name },
      { key: "type", label: "Type", text: (p) => p.type },
      { key: "vendor", label: "Vendor", text: (p) => p.vendor },
      { key: "priceUsd", label: "Price", right: true, text: (p) => (p.priceUsd != null ? `$${p.priceUsd}/mo` : "—") },
      { key: "used", label: "Used", right: true, text: (p) => (p.burn ? short(p.burn.used) : "") },
      { key: "allowance", label: "Allowance", right: true, text: (p) => (p.burn && p.burn.allowance != null ? short(p.burn.allowance) : "") },
      {
        key: "left",
        label: "Left",
        right: true,
        text: (p) => (p.burn && p.burn.daysLeft != null ? `${Math.round(p.burn.daysLeft)}d` : ""),
      },
      {
        key: "burn",
        label: "Burn",
        text: (p) =>
          p.burn && p.burn.allowance != null ? `${Math.round((p.burn.used / p.burn.allowance) * 100)}%` : "no burn published",
        sortValue: (p) => (p.burn && p.burn.allowance ? p.burn.used / p.burn.allowance : -1),
        render: (p) => {
          if (!p.burn || p.burn.allowance == null) return el("span", "muted", p.allowanceNote ?? "no burn published")
          const box = el("div")
          const pct = Math.min(100, Math.round((p.burn.used / p.burn.allowance) * 100))
          const bar = el("div", "bar")
          const fill = el("span")
          fill.style.width = `${pct}%`
          bar.append(fill)
          box.append(bar, el("span", "muted", `${pct}%`))
          return box
        },
      },
    ],
  })

  const modelsTable = dataTable({
    placeholder: "Search models…",
    columns: [
      { key: "model", label: "Model", text: (m) => `${m.providerID}/${m.modelID}` },
      { key: "local", label: "Local", text: (m) => (m.local ? "yes" : "no") },
      {
        key: "unit",
        label: "Unit price",
        right: true,
        text: (m) => (m.unitPrice ? perM(m.unitPrice.usdPerMTok) : "—"),
        sortValue: (m) => m.unitPrice?.usdPerMTok ?? -1,
      },
      { key: "basis", label: "Basis", text: (m) => m.unitPrice?.basis ?? "" },
      { key: "input", label: "In", right: true, text: (m) => perM(m.cost?.[0]?.input) },
      { key: "output", label: "Out", right: true, text: (m) => perM(m.cost?.[0]?.output) },
      { key: "read", label: "Cache read", right: true, text: (m) => perM(m.cost?.[0]?.cache?.read) },
      { key: "write", label: "Cache write", right: true, text: (m) => perM(m.cost?.[0]?.cache?.write) },
      { key: "source", label: "Source", text: (m) => m.costSource ?? "" },
    ],
  })

  const trendsTable = dataTable({
    placeholder: "Search periods…",
    columns: [
      { key: "at", label: "Period", text: (b) => at(b.at) },
      { key: "turns", label: "Turns", right: true, text: (b) => String(b.turns) },
      { key: "inputTokens", label: "Input", right: true, text: (b) => short(b.inputTokens) },
      { key: "outputTokens", label: "Output", right: true, text: (b) => short(b.outputTokens) },
      { key: "cacheReadTokens", label: "Cache read", right: true, text: (b) => short(b.cacheReadTokens) },
      { key: "cacheWriteTokens", label: "Cache write", right: true, text: (b) => short(b.cacheWriteTokens) },
      { key: "spendUsd", label: "Spend", right: true, text: (b) => dollars(b.spendUsd), sortValue: (b) => b.spendUsd },
    ],
  })

  const decisionsTable = dataTable({
    placeholder: "Search decisions…",
    expand: (d) => {
      const box = el("div")
      box.append(row("reason", d.reason || "—", true))
      box.append(row("source", [d.source, d.stage].filter(Boolean).join(" · ") || "—"))
      box.append(row("policy", d.policy || "—"))
      box.append(row("complexity", d.complexity ? String(d.complexity) : "—"))
      if (d.applied) box.append(row("applied", d.applied))
      if (d.error) box.append(row("error", d.error))
      box.append(row("session", d.session || "—"))
      return box
    },
    columns: [
      { key: "ts", label: "When", text: (d) => when(d.ts), sortValue: (d) => d.ts },
      { key: "chosen", label: "Model", text: (d) => d.chosen || "?" },
      { key: "turnClass", label: "Class", text: (d) => d.turnClass || "—" },
      { key: "reason", label: "Reason", text: (d) => d.reason || "" },
    ],
  })

  document.getElementById("plans").append(plansTable.element)
  document.getElementById("models").append(modelsTable.element)
  document.getElementById("trends").append(trendsTable.element)
  document.getElementById("decisions").append(decisionsTable.element)

  // ---- data loop --------------------------------------------------------

  async function json(route) {
    const response = await fetch(route)
    if (!response.ok) throw new Error(`${route} → ${response.status}`)
    return response.json()
  }

  async function refresh() {
    try {
      const q = `scope=${scope}`
      const [summary, models, plans, day, hour, decisions] = await Promise.all([
        json(`/api/summary.json?${q}`),
        json(`/api/models.json?${q}`),
        json(`/api/plans.json`),
        json(`/api/trends.json?${q}&days=30`),
        json(`/api/trends.json?${q}&bucket=hour`),
        json(`/api/decisions.json?${q}`),
      ])
      renderHeader(summary)
      plansTable.setRows(plans.plans ?? [])
      modelsTable.setRows(models.models ?? [])
      trendsCache = { day, hour }
      renderChart()
      trendsTable.setRows((trendBucket === "hour" ? hour : day).buckets ?? [])
      decisionsTable.setRows(decisions.items ?? [])
      renderCompaction(summary.compaction)
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
  for (const button of document.querySelectorAll("#trend-metric button")) {
    button.addEventListener("click", () => {
      trendMetric = button.dataset.metric
      renderChart()
    })
  }
  for (const button of document.querySelectorAll("#trend-bucket button")) {
    button.addEventListener("click", () => {
      trendBucket = button.dataset.bucket
      renderChart()
      trendsTable.setRows((trendBucket === "hour" ? trendsCache.hour : trendsCache.day).buckets ?? [])
    })
  }

  refresh()
  setInterval(refresh, POLL_MS)
})()

/**
 * The dashboard page. Vanilla JS over the JSON API: tables with sorting and
 * header filters (a funnel per column, no permanent chrome), consumption
 * bars with hover figures in the DeepSeek-dashboard habit, and decisions
 * that expand to their reason. Every value is rendered with `textContent`,
 * so nothing from state can become markup. The scope switcher refetches;
 * the rest is a ~10s poll.
 */
(() => {
  const POLL_MS = 10000
  let scope = "all"
  let trendMetric = "spendUsd"
  let trendBucket = "day"
  let metricChosen = false
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

  const SVG_NS = "http://www.w3.org/2000/svg"

  /** A tiny funnel glyph: the column filter, visible on hover. */
  function funnelIcon() {
    const svg = document.createElementNS(SVG_NS, "svg")
    svg.setAttribute("viewBox", "0 0 16 16")
    svg.setAttribute("class", "funnel")
    const path = document.createElementNS(SVG_NS, "path")
    path.setAttribute("d", "M2 3h12l-4.5 5.5V13L6.5 11.5V8.5z")
    svg.append(path)
    return svg
  }

  // ---- the table engine -------------------------------------------------

  /**
   * A data table with sortable columns and one search box. Column filters
   * live in the headers: hover reveals a funnel, clicking opens a small
   * panel with the column's distinct values (toggleable) and a needle. No
   * permanent filter chrome. With `expand`, rows are clickable and open a
   * detail panel beneath them. Sorting and filtering survive `setRows`, so
   * the poll does not disturb what the reader arranged.
   */
  function dataTable({ columns, rows = [], expand = null, rowKey = null, placeholder = "Search…" }) {
    let sortKey = null
    let sortDir = 1
    let query = ""
    let open = null
    const filters = {}

    const text = (col, value) => String(col.text?.(value) ?? value[col.key] ?? "")
    const keyOf = (value) => String(rowKey ? rowKey(value) : JSON.stringify(value))
    const filterOf = (key) => (filters[key] ??= { needle: "", picked: new Set() })
    const filterActive = (key) => {
      const f = filters[key]
      return Boolean(f && (f.needle || f.picked.size > 0))
    }

    const wrap = el("div", "table-wrap")
    const tools = el("div", "table-tools")
    const search = el("input")
    search.type = "search"
    search.placeholder = placeholder
    search.addEventListener("input", () => {
      query = search.value.trim().toLowerCase()
      render()
    })
    // Sorting and filtering exist but nothing said so; this line is the map.
    tools.append(search, el("p", "hint", "Click a header to sort · hover it for the column filter"))
    wrap.append(tools)

    const table = document.createElement("table")
    const thead = document.createElement("thead")
    const headRow = el("tr")
    const ths = {}
    for (const col of columns) {
      const th = document.createElement("th")
      th.append(el("span", "th-label", col.label))
      ths[col.key] = th
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
      if (col.filter !== false) {
        const button = el("button", "funnel-btn")
        button.type = "button"
        button.title = `Filter ${col.label}`
        button.append(funnelIcon())
        button.addEventListener("click", (event) => {
          event.stopPropagation()
          openFilter(col, th)
        })
        // Filter goes left of the label; the sort arrow trails it on the
        // right (the `::after` on the header).
        th.prepend(button)
      }
      headRow.append(th)
    }
    thead.append(headRow)
    const tbody = document.createElement("tbody")
    table.append(thead, tbody)
    wrap.append(table)

    // ---- header filter panels -------------------------------------------

    let panel = null
    function closePanel() {
      if (panel) {
        panel.remove()
        panel = null
      }
    }
    document.addEventListener("click", (event) => {
      if (panel && !panel.contains(event.target)) closePanel()
    })
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closePanel()
    })

    function openFilter(col, th) {
      const wasOpen = panel?.dataset?.key === col.key
      closePanel()
      if (wasOpen) return
      const state = filterOf(col.key)
      const rect = th.getBoundingClientRect()
      const box = el("div", "col-popover")
      box.dataset.key = col.key
      box.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 250))}px`
      box.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - 220)}px`

      const input = el("input")
      input.type = "search"
      input.placeholder = `Filter ${col.label.toLowerCase()}…`
      input.value = state.needle
      input.addEventListener("input", () => {
        state.needle = input.value.trim().toLowerCase()
        render()
      })
      box.append(input)

      const values = [...new Set(rows.map((value) => text(col, value)))].filter(Boolean).sort()
      for (const value of values.slice(0, 12)) {
        const chip = el("button", "chip", value)
        chip.type = "button"
        chip.setAttribute("aria-pressed", String(state.picked.has(value)))
        chip.addEventListener("click", () => {
          if (state.picked.has(value)) state.picked.delete(value)
          else state.picked.add(value)
          chip.setAttribute("aria-pressed", String(state.picked.has(value)))
          render()
        })
        box.append(chip)
      }
      if (values.length > 12) box.append(el("p", "note", `+${values.length - 12} more — use the search above`))

      const clear = el("button", "chip clear", "Clear")
      clear.type = "button"
      clear.addEventListener("click", () => {
        state.needle = ""
        state.picked.clear()
        closePanel()
        render()
      })
      box.append(clear)

      document.body.append(box)
      panel = box
      input.focus()
    }

    // ---- rows ------------------------------------------------------------

    const rank = (col, value) => {
      const raw = col.sortValue ? col.sortValue(value) : text(col, value)
      const num = Number(raw)
      return raw === "" || !Number.isFinite(num) ? String(raw) : num
    }

    function visible() {
      let out = rows.slice()
      if (query) out = out.filter((value) => columns.some((col) => text(col, value).toLowerCase().includes(query)))
      for (const col of columns) {
        const f = filters[col.key]
        if (!f) continue
        out = out.filter((value) => {
          const cell = text(col, value)
          if (f.picked.size > 0 && !f.picked.has(cell)) return false
          if (f.needle && !cell.toLowerCase().includes(f.needle)) return false
          return true
        })
      }
      if (sortKey) {
        const col = columns.find((candidate) => candidate.key === sortKey)
        out.sort((a, b) => {
          const left = rank(col, a)
          const right = rank(col, b)
          const cmp =
            typeof left === "number" && typeof right === "number"
              ? left - right
              : String(left).localeCompare(String(right))
          return cmp * sortDir
        })
      }
      return out
    }

    function render(reopenKey = null) {
      open = null
      for (const [key, th] of Object.entries(ths)) {
        th.classList.toggle("sort-asc", sortKey === key && sortDir === 1)
        th.classList.toggle("sort-desc", sortKey === key && sortDir === -1)
        th.classList.toggle("filtering", filterActive(key))
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
        columns.forEach((col, index) => {
          const td = document.createElement("td")
          if (col.right) td.classList.add("right")
          if (expand && index === 0) td.append(el("span", "chevron", "▸"))
          const cell = col.render ? col.render(value) : text(col, value)
          if (cell instanceof Node) td.append(cell)
          else td.append(document.createTextNode(cell))
          tr.append(td)
        })
        if (expand) {
          const key = keyOf(value)
          const toggle = () => {
            if (open?.key === key) {
              open.detail.remove()
              open.tr.classList.remove("open")
              open = null
              return
            }
            if (open) {
              open.detail.remove()
              open.tr.classList.remove("open")
            }
            const detail = el("tr", "detail")
            const td = document.createElement("td")
            td.colSpan = columns.length
            td.append(expand(value))
            detail.append(td)
            tr.after(detail)
            tr.classList.add("open")
            open = { key, tr, detail }
          }
          tr.addEventListener("click", toggle)
          // The poll re-renders this body every few seconds; whatever the
          // reader had open reopens instead of closing on them.
          if (reopenKey != null && key === reopenKey) toggle()
        }
        tbody.append(tr)
      }
    }

    render()
    return {
      element: wrap,
      setRows(next) {
        const reopen = open?.key ?? null
        rows = next
        render(reopen)
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
      { key: "priceUsd", label: "Price", right: true, text: (p) => (p.priceUsd != null ? `$${p.priceUsd}/mo` : "—"), sortValue: (p) => p.priceUsd ?? -1 },
      { key: "used", label: "Used", right: true, text: (p) => (p.burn ? short(p.burn.used) : ""), sortValue: (p) => p.burn?.used ?? -1 },
      {
        key: "allowance",
        label: "Allowance",
        right: true,
        text: (p) => (p.burn && p.burn.allowance != null ? short(p.burn.allowance) : ""),
        sortValue: (p) => p.burn?.allowance ?? -1,
      },
      {
        key: "left",
        label: "Left",
        right: true,
        text: (p) => (p.burn && p.burn.daysLeft != null ? `${Math.round(p.burn.daysLeft)}d` : ""),
        sortValue: (p) => p.burn?.daysLeft ?? -1,
      },
      {
        key: "burn",
        label: "Burn",
        text: (p) =>
          p.burn && p.burn.allowance != null
            ? `${Math.round((p.burn.used / p.burn.allowance) * 100)}%`
            : "no burn published",
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
      { key: "input", label: "In", right: true, text: (m) => perM(m.cost?.[0]?.input), sortValue: (m) => m.cost?.[0]?.input ?? -1 },
      { key: "output", label: "Out", right: true, text: (m) => perM(m.cost?.[0]?.output), sortValue: (m) => m.cost?.[0]?.output ?? -1 },
      { key: "read", label: "Cache read", right: true, text: (m) => perM(m.cost?.[0]?.cache?.read), sortValue: (m) => m.cost?.[0]?.cache?.read ?? -1 },
      { key: "write", label: "Cache write", right: true, text: (m) => perM(m.cost?.[0]?.cache?.write), sortValue: (m) => m.cost?.[0]?.cache?.write ?? -1 },
      { key: "source", label: "Source", text: (m) => m.costSource ?? "" },
    ],
  })

  const trendsTable = dataTable({
    placeholder: "Search periods…",
    columns: [
      { key: "at", label: "Period", text: (b) => at(b.at) },
      { key: "turns", label: "Turns", right: true, text: (b) => String(b.turns), sortValue: (b) => b.turns },
      { key: "inputTokens", label: "Input", right: true, text: (b) => short(b.inputTokens), sortValue: (b) => b.inputTokens },
      { key: "outputTokens", label: "Output", right: true, text: (b) => short(b.outputTokens), sortValue: (b) => b.outputTokens },
      { key: "cacheReadTokens", label: "Cache read", right: true, text: (b) => short(b.cacheReadTokens), sortValue: (b) => b.cacheReadTokens },
      { key: "cacheWriteTokens", label: "Cache write", right: true, text: (b) => short(b.cacheWriteTokens), sortValue: (b) => b.cacheWriteTokens },
      { key: "spendUsd", label: "Spend", right: true, text: (b) => dollars(b.spendUsd), sortValue: (b) => b.spendUsd },
    ],
  })

  const decisionsTable = dataTable({
    placeholder: "Search decisions…",
    rowKey: (d) => `${d.ts}|${d.chosen}|${d.source}`,
    expand: (d) => {
      const box = el("div", "detail-box")
      box.append(el("p", "detail-reason", d.reason || "no reason recorded"))
      const grid = el("div", "detail-grid")
      const add = (key, value) => {
        grid.append(el("span", "k", key), el("span", "v", value))
      }
      add("source", [d.source, d.stage].filter(Boolean).join(" · ") || "—")
      add("policy", d.policy || "—")
      add("complexity", d.complexity ? String(d.complexity) : "—")
      if (d.applied) add("applied", d.applied)
      if (d.error) add("error", d.error)
      add("session", d.session || "—")
      box.append(grid)
      return box
    },
    columns: [
      { key: "ts", label: "When", text: (d) => when(d.ts), sortValue: (d) => d.ts },
      { key: "chosen", label: "Model", text: (d) => d.chosen || "?" },
      { key: "turnClass", label: "Class", text: (d) => d.turnClass || "—" },
      { key: "reason", label: "Reason", text: (d) => d.reason || "" },
      { key: "source", label: "Source", text: (d) => d.source || "—" },
      { key: "policy", label: "Policy", text: (d) => d.policy || "—" },
      {
        key: "complexity",
        label: "Complexity",
        right: true,
        text: (d) => (d.complexity ? String(d.complexity) : "—"),
        sortValue: (d) => d.complexity || -1,
      },
      { key: "applied", label: "Applied", text: (d) => d.applied || "—" },
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
      // On free/local plans spend is genuinely zero; a flat spend chart says
      // nothing. Pick the first metric that carries data — once, at start —
      // and leave the reader's own choice alone afterwards.
      if (!metricChosen) {
        const buckets = day.buckets ?? []
        const spend = buckets.reduce((sum, b) => sum + b.spendUsd, 0)
        const tokens = buckets.reduce((sum, b) => sum + b.inputTokens + b.outputTokens + b.cacheReadTokens + b.cacheWriteTokens, 0)
        if (spend === 0 && tokens > 0) trendMetric = "tokens"
        metricChosen = true
      }
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

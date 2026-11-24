/**
 * Sidebar block registration for TUI hosts.
 *
 * The renderable layer needs OpenTUI core, which the host provides at
 * runtime. It is imported lazily — never at module load — so tests, the CLI,
 * and non-TUI hosts run this package with zero external dependencies, and
 * the sidebar is skipped entirely where OpenTUI is absent.
 *
 * The block's shape is the plain markdown-ish structure a reader expects:
 * a bold title, then `* item` lines. `compute` returns that shape; the
 * conversion to styled text is the only part that touches OpenTUI.
 */

/**
 * The block's text, pure: a bold title line and `• item` bullets. Exported
 * so the layout is testable without OpenTUI.
 */
export function blockContent({ title, items } = {}) {
  return {
    title: String(title ?? ""),
    body: (Array.isArray(items) ? items : []).map((item) => `• ${item}`).join("\n"),
  }
}

/**
 * The bold attribute bit in OpenTUI text options — the same value core's
 * `bold()` chunk helper sets.
 */
export const BOLD = 1

/**
 * Load the host's OpenTUI core, or null where there is none. Inject `core`
 * to test with fakes or to build against a known instance.
 */
export async function loadCore(injected = undefined) {
  if (injected !== undefined) return injected
  try {
    return await import("@opentui/core")
  } catch {
    return null
  }
}

/**
 * Register one sidebar block — a bold title renderable and a bullets
 * renderable, refreshed from `compute()` on `refreshOn` events. Returns a
 * disposer, or null when the host has no slot API or OpenTUI is unavailable.
 * Every early exit reports why through `onSkip`, so a missing block is
 * always explainable.
 *
 * Two plain text renderables, not one styled text: every primitive here is
 * one the host demonstrably renders, and a title without bold still reads
 * as a title. `compute` runs again on every refresh and must be cheap; its
 * failure keeps the previous content.
 */
export async function registerSidebarBlock(
  context,
  {
    slot = "sidebar.content",
    compute,
    refreshOn = ["session.execution.succeeded", "session.model.selected"],
    onSkip = () => {},
    core: injectedCore = undefined,
  } = {},
) {
  if (typeof context?.ui?.slot !== "function" || typeof compute !== "function") {
    onSkip("host has no slot API")
    return null
  }
  const core = await loadCore(injectedCore)
  if (!core?.TextRenderable || !core?.BoxRenderable) {
    onSkip("OpenTUI core unavailable")
    return null
  }
  const renderer = context.renderer
  if (!renderer) {
    onSkip("host gave no renderer")
    return null
  }

  const read = () => {
    try {
      return blockContent(compute())
    } catch {
      return null
    }
  }

  // Construction failures return null instead of rejecting: the caller's
  // `void ... .then(...)` would swallow a rejection and the block would
  // silently vanish. One guard around the whole renderable build.
  let title
  let body
  let box
  try {
    // A compute failure on the first build still yields a visible block:
    // an empty one would look exactly like a missing one.
    const first = read() ?? { title: "", body: "• state unavailable" }
    title = new core.TextRenderable(renderer, {
      content: first.title,
      attributes: BOLD,
      wrapMode: "none",
      truncate: true,
    })
    body = new core.TextRenderable(renderer, {
      content: first.body,
      wrapMode: "none",
      truncate: true,
    })
    box = new core.BoxRenderable(renderer, { flexDirection: "column", width: "100%" })
    box.add(title)
    box.add(body)
  } catch (error) {
    onSkip(`renderable build failed: ${error?.message ?? error}`)
    return null
  }

  const refresh = () => {
    const next = read()
    if (next == null) return
    title.content = next.title
    body.content = next.body
  }

  const registration = context.ui.slot({ append: slot, render: () => box })

  const stops = []
  if (typeof context.data?.on === "function") {
    for (const type of refreshOn) {
      const stop = context.data.on(type, refresh)
      if (typeof stop === "function") stops.push(stop)
      else if (stop && typeof stop.dispose === "function") stops.push(() => stop.dispose())
    }
  }

  return () => {
    for (const stop of stops) {
      try {
        stop()
      } catch {
        // Cleanup must not mask unload.
      }
    }
    try {
      if (typeof registration === "function") registration()
      else registration?.dispose?.()
    } catch {
      // Cleanup must not mask unload.
    }
  }
}

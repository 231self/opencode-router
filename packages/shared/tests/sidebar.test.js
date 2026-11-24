import { expect, test } from "bun:test"

import { BOLD, blockContent, loadCore, registerSidebarBlock } from "../src/sidebar.js"

/** A fake OpenTUI core: enough shape to test construction and refresh. */
function fakeCore() {
  class TextRenderable {
    constructor(ctx, options) {
      this.ctx = ctx
      this.options = options
      this.content = options?.content ?? ""
    }
  }
  class BoxRenderable {
    constructor(ctx, options) {
      this.ctx = ctx
      this.options = options
      this.children = []
    }
    add(child) {
      this.children.push(child)
      return this.children.length
    }
  }
  return { TextRenderable, BoxRenderable }
}

function fakeContext() {
  const slots = []
  const listeners = new Map()
  return {
    slots,
    listeners,
    renderer: { name: "fake-renderer" },
    ui: { slot: (input) => (slots.push(input), () => slots.splice(slots.indexOf(input), 1)) },
    data: {
      on: (type, handler) => {
        listeners.set(type, handler)
        return () => listeners.delete(type)
      },
    },
    fire(type) {
      listeners.get(type)?.()
    },
  }
}

test("a block is a title and star bullets", () => {
  const { title, body } = blockContent({
    title: "Router",
    items: ["router on · policy cost", "pin auto"],
  })
  expect(title).toBe("Router")
  expect(body).toBe("• router on · policy cost\n• pin auto")
  // No items: body empty, no dangling blank bullet list.
  expect(blockContent({ title: "Context", items: [] }).body).toBe("")
})

test("the block is a bold title renderable and a bullets renderable", async () => {
  const context = fakeContext()
  const dispose = await registerSidebarBlock(context, {
    compute: () => ({ title: "Context", items: ["ctx 500K/1.0M · 52% free"] }),
    core: fakeCore(),
  })
  const box = context.slots[0].render()
  expect(box.children).toHaveLength(2)
  const [title, body] = box.children
  expect(title.content).toBe("Context")
  expect(title.options.attributes).toBe(BOLD)
  expect(body.content).toBe("• ctx 500K/1.0M · 52% free")
  dispose()
})

test("without OpenTUI or a slot API the sidebar is skipped, not broken", async () => {
  expect(await registerSidebarBlock({}, { compute: () => ({ title: "x", items: [] }) })).toBeNull()
  const noSlot = { renderer: {}, ui: {} }
  expect(await registerSidebarBlock(noSlot, { compute: () => ({ title: "x", items: [] }) })).toBeNull()
  // A missing core (import fails, injected null) skips cleanly.
  const context = fakeContext()
  expect(await registerSidebarBlock(context, { compute: () => ({ title: "x", items: [] }), core: null })).toBeNull()
  expect(context.slots).toHaveLength(0)
})

test("the block refreshes on events and cleans up on dispose", async () => {
  const context = fakeContext()
  let value = { title: "Router", items: ["first"] }
  const dispose = await registerSidebarBlock(context, {
    compute: () => value,
    core: fakeCore(),
  })
  expect(typeof dispose).toBe("function")
  expect(context.slots).toHaveLength(1)
  expect(context.slots[0].append).toBe("sidebar.content")

  const box = context.slots[0].render()
  expect(box.children[0].content).toBe("Router")
  expect(box.children[1].content).toBe("• first")

  value = { title: "Router", items: ["updated"] }
  context.fire("session.execution.succeeded")
  expect(box.children[1].content).toBe("• updated")

  dispose()
  expect(context.slots).toHaveLength(0)
  expect(context.listeners.size).toBe(0)
})

test("a failing refresh keeps the previous content", async () => {
  const context = fakeContext()
  let fail = false
  const dispose = await registerSidebarBlock(context, {
    compute: () => {
      if (fail) throw new Error("boom")
      return { title: "Context", items: ["good"] }
    },
    core: fakeCore(),
  })
  const box = context.slots[0].render()
  fail = true
  context.fire("session.execution.succeeded")
  expect(box.children[1].content).toBe("• good")
  dispose()
})

test("loadCore returns the injected core unchanged", async () => {
  const core = fakeCore()
  expect(await loadCore(core)).toBe(core)
})

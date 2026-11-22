/**
 * Popup layout for the router's reports.
 *
 * Dialogs are plain text, so readability comes from layout: section titles,
 * an aligned label column, and values wrapped under a hanging indent. Lines
 * never run past {@link WIDTH}; `·` survives only as the separator between the
 * short fragments of one fact, and wrapping prefers those fragments so a
 * fact's value breaks between fragments rather than mid-name. The output is
 * deterministic and renders identically in the OpenCode TUI, Kilo, and the
 * CLI, which keeps every builder string-testable.
 */

/** Wrap budget for one popup line; dialogs live in ~80-column terminals. */
export const WIDTH = 72

/** Label column for facts with short labels. */
export const LABEL_WIDTH = 12

/** Labels wider than this put their value on the next line instead of pushing the column out. */
export const MAX_LABEL_WIDTH = 32

/** Indent of section bodies. */
export const INDENT = 2

/**
 * Wrap one paragraph to `width` columns.
 *
 * A value is a list of ` · `-separated fragments; the wrap points are the
 * fragment boundaries first, so `blocked deepseek/deepseek-flash (provider)`
 * stays whole, and the spaces inside an over-long fragment only as a last
 * resort. Explicit `\n` in the input start new paragraphs.
 */
export function wrap(text, width = WIDTH) {
  const lines = []
  for (const paragraph of String(text ?? "").split("\n")) {
    const fragments = paragraph.trim() ? paragraph.trim().split(" · ") : []
    if (fragments.length === 0) {
      lines.push("")
      continue
    }
    let line = ""
    for (const fragment of fragments) {
      const candidate = line === "" ? fragment : `${line} · ${fragment}`
      if (candidate.length <= width) {
        line = candidate
        continue
      }
      if (line !== "") {
        lines.push(line)
        line = ""
      }
      for (const word of fragment.split(/\s+/).filter(Boolean)) {
        if (line === "") line = word
        else if (line.length + 1 + word.length <= width) line += ` ${word}`
        else {
          lines.push(line)
          line = word
        }
      }
    }
    if (line !== "") lines.push(line)
  }
  return lines
}

/**
 * Aligned `label  value` rows. The value column follows the widest label in
 * the group (between {@link LABEL_WIDTH} and {@link MAX_LABEL_WIDTH}), and
 * values wrap under a hanging indent aligned with it. A label wider than the
 * column keeps its own line and drops its value below.
 *
 * `entries` are `[label, value]` pairs; a value may be an array of lines
 * (each wrapped on its own, e.g. a usage line followed by its description).
 */
export function facts(
  entries,
  { width = WIDTH, indent = INDENT, minLabel = LABEL_WIDTH, maxLabel = MAX_LABEL_WIDTH } = {},
) {
  const names = entries.map(([label]) => String(label ?? ""))
  const column = Math.min(maxLabel, Math.max(minLabel, ...names.map((name) => name.length)))
  const pad = " ".repeat(indent)
  const valueIndent = " ".repeat(indent + column + 1)
  const valueWidth = Math.max(20, width - indent - column - 1)
  const rows = []
  for (const [label, value] of entries) {
    const name = String(label ?? "")
    const values = wrap(Array.isArray(value) ? value.join("\n") : value, valueWidth)
    if (name.length > column) {
      rows.push(pad + name)
      for (const line of values) rows.push(valueIndent + line)
      continue
    }
    rows.push(pad + name.padEnd(column) + " " + (values[0] ?? ""))
    for (const line of values.slice(1)) rows.push(valueIndent + line)
  }
  return rows
}

/** A titled section: the title on its own line, then its facts. */
export function section(title, entries, options) {
  return [String(title), ...facts(entries, options)]
}

/** An indented, wrapped paragraph: a hint, a note, or a short explanation. */
export function note(text, { width = WIDTH, indent = INDENT } = {}) {
  const pad = " ".repeat(indent)
  return wrap(text, Math.max(20, width - indent)).map((line) => (line === "" ? "" : pad + line))
}

/** Unindented wrapped paragraphs with a blank line between them. */
export function prose(...paragraphs) {
  return join(...paragraphs.map((paragraph) => wrap(paragraph)))
}

/** Count with a pluralised noun: `1 session`, `3 sessions`. */
export function plural(count, word) {
  return `${count} ${word}${Number(count) === 1 ? "" : "s"}`
}

/** Stack blocks (arrays of lines or strings) with a blank line between them. */
export function join(...blocks) {
  return blocks
    .map((block) => (Array.isArray(block) ? block.join("\n") : String(block ?? "")))
    .filter((block) => block !== "")
    .join("\n\n")
}

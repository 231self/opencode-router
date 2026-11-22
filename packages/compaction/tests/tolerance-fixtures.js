/**
 * Synthetic long-context tasks for the tolerance bench. Kept separate from
 * the live runner so tests can check the answer key offline.
 *
 * The reference answer is derived from the same facts the prompts contain, so
 * a typo in a constant cannot silently grade a correct answer wrong. The
 * tolerance tasks' compacted prompts are realistic checkpoints: a summary
 * that keeps what the question needs. The control task drops the evidence on
 * purpose and is excluded from the tolerance summary.
 */

export const FACT_VALUE = (index) => `value-${(index * 7) % 91}`
export const factLine = (index) => `The fact-${index} parameter is set to ${FACT_VALUE(index)}.`

const AUDIT_QUESTION =
  "Based on the parameters above, what are the settings of fact-3, fact-17, and fact-42? Answer briefly."
const AUDIT_INDICES = [3, 17, 42]
const AUDIT_ANSWER = AUDIT_INDICES.map((index) => `fact-${index} is ${FACT_VALUE(index)}`).join(", ")
const PROCEDURE =
  "The deploy procedure: 1) freeze the cache, 2) rotate the token, 3) warm the standby, 4) flip traffic."

export function makeTasks() {
  const facts = Array.from({ length: 60 }, (_, index) => factLine(index))
  return [
    {
      id: "scattered-facts",
      kind: "tolerance",
      intact: [...facts, AUDIT_QUESTION].join("\n"),
      compacted: [
        `[Compacted summary: a parameter audit. Kept details: ${AUDIT_INDICES.map(factLine).join(" ")}]`,
        AUDIT_QUESTION,
      ].join("\n"),
      reference: `${AUDIT_ANSWER}.`,
    },
    {
      id: "procedure-order",
      kind: "tolerance",
      intact: [PROCEDURE, ...facts.slice(0, 20), "In order, what are the four deploy steps?"].join("\n"),
      compacted: [PROCEDURE, "In order, what are the four deploy steps?"].join("\n"),
      reference: "freeze the cache, rotate the token, warm the standby, flip traffic.",
    },
    {
      id: "control-dropped-facts",
      kind: "control",
      intact: [...facts, AUDIT_QUESTION].join("\n"),
      compacted: [
        "[Compacted summary: a long parameter audit was here; the details were not kept.]",
        AUDIT_QUESTION,
      ].join("\n"),
      reference: `${AUDIT_ANSWER}.`,
    },
  ]
}

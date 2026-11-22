# @231self/opencode-compaction

Context management for [OpenCode](https://opencode.ai) and Kilo sessions:
the deterministic context optimiser, a priced "should I compact now?"
advisory, and the plumbing to compact on request. Install it alongside
[`@231self/opencode-router`](https://www.npmjs.com/package/@231self/opencode-router):

```sh
opencode plugin add @231self/opencode-compaction
```

## Why this exists

An agent session's context is sent again on every turn. Providers bill most
of it as cache reads (cheap), so letting context grow feels free — until the
session nears its window and someone summarizes the history. Summarizing
destroys the prompt cache: the next turn re-writes the compacted prefix at
the cache-write price instead of reading the old one at the cache-read
price. Whether compaction pays is arithmetic, and this plugin does the
arithmetic for you before anything is thrown away.

It also knows when *not* to summarize. Compacting in the middle of a
derivation discards partial work — the failure mode the SelfCompact paper
measured. And for review steps, a fresh subagent with no context often
judges work better than a session drowning in it (the Elephant-Goldfish
pattern). The advisory weighs all three: keep, compact, or delegate.

## What you get

**The optimiser.** When a turn's request does not fit the model's budget,
oversized tool outputs are deduplicated, truncated, and stubbed in a fixed
order until it fits. Recent turns, system instructions, and error outputs
are never touched. If nothing can make it fit, the session is left alone and
the host is told to compact. When the request fits, nothing is changed.

**The advisory.** Each turn computes a verdict and stores it with the
session:

- `compact-now` — a sub-task just finished, the context is under pressure,
  and compaction pays for itself within the expected horizon.
- `delegate` — the next step looks like review or verification. Send it to a
  fresh subagent instead.
- `not-yet` — keep working.

The verdict combines three layers: deterministic signals from the message
shape (a tool burst followed by a summary is a sub-task boundary), the
cache economics (break-even turns, per-turn savings), and — only when the
signals are unclear — a small local judge answering a rubric. The verdict
cannot flicker: changes wait out a cooldown that grows with the judge's
measured instability.

**`/ctx`** in the TUI shows the current verdict with its numbers and what to
do about it. **`/ctx here`** asks the host to compact this session; the
request clears itself even if the host refuses. OpenCode already has its own
`/compact`; this plugin leaves that command alone and does not register a
`compact` alias.

## Settings

In `~/.config/omlx-router/config.json`:

```json
{
  "compaction": {
    "enabled": true,
    "expectedTurns": 8,
    "baseCooldown": 3,
    "judgeRefine": true,
    "summaryTokens": 1200
  }
}
```

| Setting | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` turns the advisory off. |
| `expectedTurns` | `8` | Horizon for "does compaction pay?" |
| `baseCooldown` | `3` | Turns a verdict change must wait. |
| `judgeRefine` | `true` | Let the judge resolve unclear cases. |
| `summaryTokens` | `1200` | Assumed size of a compaction summary. |

The file is read as strict JSON, so keep comments out of it.

## Calibration

The judge's compaction verdicts are not perfectly stable. Measure how much
they move and the advisory's cooldown will respect it:

```sh
bun run compaction:calibrate --repeat 3
```

This writes `~/.local/state/omlx-router/compaction-noise.json`. It needs the
local judge running (the same oMLX endpoint the router uses).

Two other research tools:

```sh
bun run compaction:ablation --repeat 3              # fixed vs signal vs hybrid, on fixtures
bun run tolerance:eval --repeat 2 --model my-model  # per-model degradation under compaction
```

The ablation is offline by default; add `--judge` to use the live oMLX judge.
The signal and hybrid arms run the shipped advisory, including the economics
veto and the cooldown. Repeats are real samples. The tolerance bench scores
each model with its full context and with a compacted checkpoint; a
deliberately lossy control task is reported separately so a model is not
punished for refusing to answer from missing evidence.

## Privacy

The advisory works on signals: token counts, message roles, tool names,
growth. Decision state stores numbers and booleans. The judge call is the
one place prompt text is used, and it is never written to logs or state.

## Development

```sh
bun test packages/compaction/tests    # offline suite (judge mocked)
bun run test:rust                     # the optimise core
```

Part of the [opencode-router](https://github.com/231self/opencode-router)
monorepo. Apache-2.0.

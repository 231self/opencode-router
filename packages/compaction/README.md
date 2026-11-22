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

The price uses the host's reported usage, not a fixed guess. The cache hit
rate is the share the provider served from cache over the last five steps on
the current model. An idle gap longer than the provider's cache lifetime is
treated as a cold cache. `/ctx` shows the rate, its source, and the sample
count; the configured `pin.cacheHitRatio` is only the fallback before the
first measurement.

The decision horizon stays `expectedTurns`, but `/ctx` also shows the same
economics at 3, 8, and 15 turns (`horizons`), so you can see where the answer
flips instead of guessing when the session ends.

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
    "summaryTokens": 1200,
    "horizons": [3, 8, 15],
    "cacheWindow": 5
  }
}
```

| Setting | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` turns the advisory off. |
| `expectedTurns` | `8` | Decision horizon for "does compaction pay?" |
| `baseCooldown` | `3` | Turns a verdict change must wait. |
| `judgeRefine` | `true` | Let the judge resolve unclear cases. |
| `summaryTokens` | `1200` | Assumed size of a compaction summary. |
| `horizons` | `[3, 8, 15]` | Turns shown in the `/ctx` projection table. |
| `cacheWindow` | `5` | Provider steps used for the measured hit rate. |
| `cacheTtlMs` | `0` | Global cache lifetime override; `0` uses the provider table. |
| `cacheTtlByProvider` | Anthropic/OpenAI 5 min | Per-provider idle expiry; `0` disables it. |

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

## Current limits

The cache hit rate is measured from provider-reported usage when the host
reports it; until then the configured fallback is used. The compacted size is
still an estimate: `summaryTokens` plus the recent tail. The next improvement
is to measure what OpenCode actually spends to summarize and rebuild the
context, and to replace the assumed summary size with the observed
post-compaction size. `/ctx` records the measured rate and its source so the
difference stays visible.

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

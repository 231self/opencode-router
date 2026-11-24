# AGENTS.md

Guidance for agents working in this repository.

## What this is

`opencode-router` monorepo: OpenCode V2 / Kilo plugins for per-turn model
routing and context management. Three publishable packages in one workspace:

- `packages/shared` → `@231self/opencode-shared` — pricing/measurement
  (`cost.js`, `tokens.js`), host adapters (`config.js`, `state.js`), the Kilo
  shim, model-ref semantics. Zero dependencies; both plugins import it.
- `packages/compaction` → `@231self/opencode-compaction` — the context
  optimiser plugin and its WASM core (`optimise`).
- `packages/router` → `@231self/opencode-router` — the model-selection plugin
  (small oMLX-served judge), CLI, and its WASM core (`route`).

## Hard rules

- **No TypeScript application code.** Host adapters, TUI part, CLI, and tests are
  plain ESM JavaScript with JSDoc where useful. The decision engine is Rust
  compiled to `wasm32-unknown-unknown`.
- **TUI surfaces are plain ESM JavaScript — no JSX/TSX, no `solid-js`.** Menus
  fit 72 columns with an ≤80 regression gate. One narrow exception: the
  sidebar modules (`tui-sidebar.js`) build renderables from `@opentui/core`
  classes behind a lazy import, in plain JS. No other module may import
  OpenTUI, and where the host provides no OpenTUI the sidebar is skipped.
- **The cores are pure.** No I/O, clock, randomness, or imports in any
  `core/`. Timestamps, pool data, pins, settings, and judge verdicts are
  passed in; state is passed back for the adapter to persist.
- **No wasm-bindgen.** The ABIs are explicit: `alloc`, `dealloc`,
  `result_len`, `abi_version` in both crates, plus `route` (router crate) and
  `optimise` (compaction crate).
- **Never log prompt text, messages, tool output, or API keys.** Decision records
  store signals and hashes only. See the design spec §13.
- **No network in tests.** Judge calls are mocked.

## VCS

This is a jj repository colocated with git. Use `jj` for all mutations
(`jj st`, `jj describe -m ...`, `jj new`, `jj bookmark set`, `jj git push`),
never `git commit`/`git checkout`/`git reset`. Bookmark `main` is the release
bookmark. Pass `-m` to every describe/commit; never use interactive flags.

## Build and test

```sh
bun run build:wasm     # both crates -> packages/*/dist/core.wasm
bun test               # whole workspace (adapter + WASM bridges)
bun run test:rust      # cargo test in both crates
bun run check          # fmt + clippy + tests + two wasm size gates + security gate
bun run security       # secret scan of the tree and every published tarball
```

Live-only checks (need oMLX and provider keys): `bun run test:e2e`,
`bun run test:e2e:live`, `bun run judge:calibrate --repeat 3` (writes the
verdict-noise band), `bun run compaction:calibrate --repeat 3` (writes the
compaction-verdict instability band), `bun run routing:eval`,
`bun run quality:eval`.

## Releasing

Publishing happens from CI on a GitHub Release, over npm trusted publishing
(OIDC). Never publish manually and never commit an npm token.

1. Bump the version in the changed package(s): `package.json`, `CHANGELOG.md`
   section, `src/version.js`, and `core/Cargo.toml` + `core/Cargo.lock` for
   the WASM packages. Router only: `tests/status.test.js` and the README
   status line. Packages version independently; the release tag tracks the
   router's version.
2. `bun run check`, commit, push `main`, and wait for `ci` and `security` to
   pass.
3. `jj tag set vX.Y.Z -r main` and `jj git push --tag vX.Y.Z`.
4. Create the GitHub Release with notes extracted from the router changelog
   section. Publishing the release triggers `.github/workflows/release.yml`,
   which re-runs `bun run check`, verifies the tag against `packages/router`,
   and stages every package whose version is not yet on npm
   (`npm stage publish --access public`, dependency order). A red check stops
   it; nothing reaches the registry yet.
5. Approve the staged versions with 2FA: `npm stage list`, then
   `npm stage approve <stage-id>` (or npmjs.com → Staged Packages → Approve)
   — **`@231self/opencode-shared` first**, then its dependents. The first
   publish after creating a trusted-publisher config must be approved within 2
   days or the config expires; re-create it if that happens.

The full runbook, including verification and rollback, is
`docs/releasing.md`.

## Design and docs

The design of record is
`docs/specs/2026-11-15-opencode-omlx-router-design.md`; the compaction
program's design and plans live in `docs/superpowers/`. The READMEs are the
user-facing contract and must stay in sync with behaviour. Update them when
behaviour changes.

Documentation is written for people. The program's final stage is a
documentation pass held to this standard:

- Plain, direct sentences; concrete examples over abstractions; every shown
  command must actually run.
- No AI-office-speak: no "leverage", "seam", "robust", "seamless", "delve",
  "landscape", no "it's not X, it's Y" constructions, no hedging stacks, no
  decorative bullet walls where prose reads better.
- Explain why things are as they are — the same voice as the code comments.
- A cold reader can install and understand the router in five minutes;
  deeper material stays precise and skimmable.

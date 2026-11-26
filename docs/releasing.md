# Building and releasing

## Requirements

| Tool | Version | Why |
|---|---|---|
| Bun | ≥ 1.4 | Workspace install, tests and scripts |
| Rust | stable, 1.98 tested | The two WASM cores |
| `wasm32-unknown-unknown` target | — | Core builds |
| binaryen (`wasm-opt`) | optional | Size optimisation; CI installs it |
| npm trusted publishers | one-time, one per package | OIDC staging from CI: no token, no 2FA prompt |
| `gh` | authenticated | Release/tag |

```sh
rustup target add wasm32-unknown-unknown
```

## Layout

Three publishable packages in one workspace:

| Package | Contents |
|---|---|
| `packages/shared` → `@231self/opencode-shared` | Pricing/measurement (`cost.js`, `tokens.js`), host adapters (`config.js`, `state.js`), Kilo shim, model-ref semantics. No dependencies. |
| `packages/compaction` → `@231self/opencode-compaction` | Context optimiser plugin + its WASM core (`optimise` ABI). Depends on shared. |
| `packages/router` → `@231self/opencode-router` | Model-selection plugin + CLI + its WASM core (`route` ABI). Depends on shared. |

## Build

```sh
bun install                 # workspace links; no external npm dependencies
bun run build:wasm          # both crates -> packages/*/dist/core.wasm
bun test                    # whole workspace (rebuilds wasm first)
bun run test:rust           # cargo test in both crates
bun run check               # fmt + clippy -D warnings + both suites + two size gates + security gate
```

Artifacts per WASM package: `dist/core.wasm` (committed for git installs and
included in npm packs by `prepack`), `src/` (plain ESM, no build step). The
router package additionally ships `bin/omlx-router.mjs` (CLI
`opencode-model-router`, alias `omlx-router`) and `config.example.json`.

`npm pack --dry-run` in each package must list exactly its `files` allowlist;
the security gate enforces this per package.

## Version and changelog

Packages version independently; the release tag tracks the router's version.
Per package:

1. Bump `version` in its `package.json` and `CHANGELOG.md` section
   (`## X.Y.Z — date`), plus `src/version.js` and, for the WASM packages,
   `core/Cargo.toml` + `core/Cargo.lock`.
2. Router only: `packages/router/tests/status.test.js` and the README status
   line.
3. Workspace siblings that depend on the bumped package should widen their
   `dependencies` range if needed.
4. `bun run check`, then the live checks (`bun run test:e2e`,
   `bun run judge:calibrate`, `bun run routing:eval -- --runs 3`,
   `bun run test:e2e:live`) as usual.
5. `jj describe -m "release: v<router-version>"`, `jj new`.

## Publish to npm (staged, then approved)

Publishing is **staged**: `.github/workflows/release.yml` runs when a GitHub
Release is published, re-validates everything (`bun run check`), verifies the
tag against `packages/router`, and stages every package whose version is not
yet on npm — in dependency order (`shared` → `compaction` → `router`) — via
`npm stage publish --access public` over npm trusted publishing (OIDC). There
is no `NPM_TOKEN` and no access token. Nothing is public until a maintainer
approves the staged versions with 2FA.

Per package, on npmjs.com: publishing access "Require two-factor
authentication and disallow bypass 2FA tokens", and in the Trusted Publisher
section leave **Allow npm publish** unchecked — CI only needs staged
permission. One-time setup per package: Settings → Trusted Publisher →
GitHub Actions → owner `231self`, repository `opencode-router`, workflow
`release.yml` — spelling and case must match exactly. The repository must stay
public (provenance requirement).

The first successful publish must happen within **two days** of creating each
trusted publisher or the configuration expires; approve promptly after a
release that introduces a new package.

Review and approve the staged versions — **shared first** (its dependents
reference it in their published manifests), then compaction, then router:

```sh
npm stage list                              # staged versions you can see
npm stage view <stage-id>                   # metadata before you approve
npm stage download <stage-id>               # inspect the tarball
npm stage approve <stage-id>                # 2FA prompt; publishes it
```

Or open npmjs.com → Staged Packages and approve there (same 2FA challenge).
Staged publishing requires npm CLI ≥ 11.15; the workflow pins a newer one.

To approve all three in order without babysitting npm's automated review
(which answers `E409` for the first few minutes after staging), pass the
ids to the helper — it waits and retries, and stops on any other failure:

```sh
scripts/approve-staged.sh <shared-id> <compaction-id> <router-id>
```

Verify after approving:

```sh
npm view @231self/opencode-shared version
npm view @231self/opencode-compaction version
npm view @231self/opencode-router version
```

Fallback if trusted publishing is unavailable: add an `NPM_TOKEN` secret (an
automation token) and set `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` on the
staging step. This reintroduces a long-lived credential; prefer OIDC.

## Tag and GitHub release

This is the release: publishing the GitHub Release triggers the staging run.

```sh
VERSION=$(node -p 'require("./packages/router/package.json").version')

jj bookmark set main -r @-
jj git push -b main
jj tag set "v$VERSION" -r main
jj git push --tag "v$VERSION"

sed -n "/^## $VERSION /,/^## /p" packages/router/CHANGELOG.md | sed '1d;$d' > /tmp/notes.md
gh release create "v$VERSION" --title "v$VERSION" --notes-file /tmp/notes.md
```

Publishing the release **stages** the packages; nothing is public until you
approve them with 2FA (see "Publish to npm" above). `ci.yml` should be green
on the tagged commit first, and the `release` workflow re-runs all of it
before staging: a red check stops the release. Prereleases never stage
(`release.yml` skips them).

## Verify the published artifact

```sh
mkdir -p /tmp/omlx-verify && cd /tmp/omlx-verify
npm pack @231self/opencode-router
tar -tzf 231self-opencode-router-*.tgz | head
```

Then install it as a consumer (below) in a scratch project and confirm a
decision is logged in `~/.local/state/omlx-router/opencode/decisions.jsonl`.
The prompt harness can drive the installed package directly:

```sh
npm install ./231self-opencode-router-*.tgz ./231self-opencode-compaction-*.tgz
bun tests/e2e/run.mjs --only judge-cost --package "$PWD/node_modules/@231self/opencode-router"
bun tests/e2e/run.mjs --only kilo-boundary --package "$PWD/node_modules/@231self/opencode-router"
```

## Consumer install (after publish)

### OpenCode V2

```sh
opencode plugin add @231self/opencode-router
opencode plugin add @231self/opencode-compaction   # context optimiser
```

or in `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@231self/opencode-router", "@231self/opencode-compaction"]
}
```

Then in the TUI: `/router` for status, `/router judge` to test the judge,
`/router policy` to choose a policy.

### Kilo

```sh
kilo plugin @231self/opencode-router
```

or in `~/.config/kilo/kilo.jsonc` / project `kilo.jsonc`:

```jsonc
{
  "$schema": "https://app.kilo.ai/config.json",
  "plugin": ["@231self/opencode-router"]
}
```

Kilo applies a decision at the next request boundary; use `opencode-model-router status`
and `opencode-model-router history` for visibility.

### From a git checkout (works before npm publish)

```sh
git clone https://github.com/231self/opencode-router
cd opencode-router
bun install
bun run build:wasm
```

OpenCode config:

```jsonc
{ "plugins": ["/absolute/path/to/opencode-router/packages/router", "/absolute/path/to/opencode-router/packages/compaction"] }
```

Kilo config:

```jsonc
{ "plugin": ["/absolute/path/to/opencode-router/packages/router/src/index.js"] }
```

## Post-release

- Watch `gh run list` and `npm view` for each package.
- If a bad release ships within 72 h: `npm unpublish <name>@x.y.z`
  (avoid if possible; prefer `npm deprecate` and a patch).
- Never reuse a published version.

## Rollback/disable for users

- Disable the plugins: `opencode plugin remove @231self/opencode-router` (and
  `@231self/opencode-compaction`) or set `"enabled": false` in
  `~/.config/omlx-router/config.json`.
- The plugins never modify host files; removing them leaves only config/state
  under `~/.config/omlx-router` and `~/.local/state/omlx-router`.

#!/usr/bin/env node
/**
 * Deterministic, offline security gate. No network, no third-party scanner:
 * everything here is a local fact we can verify on every push.
 *
 *  1. no secret-shaped strings in the tree or in any published tarball
 *  2. no external npm dependencies (workspace siblings are allowed), so
 *     there is no supply chain to poison
 *  3. no credential-shaped files in the tarballs
 *  4. each tarball contains only what its package.json says it should
 */
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const TEXT_EXTENSIONS = new Set([
  "",
  ".cjs",
  ".css",
  ".csv",
  ".html",
  ".js",
  ".json",
  ".lock",
  ".md",
  ".mjs",
  ".rs",
  ".sh",
  ".toml",
  ".ts",
  ".txt",
  ".yaml",
  ".yml",
])
const SKIP_DIRS = new Set([".git", ".jj", "node_modules", "target", "dist", "pkgcheck"])
const FORBIDDEN_NAMES = [/^auth\.json$/i, /^secrets?/i, /^id_rsa/i, /^\.env/i, /\.pem$/i, /\.key$/i, /\.p12$/i, /\.pfx$/i, /\.db$/i, /\.sqlite3?$/i]

/**
 * Published packages and their tarball allowlists. Keep in sync with each
 * package's `files` field: this gate fails on anything beyond the list.
 */
const PACKAGES = [
  {
    dir: "packages/shared",
    allowedRoots: ["package.json", "README.md", "CHANGELOG.md", "LICENSE", "src"],
  },
  {
    dir: "packages/compaction",
    allowedRoots: ["package.json", "README.md", "CHANGELOG.md", "LICENSE", "src", "dist"],
  },
  {
    dir: "packages/router",
    allowedRoots: ["package.json", "README.md", "CHANGELOG.md", "LICENSE", "config.example.json", "src", "bin", "dist", "web"],
  },
]

/** Workspace siblings may depend on each other; nothing else may be present. */
const WORKSPACE_PREFIX = "@231self/"

/** Secret shapes worth failing a build over. */
export const SECRET_PATTERNS = [
  ["OpenAI-style key", /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ["npm token", /\bnpm_[A-Za-z0-9]{20,}\b/],
  ["AWS access key id", /\bAKIA[0-9A-Z]{16}\b/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  [
    "credential assignment",
    /\b(api[_-]?key|apikey|secret|token|password|passwd|authorization)\b\s*[:=]\s*["']([^"']{16,})["']/i,
  ],
]

/** The config format's documented placeholder, not a secret. */
const PLACEHOLDER = /^\{env:[A-Z0-9_]+\}$/i

/** Find secret-shaped strings in one text blob. */
export function scanText(text) {
  const findings = []
  for (const [label, pattern] of SECRET_PATTERNS) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`
    const regex = new RegExp(pattern.source, flags)
    for (const match of text.matchAll(regex)) {
      const value = match[2] ?? match[0]
      if (PLACEHOLDER.test(value.trim())) continue
      findings.push({ label, sample: `${match[0].slice(0, 24)}…` })
    }
  }
  return findings
}

/**
 * Dependency fields that must stay empty except for workspace siblings.
 * Returns offending `field: name` strings.
 */
export function checkDependencies(manifest) {
  const fields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "bundledDependencies"]
  const offenders = []
  for (const field of fields) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (!name.startsWith(WORKSPACE_PREFIX)) offenders.push(`${field}: ${name}`)
    }
  }
  return offenders
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.isFile()) yield full
  }
}

function isText(file) {
  return TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())
}

function scanTree() {
  const findings = []
  for (const file of walk(ROOT)) {
    if (!isText(file)) continue
    const text = fs.readFileSync(file, "utf8")
    for (const finding of scanText(text)) {
      findings.push({ ...finding, file: path.relative(ROOT, file) })
    }
  }
  return findings
}

function packTarball(pkgDir) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omlx-router-security-"))
  // --ignore-scripts: scanning must not rebuild the world through prepack.
  execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", dir, "--silent"], {
    cwd: path.join(ROOT, pkgDir),
    stdio: "pipe",
  })
  const tarball = fs.readdirSync(dir).find((name) => name.endsWith(".tgz"))
  execFileSync("tar", ["-xzf", tarball, "-C", dir], { cwd: dir, stdio: "pipe" })
  return path.join(dir, "package")
}

function scanTarball(pkg) {
  const packed = packTarball(pkg.dir)
  const findings = []
  const offenders = []
  for (const file of walk(packed)) {
    const relative = path.relative(packed, file)
    const root = relative.split(path.sep)[0]
    if (!pkg.allowedRoots.includes(root)) offenders.push(`unexpected path: ${relative}`)
    if (FORBIDDEN_NAMES.some((pattern) => pattern.test(path.basename(file)))) {
      offenders.push(`credential-shaped file: ${relative}`)
      continue
    }
    if (!isText(file)) continue
    for (const finding of scanText(fs.readFileSync(file, "utf8"))) {
      findings.push({ ...finding, file: relative })
    }
  }
  return { findings, offenders }
}

function main() {
  const failures = []
  const report = (label, problems) => {
    if (problems.length === 0) {
      console.log(`ok       ${label}`)
      return
    }
    console.log(`FAIL     ${label}`)
    for (const problem of problems) console.log(`         ${problem}`)
    failures.push(label)
  }

  const tree = scanTree()
  report(
    "no secrets in the tree",
    tree.map((f) => `${f.file}: ${f.label} (${f.sample})`),
  )

  for (const pkg of PACKAGES) {
    const { findings, offenders } = scanTarball(pkg)
    report(
      `${pkg.dir}: no secrets in the published tarball`,
      findings.map((f) => `${f.file}: ${f.label} (${f.sample})`),
    )
    report(`${pkg.dir}: no unexpected files in the tarball`, offenders)
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, pkg.dir, "package.json"), "utf8"))
    report(
      `${pkg.dir}: no external npm dependencies`,
      checkDependencies(manifest),
    )
  }

  if (failures.length > 0) {
    console.log(`\nsecurity check failed: ${failures.join(", ")}`)
    process.exitCode = 1
    return
  }
  console.log("\nsecurity check ok")
}

if (import.meta.main) main()

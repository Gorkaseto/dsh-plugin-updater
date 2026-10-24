/**
 * Host half of the @local/plugin-updater bundle.
 *
 * Lists the profile's bundles installed from GitHub (through dsh's
 * `pluginManager` service, dsh ≥ 0.2), reads the `version` in each
 * repository's `package.json` at the latest commit of `main`, and reports
 * which ones have a newer version. A check runs once at startup and on
 * demand; updates reinstall a bundle from `github:owner/repo#main` with the
 * plugin manager's own remove + install (the path its UI uses, since
 * `installBundle` refuses a package that is already installed under HMR),
 * restoring the previous commit when the new install fails.
 *
 * Remote methods (`pluginupdater/<method>`) are served by the Gateway's SRC
 * fallback, like the other `@local/*` bundles: a plain service carrying a
 * `typertRemote` binding and the protocol's prototype marker.
 *
 * | Method      | Result                                                      |
 * |-------------|-------------------------------------------------------------|
 * | `status`    | the current snapshot (rows, flags, last run)                |
 * | `check`     | a fresh check; joins the running one if any                 |
 * | `update`    | starts one plugin's update; `{ accepted }`                  |
 * | `updateAll` | starts updating every updatable plugin; `{ accepted }`      |
 * | `selfUpdate`| starts the updater's own in-place update; `{ accepted }`    |
 *
 * The updater never updates itself with remove + install: removing a bundle
 * stops it first, so the reinstall would come from disposed code. It runs
 * `pnpm add github:o/r#main` in place through dsh's `runPluginCommand`
 * (loaded from the installation) and announces the outcome from the new
 * version, through `<dshHome>/storages/plugin-updater/self-update.json`.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const name = 'plugin-updater'
// `pluginManager` is optional: on a dsh without it the plugin still loads and
// reports `supported: false`.
export const inject = []

const NAMESPACE = 'pluginupdater'
const REMOTE_MARK = '@deepseek-ai/dsh-typert-protocol/remote-methods'
const SELF = '@local/plugin-updater'
const BRANCH = 'main'
const CONCURRENCY = 4
const TIMEOUT_MS = 15_000
const STARTUP_DELAY_MS = 0
const SHA_RE = /[0-9a-f]{40}/
const OPERATIONS = '@deepseek-ai/dsh-plugin-manager/operations'
const SELF_OUTPUT_BYTES = 64 * 1024
const SELF_IDLE_MS = 5 * 60_000
const RESTORED_FILES = ['package.json', 'pnpm-lock.yaml']

// ------------------------------------------------------------------ sources

/**
 * The GitHub repository a bundle's install spec names.
 * @param source - the spec `pnpm add` accepts, e.g. `github:owner/repo#ref`.
 * @returns `{ owner, repo, pinnedRef }`, `{ owner, repo, unsupported: 'path' }`
 *   for a subdirectory install, or `null` when the spec is not GitHub.
 */
function parseGithubSource(source) {
  if (typeof source !== 'string') return null
  const spec = source.trim()
  const hash = spec.indexOf('#')
  const base = hash === -1 ? spec : spec.slice(0, hash)
  const ref = hash === -1 ? '' : spec.slice(hash + 1)
  const match = /^github:([\w.-]+)\/([\w.-]+)$/i.exec(base)
    ?? /^(?:git\+)?https?:\/\/(?:[^@/]+@)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(base)
    ?? /^(?:git\+)?ssh:\/\/git@github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i.exec(base)
    ?? /^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i.exec(base)
  if (match === null) return null
  const owner = match[1]
  const repo = match[2].replace(/\.git$/i, '')
  // pnpm's `#path:/sub&ref` and `#semver:` forms share the hash.
  if (/(^|&)path:/.test(ref)) return { owner, repo, unsupported: 'path' }
  const pinned = ref.split('&').find((part) => part !== '' && !part.startsWith('semver:')) ?? null
  return { owner, repo, pinnedRef: pinned === null || pinned === BRANCH ? null : pinned }
}

// ------------------------------------------------------------------ semver

const SEMVER_RE = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*))*))?(?:\+[\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*)?$/

/** A SemVer 2.0 version (build metadata dropped), or null when invalid. */
function parseVersion(text) {
  if (typeof text !== 'string') return null
  const m = SEMVER_RE.exec(text.trim())
  if (m === null) return null
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] === undefined ? [] : m[4].split('.') }
}

/**
 * SemVer precedence of two version strings.
 * @returns -1, 0 or 1, or null when either is invalid.
 */
function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b)
  if (x === null || y === null) return null
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1
  // A release ranks above any of its prereleases.
  if (x.pre.length === 0 || y.pre.length === 0) return x.pre.length === y.pre.length ? 0 : x.pre.length === 0 ? 1 : -1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    if (i >= x.pre.length) return -1
    if (i >= y.pre.length) return 1
    const p = x.pre[i], q = y.pre[i]
    if (p === q) continue
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q)
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1
    if (pn !== qn) return pn ? -1 : 1
    return p < q ? -1 : 1
  }
  return 0
}

// ------------------------------------------------------------------ lockfile

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

/**
 * The commit pnpm resolved a dependency to, from `pnpm-lock.yaml` text: the
 * `codeload.github.com/.../tar.gz/<sha>`, `#<sha>` or `commit: <sha>` in the
 * importer's entry, else in the package's own entry.
 * @returns the 40-hex SHA, or null.
 */
function lockedCommit(lockText, packageName) {
  if (typeof lockText !== 'string' || lockText === '') return null
  const lines = lockText.split(/\r?\n/)
  const key = new RegExp(`^(\\s+)['"]?${escapeRe(packageName)}['"]?:\\s*$`)
  for (let i = 0; i < lines.length; i++) {
    const m = key.exec(lines[i])
    if (m === null) continue
    for (let j = i + 1; j < lines.length; j++) {
      const indent = /^(\s*)/.exec(lines[j])[1].length
      if (lines[j].trim() !== '' && indent <= m[1].length) break
      const sha = SHA_RE.exec(lines[j])
      if (sha !== null) return sha[0]
    }
  }
  const entry = new RegExp(`^\\s+['"]?${escapeRe(packageName)}@[^\\n]*`)
  for (let i = 0; i < lines.length; i++) {
    if (!entry.test(lines[i])) continue
    const sha = SHA_RE.exec(lines[i])
    if (sha !== null) return sha[0]
    for (let j = i + 1; j < lines.length && /^\s{4,}/.test(lines[j]); j++) {
      const inner = SHA_RE.exec(lines[j])
      if (inner !== null) return inner[0]
    }
  }
  return null
}

// ------------------------------------------------------------------ GitHub

class CheckFailure extends Error {
  /** @param code - a reason code the client localizes. */
  constructor(code, detail) {
    super(detail === undefined ? code : `${code}: ${detail}`)
    this.code = code
    this.detail = detail
  }
}

/**
 * The `version` in `package.json` at the head of `main`.
 * @returns `{ version, sha }`; `sha` is null when the API was rate limited
 *   and the file was read from the branch name instead.
 */
async function fetchMainVersion(owner, repo, { token, fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS, signal } = {}) {
  const get = async (url, headers) => {
    const timeout = AbortSignal.timeout(timeoutMs)
    try {
      return await fetchImpl(url, { headers, signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]) })
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new CheckFailure('timeout')
      throw new CheckFailure('network', error?.cause?.code ?? error?.message)
    }
  }
  const path = `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
  const apiHeaders = { 'Accept': 'application/vnd.github.sha', 'User-Agent': 'dsh-plugin-updater' }
  if (typeof token === 'string' && token !== '') apiHeaders.Authorization = `Bearer ${token}`
  const head = await get(`https://api.github.com/repos/${path}/commits/${BRANCH}`, apiHeaders)
  let sha = null
  if (head.ok) {
    const text = (await head.text()).trim()
    sha = SHA_RE.test(text) ? SHA_RE.exec(text)[0] : null
  } else if (head.status === 404 || head.status === 422) {
    throw new CheckFailure('not-found')
  } else if (head.status !== 403 && head.status !== 429) {
    throw new CheckFailure('http', String(head.status))
  }
  // Rate limited (403/429): fall back to the branch name, which the raw CDN may serve a few minutes stale.
  const file = await get(`https://raw.githubusercontent.com/${path}/${sha ?? BRANCH}/package.json`, { 'User-Agent': 'dsh-plugin-updater' })
  if (file.status === 404) throw new CheckFailure(sha === null ? 'not-found' : 'no-package-json')
  if (!file.ok) throw new CheckFailure('http', String(file.status))
  let manifest
  try { manifest = JSON.parse(await file.text()) } catch { throw new CheckFailure('bad-json') }
  if (typeof manifest?.version !== 'string' || manifest.version.trim() === '') throw new CheckFailure('no-version')
  return { version: manifest.version.trim(), sha }
}

/** Run `task` over `items`, at most `limit` at a time, keeping order. */
async function mapLimit(items, limit, task) {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await task(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

function failureOf(error) {
  if (error instanceof CheckFailure) return { code: error.code, detail: error.detail }
  return { code: 'error', detail: error?.message ?? String(error) }
}

/** The state a row's two versions give. */
function stateOf(installed, latest) {
  const order = compareVersions(latest, installed)
  if (order === null) return 'unknown'
  return order > 0 ? 'update-available' : 'up-to-date'
}

/** A failed or cancelled plugin-manager change, as an Error, else null. */
function changeError(result) {
  if (result === undefined || result === null) return null
  if (result.application !== 'failed' && result.application !== 'cancelled') return null
  const code = result.error?.code ?? result.application
  return new Error(result.error?.diagnostic ? `${code}: ${result.error.diagnostic}` : code)
}

// ------------------------------------------------------------------ self-update

/**
 * dsh's in-place package operation (`runPluginCommand`), loaded from the
 * installation: this bundle lives outside it, so a bare import cannot resolve.
 * @param installAnchor - `profileContext.installAnchor`.
 * @returns the function, or null when this dsh does not ship it.
 */
async function loadOperations(installAnchor, importer = (url) => import(url)) {
  if (typeof installAnchor !== 'string' || installAnchor === '') return null
  try {
    const path = createRequire(join(installAnchor, 'package.json')).resolve(OPERATIONS)
    const mod = await importer(pathToFileURL(path).href)
    return typeof mod?.runPluginCommand === 'function' ? mod.runPluginCommand : null
  } catch {
    return null
  }
}

/** The last lines of pnpm's output, for a failure reason. */
function outputTail(text, lines = 6) {
  return String(text ?? '').trim().split(/\r?\n/).slice(-lines).join('\n')
}

// ------------------------------------------------------------------ service

/**
 * The updater's state and operations, independent of cordis so tests can
 * drive it with a fake plugin manager.
 * @param options.manager - returns the `pluginManager` service or undefined.
 * @param options.profileDir - returns the profile directory or undefined.
 * @param options.profile - returns `profileContext` or undefined (self-update).
 * @param options.operations - resolves dsh's `runPluginCommand`, or null.
 * @param options.reconcile - returns a function applying the saved profile live, or null without HMR.
 * @param options.outcomePath - returns the self-update outcome file's path, or undefined.
 * @param options.ownVersion - resolves this bundle's own `package.json` version.
 */
function createUpdater({
  manager, profileDir, token, fetchImpl,
  profile = () => undefined, operations = async () => null, reconcile = () => null,
  outcomePath = () => undefined, ownVersion = async () => null,
  readText = (p) => readFile(p, 'utf8'),
  writeText = async (p, text) => { await mkdir(dirname(p), { recursive: true }); await writeFile(p, text, 'utf8') },
  now = () => Date.now(),
}) {
  let rows = []
  let lastCheckedAt = null
  let checking = null
  let updating = false
  let current = null
  let lastRun = null
  let supported = null
  let checkError = null
  let selfUpdateAvailable = false
  let selfUpdated = null

  const status = () => ({
    supported: supported ?? manager() !== undefined,
    checking: checking !== null,
    updating,
    current,
    lastCheckedAt,
    checkError,
    lastRun,
    selfUpdateAvailable,
    selfUpdated,
    plugins: rows.map((row) => ({ ...row })),
  })

  const rowFor = (bundle, gh, latest) => {
    const base = {
      name: bundle.name,
      repo: `${gh.owner}/${gh.repo}`,
      source: bundle.source,
      pinnedRef: gh.pinnedRef ?? null,
      installed: bundle.version ?? null,
      enabled: bundle.enabled !== false,
      self: bundle.name === SELF,
      latest: null,
      latestSha: null,
      reason: null,
      restartRequired: false,
    }
    if (gh.unsupported) return { ...base, state: 'unknown', reason: { code: 'unsupported-spec' } }
    if (latest.error) return { ...base, state: 'unknown', reason: latest.error }
    const row = { ...base, latest: latest.version, latestSha: latest.sha }
    if (parseVersion(latest.version) === null) return { ...row, state: 'unknown', reason: { code: 'invalid-version', detail: latest.version } }
    if (parseVersion(row.installed) === null) return { ...row, state: 'unknown', reason: { code: 'invalid-version', detail: String(row.installed) } }
    return { ...row, state: stateOf(row.installed, latest.version) }
  }

  const runCheck = async () => {
    const pm = manager()
    supported = pm !== undefined && typeof pm.listBundles === 'function'
      && typeof pm.removeBundle === 'function' && typeof pm.installBundle === 'function'
    if (!supported) { rows = []; return }
    checkError = null
    selfUpdateAvailable = await operations().catch(() => null) !== null && profile() !== undefined
    let bundles
    try { bundles = await pm.listBundles() } catch (error) { checkError = failureOf(error); return }
    const candidates = []
    for (const bundle of bundles ?? []) {
      if (!bundle?.installed || typeof bundle.source !== 'string') continue
      const gh = parseGithubSource(bundle.source)
      if (gh !== null) candidates.push({ bundle, gh })
    }
    const fresh = await mapLimit(candidates, CONCURRENCY, async ({ bundle, gh }) => {
      if (gh.unsupported) return rowFor(bundle, gh, null)
      try {
        return rowFor(bundle, gh, await fetchMainVersion(gh.owner, gh.repo, { token, fetchImpl }))
      } catch (error) {
        return rowFor(bundle, gh, { error: failureOf(error) })
      }
    })
    // Keep a restart notice from an earlier update until the profile restarts.
    const restart = new Set(rows.filter((r) => r.restartRequired).map((r) => r.name))
    rows = fresh.map((row) => restart.has(row.name) ? { ...row, restartRequired: true } : row)
    lastCheckedAt = now()
  }

  /** A fresh check, or the running one; resolves with the snapshot. */
  const check = () => {
    if (updating) return Promise.resolve(status())
    if (checking === null) {
      checking = runCheck()
        .catch((error) => { checkError = failureOf(error) })
        .finally(() => { checking = null })
    }
    return checking.then(status)
  }

  const patch = (name, fields) => {
    rows = rows.map((row) => row.name === name ? { ...row, ...fields } : row)
  }

  /** One plugin's remove + reinstall from `main`, restoring on failure. */
  const updateOne = async (name) => {
    const row = rows.find((r) => r.name === name)
    if (row === undefined || row.state !== 'update-available' || row.self) return false
    const pm = manager()
    if (pm === undefined) { patch(name, { state: 'failed', reason: { code: 'unsupported' } }); return false }
    current = name
    patch(name, { state: 'updating', reason: null })
    const [owner, repo] = row.repo.split('/')
    let oldSha = null
    const dir = profileDir()
    if (dir !== undefined) {
      try { oldSha = lockedCommit(await readText(join(dir, 'pnpm-lock.yaml')), name) } catch { oldSha = null }
    }
    let restartRequired = false
    const note = (result) => {
      if (result?.application === 'restart-required' || result?.restartReason !== undefined) restartRequired = true
    }
    try {
      const removed = await pm.removeBundle(name)
      const removeError = changeError(removed)
      if (removeError !== null) throw Object.assign(removeError, { stage: 'remove' })
      note(removed)
      const installed = await pm.installBundle(`github:${owner}/${repo}#${BRANCH}`, { enabled: row.enabled })
      const installError = changeError(installed)
      if (installError !== null) throw Object.assign(installError, { stage: 'install' })
      note(installed)
    } catch (error) {
      let restored = true
      if (error.stage !== 'remove') {
        const spec = oldSha !== null ? `github:${owner}/${repo}#${oldSha}` : row.source
        try {
          const back = await pm.installBundle(spec, { enabled: row.enabled })
          restored = changeError(back) === null
        } catch { restored = false }
      }
      patch(name, {
        state: 'failed',
        reason: { code: restored ? 'update-failed' : 'restore-failed', detail: error?.message ?? String(error) },
      })
      current = null
      return false
    }
    let version = null
    try { version = (await pm.listBundles()).find((b) => b.name === name)?.version ?? null } catch { version = null }
    const installed = version ?? row.latest
    patch(name, {
      installed,
      source: `github:${owner}/${repo}#${BRANCH}`,
      pinnedRef: null,
      // `main` may have moved on since the check; only a still-older install keeps the button.
      state: stateOf(installed, row.latest) === 'update-available' ? 'update-available' : 'up-to-date',
      restartRequired,
    })
    current = null
    return true
  }

  /** Runs `job` as the one update operation; false when one already runs. */
  const exclusive = (job) => {
    if (updating || checking !== null) return { accepted: false }
    updating = true
    const run = job().catch(() => {}).finally(() => { updating = false; current = null })
    return { accepted: true, done: run }
  }

  const update = (name) => exclusive(async () => {
    const ok = await updateOne(name)
    lastRun = { kind: 'single', name, updated: ok ? 1 : 0, failed: ok ? 0 : 1, at: now() }
  })

  const updateAll = () => exclusive(async () => {
    const names = rows.filter((r) => r.state === 'update-available' && !r.self).map((r) => r.name)
    let updated = 0, failed = 0
    for (const name of names) {
      if (await updateOne(name)) updated++
      else failed++
    }
    lastRun = { kind: 'all', updated, failed, at: now() }
  })

  /**
   * The updater's own in-place update: `pnpm add github:o/r#main` under the
   * profile lock, so it is never uninstalled. A failed run puts the profile
   * manifest and lockfile back; a successful one records the outcome before
   * asking HMR to load the new version, which may dispose this very instance.
   */
  const selfUpdateOne = async (row) => {
    const run = await operations().catch(() => null)
    const pc = profile()
    if (run === null || pc === undefined) { patch(row.name, { state: 'failed', reason: { code: 'self-unavailable' } }); return false }
    current = row.name
    patch(row.name, { state: 'updating', reason: null })
    const [owner, repo] = row.repo.split('/')
    const files = RESTORED_FILES.map((name) => join(pc.dir, name))
    const snapshot = await Promise.all(files.map((p) => readText(p).catch(() => undefined)))
    const pnpm = pc.packageManager
    let result
    try {
      result = await run(
        { profile: pc.name, dir: pc.dir, installAnchor: pc.installAnchor, cwd: pc.cwd ?? pc.dir, home: pc.home },
        ['add', `github:${owner}/${repo}#${BRANCH}`],
        {
          execution: 'service', outputBytes: SELF_OUTPUT_BYTES, idleTimeoutMs: SELF_IDLE_MS,
          ...pnpm === undefined ? {} : { command: pnpm.command, args: pnpm.args, env: pnpm.env },
        },
      )
    } catch (error) {
      result = { exitCode: 1, output: error?.message ?? String(error) }
    }
    if (result?.exitCode !== 0 || result.timedOut === true || (result.incompatible?.length ?? 0) > 0) {
      // pnpm has exited: put back what it may have rewritten.
      for (let i = 0; i < files.length; i++) {
        if (snapshot[i] !== undefined) await writeText(files[i], snapshot[i]).catch(() => {})
      }
      const detail = result?.incompatible?.length ? `incompatible: ${result.incompatible.map((p) => p.name ?? p).join(', ')}` : outputTail(result?.output)
      patch(row.name, { state: 'failed', reason: { code: 'update-failed', detail: detail || `exit ${result?.exitCode}` } })
      current = null
      return false
    }
    let to = row.latest
    try { to = JSON.parse(await readText(join(pc.dir, 'node_modules', ...row.name.split('/'), 'package.json'))).version ?? to } catch { /* keep main's version */ }
    const path = outcomePath()
    if (path !== undefined) {
      await writeText(path, JSON.stringify({ from: row.installed, to, at: now(), announced: false }, null, 2)).catch(() => {})
    }
    patch(row.name, { installed: to, source: `github:${owner}/${repo}#${BRANCH}`, pinnedRef: null, state: 'up-to-date', restartRequired: false })
    current = null
    const apply = reconcile()
    if (apply === null) { patch(row.name, { restartRequired: true }); return true }
    try {
      const outcome = await apply()
      if (outcome?.restartReason !== undefined || (outcome?.pending?.length ?? 0) > 0) patch(row.name, { restartRequired: true })
    } catch {
      patch(row.name, { restartRequired: true })
    }
    return true
  }

  const selfUpdate = () => {
    const row = rows.find((r) => r.self)
    if (row === undefined || row.state !== 'update-available') return { accepted: false }
    return exclusive(async () => {
      if (!(await selfUpdateOne(row))) lastRun = { kind: 'single', name: row.name, updated: 0, failed: 1, at: now() }
    })
  }

  /**
   * At startup: announce a self-update this version is the result of, once.
   * @returns the announced outcome, or null.
   */
  const loadSelfOutcome = async () => {
    const path = outcomePath()
    if (path === undefined) return null
    let outcome
    try { outcome = JSON.parse(await readText(path)) } catch { return null }
    if (outcome === null || typeof outcome !== 'object' || outcome.announced === true) return null
    const version = await ownVersion().catch(() => null)
    if (typeof outcome.to !== 'string' || outcome.to !== version) return null
    selfUpdated = { from: outcome.from ?? null, to: outcome.to, at: outcome.at ?? now() }
    await writeText(path, JSON.stringify({ ...outcome, announced: true }, null, 2)).catch(() => {})
    return selfUpdated
  }

  return { status, check, update, updateAll, selfUpdate, loadSelfOutcome }
}

// ------------------------------------------------------------------ plugin

async function readOwnVersion() {
  return JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8')).version ?? null
}

export function apply(ctx, config = {}) {
  const profile = () => ctx.get('profileContext') ?? undefined
  let operations
  const updater = createUpdater({
    manager: () => ctx.get('pluginManager') ?? undefined,
    profileDir: () => profile()?.dir,
    token: config?.githubToken,
    profile,
    operations: () => (operations ??= loadOperations(profile()?.installAnchor)),
    reconcile: () => {
      const hmr = ctx.get('hmr')
      return typeof hmr?.reconcileProfile === 'function' ? () => hmr.reconcileProfile() : null
    },
    outcomePath: () => {
      const home = profile()?.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
      return join(home, 'storages', 'plugin-updater', 'self-update.json')
    },
    ownVersion: readOwnVersion,
  })
  // A self-update this version is the result of is announced once, then marked.
  updater.loadSelfOutcome().catch(() => {})

  class PluginUpdater {
    /** The current snapshot: rows, flags, last check time and last run. */
    async status() {
      return updater.status()
    }

    /** Re-check every GitHub-installed plugin; joins a running check. */
    async check() {
      return updater.check()
    }

    /**
     * Start updating one plugin; follow progress through `status`.
     * @param name - the bundle's package name.
     */
    async update(name) {
      const { accepted } = updater.update(name)
      return { accepted }
    }

    /** Start updating every plugin with an update available, one after another. */
    async updateAll() {
      const { accepted } = updater.updateAll()
      return { accepted }
    }

    /** Start the updater's own in-place update; never part of `updateAll`. */
    async selfUpdate() {
      const { accepted } = updater.selfUpdate()
      return { accepted }
    }
  }

  const direct = (method) => Object.freeze({ method, invocation: Object.freeze({ kind: 'direct' }) })
  Object.defineProperty(PluginUpdater.prototype, REMOTE_MARK, {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze(['status', 'check', 'update', 'updateAll', 'selfUpdate'].map(direct)),
    }),
  })

  const service = new PluginUpdater()
  service.typertRemote = Object.freeze({ service, serviceKey: NAMESPACE, namespace: NAMESPACE })
  ctx.provide(NAMESPACE, service)

  // The startup check waits for the plugin manager (never, on a dsh without
  // one), never blocks profile composition, and its errors land in the rows.
  const startup = (scope) => scope.effect(() => {
    const timer = setTimeout(() => { updater.check().catch(() => {}) }, STARTUP_DELAY_MS)
    return () => clearTimeout(timer)
  }, 'plugin-updater: startup check')
  if (typeof ctx.inject === 'function') ctx.inject(['pluginManager'], startup)
  else startup(ctx)
}

export const __test__ = { parseGithubSource, parseVersion, compareVersions, lockedCommit, fetchMainVersion, createUpdater, mapLimit, loadOperations, readOwnVersion, SELF }

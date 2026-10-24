import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { __test__ } from '../index.js'

const { createUpdater, loadOperations, SELF } = __test__
const SHA = 'c'.repeat(40)

/** A fetch serving `main` versions per repo. */
function fakeFetch(versions) {
  return async (url) => {
    const api = /repos\/([^/]+)\/([^/]+)\/commits\/main$/.exec(url)
    if (api) return { ok: true, status: 200, text: async () => SHA }
    const raw = /githubusercontent\.com\/([^/]+)\/([^/]+)\//.exec(url)
    const version = versions[`${raw[1]}/${raw[2]}`]
    return version === undefined
      ? { ok: false, status: 404, text: async () => '' }
      : { ok: true, status: 200, text: async () => JSON.stringify({ version }) }
  }
}

const bundle = (name, repo, version) => ({ name, version, installed: true, enabled: true, source: `github:${repo}#0.1.0` })

/** An in-memory profile directory and outcome file. */
function memoryFs(initial = {}) {
  const files = new Map(Object.entries(initial))
  return {
    files,
    readText: async (p) => { if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return files.get(p) },
    writeText: async (p, text) => { files.set(p, text) },
  }
}

const PROFILE = { name: 'web', dir: '/profile', installAnchor: '/anchor', cwd: '/work', home: '/home/.dsh', packageManager: { command: 'node', args: ['pnpm.cjs'], env: { X: '1' } } }
const OUTCOME = '/home/.dsh/storages/plugin-updater/self-update.json'
const MANIFEST = join('/profile', 'package.json')
const LOCK = join('/profile', 'pnpm-lock.yaml')

function setup({ run = null, reconcile = () => null, bundles = [bundle(SELF, 'me/updater', '1.0.0')], versions = { 'me/updater': '1.1.0' }, own = '1.0.0', fs } = {}) {
  const memory = fs ?? memoryFs({ [MANIFEST]: '{"old":true}', [LOCK]: 'lock: old' })
  const calls = []
  const pm = { listBundles: async () => bundles, removeBundle: async (n) => { calls.push(['remove', n]); return {} }, installBundle: async (s) => { calls.push(['install', s]); return {} } }
  const updater = createUpdater({
    manager: () => pm,
    profileDir: () => PROFILE.dir,
    fetchImpl: fakeFetch(versions),
    profile: () => PROFILE,
    operations: async () => run,
    reconcile,
    outcomePath: () => OUTCOME,
    ownVersion: async () => own,
    readText: memory.readText,
    writeText: memory.writeText,
    now: () => 42,
  })
  return { updater, memory, calls }
}

test('loadOperations: resolves runPluginCommand from the install anchor, null otherwise', async () => {
  const anchor = await mkdtemp(join(tmpdir(), 'plu-anchor-'))
  const pkg = join(anchor, 'node_modules', '@deepseek-ai', 'dsh-plugin-manager')
  await mkdir(join(pkg, 'lib'), { recursive: true })
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-plugin-manager', type: 'module', exports: { './operations': './lib/operations.js' } }))
  await writeFile(join(pkg, 'lib', 'operations.js'), 'export async function runPluginCommand() { return { exitCode: 0 } }\n')
  const run = await loadOperations(anchor)
  assert.equal(typeof run, 'function')
  assert.deepEqual(await run(), { exitCode: 0 })
  assert.equal(await loadOperations(await mkdtemp(join(tmpdir(), 'plu-empty-'))), null)
  assert.equal(await loadOperations(undefined), null)
})

test('status: selfUpdateAvailable follows the operations module', async () => {
  assert.equal((await setup({ run: async () => ({ exitCode: 0 }) }).updater.check()).selfUpdateAvailable, true)
  assert.equal((await setup({ run: null }).updater.check()).selfUpdateAvailable, false)
})

test('selfUpdate: pnpm add from main in place, never remove/install, outcome written before reconcile', async () => {
  const runs = []
  const order = []
  const fs = memoryFs({ [MANIFEST]: '{"old":true}', [LOCK]: 'lock: old', [join('/profile', 'node_modules', '@local', 'plugin-updater', 'package.json')]: '{"version":"1.1.0"}' })
  const run = async (context, args, options) => { runs.push({ context, args, options }); return { exitCode: 0, output: 'ok' } }
  const { updater, memory, calls } = setup({
    run, fs,
    reconcile: () => async () => { order.push(['reconcile', memory.files.has(OUTCOME)]); return { warnings: [] } },
  })
  await updater.check()
  const { accepted, done } = updater.selfUpdate()
  assert.equal(accepted, true)
  assert.equal(updater.update('anything').accepted, false, 'nothing else runs meanwhile')
  await done
  assert.deepEqual(calls, [], 'plugin manager remove/install never used for self')
  assert.deepEqual(runs[0].args, ['add', 'github:me/updater#main'])
  assert.deepEqual(runs[0].context, { profile: 'web', dir: '/profile', installAnchor: '/anchor', cwd: '/work', home: '/home/.dsh' })
  assert.equal(runs[0].options.execution, 'service')
  assert.deepEqual([runs[0].options.command, runs[0].options.args, runs[0].options.env], ['node', ['pnpm.cjs'], { X: '1' }])
  assert.deepEqual(order, [['reconcile', true]], 'outcome file exists when reconcile runs')
  assert.deepEqual(JSON.parse(memory.files.get(OUTCOME)), { from: '1.0.0', to: '1.1.0', at: 42, announced: false })
  const row = updater.status().plugins[0]
  assert.equal(row.state, 'up-to-date')
  assert.equal(row.installed, '1.1.0')
  assert.equal(row.restartRequired, false)
})

test('selfUpdate: restart flagged when reconcile reports a reason or there is no HMR', async () => {
  const ok = async () => ({ exitCode: 0 })
  const withReason = setup({ run: ok, reconcile: () => async () => ({ restartReason: 'module-comparison' }) })
  await withReason.updater.check()
  await withReason.updater.selfUpdate().done
  assert.equal(withReason.updater.status().plugins[0].restartRequired, true)
  const noHmr = setup({ run: ok, reconcile: () => null })
  await noHmr.updater.check()
  await noHmr.updater.selfUpdate().done
  assert.equal(noHmr.updater.status().plugins[0].restartRequired, true)
})

test('selfUpdate: failure restores package.json and the lockfile byte for byte', async () => {
  const fs = memoryFs({ [MANIFEST]: '{"old":true}\r\n', [LOCK]: 'lock: old\n' })
  const run = async () => {
    fs.files.set(MANIFEST, '{"rewritten":true}')
    fs.files.set(LOCK, 'lock: new')
    return { exitCode: 1, output: 'line 1\nERR_PNPM_FETCH_404 not found' }
  }
  const { updater, memory } = setup({ run, fs })
  await updater.check()
  await updater.selfUpdate().done
  assert.equal(memory.files.get(MANIFEST), '{"old":true}\r\n')
  assert.equal(memory.files.get(LOCK), 'lock: old\n')
  assert.equal(memory.files.has(OUTCOME), false, 'no outcome on failure')
  const snap = updater.status()
  assert.equal(snap.plugins[0].state, 'failed')
  assert.match(snap.plugins[0].reason.detail, /ERR_PNPM_FETCH_404/)
  assert.equal(snap.lastRun.failed, 1)
  assert.equal(snap.updating, false)
})

test('selfUpdate: incompatible and timed-out runs count as failures', async () => {
  for (const result of [{ exitCode: 0, timedOut: true }, { exitCode: 1, incompatible: [{ name: 'dsh-plugin-updater' }] }]) {
    const { updater } = setup({ run: async () => result })
    await updater.check()
    await updater.selfUpdate().done
    assert.equal(updater.status().plugins[0].state, 'failed')
  }
})

test('selfUpdate: refused when the updater is not outdated or not present', async () => {
  const upToDate = setup({ run: async () => ({ exitCode: 0 }), versions: { 'me/updater': '1.0.0' } })
  await upToDate.updater.check()
  assert.equal(upToDate.updater.selfUpdate().accepted, false)
  const absent = setup({ run: async () => ({ exitCode: 0 }), bundles: [bundle('@acme/a', 'acme/a', '1.0.0')], versions: { 'acme/a': '1.1.0' } })
  await absent.updater.check()
  assert.equal(absent.updater.selfUpdate().accepted, false)
})

test('selfUpdate: unavailable operations mark the row instead of running', async () => {
  const { updater } = setup({ run: null })
  await updater.check()
  await updater.selfUpdate().done
  assert.equal(updater.status().plugins[0].reason.code, 'self-unavailable')
})

test('updateAll and update keep skipping self', async () => {
  const runs = []
  const { updater, calls } = setup({
    run: async (...a) => { runs.push(a); return { exitCode: 0 } },
    bundles: [bundle(SELF, 'me/updater', '1.0.0')],
  })
  await updater.check()
  await updater.updateAll().done
  await updater.update(SELF).done
  assert.deepEqual(calls, [])
  assert.deepEqual(runs, [])
  assert.equal(updater.status().plugins[0].state, 'update-available')
})

test('loadSelfOutcome: announced once across starts, only for the matching version', async () => {
  const fs = memoryFs({ [OUTCOME]: JSON.stringify({ from: '1.0.0', to: '1.1.0', at: 7, announced: false }) })
  const first = setup({ fs, own: '1.1.0' })
  assert.deepEqual(await first.updater.loadSelfOutcome(), { from: '1.0.0', to: '1.1.0', at: 7 })
  assert.deepEqual(first.updater.status().selfUpdated, { from: '1.0.0', to: '1.1.0', at: 7 })
  assert.equal(JSON.parse(fs.files.get(OUTCOME)).announced, true)
  const second = setup({ fs, own: '1.1.0' })
  assert.equal(await second.updater.loadSelfOutcome(), null, 'not announced twice')
  assert.equal(second.updater.status().selfUpdated, null)
})

test('loadSelfOutcome: nothing when the version differs, or the file is missing or corrupt', async () => {
  const pending = memoryFs({ [OUTCOME]: JSON.stringify({ from: '1.0.0', to: '1.1.0', at: 7, announced: false }) })
  assert.equal(await setup({ fs: pending, own: '1.0.0' }).updater.loadSelfOutcome(), null)
  assert.equal(JSON.parse(pending.files.get(OUTCOME)).announced, false, 'kept for the version that matches')
  assert.equal(await setup({ fs: memoryFs({}) }).updater.loadSelfOutcome(), null)
  assert.equal(await setup({ fs: memoryFs({ [OUTCOME]: '{nope' }) }).updater.loadSelfOutcome(), null)
})

test('real files: outcome file is created with its folder', async () => {
  const home = await mkdtemp(join(tmpdir(), 'plu-home-'))
  const path = join(home, 'storages', 'plugin-updater', 'self-update.json')
  const updater = createUpdater({
    manager: () => ({ listBundles: async () => [bundle(SELF, 'me/updater', '1.0.0')], removeBundle: async () => ({}), installBundle: async () => ({}) }),
    profileDir: () => home,
    fetchImpl: fakeFetch({ 'me/updater': '1.1.0' }),
    profile: () => ({ ...PROFILE, dir: home }),
    operations: async () => async () => ({ exitCode: 0 }),
    outcomePath: () => path,
  })
  await updater.check()
  await updater.selfUpdate().done
  assert.equal(JSON.parse(await readFile(path, 'utf8')).to, '1.1.0')
})

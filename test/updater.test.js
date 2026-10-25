import { test } from 'node:test'
import assert from 'node:assert/strict'
import { __test__ } from '../index.js'

const { fetchMainVersion, fetchRepoVersions, repoVersionsCache, createUpdater, SELF } = __test__
const SHA = 'c'.repeat(40), OLD = 'd'.repeat(40)

const reply = (status, body = '') => ({ ok: status >= 200 && status < 300, status, text: async () => body })

/** A fetch that serves `repos[owner/repo] = { version | status, head?: status, tags?: Array, tagsHead?: status }`. */
function fakeFetch(repos, calls = []) {
  return async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} })
    const tagsApi = /api\.github\.com\/repos\/([^/]+)\/([^/]+)\/tags(?:\?.*)?$/.exec(url)
    if (tagsApi) {
      const repo = repos[`${tagsApi[1]}/${tagsApi[2]}`]
      if (repo === undefined) return reply(404)
      if (repo.throws) throw repo.throws
      if (repo.tagsHead !== undefined) return reply(repo.tagsHead)
      return reply(200, JSON.stringify(repo.tags ?? []))
    }
    const atomApi = /github\.com\/([^/]+)\/([^/]+)\/tags\.atom$/.exec(url)
    if (atomApi) {
      const repo = repos[`${atomApi[1]}/${atomApi[2]}`]
      if (repo === undefined) return reply(404)
      if (repo.atomBody !== undefined) return reply(200, repo.atomBody)
      return reply(404)
    }
    const api = /api\.github\.com\/repos\/([^/]+)\/([^/]+)\/commits\/main$/.exec(url)
    if (api) {
      const repo = repos[`${api[1]}/${api[2]}`]
      if (repo === undefined) return reply(404)
      if (repo.throws) throw repo.throws
      return repo.head !== undefined ? reply(repo.head) : reply(200, repo.sha ?? SHA)
    }
    const raw = /raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/package\.json$/.exec(url)
    const repo = repos[`${raw[1]}/${raw[2]}`]
    if (repo === undefined || repo.file === 404) return reply(404)
    if (repo.body !== undefined) return reply(200, repo.body)
    return reply(200, JSON.stringify({ name: raw[2], version: repo.version }))
  }
}

test('fetchMainVersion: reads package.json at the head SHA', async () => {
  const calls = []
  const result = await fetchMainVersion('acme', 'foo', { token: 'tkn', fetchImpl: fakeFetch({ 'acme/foo': { version: '1.3.0' } }, calls) })
  assert.deepEqual(result, { version: '1.3.0', sha: SHA })
  assert.match(calls[1].url, new RegExp(`/acme/foo/${SHA}/package.json$`))
  assert.equal(calls[0].headers.Authorization, 'Bearer tkn')
  assert.equal(calls[1].headers.Authorization, undefined, 'token is only sent to api.github.com')
})

test('fetchMainVersion: rate limit falls back to raw main', async () => {
  const calls = []
  const result = await fetchMainVersion('acme', 'foo', { fetchImpl: fakeFetch({ 'acme/foo': { head: 403, version: '2.0.0' } }, calls) })
  assert.deepEqual(result, { version: '2.0.0', sha: null })
  assert.match(calls[1].url, /\/acme\/foo\/main\/package.json$/)
})

test('fetchMainVersion: failure reasons', async () => {
  const code = (repos) => fetchMainVersion('acme', 'foo', { fetchImpl: fakeFetch(repos) }).then(() => 'ok', (e) => e.code)
  assert.equal(await code({}), 'not-found')
  assert.equal(await code({ 'acme/foo': { file: 404 } }), 'no-package-json')
  assert.equal(await code({ 'acme/foo': { body: '{nope' } }), 'bad-json')
  assert.equal(await code({ 'acme/foo': { body: '{"name":"x"}' } }), 'no-version')
  assert.equal(await code({ 'acme/foo': { head: 500 } }), 'http')
  assert.equal(await code({ 'acme/foo': { throws: new TypeError('fetch failed') } }), 'network')
  const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' })
  assert.equal(await code({ 'acme/foo': { throws: timeout } }), 'timeout')
})

// ------------------------------------------------------------------ fake plugin manager

function fakeManager(bundles, { failInstall = () => false, restart = false } = {}) {
  const calls = []
  const state = new Map(bundles.map((b) => [b.name, { ...b }]))
  const versions = {}
  return {
    calls,
    versions,
    state,
    async listBundles() { calls.push(['list']); return [...state.values()].map((b) => ({ ...b })) },
    async removeBundle(name) {
      calls.push(['remove', name])
      state.delete(name)
      return { changed: true, application: 'applied', stage: 'remove', target: name }
    },
    async installBundle(spec, options) {
      calls.push(['install', spec, options])
      const m = /^github:([^/]+)\/([^#]+)#(.+)$/.exec(spec)
      const name = Object.keys(versions).find((n) => versions[n].repo === `${m[1]}/${m[2]}`)
      if (failInstall(spec)) return { changed: false, application: 'failed', stage: 'install', target: spec, error: { code: 'operation-error', diagnostic: 'boom' } }
      const version = m[3] === 'main' ? versions[name].main : versions[name].old
      state.set(name, { name, version, installed: true, enabled: options.enabled, source: spec })
      return { changed: true, application: restart ? 'restart-required' : 'applied', ...restart ? { restartReason: 'module-comparison' } : {}, stage: 'install', target: spec }
    },
  }
}

const bundle = (name, repo, version, extra = {}) => ({ name, version, installed: true, enabled: true, source: `github:${repo}`, ...extra })

function setup(bundles, repos, versions, options) {
  const pm = fakeManager(bundles, options)
  Object.assign(pm.versions, versions)
  const lock = Object.entries(versions).map(([name, v]) => `      '${name}':\n        specifier: x\n        version: https://codeload.github.com/${v.repo}/tar.gz/${OLD}`).join('\n')
  const updater = createUpdater({
    manager: () => pm,
    profileDir: () => '/profile',
    fetchImpl: fakeFetch(repos),
    readText: async () => `importers:\n  .:\n    dependencies:\n${lock}\n`,
  })
  return { pm, updater }
}

test('check: lists only GitHub bundles, reports states and failures', async () => {
  const { updater } = setup([
    bundle('@acme/new', 'acme/new', '1.2.0'),
    bundle('@acme/same', 'acme/same', '1.2.0'),
    bundle('@acme/ahead', 'acme/ahead', '2.0.0'),
    bundle('@acme/pinned', 'acme/pinned', '1.0.0', { source: 'github:acme/pinned#v1.0.0' }),
    bundle('@acme/gone', 'acme/gone', '1.0.0'),
    bundle('@acme/badver', 'acme/badver', '1.0.0'),
    { name: '@npm/pkg', version: '1.0.0', installed: true, enabled: true, source: '@npm/pkg@1.0.0' },
    { name: '@local/linked', version: '1.0.0', installed: true, enabled: true, source: 'link:C:/x' },
    { name: '@deepseek-ai/dsh-base', version: '0.2.0', installed: true, enabled: true },
  ], {
    'acme/new': { version: '1.3.0' },
    'acme/same': { version: '1.2.0' },
    'acme/ahead': { version: '1.9.0' },
    'acme/pinned': { version: '1.4.0' },
    'acme/badver': { version: 'latest' },
  }, {})
  const snap = await updater.check()
  const by = Object.fromEntries(snap.plugins.map((p) => [p.name, p]))
  assert.deepEqual(Object.keys(by).sort(), ['@acme/ahead', '@acme/badver', '@acme/gone', '@acme/new', '@acme/pinned', '@acme/same'])
  assert.equal(by['@acme/new'].state, 'update-available')
  assert.equal(by['@acme/new'].latest, '1.3.0')
  assert.equal(by['@acme/new'].latestSha, SHA)
  assert.equal(by['@acme/same'].state, 'up-to-date')
  assert.equal(by['@acme/ahead'].state, 'up-to-date')
  assert.equal(by['@acme/pinned'].state, 'update-available')
  assert.equal(by['@acme/pinned'].pinnedRef, 'v1.0.0')
  assert.equal(by['@acme/gone'].state, 'unknown')
  assert.equal(by['@acme/gone'].reason.code, 'not-found')
  assert.equal(by['@acme/badver'].state, 'unknown')
  assert.equal(by['@acme/badver'].reason.code, 'invalid-version')
  assert.equal(snap.supported, true)
  assert.equal(typeof snap.lastCheckedAt, 'number')
})

test('check: concurrent callers share one run', async () => {
  const { pm, updater } = setup([bundle('@acme/new', 'acme/new', '1.2.0')], { 'acme/new': { version: '1.3.0' } }, {})
  const [a, b] = await Promise.all([updater.check(), updater.check()])
  assert.deepEqual(a, b)
  assert.equal(pm.calls.filter((c) => c[0] === 'list').length, 1)
})

test('check: unsupported without a plugin manager', async () => {
  const updater = createUpdater({ manager: () => undefined, profileDir: () => undefined })
  const snap = await updater.check()
  assert.equal(snap.supported, false)
  assert.deepEqual(snap.plugins, [])
})

test('update: reinstalls from main, keeps enabled state', async () => {
  const { pm, updater } = setup(
    [bundle('@acme/new', 'acme/new', '1.2.0', { enabled: false })],
    { 'acme/new': { version: '1.3.0' } },
    { '@acme/new': { repo: 'acme/new', main: '1.3.0', old: '1.2.0' } },
  )
  await updater.check()
  const { accepted, done } = updater.update('@acme/new')
  assert.equal(accepted, true)
  assert.equal(updater.status().updating, true)
  assert.equal(updater.update('@acme/new').accepted, false, 'one operation at a time')
  await done
  const row = updater.status().plugins[0]
  assert.equal(row.state, 'up-to-date')
  assert.equal(row.installed, '1.3.0')
  assert.equal(row.source, 'github:acme/new#main')
  assert.deepEqual(pm.calls.filter((c) => c[0] !== 'list'), [
    ['remove', '@acme/new'],
    ['install', 'github:acme/new#main', { enabled: false }],
  ])
  assert.equal(pm.state.get('@acme/new').enabled, false)
  assert.deepEqual(updater.status().lastRun.updated, 1)
})

test('update: failed install restores the locked commit', async () => {
  const { pm, updater } = setup(
    [bundle('@acme/new', 'acme/new', '1.2.0')],
    { 'acme/new': { version: '1.3.0' } },
    { '@acme/new': { repo: 'acme/new', main: '1.3.0', old: '1.2.0' } },
    { failInstall: (spec) => spec.endsWith('#main') },
  )
  await updater.check()
  await updater.update('@acme/new').done
  const row = updater.status().plugins[0]
  assert.equal(row.state, 'failed')
  assert.equal(row.reason.code, 'update-failed')
  assert.match(row.reason.detail, /boom/)
  assert.deepEqual(pm.calls.at(-1), ['install', `github:acme/new#${OLD}`, { enabled: true }])
  assert.equal(pm.state.get('@acme/new').version, '1.2.0', 'previous version still installed')
})

test('update: restore failure is reported', async () => {
  const { updater } = setup(
    [bundle('@acme/new', 'acme/new', '1.2.0')],
    { 'acme/new': { version: '1.3.0' } },
    { '@acme/new': { repo: 'acme/new', main: '1.3.0', old: '1.2.0' } },
    { failInstall: () => true },
  )
  await updater.check()
  await updater.update('@acme/new').done
  assert.equal(updater.status().plugins[0].reason.code, 'restore-failed')
})

test('update: restart-required is flagged and survives a re-check', async () => {
  const { updater } = setup(
    [bundle('@acme/new', 'acme/new', '1.2.0')],
    { 'acme/new': { version: '1.3.0' } },
    { '@acme/new': { repo: 'acme/new', main: '1.3.0', old: '1.2.0' } },
    { restart: true },
  )
  await updater.check()
  await updater.update('@acme/new').done
  assert.equal(updater.status().plugins[0].restartRequired, true)
  await updater.check()
  assert.equal(updater.status().plugins[0].restartRequired, true)
})

test('update: refuses self and rows without an update', async () => {
  const { pm, updater } = setup(
    [bundle(SELF, 'me/updater', '1.0.0'), bundle('@acme/same', 'acme/same', '1.0.0')],
    { 'me/updater': { version: '1.1.0' }, 'acme/same': { version: '1.0.0' } },
    {},
  )
  const snap = await updater.check()
  const self = snap.plugins.find((p) => p.name === SELF)
  assert.equal(self.self, true)
  assert.equal(self.state, 'update-available')
  await updater.update(SELF).done
  await updater.update('@acme/same').done
  assert.equal(pm.calls.filter((c) => c[0] === 'remove').length, 0)
})

test('updateAll: continues after a failure and skips self', async () => {
  const { pm, updater } = setup(
    [
      bundle('@acme/a', 'acme/a', '1.0.0'),
      bundle('@acme/b', 'acme/b', '1.0.0'),
      bundle('@acme/c', 'acme/c', '1.0.0'),
      bundle(SELF, 'me/updater', '1.0.0'),
    ],
    { 'acme/a': { version: '1.1.0' }, 'acme/b': { version: '1.1.0' }, 'acme/c': { version: '1.1.0' }, 'me/updater': { version: '1.1.0' } },
    {
      '@acme/a': { repo: 'acme/a', main: '1.1.0', old: '1.0.0' },
      '@acme/b': { repo: 'acme/b', main: '1.1.0', old: '1.0.0' },
      '@acme/c': { repo: 'acme/c', main: '1.1.0', old: '1.0.0' },
    },
    { failInstall: (spec) => spec === 'github:acme/b#main' },
  )
  await updater.check()
  const { accepted, done } = updater.updateAll()
  assert.equal(accepted, true)
  await done
  const snap = updater.status()
  assert.deepEqual({ updated: snap.lastRun.updated, failed: snap.lastRun.failed }, { updated: 2, failed: 1 })
  const by = Object.fromEntries(snap.plugins.map((p) => [p.name, p.state]))
  assert.deepEqual(by, { '@acme/a': 'up-to-date', '@acme/b': 'failed', '@acme/c': 'up-to-date', [SELF]: 'update-available' })
  assert.ok(!pm.calls.some((c) => c[0] === 'remove' && c[1] === SELF))
  assert.equal(snap.updating, false)
})

test('fetchRepoVersions: retrieves tags, sorts descending semver and selects default', async () => {
  repoVersionsCache.clear()
  const calls = []
  const tags = [
    { name: 'v1.0.0', commit: { sha: '1111' } },
    { name: 'v1.2.0', commit: { sha: '2222' } },
    { name: 'v1.1.5', commit: { sha: '3333' } },
  ]
  const result = await fetchRepoVersions('acme', 'foo', {
    token: 'my-token',
    fetchImpl: fakeFetch({ 'acme/foo': { tags } }, calls),
  })
  assert.equal(calls[0].headers.Authorization, 'Bearer my-token')
  assert.equal(result.defaultRef, 'v1.2.0')
  assert.equal(result.latestTagged, 'v1.2.0')
  assert.equal(result.versions.length, 4) // 3 tags + 1 latest untagged
  assert.deepEqual(result.versions.map((v) => v.ref), ['v1.2.0', 'v1.1.5', 'v1.0.0', 'main'])
  assert.equal(result.versions[0].isLatestTagged, true)
  assert.equal(result.versions[3].isLatestUntagged, true)
  assert.equal(result.versions[3].ref, 'main')
})

test('fetchRepoVersions: repository without tags defaults to latest untagged', async () => {
  repoVersionsCache.clear()
  const result = await fetchRepoVersions('acme', 'empty', {
    fetchImpl: fakeFetch({ 'acme/empty': { tags: [] } }),
  })
  assert.equal(result.defaultRef, 'main')
  assert.equal(result.latestTagged, null)
  assert.equal(result.versions.length, 1)
  assert.equal(result.versions[0].isLatestUntagged, true)
  assert.equal(result.versions[0].ref, 'main')
})

test('fetchRepoVersions: handles mixed semver and non-semver tags', async () => {
  repoVersionsCache.clear()
  const tags = [
    { name: 'beta-test', commit: { sha: '0000' } },
    { name: 'v2.0.0', commit: { sha: '2000' } },
    { name: 'nightly', commit: { sha: '9999' } },
    { name: 'v1.0.0', commit: { sha: '1000' } },
  ]
  const result = await fetchRepoVersions('acme', 'mixed', {
    fetchImpl: fakeFetch({ 'acme/mixed': { tags } }),
  })
  assert.equal(result.defaultRef, 'v2.0.0')
  assert.equal(result.latestTagged, 'v2.0.0')
  // semver tags first descending, then non-semver, then latest untagged
  assert.deepEqual(result.versions.map((v) => v.ref), ['v2.0.0', 'v1.0.0', 'beta-test', 'nightly', 'main'])
})

test('fetchRepoVersions: error cases and rate limits', async () => {
  repoVersionsCache.clear()
  const code = (repos) => fetchRepoVersions('acme', 'foo', { fetchImpl: fakeFetch(repos), cache: false }).then(() => 'ok', (e) => e.code)
  assert.equal(await code({}), 'not-found')
  assert.equal(await code({ 'acme/foo': { tagsHead: 403 } }), 'http')
  assert.equal(await code({ 'acme/foo': { tagsHead: 500 } }), 'http')
  assert.equal(await code({ 'acme/foo': { throws: new TypeError('failed') } }), 'network')
})

test('fetchRepoVersions: rate limit falls back to tags.atom feed', async () => {
  repoVersionsCache.clear()
  const atomXml = `<feed><entry><title>v3.0.0</title></entry><entry><title>v2.5.0</title></entry></feed>`
  const result = await fetchRepoVersions('acme', 'ratelimited', {
    fetchImpl: fakeFetch({ 'acme/ratelimited': { tagsHead: 403, atomBody: atomXml } }),
    cache: false,
  })
  assert.equal(result.defaultRef, 'v3.0.0')
  assert.deepEqual(result.versions.map((v) => v.ref), ['v3.0.0', 'v2.5.0', 'main'])
})

test('fetchRepoVersions: caching returns cached data within TTL', async () => {
  repoVersionsCache.clear()
  let fetchCount = 0
  const fetchImpl = async (url) => {
    fetchCount++
    return reply(200, JSON.stringify([{ name: 'v1.0.0' }]))
  }
  const res1 = await fetchRepoVersions('acme', 'cached', { fetchImpl, cache: true })
  const res2 = await fetchRepoVersions('acme', 'cached', { fetchImpl, cache: true })
  assert.equal(fetchCount, 1)
  assert.deepEqual(res1, res2)
})

test('installVersion: installs specific tag and updates row', async () => {
  const { pm, updater } = setup(
    [bundle('@acme/foo', 'acme/foo', '1.0.0')],
    {},
    { '@acme/foo': { repo: 'acme/foo', main: '1.2.0', old: '1.0.0' } },
  )
  await updater.check()
  const { accepted, done } = updater.installVersion({ name: '@acme/foo', repo: 'acme/foo', ref: 'v1.1.0' })
  assert.equal(accepted, true)
  await done
  const snap = updater.status()
  const row = snap.plugins.find((p) => p.name === '@acme/foo')
  assert.equal(row.pinnedRef, 'v1.1.0')
  assert.equal(row.source, 'github:acme/foo#v1.1.0')
  assert.ok(pm.calls.some((c) => c[0] === 'remove' && c[1] === '@acme/foo'))
  assert.ok(pm.calls.some((c) => c[0] === 'install' && c[1] === 'github:acme/foo#v1.1.0'))
})

test('installVersion: rollback on install failure', async () => {
  const { pm, updater } = setup(
    [bundle('@acme/foo', 'acme/foo', '1.0.0')],
    {},
    { '@acme/foo': { repo: 'acme/foo', main: '1.2.0', old: '1.0.0' } },
    { failInstall: (spec) => spec === 'github:acme/foo#v2.0.0' },
  )
  await updater.check()
  const { accepted, done } = updater.installVersion({ name: '@acme/foo', repo: 'acme/foo', ref: 'v2.0.0' })
  assert.equal(accepted, true)
  await done
  const snap = updater.status()
  const row = snap.plugins.find((p) => p.name === '@acme/foo')
  assert.equal(row.state, 'failed')
  assert.equal(row.reason.code, 'update-failed')
  // Verify rollback install was attempted
  assert.ok(pm.calls.some((c) => c[0] === 'install' && c[1] === `github:acme/foo#${OLD}`))
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

const REMOTE_MARK = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/** A minimal cordis-like context: provide/get/effect/inject. */
function fakeCtx(services) {
  const provided = {}
  const disposers = []
  const ctx = {
    provided,
    disposers,
    get: (key) => services[key],
    provide: (key, value) => { provided[key] = value },
    effect: (fn) => { const off = fn(); if (typeof off === 'function') disposers.push(off) },
    inject: (deps, callback) => { if (deps.every((d) => services[d] !== undefined)) callback(ctx) },
  }
  return ctx
}

test('apply: registers the Remote service and runs one startup check', async () => {
  let lists = 0
  const pluginManager = {
    listBundles: async () => { lists++; return [] },
    removeBundle: async () => ({}),
    installBundle: async () => ({}),
  }
  const ctx = fakeCtx({ pluginManager })
  apply(ctx, {})
  const service = ctx.provided.pluginupdater
  assert.ok(service, 'service provided')
  assert.equal(service.typertRemote.namespace, 'pluginupdater')
  const methods = Object.getPrototypeOf(service)[REMOTE_MARK].methods.map((m) => m.method)
  assert.deepEqual(methods, ['status', 'check', 'update', 'updateAll', 'selfUpdate', 'versions', 'installVersion'])
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(lists, 1, 'startup check ran once')
  const snap = await service.status()
  assert.equal(snap.supported, true)
  assert.equal(typeof snap.lastCheckedAt, 'number')
})

test('apply: without a plugin manager the service reports unsupported and no check runs', async () => {
  const ctx = fakeCtx({})
  apply(ctx, {})
  await new Promise((resolve) => setTimeout(resolve, 20))
  const snap = await ctx.provided.pluginupdater.status()
  assert.equal(snap.supported, false)
  assert.equal(snap.lastCheckedAt, null)
})

test('apply: service.versions handles various argument shapes from RPC or direct calls', async () => {
  const ctx = fakeCtx({})
  apply(ctx, {})
  const service = ctx.provided.pluginupdater

  // Mock globalThis.fetch to avoid network calls during apply test
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify([{ name: 'v1.0.0' }, { name: 'v1.1.0' }]),
  })
  try {
    const res1 = await service.versions({ owner: 'acme', repo: 'pkg1' })
    assert.deepEqual(res1.versions.map((v) => v.ref), ['v1.1.0', 'v1.0.0', 'main'])

    const res2 = await service.versions({ args: { owner: 'acme', repo: 'pkg2' } })
    assert.deepEqual(res2.versions.map((v) => v.ref), ['v1.1.0', 'v1.0.0', 'main'])

    const res3 = await service.versions('acme/pkg3')
    assert.deepEqual(res3.versions.map((v) => v.ref), ['v1.1.0', 'v1.0.0', 'main'])

    const res4 = await service.versions('acme', 'pkg4')
    assert.deepEqual(res4.versions.map((v) => v.ref), ['v1.1.0', 'v1.0.0', 'main'])
  } finally {
    globalThis.fetch = originalFetch
  }
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

/** Minimal React: elements as plain objects, hooks without re-rendering. */
const React = {
  Fragment: 'fragment',
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
  // Tests can force a component's first `useState` value through `React.forcedState`, or multiple through `React.forcedStates`.
  forcedState: undefined,
  forcedStates: undefined,
  useState: (initial) => {
    if (Array.isArray(React.forcedStates) && React.forcedStates.length > 0) {
      return [React.forcedStates.shift(), () => {}]
    }
    const val = React.forcedState !== undefined ? React.forcedState : initial
    React.forcedState = undefined
    return [val, () => {}]
  },
  useEffect: () => {},
  useSyncExternalStore: (subscribe, get) => get(),
}
const ReactDom = { createPortal: (node, host, key) => ({ type: 'portal', props: { host, key }, children: [node] }) }
/** dsh's shared primitives as plain elements: a `modal` holding its description and footer. */
const Primitives = {
  Modal: (props) => ({ type: 'modal', props, children: [props.description, props.footer] }),
  Button: (props) => ({ type: 'button', props, children: [props.children] }),
}

/** Render function components down to host elements. */
function render(node) {
  if (node === null || node === undefined || node === false) return null
  if (Array.isArray(node)) return node.map(render)
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') return render(node.type({ ...node.props, children: node.children }))
  return { ...node, children: node.children.map(render) }
}

function text(node) {
  if (node === null || node === undefined) return ''
  if (Array.isArray(node)) return node.map(text).join(' ')
  if (typeof node !== 'object') return String(node)
  return text(node.children)
}

function find(node, pred, out = []) {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) { node.forEach((n) => find(n, pred, out)); return out }
  if (pred(node)) out.push(node)
  find(node.children, pred, out)
  return out
}

// ------------------------------------------------------------------ fake DOM

class El {
  constructor(tag, attrs = {}) {
    this.tagName = tag.toUpperCase()
    this.nodeType = 1
    this.attrs = new Map(Object.entries(attrs))
    this.children = []
    this.parentNode = null
  }
  hasAttribute(name) { return this.attrs.has(name) }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null }
  setAttribute(name, value) { this.attrs.set(name, String(value)) }
  get nextSibling() {
    if (this.parentNode === null) return null
    const list = this.parentNode.children
    return list[list.indexOf(this) + 1] ?? null
  }
  insertBefore(node, ref) {
    node.remove()
    const at = ref === null ? this.children.length : this.children.indexOf(ref)
    this.children.splice(at === -1 ? this.children.length : at, 0, node)
    node.parentNode = this
    return node
  }
  appendChild(node) { return this.insertBefore(node, null) }
  remove() {
    if (this.parentNode === null) return
    this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1)
    this.parentNode = null
  }
  /** Only `[attr]` selectors, which is all the client uses. */
  querySelectorAll(selector) {
    const attr = /^\[([\w-]+)\]$/.exec(selector)[1]
    const out = []
    const walk = (el) => { for (const c of el.children) { if (c.hasAttribute(attr)) out.push(c); walk(c) } }
    walk(this)
    return out
  }
  closest(selector) {
    const attr = /^\[([\w-]+)\]$/.exec(selector)[1]
    for (let el = this; el !== null; el = el.parentNode) if (el.hasAttribute?.(attr)) return el
    return null
  }
}

function el(tag, attrs, ...children) {
  const node = new El(tag, attrs)
  for (const c of children) node.appendChild(c)
  return node
}

/** The native Installed plugins section as `renderGroup` / `PackageCard` draw it. */
function card(name) {
  return el('li', { 'data-plugin-package': name, 'data-plugin-status': 'enabled' },
    el('div', { class: 'cardHead' },
      el('span', { class: 'cardIcon' }),
      el('div', { class: 'cardMain' },
        el('div', { class: 'titleRow' }, el('button', { class: 'cardTitle' })),
        el('span', { class: 'cardDesc' })),
      el('div', { class: 'cardEnd' }, el('button', { role: 'switch' }))))
}

function page(names) {
  const body = el('body', {},
    el('section', { 'data-plugin-group': 'extensions' }, el('div', { class: 'groupHead' }), el('ul', {}, card('@other/experimental'))),
    el('section', { 'data-plugin-group': 'bundles' },
      el('div', { class: 'groupHead' }, el('h3', {})),
      el('ul', {}, ...names.map(card))))
  return { body, createElement: (tag) => new El(tag), querySelectorAll: (s) => body.querySelectorAll(s) }
}

const hostKinds = (node) => node.children.filter((c) => c.hasAttribute('data-plu-host')).map((c) => c.getAttribute('data-plu-host'))

// ------------------------------------------------------------------ module

const row = (name, state, extra = {}) => ({
  name, repo: `acme/${name}`, source: `github:acme/${name}`, pinnedRef: null, installed: '1.0.0', enabled: true, self: false,
  latest: '1.1.0', latestSha: 'e'.repeat(40), reason: null, restartRequired: false, state, ...extra,
})

const SNAP = {
  supported: true, checking: false, updating: false, current: null, lastCheckedAt: 1_700_000_000_000, checkError: null, lastRun: null,
  plugins: [row('a', 'update-available'), row('b', 'up-to-date', { latest: '1.0.0' }), row('c', 'unknown', { latest: null, reason: { code: 'not-found' } })],
}

async function load(snap = SNAP, { confirm = () => true, primitives = true, session = new Map() } = {}) {
  let module
  const required = (id) => {
    if (id === 'react') return React
    if (id === 'react-dom') return ReactDom
    if (id === '@deepseek-ai/dsh-client-ui-primitives' && primitives) return Primitives
    throw new Error(`unexpected require ${id}`)
  }
  globalThis.window = { __ModuleLoader__: { load: (def) => { module = def.factory(required) } }, sessionStorage: session, confirm }
  globalThis.document = { createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild() {} } }
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  new Function(source)()
  const registered = []
  const calls = []
  const panels = []
  const ctx = {
    effect: (fn) => fn(),
    on: () => () => {},
    locale: { register: () => () => {}, bind: () => (key, params) => params ? `${key} ${JSON.stringify(params)}` : key },
    slots: { inject: (_name, fn) => fn(), register: (options, component) => { registered.push({ options, component }); return () => {} } },
    connection: { rpc: { call: async (_path, endpoint, { args }) => { calls.push([endpoint, args]); return { ok: true, value: typeof snap === 'function' ? snap() : snap } } } },
    layout: { selectPanel: (id) => panels.push(id) },
  }
  assert.deepEqual(module.inject, ['connection', 'locale', 'slots', 'layout'])
  module.apply(ctx)
  await new Promise((resolve) => setTimeout(resolve, 10))
  const slot = (id) => registered.find((r) => r.options.id === id)
  return { module, registered, calls, panels, slot }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10))

test('client: no Updates tab; registers the Installed hook, detail seats and toast', async () => {
  const { registered, calls } = await load()
  assert.deepEqual(registered.map((r) => [r.options.name, r.options.id]), [
    ['shell.overlay', 'plugin-updater.installed-hook'],
    ['plugins.detail.badge', 'plugin-updater.badge'],
    ['plugins.detail.actions', 'plugin-updater.update'],
    ['plugins.detail.actions', 'plugin-updater.version-selector'],
    ['shell.overlay', 'plugin-updater.startup-toast'],
    ['shell.overlay', 'plugin-updater.run-snackbar'],
    ['shell.overlay', 'plugin-updater.confirm'],
    ['shell.overlay', 'plugin-updater.install-modal'],
  ])
  assert.ok(!registered.some((r) => r.options.name === 'plugins.tab'))
  assert.deepEqual(calls[0], ['pluginupdater/status', {}])
})

test('client: every surface shares one store snapshot', async () => {
  const { slot } = await load()
  const a = slot('plugin-updater.installed-hook').options.inject().store
  const b = slot('plugin-updater.badge').options.inject().store
  assert.equal(a, b)
  assert.equal(a.get(), SNAP)
})

test('attachHosts: head host after the Installed plugins heading, card hosts only on wanted cards', async () => {
  const { module } = await load()
  const { attachHosts } = module.__test__
  const doc = page(['a', 'b', '@local/linked'])
  const mounts = attachHosts(doc, new Set(['a']))
  const section = doc.body.children[1]
  assert.deepEqual(section.children.map((c) => c.getAttribute('data-plu-host') ?? c.tagName), ['DIV', 'head', 'UL'])
  assert.equal(mounts.head, section.children[1])
  assert.deepEqual([...mounts.cards.keys()], ['a'])
  const [liA, liB, liLinked] = section.children[2].children
  const cardHead = liA.children[0]
  assert.deepEqual(hostKinds(cardHead.children[1].children[0]), ['tag'], 'tag at the end of the title row')
  assert.equal(cardHead.children[2].getAttribute('data-plu-host'), 'action', 'action just before the switch')
  assert.equal(cardHead.children[3].getAttribute('class'), 'cardEnd')
  assert.deepEqual(hostKinds(liA), ['reason'])
  for (const li of [liB, liLinked]) assert.equal(li.querySelectorAll('[data-plu-host]').length, 0, 'other cards untouched')
  assert.equal(doc.body.children[0].querySelectorAll('[data-plu-host]').length, 0, 'other sections untouched')
})

test('attachHosts: idempotent, repairs removed hosts, drops stale ones', async () => {
  const { module } = await load()
  const { attachHosts, detachHosts } = module.__test__
  const doc = page(['a', 'b'])
  const first = attachHosts(doc, new Set(['a', 'b']))
  const again = attachHosts(doc, new Set(['a', 'b']))
  assert.equal(again.head, first.head)
  assert.equal(again.cards.get('a').tag, first.cards.get('a').tag)
  assert.equal(doc.querySelectorAll('[data-plu-host]').length, 7)
  // A page re-render dropped one host and re-created a card.
  first.cards.get('a').action.remove()
  const ul = doc.body.children[1].children[2]
  ul.insertBefore(card('b'), ul.children[1])
  ul.children[2].remove()
  const repaired = attachHosts(doc, new Set(['a', 'b']))
  assert.equal(repaired.cards.get('a').action.parentNode, ul.children[0].children[0])
  assert.notEqual(repaired.cards.get('b').tag, first.cards.get('b').tag)
  // b is up to date now: its hosts go.
  attachHosts(doc, new Set(['a']))
  assert.equal(ul.children[1].querySelectorAll('[data-plu-host]').length, 0)
  detachHosts(doc)
  assert.equal(doc.querySelectorAll('[data-plu-host]').length, 0)
})

test('attachHosts: nothing when the section is absent', async () => {
  const { module } = await load()
  const body = el('body', {}, el('section', { 'data-plugin-group': 'basic' }))
  const mounts = module.__test__.attachHosts({ body, createElement: (t) => new El(t) }, new Set(['a']))
  assert.equal(mounts.head, null)
  assert.equal(mounts.cards.size, 0)
})

test('ownMutation: ignores changes made only to the plugin hosts', async () => {
  const { module } = await load()
  const { ownMutation } = module.__test__
  const host = el('div', { 'data-plu-host': 'head' })
  const inner = el('span', {})
  host.appendChild(inner)
  const native = el('li', {})
  assert.equal(ownMutation({ target: inner, addedNodes: [], removedNodes: [] }), true)
  assert.equal(ownMutation({ target: el('ul', {}), addedNodes: [host], removedNodes: [] }), true)
  assert.equal(ownMutation({ target: el('ul', {}), addedNodes: [native], removedNodes: [] }), false)
})

/** Render the Installed hook's portals with given host mounts. */
function renderHook(slot, mounts) {
  React.forcedState = mounts
  try {
    return render(React.createElement(slot.component, slot.options.inject()))
  } finally {
    React.forcedState = undefined
  }
}

const hostsFor = (names) => ({
  head: el('div', {}),
  cards: new Map(names.map((n) => [n, { tag: el('span', {}), action: el('div', {}), reason: el('div', {}) }])),
})

test('Installed hook: section toolbar with check, Update all and last checked', async () => {
  const { slot, calls } = await load()
  const tree = renderHook(slot('plugin-updater.installed-hook'), hostsFor(['a', 'c']))
  const head = find(tree, (n) => n.type === 'portal' && n.props.key === 'head')[0]
  const buttons = find(head, (n) => n.type === 'button').map(text)
  assert.ok(buttons.includes('action.check'))
  assert.ok(buttons.some((b) => b.startsWith('action.updateAll') && b.includes('"count":1')))
  assert.match(text(head), /last\.at/)
  find(head, (n) => n.type === 'button' && text(n).startsWith('action.updateAll'))[0].props.onClick()
  await tick()
  assert.ok(calls.some((c) => c[0] === 'pluginupdater/updateAll'))
})

test('Installed hook: outdated card gets tag and Update, unknown card gets its reason', async () => {
  const { slot, calls } = await load()
  const tree = renderHook(slot('plugin-updater.installed-hook'), hostsFor(['a', 'c']))
  const portal = (key) => find(tree, (n) => n.type === 'portal' && n.props.key === key)[0]
  assert.match(text(portal('tag:a')), /badge .*1\.1\.0/)
  assert.equal(text(portal('action:a')), 'action.update')
  assert.match(text(portal('tag:c')), /state\.unknown/)
  assert.equal(find(portal('action:c'), (n) => n.type === 'button').length, 0)
  assert.match(text(portal('reason:c')), /reason\.not-found/)
  find(portal('action:a'), (n) => n.type === 'button')[0].props.onClick()
  await tick()
  assert.ok(calls.some((c) => c[0] === 'pluginupdater/update' && c[1].name === 'a'))
})

test('pinned update asks in the in-app dialog: Cancel stops, Update runs', async () => {
  const pinned = { ...SNAP, plugins: [row('p', 'update-available', { pinnedRef: '0.1.0' })] }
  const { slot, calls } = await load(pinned, { confirm: () => { throw new Error('native confirm used') } })
  const tree = renderHook(slot('plugin-updater.installed-hook'), hostsFor(['p']))
  assert.match(text(find(tree, (n) => n.props?.key === 'tag:p')[0]), /row\.pinned .*0\.1\.0/)
  const press = () => find(renderHook(slot('plugin-updater.installed-hook'), hostsFor(['p'])), (n) => n.type === 'button' && text(n) === 'action.update')[0].props.onClick()
  const dialog = () => render(React.createElement(slot('plugin-updater.confirm').component, slot('plugin-updater.confirm').options.inject()))
  assert.equal(dialog(), null, 'closed until asked')
  press()
  let modal = dialog()
  assert.equal(modal.type, 'modal')
  assert.equal(modal.props.title, 'pin.title')
  assert.match(text(modal), /pin\.confirm .*"ref":"0\.1\.0"/)
  const buttons = () => find(modal, (n) => n.type === 'button')
  assert.deepEqual(buttons().map((b) => [text(b), b.props.variant]), [['action.cancel', 'outline'], ['action.update', 'primary']])
  buttons()[0].props.onClick()
  await tick()
  assert.equal(dialog(), null, 'Cancel closes it')
  assert.ok(!calls.some((c) => c[0] === 'pluginupdater/update'), 'Cancel runs nothing')
  press()
  modal = dialog()
  buttons()[1].props.onClick()
  await tick()
  assert.equal(dialog(), null)
  assert.ok(calls.some((c) => c[0] === 'pluginupdater/update' && c[1].name === 'p'), 'Update runs it')
})

test('pinned update falls back to window.confirm without dsh primitives', async () => {
  const asked = []
  const pinned = { ...SNAP, plugins: [row('p', 'update-available', { pinnedRef: '0.1.0' })] }
  const { slot, calls } = await load(pinned, { primitives: false, confirm: (msg) => { asked.push(msg); return false } })
  find(renderHook(slot('plugin-updater.installed-hook'), hostsFor(['p'])), (n) => n.type === 'button' && text(n) === 'action.update')[0].props.onClick()
  await tick()
  assert.equal(asked.length, 1)
  assert.match(asked[0], /pin\.confirm/)
  assert.ok(!calls.some((c) => c[0] === 'pluginupdater/update'))
})

test('Installed hook: self row shows the hint and no Update button', async () => {
  const self = { ...SNAP, plugins: [row('dsh-plugin-updater', 'update-available', { self: true })] }
  const { slot } = await load(self)
  const tree = renderHook(slot('plugin-updater.installed-hook'), hostsFor(['dsh-plugin-updater']))
  assert.equal(find(tree, (n) => n.type === 'button' && text(n) === 'action.update').length, 0)
  assert.match(text(tree), /row\.self/)
  const head = find(tree, (n) => n.props?.key === 'head')[0]
  assert.ok(!text(head).includes('action.updateAll'), 'Update all skips self')
})

test('Installed hook: unsupported and empty lines under the heading', async () => {
  const unsupported = await load({ ...SNAP, supported: false, plugins: [] })
  assert.match(text(renderHook(unsupported.slot('plugin-updater.installed-hook'), hostsFor([]))), /unsupported/)
  const empty = await load({ ...SNAP, plugins: [] })
  assert.match(text(renderHook(empty.slot('plugin-updater.installed-hook'), hostsFor([]))), /empty/)
})

test('detail badge and action only for outdated bundles', async () => {
  const { slot, calls } = await load()
  const badge = slot('plugin-updater.badge'), action = slot('plugin-updater.update')
  const subject = (name) => ({ kind: 'bundle', pkg: { name } })
  const props = (s) => ({ ...badge.options.inject(), subject: s })
  assert.match(text(render(React.createElement(badge.component, props(subject('a'))))), /badge .*1\.1\.0/)
  assert.equal(render(React.createElement(badge.component, props(subject('b')))), null)
  assert.equal(render(React.createElement(badge.component, props({ kind: 'item', id: 'x' }))), null)
  const button = render(React.createElement(action.component, { ...action.options.inject(), subject: subject('a') }))
  assert.equal(text(button), 'action.update')
  button.props.onClick()
  await tick()
  assert.ok(calls.some((c) => c[0] === 'pluginupdater/update' && c[1].name === 'a'))
  assert.equal(render(React.createElement(action.component, { ...action.options.inject(), subject: subject('b') })), null)
})

test('startup toast announces updates and View opens the Plugins page', async () => {
  const { slot, panels } = await load()
  globalThis.requestAnimationFrame = () => 0
  const toast = slot('plugin-updater.startup-toast')
  const tree = render(React.createElement(toast.component, toast.options.inject()))
  assert.match(text(tree), /toast .*"count":1/)
  find(tree, (n) => n.type === 'button' && text(n) === 'action.view')[0].props.onClick()
  assert.deepEqual(panels, ['plugins'])
})

test('no toast when nothing to update', async () => {
  const { slot } = await load({ ...SNAP, plugins: [row('b', 'up-to-date')] })
  const toast = slot('plugin-updater.startup-toast')
  assert.equal(render(React.createElement(toast.component, toast.options.inject())), null)
})

test('run snackbar: not for a run done before load, shown for a new run, not in the section head', async () => {
  let current = { ...SNAP, lastRun: { kind: 'all', updated: 1, failed: 0, at: 1 } }
  const { slot } = await load(() => current)
  const snackbar = slot('plugin-updater.run-snackbar')
  assert.equal(render(React.createElement(snackbar.component, snackbar.options.inject())), null, 'old run not announced')
  const head = find(renderHook(slot('plugin-updater.installed-hook'), hostsFor([])), (n) => n.props?.key === 'head')[0]
  assert.ok(!/run\./.test(text(head)), 'no summary under the heading')
  current = { ...current, lastRun: { kind: 'all', updated: 2, failed: 1, at: 2 } }
  slot('plugin-updater.installed-hook').options.inject().actions.check()
  await tick()
  const tree = render(React.createElement(snackbar.component, snackbar.options.inject()))
  assert.match(text(tree), /run\.all .*"updated":2.*"failed":1/)
  assert.match(tree.props.className, /plu-err/)
  find(tree, (n) => n.type === 'button')[0].props.onClick()
  assert.equal(render(React.createElement(snackbar.component, snackbar.options.inject())), null, 'dismissed')
})

// ------------------------------------------------------------------ self-update

const selfRow = (extra = {}) => row('dsh-plugin-updater', 'update-available', { self: true, repo: 'me/updater', ...extra })
const selfSnap = (plugins, extra = {}) => ({ ...SNAP, selfUpdateAvailable: true, plugins, ...extra })
const buttonsIn = (tree) => find(tree, (n) => n.type === 'button')

test('self card: outline "Update Plugin Updater" with icon, others keep primary Update', async () => {
  const { slot } = await load(selfSnap([selfRow(), row('a', 'update-available')]))
  const tree = renderHook(slot('plugin-updater.installed-hook'), hostsFor(['dsh-plugin-updater', 'a']))
  const selfBtn = buttonsIn(find(tree, (n) => n.props?.key === 'action:dsh-plugin-updater')[0])[0]
  assert.equal(text(selfBtn), 'self.action')
  assert.equal(selfBtn.props.variant, 'outline')
  assert.ok(selfBtn.props.icon, 'has the refresh icon')
  const other = buttonsIn(find(tree, (n) => n.props?.key === 'action:a')[0])[0]
  assert.equal(text(other), 'action.update')
  assert.match(other.props.className, /plu-primary/)
  assert.match(text(find(tree, (n) => n.props?.key === 'reason:dsh-plugin-updater')[0]), /self\.hint/)
})

test('self card: no control and the old hint when self-update is unavailable', async () => {
  const { slot } = await load(selfSnap([selfRow()], { selfUpdateAvailable: false }))
  const tree = renderHook(slot('plugin-updater.installed-hook'), hostsFor(['dsh-plugin-updater']))
  assert.equal(buttonsIn(find(tree, (n) => n.props?.key === 'action:dsh-plugin-updater')[0]).length, 0)
  assert.match(text(tree), /row\.self/)
})

test('self detail page: same distinct control', async () => {
  const { slot } = await load(selfSnap([selfRow()]))
  const action = slot('plugin-updater.update')
  const tree = render(React.createElement(action.component, { ...action.options.inject(), subject: { kind: 'bundle', pkg: { name: 'dsh-plugin-updater' } } }))
  assert.equal(text(tree), 'self.action')
  assert.equal(tree.props.variant, 'outline')
})

test('self-update always confirms (even unpinned): Cancel sends nothing, confirm sends selfUpdate', async () => {
  const { slot, calls } = await load(selfSnap([selfRow()]))
  const press = () => buttonsIn(find(renderHook(slot('plugin-updater.installed-hook'), hostsFor(['dsh-plugin-updater'])), (n) => n.props?.key === 'action:dsh-plugin-updater')[0])[0].props.onClick()
  const dialog = () => render(React.createElement(slot('plugin-updater.confirm').component, slot('plugin-updater.confirm').options.inject()))
  press()
  let modal = dialog()
  assert.equal(modal.props.title, 'self.title')
  assert.match(text(modal), /self\.confirm .*"version":"1\.1\.0"/)
  assert.ok(!/pin\.confirm/.test(text(modal)), 'no pin sentence when unpinned')
  assert.deepEqual(buttonsIn(modal).map(text), ['action.cancel', 'self.action'])
  buttonsIn(modal)[0].props.onClick()
  await tick()
  assert.ok(!calls.some((c) => c[0] === 'pluginupdater/selfUpdate'))
  press()
  modal = dialog()
  buttonsIn(modal)[1].props.onClick()
  await tick()
  assert.ok(calls.some((c) => c[0] === 'pluginupdater/selfUpdate'))
  assert.ok(!calls.some((c) => c[0] === 'pluginupdater/update'), 'never the plain update')
})

test('self-update confirm adds the pin sentence when pinned', async () => {
  const { slot } = await load(selfSnap([selfRow({ pinnedRef: 'v1.0.0' })]))
  buttonsIn(find(renderHook(slot('plugin-updater.installed-hook'), hostsFor(['dsh-plugin-updater'])), (n) => n.props?.key === 'action:dsh-plugin-updater')[0])[0].props.onClick()
  const modal = render(React.createElement(slot('plugin-updater.confirm').component, slot('plugin-updater.confirm').options.inject()))
  assert.match(text(modal), /self\.confirm .*pin\.confirm .*v1\.0\.0/)
})

test('Update all excludes self: count 2 with two plugins + self, hidden when only self', async () => {
  const both = await load(selfSnap([selfRow(), row('a', 'update-available'), row('b', 'update-available')]))
  const head = find(renderHook(both.slot('plugin-updater.installed-hook'), hostsFor([])), (n) => n.props?.key === 'head')[0]
  const all = buttonsIn(head).find((b) => text(b).startsWith('action.updateAll'))
  assert.match(text(all), /"count":2/)
  const only = await load(selfSnap([selfRow()]))
  const onlyHead = find(renderHook(only.slot('plugin-updater.installed-hook'), hostsFor([])), (n) => n.props?.key === 'head')[0]
  assert.ok(!buttonsIn(onlyHead).some((b) => text(b).startsWith('action.updateAll')))
})

test('self-updated snackbar: shown once per session, not again after a reload', async () => {
  const snap = selfSnap([selfRow({ state: 'up-to-date' })], { selfUpdated: { from: '1.0.0', to: '1.1.0', at: 99 } })
  const storage = new Map()
  const session = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) }
  const first = await load(snap, { session })
  const bar = first.slot('plugin-updater.run-snackbar')
  assert.match(text(render(React.createElement(bar.component, bar.options.inject()))), /self\.done .*"version":"1\.1\.0"/)
  // Same session, page reloaded: the stored marker keeps it quiet.
  const second = await load(snap, { session })
  const bar2 = second.slot('plugin-updater.run-snackbar')
  assert.equal(render(React.createElement(bar2.component, bar2.options.inject())), null)
})

test('VersionDropdown: renders options, distinguishing latest tagged and latest untagged', async () => {
  const { module } = await load()
  const { VersionDropdown } = module.__test__
  const versions = [
    { label: 'v1.2.0', ref: 'v1.2.0', isLatestTagged: true, isLatestUntagged: false },
    { label: 'v1.0.0', ref: 'v1.0.0', isLatestTagged: false, isLatestUntagged: false },
    { label: 'latest untagged', ref: 'main', isLatestTagged: false, isLatestUntagged: true },
  ]
  let selected = 'v1.2.0'
  const t = (key) => key
  const el = render(React.createElement(VersionDropdown, {
    versions,
    selectedRef: selected,
    onChange: (val) => { selected = val },
    t,
  }))
  assert.equal(el.type, 'select')
  assert.equal(el.children.length, 3)
  assert.match(text(el.children[0]), /v1\.2\.0 \(version\.latestTagged\)/)
  assert.match(text(el.children[1]), /v1\.0\.0/)
  assert.match(text(el.children[2]), /latest untagged \(version\.latestUntagged\)/)
  assert.equal(el.props.value, 'v1.2.0')
  el.props.onChange({ target: { value: 'main' } })
  assert.equal(selected, 'main')
})

test('InstallVersionControl: mounts on data-plugin-install and installs chosen version', async () => {
  const { module } = await load()
  const { attachHosts, InstallVersionControl } = module.__test__
  const doc = page(['a'])
  doc.body.appendChild(el('div', { 'data-plugin-install': 'true' }))
  const mounts = attachHosts(doc, new Set())
  assert.ok(mounts.install, 'install host mounted')
  assert.equal(mounts.install.getAttribute('data-plu-host'), 'install')

  let installedArgs = null
  const mockActions = {
    fetchVersions: async () => ({
      versions: [
        { label: 'v2.0.0', ref: 'v2.0.0', isLatestTagged: true },
        { label: 'latest untagged', ref: 'main', isLatestUntagged: true },
      ],
      defaultRef: 'v2.0.0',
    }),
    installVersion: async (args) => { installedArgs = args },
  }
  const t = (k) => k

  // Test control directly
  React.forcedStates = [
    'acme/myplugin',
    {
      versions: [
        { label: 'v2.0.0', ref: 'v2.0.0', isLatestTagged: true },
        { label: 'latest untagged', ref: 'main', isLatestUntagged: true },
      ],
      defaultRef: 'v2.0.0',
    },
    'main',
  ]
  try {
    const ctrl = render(React.createElement(InstallVersionControl, { actions: mockActions, busy: false, t }))
    assert.equal(ctrl.type, 'div')
    const button = find(ctrl, (n) => n.type === 'button')[0]
    assert.equal(text(button), 'action.install')
    button.props.onClick()
    assert.deepEqual(installedArgs, { repo: 'acme/myplugin', ref: 'main' })
  } finally {
    React.forcedStates = undefined
  }
})

test('DetailVersionSelector: renders dropdown on detail page and handles version switch', async () => {
  const { slot } = await load()
  const selectorSlot = slot('plugin-updater.version-selector')
  assert.ok(selectorSlot, 'version-selector slot registered')

  const subject = { kind: 'bundle', pkg: { name: 'a' } }
  const face = selectorSlot.options.inject()
  React.forcedState = {
    versions: [
      { label: 'v1.1.0', ref: 'v1.1.0', isLatestTagged: true },
      { label: 'v1.0.0', ref: 'v1.0.0' },
      { label: 'latest untagged', ref: 'main', isLatestUntagged: true },
    ],
    defaultRef: 'v1.1.0',
    latestTagged: 'v1.1.0',
  }
  try {
    const el = render(React.createElement(selectorSlot.component, { ...face, subject }))
    assert.ok(el, 'rendered version selector component')
    assert.equal(el.type, 'div')
    const select = find(el, (n) => n.type === 'select')[0]
    assert.ok(select, 'select dropdown exists')
  } finally {
    React.forcedState = undefined
  }
})

test('InstallModal and SectionHead: toolbar button opens modal, modal discovers versions and installs', async () => {
  const { module, slot } = await load()
  const { installModalOpen, InstallModal } = module.__test__

  // 1. Toolbar has "action.installPlugin" button which opens modal
  const hookSlot = slot('plugin-updater.installed-hook')
  const tree = renderHook(hookSlot, hostsFor(['a']))
  const head = find(tree, (n) => n.type === 'portal' && n.props.key === 'head')[0]
  const installBtn = find(head, (n) => n.type === 'button' && text(n).includes('action.installPlugin'))[0]
  assert.ok(installBtn, 'Install plugin button is present in SectionHead toolbar')

  assert.equal(installModalOpen.get(), false)
  installBtn.props.onClick()
  assert.equal(installModalOpen.get(), true, 'clicking button opens modal')

  // 2. InstallModal renders with inputs and dropdown
  let installedArgs = null
  const mockActions = {
    fetchVersions: async () => ({
      versions: [
        { label: 'v1.5.0', ref: 'v1.5.0', isLatestTagged: true },
        { label: 'latest untagged', ref: 'main', isLatestUntagged: true },
      ],
      defaultRef: 'v1.5.0',
    }),
    installVersion: async (args) => { installedArgs = args; return Promise.resolve() },
  }
  const t = (k) => k

  // Force state for InstallModal: spec, versionsData, selectedRef
  React.forcedStates = [
    'acme/newpkg',
    {
      versions: [
        { label: 'v1.5.0', ref: 'v1.5.0', isLatestTagged: true },
        { label: 'latest untagged', ref: 'main', isLatestUntagged: true },
      ],
      defaultRef: 'v1.5.0',
    },
    'v1.5.0',
  ]
  try {
    const modal = render(React.createElement(InstallModal, {
      actions: mockActions,
      t,
      store: { get: () => SNAP, subscribe: () => () => {} },
    }))
    assert.ok(modal, 'modal rendered')
    const button = find(modal, (n) => n.type === 'button' && text(n) === 'action.install')[0]
    assert.ok(button, 'install button exists')
    button.props.onClick()
    assert.deepEqual(installedArgs, { repo: 'acme/newpkg', ref: 'v1.5.0' })
  } finally {
    React.forcedStates = undefined
    installModalOpen.set(false)
  }
})

test('DetailVersionSelector: renders immediate fallback select even without prior fetch', async () => {
  const { slot } = await load()
  const selectorSlot = slot('plugin-updater.version-selector')
  const subject = { kind: 'bundle', name: 'a' } // uses subject.name
  const face = selectorSlot.options.inject()

  const el = render(React.createElement(selectorSlot.component, { ...face, subject }))
  assert.ok(el, 'rendered version selector component')
  const select = find(el, (n) => n.type === 'select')[0]
  assert.ok(select, 'immediate select dropdown exists')
  assert.equal(select.children.length, 1)
  assert.match(text(select.children[0]), /v1\.0\.0|main/)
})

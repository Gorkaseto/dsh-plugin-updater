/**
 * Plugin updater — Client half of the dsh-plugin-updater bundle.
 *
 * Everything renders inside dsh's native Plugins page (`main` panel
 * `plugins`, from `@deepseek-ai/dsh-client-ui-plugin-manager`), with no tab
 * of its own:
 *
 * - **Installed plugins section.** It has no extension seat, so a
 *   `shell.overlay` entry watches for `section[data-plugin-group="bundles"]`
 *   and its `li[data-plugin-package]` cards and mounts portal hosts next to
 *   the page's own nodes: a toolbar under the heading (check for updates,
 *   update all, last checked, status lines) and, on each GitHub card that has
 *   something to say, a state tag in the title row, an Update button before
 *   the switch and a reason line. React re-renders that drop a host are
 *   repaired on the next scan. A harness update that changes this markup may
 *   need a matching tweak in `SEL` below.
 * - **Detail page.** The official `plugins.detail.badge` ("Update available ·
 *   x.y.z") and `plugins.detail.actions` (Update) seats.
 *
 * A second `shell.overlay` toast announces the startup check's result once
 * per page load; its View opens the Plugins page (Installed by default) and
 * scrolls the Installed plugins section into view. A third is the snackbar
 * that briefly reports each finished update (single or Update all).
 *
 * All surfaces read one store holding the Host's last `pluginupdater/status`
 * snapshot, polled while a check or an update runs. Host methods are served
 * by the Gateway's SRC fallback, so they are called straight over the
 * Connection carrier (`connection.rpc.call('/api', …)`). Styles use theme
 * tokens under this plugin's `plu-` prefix.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-updater',
  factory(require) {
    const React = require('react')
    const { createPortal } = require('react-dom')
    // dsh's own dialog pieces (a shared platform module), so confirmations look native;
    // null on a dsh that does not share them.
    let Primitives = null
    try { Primitives = require('@deepseek-ai/dsh-client-ui-primitives') } catch { Primitives = null }
    const h = React.createElement
    const { Fragment, useEffect, useState, useSyncExternalStore } = React

    const NS = 'plugin-updater'
    const PLUGINS_PANEL = 'plugins'
    const BUSY_POLL_MS = 1000
    const IDLE_POLL_MS = 2000
    const IDLE_POLL_TRIES = 30
    // The page loads its plugin list asynchronously; wait this long for the section.
    const SCROLL_WAIT_MS = 5000
    const SNACKBAR_MS = 6000
    const TOAST_MS = 3000
    const DISMISS_KEY = 'plugin-updater.toast-dismissed'
    const SELF_SEEN_KEY = 'plugin-updater.self-updated'

    // The native page's markup this plugin attaches to (ui-plugin-manager's
    // `renderGroup` / `PackageCard`): the Installed plugins group, its head
    // `div` first, and cards whose first child is the card head — icon `span`,
    // main `div` (title row first), then the end `div` holding the switch.
    const SEL = {
      section: { tag: 'SECTION', attr: 'data-plugin-group', value: 'bundles' },
      card: { tag: 'LI', attr: 'data-plugin-package' },
    }
    const HOST = 'data-plu-host'

    // ---------------------------------------------------------------- copy

    const en = {
      'head.hint': 'Plugins installed from GitHub are compared with the version in package.json on the latest commit of their repository’s main branch.',
      'action.check': 'Check for updates',
      'action.checking': 'Checking…',
      'action.updateAll': 'Update all ({count})',
      'action.update': 'Update',
      'action.updating': 'Updating…',
      'action.view': 'View',
      'action.dismiss': 'Dismiss',
      'action.cancel': 'Cancel',
      'action.updateAllShort': 'Update all',
      'last.never': 'Not checked yet',
      'last.at': 'Last checked {time}',
      'empty': 'No plugins installed from GitHub were found in this profile.',
      'unsupported': 'Update checks are not available: this dsh version has no plugin manager service. Update dsh to 0.2 or later.',
      'checkError': 'Couldn’t list the installed plugins: {message}',
      'state.up-to-date': 'up to date',
      'state.update-available': 'update available',
      'state.updating': 'updating',
      'state.failed': 'update failed',
      'state.unknown': 'update check failed',
      'row.pinned': 'pinned to {ref}',
      'row.self': 'This is the updater itself: update it by uninstalling and reinstalling it.',
      'self.action': 'Update Plugin Updater',
      'self.title': 'Update Plugin Updater?',
      'self.confirm': 'Plugin Updater will replace itself with the version on main ({version}). The Plugins page may reload while it does, and dsh may need a restart to finish.',
      'self.hint': 'The updater updates itself and then reloads.',
      'self.done': 'Plugin Updater updated to {version}.',
      'pin.title': 'Update pinned plugin?',
      'pin.titleAll': 'Update pinned plugins?',
      'pin.confirm': '{name} is pinned to {ref}. Updating reinstalls it from main, and it will track main from then on.',
      'pin.confirmAll': 'Some plugins are pinned ({names}). Updating reinstalls them from main, and they will track main from then on.',
      'restart': 'Restart dsh to finish applying these updates: {names}.',
      'run.single': 'Updated {updated}, failed {failed}.',
      'run.all': 'Update all finished: {updated} updated, {failed} failed.',
      'badge': 'Update available · {version}',
      'toast': '{count} plugin update(s) available.',
      'reason.not-found': 'repository, main branch or package not found (private?)',
      'reason.no-package-json': 'no package.json on main',
      'reason.bad-json': 'package.json on main is not valid JSON',
      'reason.no-version': 'package.json on main declares no version',
      'reason.invalid-version': 'not a valid version: {detail}',
      'reason.http': 'GitHub answered HTTP {detail}',
      'reason.network': 'network error ({detail})',
      'reason.timeout': 'GitHub did not answer in time',
      'reason.unsupported-spec': 'installed from a repository subfolder, which is not supported',
      'reason.update-failed': 'update failed, previous version kept: {detail}',
      'reason.restore-failed': 'update failed and the previous version could not be restored; reinstall it by hand: {detail}',
      'reason.unsupported': 'the plugin manager is not available',
      'reason.self-unavailable': 'self-update is not available in this dsh version',
      'reason.error': '{detail}',
      'version.latestTagged': 'latest tagged',
      'version.latestUntagged': 'latest untagged',
      'version.select': 'Select version',
      'install.title': 'Install GitHub plugin',
      'install.desc': 'Install a plugin from a GitHub repository at any tagged release or latest untagged.',
      'install.repoLabel': 'Repository',
      'install.repoPlaceholder': 'owner/repo (e.g. acme/my-plugin)',
      'install.loading': 'Fetching available versions…',
      'action.installPlugin': 'Install plugin',
      'action.switchVersion': 'Switch version',
      'action.install': 'Install',
      'action.installing': 'Installing…',
    }

    const es = {
      'head.hint': 'Los plugins instalados desde GitHub se comparan con la versión de package.json en el último commit de la rama main de su repositorio.',
      'action.check': 'Buscar actualizaciones',
      'action.checking': 'Comprobando…',
      'action.updateAll': 'Actualizar todo ({count})',
      'action.update': 'Actualizar',
      'action.updating': 'Actualizando…',
      'action.view': 'Ver',
      'action.dismiss': 'Cerrar',
      'action.cancel': 'Cancelar',
      'action.updateAllShort': 'Actualizar todo',
      'last.never': 'Aún sin comprobar',
      'last.at': 'Última comprobación: {time}',
      'empty': 'No se han encontrado plugins instalados desde GitHub en este perfil.',
      'unsupported': 'La comprobación de actualizaciones no está disponible: esta versión de dsh no tiene el servicio de gestión de plugins. Actualiza dsh a la 0.2 o posterior.',
      'checkError': 'No se pudieron listar los plugins instalados: {message}',
      'state.up-to-date': 'al día',
      'state.update-available': 'actualización disponible',
      'state.updating': 'actualizando',
      'state.failed': 'error al actualizar',
      'state.unknown': 'no se pudo comprobar',
      'row.pinned': 'fijado a {ref}',
      'row.self': 'Es el propio actualizador: actualízalo desinstalándolo y volviéndolo a instalar.',
      'self.action': 'Actualizar Plugin Updater',
      'self.title': '¿Actualizar Plugin Updater?',
      'self.confirm': 'Plugin Updater se sustituirá por la versión de main ({version}). La página de Plugins puede recargarse mientras tanto y puede que haya que reiniciar dsh para terminar.',
      'self.hint': 'El actualizador se actualiza a sí mismo y después se recarga.',
      'self.done': 'Plugin Updater actualizado a {version}.',
      'pin.title': '¿Actualizar el plugin fijado?',
      'pin.titleAll': '¿Actualizar los plugins fijados?',
      'pin.confirm': '{name} está fijado a {ref}. Al actualizar se reinstala desde main y a partir de entonces seguirá main.',
      'pin.confirmAll': 'Algunos plugins están fijados ({names}). Al actualizar se reinstalan desde main y a partir de entonces seguirán main.',
      'restart': 'Reinicia dsh para terminar de aplicar estas actualizaciones: {names}.',
      'run.single': 'Actualizados {updated}, con error {failed}.',
      'run.all': 'Actualizar todo terminado: {updated} actualizados, {failed} con error.',
      'badge': 'Actualización disponible · {version}',
      'toast': '{count} actualización(es) de plugins disponibles.',
      'reason.not-found': 'no se encontró el repositorio, la rama main o el paquete (¿privado?)',
      'reason.no-package-json': 'no hay package.json en main',
      'reason.bad-json': 'el package.json de main no es JSON válido',
      'reason.no-version': 'el package.json de main no declara versión',
      'reason.invalid-version': 'versión no válida: {detail}',
      'reason.http': 'GitHub respondió HTTP {detail}',
      'reason.network': 'error de red ({detail})',
      'reason.timeout': 'GitHub no respondió a tiempo',
      'reason.unsupported-spec': 'instalado desde una subcarpeta del repositorio, lo que no está soportado',
      'reason.update-failed': 'la actualización falló, se mantiene la versión anterior: {detail}',
      'reason.restore-failed': 'la actualización falló y no se pudo restaurar la versión anterior; reinstálalo a mano: {detail}',
      'reason.unsupported': 'el gestor de plugins no está disponible',
      'reason.self-unavailable': 'la autoactualización no está disponible en esta versión de dsh',
      'reason.error': '{detail}',
      'version.latestTagged': 'última con tag',
      'version.latestUntagged': 'última sin tag (main)',
      'version.select': 'Seleccionar versión',
      'install.title': 'Instalar plugin desde GitHub',
      'install.desc': 'Instala un plugin desde un repositorio de GitHub eligiendo una versión o la última sin tag.',
      'install.repoLabel': 'Repositorio',
      'install.repoPlaceholder': 'owner/repo (ej. acme/mi-plugin)',
      'install.loading': 'Buscando versiones disponibles…',
      'action.installPlugin': 'Instalar plugin',
      'action.switchVersion': 'Cambiar versión',
      'action.install': 'Instalar',
      'action.installing': 'Instalando…',
    }

    const CSS = `
[data-plu-host="head"] { display: flex; flex-direction: column; gap: 6px; margin: 0 0 10px; color: var(--dsw-alias-label-primary); font-family: var(--dsw-font-family); font-size: 12px; }
[data-plu-host="tag"] { display: inline-flex; align-items: center; gap: 4px; margin-left: 6px; vertical-align: middle; }
/* The card title's ::after stretches over the whole card; like the native switch, sit above it. */
[data-plu-host="action"] { position: relative; z-index: 1; display: flex; align-items: center; flex: none; margin: 0 10px 0 auto; }
[data-plu-host="reason"] { display: block; }
[data-plu-host="install"] { margin: 8px 0; }
.plu-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.plu-grow { flex: 1; }
.plu-hint { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 1.5; }
.plu-btn { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; padding: 4px 10px; cursor: pointer; white-space: nowrap; }
.plu-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.plu-btn:disabled { opacity: .5; cursor: default; }
.plu-btn.plu-primary { background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-base); border-color: transparent; }
.plu-btn.plu-primary:hover:not(:disabled) { opacity: .9; background: var(--dsw-alias-label-primary); }
.plu-badge { font-size: 11px; line-height: 16px; padding: 0 6px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); white-space: nowrap; font-weight: 400; }
.plu-badge.plu-new { color: var(--dsw-alias-state-success-primary, var(--dsw-alias-brand-primary)); border-color: currentColor; }
.plu-badge.plu-warn { color: var(--dsw-alias-state-warn-primary); border-color: currentColor; }
.plu-badge.plu-err { color: var(--dsw-alias-state-error-primary); border-color: currentColor; }
.plu-reason { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 1.45; padding: 4px 0 0 0; }
.plu-reason.plu-err { color: var(--dsw-alias-state-error-primary); }
.plu-banner { border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; padding: 6px 10px; font-size: 12px; line-height: 1.5; }
.plu-banner.plu-warn { border-color: var(--dsw-alias-state-warn-primary); }
.plu-banner.plu-err { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.plu-toast { position: fixed; z-index: 10001; left: 50%; bottom: 24px; transform: translateX(-50%); display: flex; align-items: center; gap: 12px; padding: 8px 10px 8px 14px; border-radius: 10px; background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-base); font-family: var(--dsw-font-family); font-size: 13px; box-shadow: 0 8px 24px rgba(0,0,0,.25); max-width: min(640px, calc(100vw - 32px)); }
.plu-toast-timed { overflow: hidden; }
.plu-toast-bar { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: currentColor; opacity: .5; transform-origin: left; animation: plu-toast-timeout linear forwards; }
@keyframes plu-toast-timeout { from { transform: scaleX(1); } to { transform: scaleX(0); } }
.plu-toast.plu-err { background: var(--dsw-alias-state-error-primary); color: #fff; }
.plu-toast button { border: none; background: transparent; color: inherit; font: inherit; font-weight: 600; cursor: pointer; text-decoration: underline; }
.plu-select { border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; padding: 3px 8px; cursor: pointer; }
.plu-input { border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; padding: 4px 8px; }
.plu-detail-version { display: inline-flex; align-items: center; gap: 8px; margin-right: 8px; }
.plu-install-row { display: flex; align-items: center; gap: 8px; margin: 8px 0; }
.plu-modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 10002; display: flex; align-items: center; justify-content: center; }
.plu-modal { background: var(--dsw-alias-bg-base, #1e1e1e); color: var(--dsw-alias-label-primary, #fff); border: 1px solid var(--dsw-alias-border-l2, #333); border-radius: 12px; padding: 20px; width: 440px; max-width: calc(100vw - 32px); box-shadow: 0 16px 32px rgba(0,0,0,0.4); font-family: var(--dsw-font-family); font-size: 13px; display: flex; flex-direction: column; gap: 14px; }
.plu-modal h3 { margin: 0; font-size: 15px; font-weight: 600; }
.plu-modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
`

    // ---------------------------------------------------------------- store

    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        get: () => value,
        set(next) { value = next; for (const fn of listeners) fn() },
        subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn) } },
      }
    }

    function useStoreValue(store) {
      return useSyncExternalStore(store.subscribe, store.get)
    }

    const busyOf = (snap) => snap !== null && (snap.checking || snap.updating)
    const updatable = (snap) => (snap?.plugins ?? []).filter((p) => p.state === 'update-available' && !p.self)
    // Up-to-date cards stay exactly as the page draws them.
    const showsOnCard = (row) => row.state !== 'up-to-date'

    function readDismissed() {
      try { return window.sessionStorage.getItem(DISMISS_KEY) } catch { return null }
    }

    function writeDismissed(value) {
      try { window.sessionStorage.setItem(DISMISS_KEY, value) } catch { /* storage unavailable: the toast just shows again next load */ }
    }

    function readSelfSeen() {
      try { return window.sessionStorage.getItem(SELF_SEEN_KEY) } catch { return null }
    }

    function writeSelfSeen(value) {
      try { window.sessionStorage.setItem(SELF_SEEN_KEY, value) } catch { /* storage unavailable: the Host still marks it announced */ }
    }

    // ---------------------------------------------------------------- hosts

    const matches = (el, sel) => el?.tagName === sel.tag && el.hasAttribute(sel.attr)
      && (sel.value === undefined || el.getAttribute(sel.attr) === sel.value)

    function findAll(root, sel) {
      const out = []
      const walk = (el) => {
        for (const child of el.children) {
          if (child.hasAttribute(HOST)) continue
          if (matches(child, sel)) out.push(child)
          walk(child)
        }
      }
      if (root !== null && root !== undefined) walk(root)
      return out
    }

    const ownChild = (parent, kind) => [...parent.children].find((c) => c.getAttribute(HOST) === kind) ?? null
    const nativeChildren = (parent) => [...parent.children].filter((c) => !c.hasAttribute(HOST))

    /** `parent`'s host of `kind`, created (or moved back) just before `before`. */
    function ensureHost(doc, parent, kind, before, tagName = 'div') {
      let host = ownChild(parent, kind)
      if (host === null) {
        host = doc.createElement(tagName)
        host.setAttribute(HOST, kind)
      }
      // `before` is the host itself when it already sits right after its anchor.
      if (before === host) return host
      if (host.parentNode !== parent || host.nextSibling !== before) parent.insertBefore(host, before)
      return host
    }

    /**
     * Mount (or repair) the portal hosts in the Installed plugins section:
     * the head host after the section's head `div`, and tag/action/reason
     * hosts on the cards named in `wanted`. Hosts on other cards are removed.
     * @returns `{ section, head, cards: Map<name, { tag, action, reason }>, install: Element | null }`.
     */
    function attachHosts(doc, wanted) {
      const section = findAll(doc.body, SEL.section)[0] ?? null
      const cards = new Map()
      const installEl = findAll(doc.body, { tag: 'DIV', attr: 'data-plugin-install' })[0]
        ?? findAll(doc.body, { tag: 'SECTION', attr: 'data-plugin-install' })[0]
        ?? null
      const install = installEl !== null ? ensureHost(doc, installEl, 'install', null) : null
      if (section === null) return { section: null, head: null, cards, install }
      const headDiv = nativeChildren(section)[0] ?? null
      const head = ensureHost(doc, section, 'head', headDiv === null ? null : headDiv.nextSibling)
      for (const li of findAll(section, SEL.card)) {
        const name = li.getAttribute(SEL.card.attr)
        const cardHead = nativeChildren(li)[0]
        const parts = cardHead === undefined ? [] : nativeChildren(cardHead)
        const titleRow = parts[1] === undefined ? undefined : nativeChildren(parts[1])[0]
        if (!wanted.has(name) || titleRow === undefined) {
          for (const host of [...li.querySelectorAll(`[${HOST}]`)]) host.remove()
          continue
        }
        const end = parts.length > 2 ? parts[parts.length - 1] : null
        cards.set(name, {
          tag: ensureHost(doc, titleRow, 'tag', null, 'span'),
          action: ensureHost(doc, cardHead, 'action', end),
          reason: ensureHost(doc, li, 'reason', cardHead.nextSibling),
        })
      }
      return { section, head, cards, install }
    }

    function detachHosts(doc) {
      for (const host of [...doc.querySelectorAll(`[${HOST}]`)]) host.remove()
    }

    /** Whether a mutation only touched this plugin's own hosts. */
    function ownMutation(record) {
      const own = (node) => node.nodeType === 1 && node.hasAttribute?.(HOST)
      if (record.target?.closest?.(`[${HOST}]`)) return true
      const nodes = [...record.addedNodes, ...record.removedNodes]
      return nodes.length > 0 && nodes.every(own)
    }

    const sameMounts = (a, b) => a.head === b.head && a.install === b.install && a.cards.size === b.cards.size
      && [...a.cards].every(([name, m]) => {
        const n = b.cards.get(name)
        return n !== undefined && n.tag === m.tag && n.action === m.action && n.reason === m.reason
      })

    // ---------------------------------------------------------------- views

    function reasonText(t, reason) {
      if (reason === null || reason === undefined) return null
      const key = `reason.${reason.code}`
      const text = t(key, { detail: reason.detail ?? '' })
      return text === key ? `${reason.code}${reason.detail ? `: ${reason.detail}` : ''}` : text
    }

    function stateClass(state) {
      if (state === 'update-available') return 'plu-badge plu-new'
      if (state === 'failed') return 'plu-badge plu-err'
      if (state === 'unknown' || state === 'updating') return 'plu-badge plu-warn'
      return 'plu-badge'
    }

    // The open confirmation: `{ title, description, confirmLabel, resolve }`, rendered by `ConfirmDialog`.
    const confirmRequest = createStore(null)
    const installModalOpen = createStore(false)

    /** An in-app confirmation; resolves true to go ahead. */
    function askConfirm(request) {
      if (Primitives === null) return Promise.resolve(window.confirm(request.description))
      return new Promise((resolve) => {
        confirmRequest.get()?.resolve(false)
        confirmRequest.set({ ...request, resolve })
      })
    }

    /** Ask before an update that drops a `#ref` pin; resolves true to go ahead. */
    function confirmPins(t, rows) {
      const pinned = rows.filter((r) => r.pinnedRef !== null)
      if (pinned.length === 0) return Promise.resolve(true)
      const one = rows.length === 1
      return askConfirm({
        title: t(one ? 'pin.title' : 'pin.titleAll'),
        description: one
          ? t('pin.confirm', { name: pinned[0].name, ref: pinned[0].pinnedRef })
          : t('pin.confirmAll', { names: pinned.map((p) => p.name).join(', ') }),
        confirmLabel: t(one ? 'action.update' : 'action.updateAllShort'),
      })
    }

    function startUpdate(t, actions, row) {
      confirmPins(t, [row]).then((ok) => { if (ok) actions.update(row.name) })
    }

    /** dsh's own `Modal` with Cancel / Update, for the request `askConfirm` opened. */
    function ConfirmDialog({ t }) {
      const request = useStoreValue(confirmRequest)
      if (Primitives === null || request === null) return null
      const { Modal, Button } = Primitives
      const done = (ok) => {
        if (confirmRequest.get() === request) confirmRequest.set(null)
        request.resolve(ok)
      }
      return h(Modal, {
        open: true,
        onClose: () => done(false),
        title: request.title,
        closeLabel: t('action.dismiss'),
        description: request.description,
        footer: h(Fragment, null,
          h(Button, { variant: 'outline', onClick: () => done(false) }, t('action.cancel')),
          h(Button, { variant: 'primary', autoFocus: true, onClick: () => done(true) }, request.confirmLabel)),
      })
    }

    /** The toolbar and status lines under the Installed plugins heading. */
    function SectionHead({ snap, actions, t }) {
      if (snap === null) return null
      if (!snap.supported) return h('div', { className: 'plu-hint' }, t('unsupported'))
      const busy = busyOf(snap)
      const ready = updatable(snap)
      const restart = snap.plugins.filter((p) => p.restartRequired).map((p) => p.name)
      const updateAll = () => { confirmPins(t, ready).then((ok) => { if (ok) actions.updateAll() }) }
      return h(Fragment, null,
        h('div', { className: 'plu-toolbar' },
          h('span', { className: 'plu-hint plu-grow', title: t('head.hint') },
            snap.lastCheckedAt === null ? t('last.never') : t('last.at', { time: new Date(snap.lastCheckedAt).toLocaleString() })),
          h('button', { type: 'button', className: 'plu-btn plu-primary', disabled: busy, onClick: () => installModalOpen.set(true), title: t('install.title') },
            t('action.installPlugin')),
          h('button', { type: 'button', className: 'plu-btn', disabled: busy, onClick: actions.check, title: t('head.hint') },
            snap.checking ? t('action.checking') : t('action.check')),
          ready.length > 0
            ? h('button', { type: 'button', className: 'plu-btn plu-primary', disabled: busy, onClick: updateAll }, t('action.updateAll', { count: ready.length }))
            : null,
        ),
        snap.checkError ? h('div', { className: 'plu-banner plu-err' }, t('checkError', { message: snap.checkError.detail ?? snap.checkError.code })) : null,
        restart.length > 0 ? h('div', { className: 'plu-banner plu-warn' }, t('restart', { names: restart.join(', ') })) : null,
        snap.plugins.length === 0 && snap.lastCheckedAt !== null && !snap.checking
          ? h('div', { className: 'plu-hint' }, t('empty'))
          : null,
      )
    }

    function CardTag({ row, t }) {
      return h(Fragment, null,
        h('span', { className: stateClass(row.state) },
          row.state === 'update-available' ? t('badge', { version: row.latest }) : t(`state.${row.state}`)),
        row.pinnedRef !== null ? h('span', { className: 'plu-badge' }, t('row.pinned', { ref: row.pinnedRef })) : null)
    }

    // A circular arrow: marks the self-update control apart from per-plugin updates.
    const REFRESH_ICON = h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
      h('path', { d: 'M21 12a9 9 0 1 1-2.64-6.36' }), h('path', { d: 'M21 3v6h-6' }))

    /** Always asks (pinned or not), then starts the updater's own in-place update. */
    function startSelfUpdate(t, actions, row) {
      const pin = row.pinnedRef !== null ? ` ${t('pin.confirm', { name: row.name, ref: row.pinnedRef })}` : ''
      askConfirm({
        title: t('self.title'),
        description: `${t('self.confirm', { version: row.latest })}${pin}`,
        confirmLabel: t('self.action'),
      }).then((ok) => { if (ok) actions.selfUpdate() })
    }

    /** The self-update control: dsh's secondary (outline) button with a refresh icon. */
    function SelfUpdateButton({ row, busy, actions, t }) {
      const onClick = () => startSelfUpdate(t, actions, row)
      if (Primitives !== null) {
        return h(Primitives.Button, { variant: 'outline', size: 'sm', icon: REFRESH_ICON, disabled: busy, onClick, 'data-plu-self': '' }, t('self.action'))
      }
      return h('button', { type: 'button', className: 'plu-btn', disabled: busy, onClick, 'data-plu-self': '' }, REFRESH_ICON, t('self.action'))
    }

    function CardAction({ row, busy, selfAvailable, actions, t }) {
      if (row.state === 'updating') return h('span', { className: 'plu-hint' }, t('action.updating'))
      if (row.state !== 'update-available') return null
      if (row.self) return selfAvailable ? h(SelfUpdateButton, { row, busy, actions, t }) : null
      return h('button', { type: 'button', className: 'plu-btn plu-primary', disabled: busy, onClick: () => startUpdate(t, actions, row) },
        t('action.update'))
    }

    function CardReason({ row, selfAvailable, t }) {
      const text = row.self && row.state === 'update-available'
        ? t(selfAvailable ? 'self.hint' : 'row.self')
        : reasonText(t, row.reason)
      if (text === null) return null
      return h('div', { className: `plu-reason${row.state === 'failed' ? ' plu-err' : ''}` }, text)
    }

    function parseGithubSource(source) {
      if (typeof source !== 'string') return null
      const spec = source.trim()
      const hash = spec.indexOf('#')
      const base = hash === -1 ? spec : spec.slice(0, hash)
      const ref = hash === -1 ? '' : spec.slice(hash + 1)
      const match = /^github:([\w.-]+)\/([\w.-]+)$/i.exec(base)
        ?? /^([\w.-]+)\/([\w.-]+)$/i.exec(base)
        ?? /^(?:git\+)?https?:\/\/(?:[^@/]+@)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(base)
        ?? /^(?:git\+)?ssh:\/\/git@github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i.exec(base)
        ?? /^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i.exec(base)
      if (match === null) return null
      const owner = match[1]
      const repo = match[2].replace(/\.git$/i, '')
      if (/(^|&)path:/.test(ref)) return { owner, repo, unsupported: 'path' }
      const pinned = ref.split('&').find((part) => part !== '' && !part.startsWith('semver:')) ?? null
      return { owner, repo, pinnedRef: pinned === null || pinned === 'main' ? null : pinned }
    }

    function VersionDropdown({ versions = [], selectedRef, onChange, disabled, t, className = 'plu-select' }) {
      return h('select', {
        className,
        disabled: disabled || versions.length === 0,
        value: selectedRef ?? '',
        onChange: (e) => onChange?.(e.target.value),
      }, versions.map((v) => {
        let suffix = ''
        if (v.isLatestTagged) suffix = ` (${t('version.latestTagged') || 'latest tagged'})`
        else if (v.isLatestUntagged) suffix = ` (${t('version.latestUntagged') || 'latest untagged'})`
        return h('option', { key: v.ref, value: v.ref }, `${v.label}${suffix}`)
      }))
    }

    function InstallVersionControl({ actions, busy, t }) {
      const [spec, setSpec] = useState('')
      const [versionsData, setVersionsData] = useState(null)
      const [selectedRef, setSelectedRef] = useState(null)
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState(null)

      const onSpecChange = (val) => {
        setSpec(val)
        const parsed = parseGithubSource(val)
        if (parsed && !parsed.unsupported) {
          setLoading(true)
          actions.fetchVersions(parsed.owner, parsed.repo)
            .then((res) => {
              setVersionsData(res)
              setSelectedRef(res.defaultRef)
              setError(null)
            })
            .catch((err) => {
              setError(err.message)
              setVersionsData(null)
            })
            .finally(() => setLoading(false))
        } else {
          setVersionsData(null)
          setSelectedRef(null)
          setError(null)
        }
      }

      const onInstall = () => {
        const parsed = parseGithubSource(spec)
        if (!parsed || busy || loading) return
        const ref = selectedRef ?? versionsData?.defaultRef ?? 'main'
        actions.installVersion({
          repo: `${parsed.owner}/${parsed.repo}`,
          ref,
        })
      }

      return h('div', { className: 'plu-install-row' },
        h('input', {
          type: 'text',
          className: 'plu-input',
          placeholder: 'owner/repo or github:owner/repo',
          value: spec,
          onChange: (e) => onSpecChange(e.target.value),
        }),
        versionsData && versionsData.versions?.length > 0 ? h(VersionDropdown, {
          versions: versionsData.versions,
          selectedRef: selectedRef ?? versionsData.defaultRef,
          onChange: setSelectedRef,
          disabled: busy || loading,
          t,
        }) : null,
        h('button', {
          type: 'button',
          className: 'plu-btn plu-primary',
          disabled: busy || loading || !versionsData,
          onClick: onInstall,
        }, t('action.install'))
      )
    }

    function InstallModal({ actions, t, store }) {
      const open = useStoreValue(installModalOpen)
      const snap = useStoreValue(store)
      const busy = busyOf(snap)
      const [spec, setSpec] = useState('')
      const [versionsData, setVersionsData] = useState(null)
      const [selectedRef, setSelectedRef] = useState(null)
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState(null)

      if (!open) return null

      const onClose = () => {
        installModalOpen.set(false)
        setSpec('')
        setVersionsData(null)
        setSelectedRef(null)
        setError(null)
      }

      const onSpecChange = (val) => {
        setSpec(val)
        const parsed = parseGithubSource(val)
        if (parsed && !parsed.unsupported) {
          setLoading(true)
          setError(null)
          actions.fetchVersions(parsed.owner, parsed.repo)
            .then((res) => {
              setVersionsData(res)
              setSelectedRef(res.defaultRef)
              setError(null)
            })
            .catch((err) => {
              setError(err.message)
              setVersionsData(null)
            })
            .finally(() => setLoading(false))
        } else {
          setVersionsData(null)
          setSelectedRef(null)
          setError(null)
        }
      }

      const onInstall = () => {
        const parsed = parseGithubSource(spec)
        if (!parsed || busy || loading) return
        const ref = selectedRef ?? versionsData?.defaultRef ?? 'main'
        actions.installVersion({
          repo: `${parsed.owner}/${parsed.repo}`,
          ref,
        }).then(() => {
          onClose()
        })
      }

      const content = h('div', { className: 'plu-modal-body', style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
        h('p', { className: 'plu-hint', style: { margin: 0 } }, t('install.desc')),
        h('label', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          h('span', { style: { fontWeight: 500 } }, t('install.repoLabel')),
          h('input', {
            type: 'text',
            className: 'plu-input',
            placeholder: t('install.repoPlaceholder'),
            value: spec,
            autoFocus: true,
            onChange: (e) => onSpecChange(e.target.value),
          })
        ),
        loading ? h('div', { className: 'plu-hint' }, t('install.loading')) : null,
        error ? h('div', { className: 'plu-banner plu-err' }, error) : null,
        versionsData && versionsData.versions?.length > 0 ? h('label', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          h('span', { style: { fontWeight: 500 } }, t('version.select')),
          h(VersionDropdown, {
            versions: versionsData.versions,
            selectedRef: selectedRef ?? versionsData.defaultRef,
            onChange: setSelectedRef,
            disabled: busy || loading,
            t,
          })
        ) : null
      )

      if (Primitives !== null) {
        return h(Primitives.Modal, {
          open: true,
          onClose,
          title: t('install.title'),
          closeLabel: t('action.dismiss'),
          description: content,
          footer: h(Fragment, null,
            h(Primitives.Button, { variant: 'outline', onClick: onClose }, t('action.cancel')),
            h(Primitives.Button, {
              variant: 'primary',
              disabled: busy || loading || !versionsData,
              onClick: onInstall,
            }, busy ? t('action.installing') : t('action.install'))
          ),
        })
      }

      return h('div', { className: 'plu-modal-backdrop', onClick: (e) => { if (e.target === e.currentTarget) onClose() } },
        h('div', { className: 'plu-modal' },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
            h('h3', null, t('install.title')),
            h('button', { type: 'button', className: 'plu-btn', onClick: onClose, style: { padding: '2px 6px' } }, '✕')
          ),
          content,
          h('div', { className: 'plu-modal-actions' },
            h('button', { type: 'button', className: 'plu-btn', onClick: onClose }, t('action.cancel')),
            h('button', {
              type: 'button',
              className: 'plu-btn plu-primary',
              disabled: busy || loading || !versionsData,
              onClick: onInstall,
            }, busy ? t('action.installing') : t('action.install'))
          )
        )
      )
    }

    /** Watches the Plugins page and renders into the hosts `attachHosts` keeps in place. */
    function InstalledHook({ store, actions, t }) {
      const snap = useStoreValue(store)
      const [mounts, setMounts] = useState({ head: null, cards: new Map(), install: null })
      const wantedKey = (snap?.supported ? snap.plugins.filter(showsOnCard).map((p) => p.name) : []).join('\n')

      useEffect(() => {
        const wanted = new Set(wantedKey === '' ? [] : wantedKey.split('\n'))
        let frame = 0
        const scan = () => {
          frame = 0
          const next = attachHosts(document, wanted)
          setMounts((prev) => sameMounts(prev, next) ? prev : next)
        }
        const observer = new MutationObserver((records) => {
          if (records.every(ownMutation)) return
          if (frame === 0) frame = requestAnimationFrame(scan)
        })
        observer.observe(document.body, { childList: true, subtree: true })
        scan()
        return () => {
          observer.disconnect()
          if (frame !== 0) cancelAnimationFrame(frame)
        }
      }, [wantedKey])

      useEffect(() => () => detachHosts(document), [])

      if (snap === null) return null
      const busy = busyOf(snap)
      const selfAvailable = snap.selfUpdateAvailable === true
      const byName = new Map(snap.plugins.map((p) => [p.name, p]))
      const portals = []
      if (mounts.head !== null) portals.push(createPortal(h(SectionHead, { snap, actions, t }), mounts.head, 'head'))
      if (mounts.install !== null) portals.push(createPortal(h(InstallVersionControl, { actions, busy, t }), mounts.install, 'install'))
      for (const [name, m] of mounts.cards) {
        const row = byName.get(name)
        if (row === undefined) continue
        portals.push(createPortal(h(CardTag, { row, t }), m.tag, `tag:${name}`))
        portals.push(createPortal(h(CardAction, { row, busy, selfAvailable, actions, t }), m.action, `action:${name}`))
        portals.push(createPortal(h(CardReason, { row, selfAvailable, t }), m.reason, `reason:${name}`))
      }
      return h(Fragment, null, portals)
    }

    /** The row a native detail page is about, when it is an outdated bundle. */
    function outdatedRow(snap, subject) {
      if (snap === null || subject?.kind !== 'bundle') return null
      const row = snap.plugins.find((p) => p.name === subject.pkg?.name)
      return row !== undefined && (row.state === 'update-available' || row.state === 'updating') ? row : null
    }

    function DetailBadge({ subject, store, t }) {
      const snap = useStoreValue(store)
      const row = outdatedRow(snap, subject)
      if (row === null) return null
      const title = row.self ? t(snap.selfUpdateAvailable === true ? 'self.hint' : 'row.self') : undefined
      return h('span', { className: 'plu-badge plu-new', title }, t('badge', { version: row.latest }))
    }

    function DetailAction({ subject, store, actions, t }) {
      const snap = useStoreValue(store)
      const row = outdatedRow(snap, subject)
      if (row === null) return null
      if (row.self) {
        if (row.state === 'updating') return h('span', { className: 'plu-hint' }, t('action.updating'))
        return snap.selfUpdateAvailable === true ? h(SelfUpdateButton, { row, busy: busyOf(snap), actions, t }) : null
      }
      return h('button', { type: 'button', className: 'plu-btn plu-primary', disabled: busyOf(snap), onClick: () => startUpdate(t, actions, row) },
        row.state === 'updating' ? t('action.updating') : t('action.update'))
    }

    function DetailVersionSelector({ subject, store, actions, t }) {
      const snap = useStoreValue(store)
      if (snap === null) return null
      const name = subject?.pkg?.name ?? subject?.package?.name ?? subject?.name ?? subject?.id
      if (!name) return null
      if (subject?.kind && subject.kind !== 'bundle' && subject.kind !== 'plugin') return null

      const row = snap.plugins?.find((p) => p.name === name)
      if (row?.self) return null

      let repo = row?.repo
      if (!repo) {
        const anySource = subject?.source ?? subject?.pkg?.source ?? subject?.package?.source
          ?? subject?.pkg?.repository?.url ?? subject?.pkg?.repository
          ?? subject?.package?.repository?.url ?? subject?.package?.repository
          ?? subject?.repo
        if (typeof anySource === 'string') {
          const parsed = parseGithubSource(anySource)
          if (parsed && !parsed.unsupported) repo = `${parsed.owner}/${parsed.repo}`
        }
      }
      if (!repo) return null

      const cleanedRepo = repo.replace(/^github:/i, '').replace(/^git\+https?:\/\/github\.com\//i, '').replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').trim()
      const parts = cleanedRepo.split('/')
      const owner = parts[0]
      const rName = parts[1]
      if (!owner || !rName) return null

      const [versionsData, setVersionsData] = useState(null)
      const [loading, setLoading] = useState(false)
      const [selectedRef, setSelectedRef] = useState(null)

      useEffect(() => {
        if (!owner || !rName) return
        setLoading(true)
        if (actions?.fetchVersions) {
          actions.fetchVersions(owner, rName)
            .then((res) => {
              if (res && Array.isArray(res.versions) && res.versions.length > 0) {
                setVersionsData(res)
                setSelectedRef((prev) => prev ?? (row?.pinnedRef ?? res.defaultRef ?? 'main'))
              }
            })
            .catch(() => {})
            .finally(() => setLoading(false))
        }
      }, [owner, rName, row?.pinnedRef])

      const currentRef = row?.pinnedRef ?? 'main'
      const activeRef = selectedRef ?? currentRef
      const isDifferent = activeRef !== currentRef
      const busy = busyOf(snap)

      const onSwitch = () => {
        if (!isDifferent || busy) return
        actions.installVersion({
          name,
          repo,
          ref: activeRef,
          enabled: row?.enabled ?? true,
        })
      }

      const currentLabel = row?.pinnedRef ?? (row?.current ? `v${row.current}` : (row?.installed ? `v${row.installed}` : 'main'))
      const versions = (versionsData && versionsData.versions && versionsData.versions.length > 0)
        ? versionsData.versions
        : [{ label: currentLabel, ref: currentRef, isLatestTagged: false, isLatestUntagged: false }]

      return h('div', { className: 'plu-detail-version' },
        h('span', { className: 'plu-hint', style: { marginRight: '6px' } }, `${t('version.select') || 'Version'}:`),
        h(VersionDropdown, {
          versions,
          selectedRef: activeRef,
          disabled: busy || loading,
          onChange: setSelectedRef,
          t,
        }),
        isDifferent ? h('button', {
          type: 'button',
          className: 'plu-btn plu-primary',
          disabled: busy || loading,
          onClick: onSwitch,
        }, row?.state === 'updating' ? t('action.updating') : t('action.switchVersion')) : null,
        loading ? h('span', { className: 'plu-hint', style: { marginLeft: '6px' } }, t('action.checking') || '…') : null,
      )
    }

    function StartupToast({ store, firstCheck, openPlugins, t }) {
      const snap = useStoreValue(store)
      const first = useStoreValue(firstCheck)
      const [hidden, setHidden] = useState(false)
      // Still the startup result: a later manual check never re-opens the toast.
      const visible = !hidden && first !== null && readDismissed() !== String(first.at) && first.count > 0 &&
        snap !== null && snap.supported
      const close = () => { writeDismissed(String(first.at)); setHidden(true) }
      // Hides by itself; counts as seen, so a reload does not bring it back.
      useEffect(() => {
        if (!visible) return undefined
        const timer = setTimeout(close, TOAST_MS)
        return () => clearTimeout(timer)
      }, [visible])
      if (!visible) return null
      return h('div', { className: 'plu-toast plu-toast-timed', role: 'status' },
        h('span', null, t('toast', { count: first.count })),
        h('button', { onClick: () => { close(); openPlugins() } }, t('action.view')),
        h('button', { onClick: close, 'aria-label': t('action.dismiss') }, '✕'),
        h('div', { className: 'plu-toast-bar', 'aria-hidden': 'true', style: { animationDuration: `${TOAST_MS}ms` } }))
    }

    /** A finished update's summary, shown briefly at the bottom of the window. */
    function RunSnackbar({ runNotice, t }) {
      const run = useStoreValue(runNotice)
      useEffect(() => {
        if (run === null) return undefined
        const timer = setTimeout(() => { if (runNotice.get() === run) runNotice.set(null) }, SNACKBAR_MS)
        return () => clearTimeout(timer)
      }, [run])
      if (run === null) return null
      const text = run.kind === 'self'
        ? t('self.done', { version: run.to })
        : t(run.kind === 'all' ? 'run.all' : 'run.single', { updated: run.updated, failed: run.failed })
      return h('div', { className: `plu-toast${run.failed > 0 ? ' plu-err' : ''}`, role: 'status' },
        h('span', null, text),
        h('button', { onClick: () => runNotice.set(null), 'aria-label': t('action.dismiss') }, '✕'))
    }

    return {
      inject: ['connection', 'locale', 'slots', 'layout'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh: en }), 'dsh-plugin-updater: locale dictionaries')
        ctx.effect(() => {
          try { return ctx.locale.register(NS, 'es', es) } catch { return () => {} }
        }, 'dsh-plugin-updater: es dictionary')
        const t = ctx.locale.bind(NS)

        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.plugin = 'dsh-plugin-updater'
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'dsh-plugin-updater: styles')

        const call = async (endpoint, args = {}) => {
          const result = await ctx.connection.rpc.call('/api', endpoint, { args })
          if (!result.ok) throw new Error(result.error?.message ?? result.error?.code ?? 'unknown failure')
          return result.value
        }

        const store = createStore(null)
        // The first completed check this page sees: the startup toast's subject.
        const firstCheck = createStore(null)
        // The latest finished run to announce; runs already done when the page loaded are not.
        const runNotice = createStore(null)
        let seenRunAt = null
        let primed = false
        let timer = 0
        let idleTries = 0
        let disposed = false

        const publish = (snap) => {
          store.set(snap)
          const at = snap.lastRun?.at ?? null
          if (!primed) { seenRunAt = at; primed = true }
          else if (!snap.updating && at !== null && at !== seenRunAt) { seenRunAt = at; runNotice.set(snap.lastRun) }
          // The new version announces a self-update once per session (the page may have reloaded meanwhile).
          const self = snap.selfUpdated
          if (self && readSelfSeen() !== String(self.at)) {
            writeSelfSeen(String(self.at))
            runNotice.set({ kind: 'self', to: self.to, at: self.at })
          }
          if (firstCheck.get() === null && snap.lastCheckedAt !== null && !snap.checking) {
            firstCheck.set({ at: snap.lastCheckedAt, count: updatable(snap).length })
          }
        }

        const schedule = (snap) => {
          clearTimeout(timer)
          if (disposed) return
          if (busyOf(snap)) { timer = setTimeout(refresh, BUSY_POLL_MS); return }
          // The startup check may not have started when the page boots.
          if (snap.supported && snap.lastCheckedAt === null && idleTries++ < IDLE_POLL_TRIES) timer = setTimeout(refresh, IDLE_POLL_MS)
        }

        async function refresh() {
          try {
            const snap = await call('pluginupdater/status')
            publish(snap)
            schedule(snap)
          } catch {
            // Host not reachable yet (or bundle reloading): try again shortly.
            if (!disposed && idleTries++ < IDLE_POLL_TRIES) timer = setTimeout(refresh, IDLE_POLL_MS)
          }
        }

        const actions = {
          check: () => {
            const snap = store.get()
            if (busyOf(snap)) return
            if (snap !== null) store.set({ ...snap, checking: true })
            call('pluginupdater/check').then(publish, () => {}).finally(refresh)
          },
          update: (name) => {
            const snap = store.get()
            if (busyOf(snap)) return
            if (snap !== null) store.set({ ...snap, updating: true, plugins: snap.plugins.map((p) => p.name === name ? { ...p, state: 'updating' } : p) })
            call('pluginupdater/update', { name }).catch(() => {}).finally(refresh)
          },
          updateAll: () => {
            const snap = store.get()
            if (busyOf(snap)) return
            if (snap !== null) store.set({ ...snap, updating: true })
            call('pluginupdater/updateAll').catch(() => {}).finally(refresh)
          },
          selfUpdate: () => {
            const snap = store.get()
            if (busyOf(snap)) return
            if (snap !== null) store.set({ ...snap, updating: true, plugins: snap.plugins.map((p) => p.self ? { ...p, state: 'updating' } : p) })
            call('pluginupdater/selfUpdate').catch(() => {}).finally(refresh)
          },
          fetchVersions: (ownerOrRepo, maybeRepo) => {
            let owner = ownerOrRepo
            let repo = maybeRepo
            if (typeof ownerOrRepo === 'string' && !maybeRepo && ownerOrRepo.includes('/')) {
              const parts = ownerOrRepo.replace(/^github:/i, '').replace(/\.git$/i, '').split('/')
              owner = parts[0]
              repo = parts[1]
            }
            return call('pluginupdater/versions', { owner, repo, repoName: repo })
          },
          installVersion: ({ name, repo, ref, enabled }) => {
            const snap = store.get()
            if (busyOf(snap)) return Promise.resolve()
            if (snap !== null && name) store.set({ ...snap, updating: true, plugins: snap.plugins.map((p) => p.name === name ? { ...p, state: 'updating' } : p) })
            return call('pluginupdater/installVersion', { name, repo, ref, enabled }).catch(() => {}).finally(refresh)
          },
        }

        ctx.effect(() => {
          disposed = false
          refresh()
          return () => { disposed = true; clearTimeout(timer) }
        }, 'dsh-plugin-updater: status polling')
        ctx.on('connection/reset', () => { idleTries = 0; refresh() })

        const face = { store, actions, t }

        // The page opens on Installed; bring its Installed plugins section into view once it renders.
        const openPlugins = () => {
          ctx.layout.selectPanel(PLUGINS_PANEL)
          const until = Date.now() + SCROLL_WAIT_MS
          const reveal = () => {
            const section = findAll(document.body, SEL.section)[0]
            if (section !== undefined) section.scrollIntoView({ block: 'start', behavior: 'smooth' })
            else if (Date.now() < until) requestAnimationFrame(reveal)
          }
          requestAnimationFrame(reveal)
        }

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'plugin-updater.installed-hook',
          locale: NS,
          inject: () => face,
        }, InstalledHook))

        ctx.slots.inject('plugins.detail.badge', () => ctx.slots.register({
          name: 'plugins.detail.badge',
          id: 'plugin-updater.badge',
          locale: NS,
          inject: () => face,
        }, DetailBadge))

        ctx.slots.inject('plugins.detail.actions', () => ctx.slots.register({
          name: 'plugins.detail.actions',
          id: 'plugin-updater.update',
          locale: NS,
          inject: () => face,
        }, DetailAction))

        ctx.slots.inject('plugins.detail.actions', () => ctx.slots.register({
          name: 'plugins.detail.actions',
          id: 'plugin-updater.version-selector',
          locale: NS,
          inject: () => face,
        }, DetailVersionSelector))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'plugin-updater.startup-toast',
          locale: NS,
          inject: () => ({ store, firstCheck, openPlugins, t }),
        }, StartupToast))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'plugin-updater.run-snackbar',
          locale: NS,
          inject: () => ({ runNotice, t }),
        }, RunSnackbar))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'plugin-updater.confirm',
          locale: NS,
          inject: () => ({ t }),
        }, ConfirmDialog))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'plugin-updater.install-modal',
          locale: NS,
          inject: () => face,
        }, InstallModal))
      },
      __test__: { attachHosts, detachHosts, ownMutation, SEL, HOST, VersionDropdown, InstallVersionControl, InstallModal, installModalOpen, DetailVersionSelector, parseGithubSource },
    }
  },
})

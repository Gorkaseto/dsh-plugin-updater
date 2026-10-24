# Design

## Context

- **Current behaviour.** `add-plugin-update-checker` already reports the updater's own row (`self: true`), skips it in `updateAll()`, and refuses it in `update(name)`. The card shows a "reinstall it by hand" hint.
- **Why `remove` + `install` can't be used for itself.** In dsh 0.2 `pluginManager.removeBundle(name)` first deselects the bundle and reloads with HMR. That stops the bundle's host fiber, here the updater itself, and only then runs `pnpm remove` (`packages/boot/plugin-manager/src/index.ts`, `removeBundle`). The follow-up `installBundle` would have to come from code that was just disposed. If it never ran or failed, the updater would be uninstalled with nothing left to restore it.
- **In-place install primitive.** `@deepseek-ai/dsh-plugin-manager/operations` exports `runPluginCommand(context, args, options)`. It takes the same `package.json` file lock the plugin manager's own changes take (`withFileLock`), then runs `runProfilePnpm` under it.
  - `context` is `{ profile, dir, installAnchor, cwd, home }`.
  - `options` include `command` / `args` / `env` for an application-owned pnpm (Desktop), `execution: 'service'`, `outputBytes` and `idleTimeoutMs`.
  - It returns `{ exitCode, output, timedOut, incompatible, logPath }`.
  - It restores `package.json` and `pnpm-lock.yaml` only when a compatibility check refuses the run, not on other pnpm failures.
- **Where to load it from.** The updater lives outside dsh's install (a `link:` folder in development, `node_modules` from GitHub), so a bare import doesn't resolve. `createRequire(join(installAnchor, 'package.json')).resolve('@deepseek-ai/dsh-plugin-manager/operations')` does: checked against `D:\ARCHIVADOR\deepseek-harness\apps\cli`. The package is ESM, so it's loaded with `import(pathToFileURL(path))`.
- **Applying the change.** `ctx.get('hmr')?.reconcileProfile()` recomposes the profile live. A changed module that can't be swapped reports a `restartReason`. Without HMR (restart-only profiles) the new version loads at the next start.
- **Profile info.** `ctx.get('profileContext')` gives `{ name, dir, installAnchor, cwd, home, packageManager }`.

## Goals / Non-Goals

**Goals:**
- At no time is the updater uninstalled. A failure leaves the running version installed.
- The outcome survives the updater reloading or dsh restarting, and is announced exactly once.
- The self-update control is visibly different from per-plugin updates and is never triggered by "Update all".

**Non-Goals:**
- Updating other plugins in place. They keep the plugin manager's `remove` + `install` path, which reloads them live.
- Approving blocked build scripts for the updater's own repo.
- Self-update for local installs (`link:` / `file:`). Those aren't GitHub sources, so they are never checked.

## Decisions

### 1. In-place `pnpm add` instead of remove + install
`selfUpdate()` runs `runPluginCommand(context, ['add', 'github:owner/repo#main'], { execution: 'service', … })`. pnpm replaces the dependency spec and the files under `node_modules/<name>` while the old version keeps running from memory.

Before the run it snapshots `package.json` and `pnpm-lock.yaml`. If the run exits non-zero, times out or reports `incompatible`, it writes them back (pnpm has exited by then). The row is then marked `failed` with the pnpm output tail. The profile's `packageManager` command, args and env are passed through, so Desktop's bundled pnpm is used.

**Alternatives considered:**
- `removeBundle` + `installBundle` from the updater. Rejected: it uninstalls the updater before reinstalling it (see Context).
- Doing the remove + install from the client. Rejected: the client module belongs to the same bundle and is disposed with it.
- Spawning `dsh plugin add`. Rejected: Desktop refuses its profile from a plain CLI while it runs.

### 2. Applying and reporting the outcome
After a successful install, `selfUpdate()`:
1. writes `<dshHome>/storages/plugin-updater/self-update.json` with `{ from, to, at, announced: false }`;
2. calls `hmr.reconcileProfile()` when HMR exists.

The reconcile may dispose the running updater, so nothing important happens after it except marking `restartRequired` when it returns a `restartReason`. Without HMR, the row is marked `restartRequired` right away.

On every host start, `apply()` reads that file. If `to` equals its own `package.json` version and `announced` is false:
- it exposes `selfUpdated: { from, to, at }` in `status()` for this instance's lifetime;
- it rewrites the file with `announced: true`.

So after a live swap or a restart, the new version announces itself once. If `to` doesn't match (the swap is still pending), nothing is announced.

The client shows a snackbar "Plugin Updater updated to x.y.z" when `selfUpdated.at` differs from the value stored in `sessionStorage` (wrapped in try/catch). The restart notice reuses the existing `restartRequired` banner under the Installed plugins heading.

### 3. Host API and mutual exclusion
- **New method.** `pluginupdater/selfUpdate` returns `{ accepted }`. It runs under the same `exclusive()` guard as `update` / `updateAll`, so no other operation overlaps.
- **Refused when:** the self row isn't `update-available`, the operations module can't be loaded, or `profileContext` is missing. The row then gets a reason.
- **Unchanged:** `update(name)` keeps refusing `self`, and `updateAll()` keeps filtering `self` out. That enforces "not part of Update all" on the host, not just in the UI.
- **`selfUpdateAvailable`.** A new `status()` flag, true when the operations module resolves, so the client can hide the control otherwise and keep the old hint.

### 4. Distinct control and copy
- **On the self card:** an "Update Plugin Updater" button in the `action` host. It uses dsh's `Button` with `variant: 'outline'` (secondary), plus an inline refresh icon. The per-plugin "Update" stays `primary`, as now.
- **Hint line:** "The updater updates itself and then reloads."
- **Detail page:** the `plugins.detail.actions` entry renders the same control for the self bundle.
- **Confirmation:** always `askConfirm`, even when not pinned. Title "Update Plugin Updater?". The description covers replacing itself, the page reloading, and a possible restart, plus the pin sentence when pinned. The confirm label is "Update Plugin Updater".
- **"Update all":** the count and visibility keep using `updatable(snap)`, which already excludes `self`.

### 5. Testing hooks
- **Injected loader.** `createUpdater` gets an injected `loadOperations()` and `readOwnVersion()`, so `node --test` can drive success, failure plus restore, and announce-once without dsh.
- **Live check.** Install the updater itself from a GitHub ref with a lower version into the isolated test profile.

## Risks / Trade-offs

- **[Private API]** `@deepseek-ai/dsh-plugin-manager/operations` and its `PackageOperationContext` shape are internal to dsh. → Mitigation: feature-detect `runPluginCommand`; when it is missing, `selfUpdateAvailable` is false and the old hint stays; record the tested dsh version.
- **[Bypasses manager bookkeeping]** The plugin manager's in-memory state (for example `installedFrom`) doesn't see this run. → Mitigation: `listBundles()` reads disk state, and the same file lock serializes with manager operations. Only the updater's own row is touched.
- **[Stale modules]** pnpm replaces files under a running module. → Mitigation: Node has already loaded the old modules into memory. The reconcile, or the next start, loads the new ones. Until then the restart notice is shown.
- **[Downloaded files left on failure]** A failed run can leave new files on disk while the manifests are restored. → Mitigation: pnpm reconciles `node_modules` with the lockfile on the next install; this matches what the manager does on compatibility denial.
- **[Disposed mid-call]** `reconcileProfile()` may dispose the caller. → Mitigation: the outcome file is written before the call, and nothing after it is needed for correctness.

## Migration Plan

- **Order:** archive `add-plugin-update-checker` first, then this change. This change's delta removes that change's "No self-update" requirement.
- **Rollback:** reinstall the previous updater version by hand (`github:owner/repo#<old sha>`). Deleting `self-update.json` is harmless.

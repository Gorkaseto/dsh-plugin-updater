# Design

## Context

- **Plugin shape.** The new plugin follows the sibling `@local/*` bundles in `C:\Users\Gorka\Documents\deepseek-harness\` (SkillManager is the closest one):
  - `package.json` has a `dsh.bundle.patch` field and a `dsh.client` block.
  - `cordis.patch.yml` inserts the host row.
  - `index.js` is the host half. It exposes Remote methods through a plain service that carries a `typertRemote` binding and the `@deepseek-ai/dsh-typert-protocol/remote-methods` prototype mark. The client calls them as `ctx.connection.rpc.call('/api', '<ns>/<method>', { args })`.
  - `client.js` is a `window.__ModuleLoader__.load` module that registers into slots through `ctx.slots` and has its own locale namespace (`en` / `es`).
  - Plain JS, no build step, no npm dependencies.
- **Harness plugin manager.** It lives in the dsh source checkout at `D:\ARCHIVADOR\deepseek-harness`, `packages/boot/plugin-manager`, in dsh ≥ 0.2. Its `pluginManager` service (`TypertRemoteService`) provides:
  - `listBundles()`: returns `name`, `version`, `source` (the install spec, e.g. `github:owner/repo#ref`), `installed`, `enabled` and `removable`.
  - `installBundle(spec, opts)`: runs `pnpm add` with rollback of `package.json` and `pnpm-lock.yaml` on failure.
  - `removeBundle(name)` and `setBundleEnabled(name, enabled)`.
  - **No update method.** With HMR, `installBundle` refuses a package that is already installed (`already-installed`). The official plugin UI updates by calling `removeBundle` and then `installBundle`.
  - Each change returns `application: 'applied' | 'restart-required' | …` plus `restartReason`.
- **Precedent.** `packages/boot/plugin-market` is a host plugin that already injects `pluginManager` and computes "update-available" with a semver comparison.
- **Native Plugins page.** `packages/client/ui-plugin-manager` registers the page as the `main` panel `plugins`, opened from the sidebar. Its `slot-contract.ts` declares extension slots for other plugins:
  - `plugins.tab`: tabs after **Installed**, with owner props `{ install, openPackage }`. Discover from `ui-plugin-market` is registered this way. This change does not use it: no extra tab is wanted.
  - `plugins.detail.actions`: head controls on a detail page, with props `{ subject }`.
  - `plugins.detail.badge`: tags beside a detail page's title.
  - `plugins.detail.section`: sections under a detail page.

  A detail subject is `{ kind: 'bundle', pkg: { name, version, installed, enabled, … } }` (or `row` / `item`). From outside, the page can be opened with `ctx.layout.selectPanel('plugins')`, and a bundle's page through the `pluginNavigation.openBundle(name)` reflect service. It cannot be opened on a given tab, but it opens on **Installed** by default.
- **Installed plugins section: no slot, stable markup.** The section and its cards (`PluginManagerPage.tsx`, `renderGroup` / `PackageCard`) have no extension slot. Their classes are hashed CSS modules, but they carry data attributes that the page itself relies on, for example for its highlight scroll (`[data-plugin-package="…"]`):
  - `section[data-plugin-group="bundles"]` is the section. Its first child is the head `div` holding `<h3>` "Installed plugins". Its cards are in a `ul`.
  - `li[data-plugin-package="<name>"]` is one card (`data-plugin-status` gives its state). It holds the card head: an icon `span`, a main `div` whose first child is the title row (title button plus tags), and a final end `div` holding the on/off switch.
  - The group is only rendered when there is at least one installed bundle. The updater itself is one, so the group exists whenever the updater runs.
  - The page already shows a native "Update available" tag for official catalog bundles (`updateAvailable(pkg)`). That never applies to GitHub-installed bundles.
- **Older CLI.** The dsh CLI installed on this machine (0.1.5-rc.3, via npx) has no plugin-manager package.

## Goals / Non-Goals

**Goals:**
- The host half owns the check and update state, so a page reload doesn't lose an "Update all" that is running.
- No new runtime dependencies, keeping the plugin's no-build, no-deps style.
- Work in any profile that has `pluginManager`, both live-reload (`web`) and restart-only.

**Non-Goals:**
- Private repos, GitHub Enterprise, and GitLab, Bitbucket or plain git hosts. An optional token is the only auth hook (see Decision 3).
- Plugins installed from GitHub as a monorepo subdirectory (`#path:` specs). These are reported as "unknown — unsupported spec".
- Detecting new commits that don't bump `version`. The comparison is version-based, as requested.
- Periodic background checks while the app is running. The only automatic check is the one at startup.
- Updating the updater itself (see the spec's No self-update requirement).

## Decisions

### 1. Host-side orchestration, `pluginupdater` Remote namespace
`index.js` provides the service `pluginupdater` with `inject: ['pluginManager']`. It is optional: it uses `ctx.get('pluginManager')`, so on an older dsh the plugin still loads and `status()` reports `supported: false`. Its methods:

- `status()`: returns `{ supported, checking, updating, lastCheckedAt, plugins: PluginRow[], lastRun? }`.
- `check()`: returns the in-flight check promise if one is running. Otherwise it starts a new check.
- `update(name)` and `updateAll()`: queued on one internal mutex. They return `{ accepted }` right away, and the client follows progress through `status()`.

Each `PluginRow` is `{ name, repo, source, pinnedRef?, installed, latest?, latestSha?, state: 'up-to-date'|'update-available'|'updating'|'failed'|'unknown', reason?, self, restartRequired? }`.

**Why host-side?** Network calls from Node avoid browser CORS and rate-limit quirks. Long updates survive leaving the Plugins page. The startup check runs without any page open.

**Alternative considered:** a client-only plugin calling `remote.pluginManager` directly. It is simpler, but the state is lost on reload and there is no startup check when no page is open.

### 2. GitHub source detection
Each `listBundles()` entry has a `source` field. The plugin parses it for these forms:
- `github:owner/repo[#ref]`
- `git+https://github.com/owner/repo(.git)[#ref]`
- `https://github.com/owner/repo(.git)[#ref]`
- `git+ssh://git@github.com/owner/repo.git[#ref]` and `git@github.com:owner/repo.git[#ref]`

Any `#ref` is recorded as `pinnedRef`. A ref that contains `path:` (a subdirectory install) is marked "unknown — unsupported spec". Everything else is filtered out. The parser is a pure function so it can be unit-tested.

### 3. Reading `main`'s package.json
For each repo the plugin makes two requests:

1. `GET https://api.github.com/repos/{owner}/{repo}/commits/main` with `Accept: application/vnd.github.sha` returns the head SHA of `main`. That is the "last main branch commit".
2. `GET https://raw.githubusercontent.com/{owner}/{repo}/{sha}/package.json` returns the file, and the plugin parses its `version`.

Fetching by SHA avoids the roughly 5-minute CDN staleness of `raw…/main/…`.

- **Rate limits.** Unauthenticated API calls are capped at 60 per hour, so step 1 can hit the limit. If step 1 returns a rate-limit error (403 or 429), the plugin falls back to `raw…/main/package.json`. The SHA is then unknown.
- **Optional token.** The plugin accepts an optional `githubToken` config value, taken from `cordis.patch.yml`. It is sent only to `api.github.com`.
- **Concurrency and timeout.** Checks run 4 at a time, with a 15 s timeout per request, through `fetch` and `AbortSignal.timeout`.
- **Failure reasons.** 404 becomes "not found / private / no main branch". A missing or invalid `version` becomes "unknown".

**Alternative considered:** `git ls-remote` plus cloning. Rejected: it is heavy, and the plugin manager already uses `ls-remote` only to check that a repo is reachable.

### 4. Version comparison
A small inline semver parser and comparator, following SemVer 2.0 precedence including prerelease identifiers. Build metadata is ignored. The state is "update-available" only when `latest > installed`. If either version is invalid, the state is "unknown". It is a pure function, unit-tested.

**Alternative considered:** depending on `semver`. Rejected, to keep the plugin dependency-free.

### 5. Update procedure (per plugin)
Updates run under the updater's mutex. For each plugin:

1. Note `enabled`, the old `source`, and the resolved commit from `<profile.dir>/pnpm-lock.yaml`, if any. The commit is matched with a regex on the `codeload.github.com/.../tar.gz/<sha>` or `commit:` line. Profile info comes from `ctx.get('profileContext')`.
2. Call `pluginManager.removeBundle(name)`.
3. Call `pluginManager.installBundle('github:owner/repo#main', { enabled })`.
4. If step 3 fails, restore the old version by reinstalling `github:owner/repo#<oldSha>`. If no old SHA is known, reinstall the original `source`, again with `{ enabled }`. The row is marked "failed" with the original error. If the restore also fails, the reason says the plugin was removed and must be reinstalled by hand.
5. If the change result has `application === 'restart-required'` (or a `restartReason`), set `restartRequired` on the row.
6. Re-read `listBundles()` and refresh the row's installed version.

`updateAll()` runs this procedure in order over the rows that are `update-available && !self`, and records a `{ updated, failed }` summary in `lastRun`.

**Why remove + install?** It is the path the harness itself uses, and `installBundle` refuses packages that are already installed under HMR.

**Alternative considered:** `runProfilePnpm(['add', spec])` from `@deepseek-ai/dsh-plugin-manager/operations`. It updates in place with rollback, but it bypasses the manager's reload and HMR reconciliation, so the new code would not be loaded live. Kept only as a possible later improvement.

The spec is rewritten to `#main` on purpose: the user asked to track `main`, and the spec's pinned-update requirement makes the UI warn the user first.

**Self-detection:** a row is `self` when `name === '@local/plugin-updater'`, the updater's own `package.json` name.

### 6. Startup check
In `apply(ctx)` the host starts `check()` from `ctx.effect` (deferred with `setTimeout(…, 0)`), so it never blocks profile composition. Errors are caught and stored per row.

The client registers a `shell.overlay` component. On page boot it calls `pluginupdater/status`, polling every 2 s while `checking`. When the first finished check reports `update-available` rows, it shows a dismissible toast: "N plugin updates available — View". "View" calls `ctx.layout.selectPanel('plugins')` to open the native Plugins page, which lands on **Installed**. It then scrolls `section[data-plugin-group="bundles"]` into view once that section appears. A dismissal is remembered for that check's `lastCheckedAt` in `sessionStorage`, wrapped in try/catch, so a reload doesn't nag again.

### 7. UI placement: inside the native Installed plugins section
All list UI goes into the existing **Installed plugins** section of the Installed tab. There is no new tab, panel, window or Settings section.

**Section and cards: overlay-mounted portals.** A `shell.overlay` component (`plugin-updater.installed-hook`) watches `document.body` with a `MutationObserver`, throttled to one scan per animation frame. On each scan:

- **Section head.** In `section[data-plugin-group="bundles"]` it makes sure our host element `[data-plu-head]` sits right after the head `div`, and renders into it with a React portal:
  - a toolbar: "Check for updates", "Update all (N)" (only when N > 0) and "Last checked …";
  - one line for each of: the in-progress state, the unsupported or empty state, a check error, and the restart notice. These stay until their cause goes away.

  The last run's summary is not a line here. It is a transient snackbar (a third `shell.overlay` entry, bottom-centre like the startup toast) shown when a `lastRun` newer than the one seen at page load arrives with `updating: false`. It hides after 6 s and can be dismissed.
- **Cards.** For each `li[data-plugin-package]` whose name has a row in the status snapshot, it makes sure two host elements exist:
  - `[data-plu-tag]` at the end of the title row: the state tag ("Update available · x.y.z", "updating", "failed", "unknown") and a "pinned to …" tag;
  - `[data-plu-action]` just before the end `div` with the switch: the "Update" button for `update-available && !self` rows.

  The failure or unknown reason, and the self hint, go in a `[data-plu-reason]` line under the card head. Up-to-date rows render nothing.
- **Re-attaching.** Hosts that React's re-render of the page removed are put back on the next scan. Hosts for cards that are gone are dropped. On dispose, the observer disconnects and every `[data-plu-*]` host is removed.

Our hosts are appended next to React-owned nodes, never inside the nodes React re-creates per render, and they are marked `data-plu-*` so the scan only touches its own elements. Styles stay under the `plu-` prefix.

**Detail page: official slots, unchanged.**
- `plugins.detail.badge`: "Update available · x.y.z" for a `bundle` subject whose row is `update-available`; `null` otherwise.
- `plugins.detail.actions`: the "Update" button for the same subjects, except `self`.

**Shared state.** All surfaces read one client-side store: the last `status()` result, polled every 1 s while `checking || updating`. They share the disabled state and outcomes. A pinned update (card button, detail action or "Update all" with pinned rows) asks first in an in-app confirmation dialog, naming the pin and saying the plugin will then track `main`.

**In-app confirmation.** The pin confirmation is never the browser's native `confirm` (in Desktop that is an OS dialog titled `@deepseek-ai/dsh-desktop`). A fourth `shell.overlay` entry renders dsh's own `Modal` and `Button` from the shared platform module `@deepseek-ai/dsh-client-ui-primitives`, the same pieces the Plugins page uses for its install dialogs:
- the title, for example "Update pinned plugin?";
- the pin sentence as the description;
- an outline **Cancel** button and a primary **Update** button with autofocus.

Escape, the mask and Cancel resolve `false`. A store-held request lets any surface `await askConfirm(...)`. If that module cannot be required (an older dsh), the plugin falls back to `window.confirm`.

**Why this approach.** The user wants the functionality in the existing Installed plugins section and no extra tab. That section has no slot, so mounting next to the page's stable data attributes is the only way that doesn't change dsh. SkillManager's Workspace-menu hook is precedent for this technique. The detail page keeps the official slots because they exist.

**Alternatives considered:**
- a `plugins.tab` "Updates" tab: rejected by the user;
- adding a card slot upstream in `ui-plugin-manager`: the clean fix, but out of scope;
- patching the page's React tree: not possible from a plugin.

**Older dsh.** In a dsh without the native Plugins page (0.1.x), nothing is found and nothing renders, and the startup check is skipped. In a dsh with the page but no usable `pluginManager`, the section head shows the "unsupported harness version" line and the cards get nothing.

## Risks / Trade-offs

- **Remove/install is not atomic.** A failed install leaves a window where the plugin is uninstalled. → Mitigation: the automatic restore of the old SHA or source in Decision 5. A failed restore is reported loudly.
- **GitHub API rate limit (60/h).** → Mitigation: the raw-`main` fallback and the optional `githubToken`. The SHA column is blank when the fallback is used.
- **Blocked build scripts.** pnpm 10+ blocks the `prepare` script of git dependencies, so a plugin that needs a build may fail to install. → Mitigation: show the plugin manager's error text, which includes its `allowBuilds` hint. The updater does not approve builds automatically (that would be a security decision).
- **Harness API drift.** The plugin manager API is internal to dsh ≥ 0.2. → Mitigation: feature-detect `ctx.get('pluginManager')` and the methods it needs, and show "unsupported" otherwise. The minimum tested dsh version goes in the README.
- **Native page slot drift.** The `plugins.detail.*` slot names and owner props come from `ui-plugin-manager`'s internal `slot-contract.ts`. → Mitigation: register defensively (slots that are missing are simply never rendered), and record the tested dsh version in the README.
- **Fragile Installed-section hook.** The section and card controls depend on `data-plugin-group="bundles"`, `data-plugin-package` and the card's child order, not on a contract. A dsh update that changes that markup may need a matching tweak here, as with SkillManager's menu hook. → Mitigation: selectors live in one constant block. If nothing matches, nothing renders and nothing breaks, and the detail-page badge and action still work. The tested dsh version goes in the README.
- **Re-render churn.** The page re-renders often (busy states, refreshes). → Mitigation: the observer ignores mutations made only to our own `data-plu-*` nodes, and scans at most once per animation frame.
- **Not testable on the installed CLI.** The installed dsh 0.1.5-rc.3 lacks `pluginManager`, so end-to-end testing needs a dsh ≥ 0.2 build. The source checkout `D:\ARCHIVADOR\deepseek-harness` is the candidate.
- **Wrong "update available" after a pin.** After an update pins to `#main`, a later local downgrade could keep showing an update. This is acceptable: the comparison is version-based by design.

## Migration Plan

- This is a new plugin, so there is nothing to migrate.
- **Install:** add the folder to a dsh ≥ 0.2 profile as a local folder (`dsh plugin --profile web add link:../dsh-plugin-updater`, or the Desktop plugin manager).
- **Rollback:** remove the bundle. The plugin writes no state outside its own memory, apart from the session-scoped dismissal flag.

## Open Questions

- Should "Update all" also offer an opt-in to approve blocked build scripts? Deferred: the default is to report and not approve, and changing it later doesn't affect the specs.

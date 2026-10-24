# dsh-plugin-updater

A plugin updater for DSH. It finds the plugins in your profile that were
installed from GitHub, compares each one's installed version with the
`version` in `package.json` on the latest commit of its repository's `main`
branch, and updates them — one at a time or all at once.

Everything lives inside dsh's own **Plugins** page (the sidebar's Plugins
panel), in its existing **Installed plugins** section. There is no extra tab.

- **Under the "Installed plugins" heading**:
  - **Check for updates** re-runs the check; the time of the last check is
    shown beside it.
  - **Update all (N)** updates every plugin with an update available, one
    after another. A failure doesn't stop the others.
  - Lines for a check error, the restart notice, and the empty or
    unsupported state.
- **After an update** (single or Update all), a snackbar at the bottom of the
  window reports how many were updated and how many failed, then hides after
  a few seconds.
- **On each GitHub plugin's card** that has something to say:
  - an *Update available · x.y.z* tag (or *updating*, *update failed*,
    *update check failed*) and *pinned to …* when installed with `#ref`;
  - an **Update** button just before its on/off switch;
  - the reason under the card when a check or an update failed.

  Up-to-date and non-GitHub cards are left exactly as dsh draws them.
- **On an outdated plugin's own page**: an *Update available · x.y.z* badge
  beside its title and an **Update** button among its head actions.
- **At startup** a check runs once in the background. When it finds updates,
  a toast says how many; **View** opens the Plugins page and scrolls to
  Installed plugins. The toast hides by itself after 3 seconds; a thin bar
  along its bottom shrinks from right to left as the time runs out.

## How it works

- **Which plugins.** Bundles whose install source is a GitHub repository:
  `github:owner/repo`, `git+https://github.com/owner/repo(.git)`,
  `https://github.com/owner/repo`, `git+ssh://git@github.com/…` or
  `git@github.com:owner/repo`, each with or without `#ref`. Registry, local
  (`link:` / `file:`), tarball and other git hosts are ignored.
- **Which version.** It asks `api.github.com` for the head commit of `main`,
  then reads `package.json` at that exact commit from
  `raw.githubusercontent.com`. Versions are compared with SemVer precedence;
  only a strictly greater `main` version counts as an update.
- **Updating.** dsh's plugin manager has no update action, so the updater
  does what its UI does: remove the bundle, then install
  `github:owner/repo#main` with the same enabled/disabled state. If the
  install fails, the previous commit (from `pnpm-lock.yaml`) is reinstalled.
  When dsh says the change needs a restart, a notice under the Installed plugins heading says so.
- **Pinned plugins.** A plugin installed with `#tag`, `#branch` or `#commit`
  is still compared with `main`. Updating it asks first, because it then
  tracks `main`. The question is an in-app dialog built from dsh's own
  `Modal` and `Button` (`@deepseek-ai/dsh-client-ui-primitives`), with
  **Cancel** and **Update**; only a dsh that does not share those falls back
  to the browser's `confirm`.
- **Updating the updater itself.** When the updater is installed from GitHub
  and `main` is newer, its card and its page show **Update Plugin Updater**:
  an outline button with a refresh icon, unlike the solid **Update** of other
  plugins. It always asks first, pinned or not, and **Update all** never
  includes it.
  - It never uninstalls itself (removing a bundle stops it first). It runs
    `pnpm add github:owner/repo#main` in place through dsh's
    `runPluginCommand`, under the same profile lock as the plugin manager.
  - If that fails, `package.json` and `pnpm-lock.yaml` are put back and the
    current version keeps running.
  - On success it writes `<dshHome>/storages/plugin-updater/self-update.json`
    and asks dsh to load the new version live. When dsh can't, the Installed
    plugins heading says to restart dsh.
  - The new version shows *Plugin Updater updated to x.y.z* once.

## Configuration

`cordis.patch.yml` takes one optional key:

| Key | Meaning |
|---|---|
| `githubToken` | Token sent as `Authorization: Bearer …` to `api.github.com` only. Raises the 60 requests/hour unauthenticated limit. |

```yaml
- insert:
    - id: plugin-updater
      name: 'dsh-plugin-updater'
      config:
        githubToken: !!js process.env.GITHUB_TOKEN
```

## Install

Needs **dsh 0.2 or later** (the `pluginManager` service and the native
Plugins page). Tested with 0.2.1-rc.2.

The `desktop` profile is managed by the Electron app: add the plugin from the
app's plugin manager as a local folder (a `link:` dependency, like the other
`@local/*` bundles). For a `web` profile:

```sh
dsh plugin --profile web add link:../dsh-plugin-updater
```

## Caveats

- **Public GitHub repos and `main` only.** Private repos, repositories whose
  branch is not `main` (e.g. `master`) and subfolder installs (`#path:`)
  show as *unknown*.
- **Rate limit.** Without a token, GitHub allows 60 API requests per hour.
  When it is hit, the updater falls back to `raw…/main/package.json` (which
  the CDN can serve a few minutes stale) and shows no SHA.
- **Blocked build scripts.** pnpm 10+ blocks a git dependency's `prepare`
  script until it is allowed in `pnpm-workspace.yaml` (`allowBuilds`). Such
  an update fails with the plugin manager's message; the updater never
  approves builds for you.
- **Version-based.** New commits that don't bump `version` aren't reported.
- **Self-update relies on dsh internals.** It loads `runPluginCommand` from
  `@deepseek-ai/dsh-plugin-manager/operations` out of dsh's installation
  (`profileContext.installAnchor`). On a dsh without it, the updater's card
  keeps the "uninstall and reinstall it" hint instead of the button.
- **Fragile Installed-section hook.** The Installed plugins section and its
  cards have no extension seat. A `shell.overlay` entry watches the page and
  mounts its controls next to `section[data-plugin-group="bundles"]` and
  `li[data-plugin-package]` (selectors in `SEL` in `client.js`). A harness
  update that changes that markup may need a matching tweak; until then the
  card controls just don't appear, and the detail-page badge and button
  (official seats) keep working.

## Structure

- `index.js` — the Host half. It provides the `pluginupdater` service with
  `status`, `check`, `update`, `updateAll` and `selfUpdate`, runs the startup
  check, announces a finished self-update, and serializes updates (one at a
  time).
- `client.js` — the Client module: the Installed-section hook and the startup
  toast (both `shell.overlay`), the `plugins.detail.badge` and
  `plugins.detail.actions` entries, and the `plugin-updater` locale namespace
  (`en` / `es`).
- `cordis.patch.yml` — inserts the `plugin-updater` plugin row.
- `locale/` — the `en` / `zh` metadata strings.
- `icon.svg` — the plugin icon.
- `test/` — `node --test` suites (`npm test`).

## License

Copyright 2026 gorkaseto. Licensed under the
[Apache License, Version 2.0](LICENSE); see [NOTICE](NOTICE).

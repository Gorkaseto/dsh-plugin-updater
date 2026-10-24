# Proposal

## Why

dsh can install plugins straight from GitHub (`github:owner/repo`), but it never tells you when the repo has moved on. The built-in plugin manager has no update action for these plugins. Its own UI says to "uninstall and reinstall" them, so GitHub-installed plugins quietly go stale. We want a plugin that finds outdated GitHub plugins on its own and updates them in one click.

## What Changes

- New dsh plugin bundle `@local/plugin-updater` in this folder. It follows the layout of the sibling `@local/*` plugins: `index.js` host half, `client.js` client module, `cordis.patch.yml`, `locale/`, `icon.svg`, README, LICENSE and NOTICE.
- **Detection.** The plugin lists the profile's installed bundles whose install source is a GitHub repo. For each one it reads the `version` in that repo's `package.json` at the latest commit of the `main` branch, and compares it with the installed `version`.
- **Automatic check on startup.** A check runs once when the app (profile) starts. If any updates are found, a non-blocking notice says so.
- **Manual check.** A **Check for updates** button re-runs the check on demand.
- **Per-plugin update.** Each plugin with an update shows an **Update** button. It reinstalls that plugin from its GitHub repo at the latest `main`.
- **Update all.** One button updates every updatable plugin at once, one after another, and then reports the result for each.
- **Built into dsh's own Plugins page.** The UI lives inside the existing **Installed plugins** section of the native Plugins page (the sidebar's Plugins panel), on its **Installed** tab. No new tab or window is added.
  - Next to the section heading: **Check for updates**, **Update all (N)** and "Last checked …".
  - On each outdated GitHub plugin's card: an "Update available · x.y.z" tag and an **Update** button next to its on/off switch. A failed or unknown check shows its reason on the card.
  - On that plugin's own detail page: the same badge and an **Update** button, shown as soon as an update is detected.

## Capabilities

### New Capabilities
- `plugin-update-detection`: Finds GitHub-installed plugins and compares the installed version with the `package.json` version on the latest `main` commit. Covers the automatic startup check, the manual check and the status reported per plugin.
- `plugin-update-install`: Updates one plugin, or all updatable plugins, to the latest `main` of its GitHub repo. Reports progress and the outcome, including when a restart is needed.

### Modified Capabilities
<!-- None: no existing specs in this project. -->

## Impact

- **New code:** only in this folder, `C:\Users\Gorka\Documents\deepseek-harness\dsh-plugin-updater`.
- **Harness dependency:**
  - Needs dsh's `pluginManager` service (`@deepseek-ai/dsh-plugin-manager`, in dsh ≥ 0.2) to list bundles and to remove and reinstall them.
  - The dsh 0.1.5-rc.3 CLI currently installed on this machine does not include that service. There, the plugin shows an "unsupported harness" state instead of failing.
- **Network:** reads public files from `raw.githubusercontent.com`. Private repos and other git hosts (GitLab, Bitbucket, plain git URLs) are out of scope for this change.
- **Profile changes:** an update rewrites the profile's `package.json` and `pnpm-lock.yaml` through the plugin manager. That uses the plugin manager's own locking and rollback.
- **Native page markup:** the Installed plugins section and its cards have no extension slot. The plugin attaches to dsh's own markup there (`data-plugin-group="bundles"`, `data-plugin-package`), so a dsh update that changes that markup may need a matching tweak. The detail page uses its official slots.
- **Install:** added to a profile as a local folder, like the other `@local/*` bundles.

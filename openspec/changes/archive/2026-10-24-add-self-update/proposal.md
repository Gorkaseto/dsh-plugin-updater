# Proposal

## Why

The updater can update every GitHub-installed plugin except itself. When the updater is installed from GitHub, its own update is only reported, and you have to uninstall and reinstall it by hand. The updater should be able to update itself safely, with a control that is clearly different from a normal plugin update because it replaces the tool doing the updating.

## What Changes

- **Self-update action.** When the updater's own card (and its detail page) reports an update, it offers an **Update Plugin Updater** button.
- **Different look.** The button is visually distinct from the per-plugin **Update** buttons: a secondary style with a refresh icon. The row's hint explains that the updater updates itself and then reloads.
- **Always confirms.** Pressing it always opens the in-app confirmation dialog (dsh's `Modal`), even when the updater is not pinned. The dialog says the updater will replace itself, and that dsh may need a restart.
- **Never part of Update all.** "Update all" still skips the updater, and its count does not include it.
- **Safe in-place update.** The updater never uninstalls itself. It replaces its own package in place (`pnpm add github:owner/repo#main` through dsh's plugin-manager operations), so a failure leaves the current version installed and working.
- **Outcome after reload.** The new version announces the result once it starts ("Plugin Updater updated to x.y.z"). If dsh can't swap it live, the user is told to restart dsh.
- **BREAKING (behaviour):** removes the "No self-update" requirement of `add-plugin-update-checker`.

## Capabilities

### New Capabilities
- `plugin-self-update`: The updater updates itself from the latest `main` of its own GitHub repository: the distinct control, the mandatory confirmation, exclusion from "Update all", the in-place install, and the outcome reported after it reloads.

### Modified Capabilities
- `plugin-update-install`: removes the "No self-update" requirement that `add-plugin-update-checker` introduces. That change must be archived **before** this one, so the requirement exists in the main spec when this delta removes it.

## Impact

- **Code:** `index.js` (new `selfUpdate` Remote method, in-place install, outcome file) and `client.js` (distinct button, confirmation, outcome snackbar), plus tests and README. All in this folder.
- **Harness dependency:**
  - `runProfilePnpm` from `@deepseek-ai/dsh-plugin-manager/operations`, loaded from dsh's install anchor (`profileContext.installAnchor`). It already resolves from there in dsh 0.2.1-rc.2.
  - Optionally `hmr.reconcileProfile()` to apply the new version live.
  - Both are feature-detected; without them, self-update is unavailable and the old hint stays.
- **State on disk:** one small file, `<dshHome>/storages/plugin-updater/self-update.json`. It carries the outcome across the reload.
- **Only for GitHub installs:** an updater installed as a local folder (`link:`), as in development, is not checked, so no self-update is offered.

# plugin-self-update Specification

## Purpose

Lets the plugin updater update itself from the latest `main` of its own GitHub repository, through a control that is distinct from per-plugin updates, always confirmed, never part of "Update all", and safe if it fails.

## Requirements

### Requirement: Distinct self-update control
When the updater itself is installed from GitHub and is reported as "update available", the system SHALL offer a self-update control on the updater's card in the Installed plugins section and on its detail page:
- The control SHALL be labelled "Update Plugin Updater" (localized).
- It SHALL look different from the per-plugin "Update" buttons: a secondary, non-primary style with a refresh icon.
- The card SHALL also show a hint saying that the updater updates itself and then reloads.

When the updater is up to date, unknown, or not installed from GitHub, no self-update control SHALL be shown.

#### Scenario: Self-update offered
- **WHEN** the updater is installed from `github:acme/dsh-plugin-updater` at `1.0.0` and `main` declares `1.1.0`
- **THEN** its card shows "Update available · 1.1.0" and an "Update Plugin Updater" button in the distinct style, and its detail page shows the same control

#### Scenario: Local install
- **WHEN** the updater is installed from a local folder (`link:`)
- **THEN** no self-update control is shown anywhere

### Requirement: Self-update always asks first
Pressing the self-update control SHALL open the in-app confirmation dialog before anything is changed, whether or not the updater is pinned. The dialog SHALL say that:
- the updater will replace itself with the version on `main`;
- the Plugins page may reload while it does;
- dsh may need a restart to finish.

If the updater is pinned, the dialog SHALL also say that it will track `main` from then on. Cancelling SHALL change nothing.

#### Scenario: Confirm self-update
- **WHEN** the user presses "Update Plugin Updater" and confirms
- **THEN** the self-update starts

#### Scenario: Cancel self-update
- **WHEN** the user presses "Update Plugin Updater" and cancels the dialog
- **THEN** nothing is installed, and the updater stays at its current version

### Requirement: Not part of Update all
"Update all" SHALL never update the updater itself. Its count SHALL NOT include it, and it SHALL NOT be offered when the updater is the only plugin with an update.

#### Scenario: Update all with the updater outdated
- **WHEN** two plugins and the updater have updates available and the user runs "Update all"
- **THEN** only the two plugins are updated, the button reads "Update all (2)", and the updater still shows its self-update control

#### Scenario: Only the updater is outdated
- **WHEN** the updater is the only plugin with an update available
- **THEN** no "Update all" button is shown, and the self-update control is

### Requirement: Self-update never leaves the updater uninstalled
The self-update SHALL replace the updater's installed package in place, from `github:owner/repo#main`. At no point SHALL the updater be uninstalled. If the install fails or is cancelled, the previous version SHALL remain installed and running. Its card SHALL show "update failed" with the reason, and the self-update control SHALL stay available. No other update SHALL run while a self-update runs.

#### Scenario: Self-update install fails
- **WHEN** installing the updater from `main` fails, for example because of a network error or a blocked build script
- **THEN** the updater is still installed at its previous version and keeps working, and its card shows "update failed" with the reason

#### Scenario: Busy during self-update
- **WHEN** a self-update is running
- **THEN** every "Update", "Update all", "Check for updates" and self-update button is disabled

### Requirement: Outcome reported after the updater reloads
After a successful self-update, the system SHALL report the outcome even though the updater reloads:
- If the new version starts in the same session, it SHALL show a snackbar once, saying the updater was updated to the new version.
- If dsh cannot load the new version without a restart, the system SHALL say that dsh must be restarted to finish updating the updater. When dsh next starts, the new version SHALL show the "updated" snackbar once.

The outcome SHALL be shown only once, and never for a self-update older than the current dsh start that was already announced.

#### Scenario: Live self-update
- **WHEN** the self-update succeeds and dsh loads the new updater version without a restart
- **THEN** a snackbar says "Plugin Updater updated to 1.1.0", and the updater's card shows it up to date

#### Scenario: Restart needed
- **WHEN** the self-update succeeds but dsh reports that a restart is needed
- **THEN** a notice says to restart dsh to finish updating the updater, and after the restart a snackbar says "Plugin Updater updated to 1.1.0" once

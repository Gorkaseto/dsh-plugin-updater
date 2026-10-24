# Spec Delta

## Purpose

Lets the user bring outdated GitHub-installed plugins up to the latest `main` commit of their repository. Plugins can be updated one at a time or all at once, and the user sees each outcome.

## ADDED Requirements

### Requirement: Update a single plugin
Each plugin reported as "update available" SHALL show an "Update" button in two places: on its card in the native Installed plugins section, next to its switch, and among the head actions of its detail page. Pressing either one SHALL reinstall that plugin from the latest `main` of its GitHub repository. Both controls SHALL share the same progress and outcome. Plugins that are up to date or unknown SHALL NOT show the button. The plugin's enabled or disabled state SHALL be the same after the update as before it.

#### Scenario: Update from the plugin's card
- **WHEN** the user presses "Update" on the card of a plugin with installed `1.2.0` and `main` at `1.3.0`
- **THEN** the plugin is reinstalled from `main`, its card shows installed `1.3.0`, and the update tag and button disappear

#### Scenario: Update from the plugin's detail page
- **WHEN** the user opens an outdated plugin's detail page and presses its "Update" action
- **THEN** the plugin is updated exactly as from its card, and both places show the new state

#### Scenario: No button when up to date
- **WHEN** a plugin is reported as "up to date" or "unknown"
- **THEN** neither its card nor its detail page shows an "Update" button

#### Scenario: Disabled plugin stays disabled
- **WHEN** a disabled plugin is updated
- **THEN** it is still disabled after the update

### Requirement: Update all updatable plugins
The Installed plugins section SHALL show an "Update all" button next to its heading whenever at least one plugin is reported as "update available". Pressing it SHALL update every such plugin, one after another. A failure on one plugin SHALL NOT stop the others. When all are done, a summary of how many succeeded and how many failed SHALL be shown as a transient snackbar. The snackbar SHALL disappear on its own after a few seconds, SHALL be dismissible, and SHALL NOT stay in the Installed plugins section. A single update's outcome SHALL be announced the same way. A summary from before the page loaded SHALL NOT be shown again.

#### Scenario: Update all succeeds
- **WHEN** three plugins have updates available and the user presses "Update all"
- **THEN** all three are updated in turn, and a snackbar reports 3 updated and 0 failed, then hides by itself

#### Scenario: Summary not repeated after reload
- **WHEN** an "Update all" finished earlier and the user reloads the page
- **THEN** no summary snackbar is shown for that earlier run

#### Scenario: One update fails
- **WHEN** "Update all" runs over three plugins and the second one fails to install
- **THEN** the first and third are still updated, the second's card shows "failed" with the error, and the snackbar reports 2 updated and 1 failed

#### Scenario: Button hidden with nothing to update
- **WHEN** no plugin is reported as "update available"
- **THEN** the "Update all" button is not shown

### Requirement: Progress and mutual exclusion
While an update is running, the card of the plugin being updated SHALL show an "updating" state. All update and check buttons SHALL be disabled until the operation ends. Only one update operation, single or "Update all", SHALL run at a time.

#### Scenario: Buttons locked during update
- **WHEN** a single update or "Update all" is in progress
- **THEN** every "Update", "Update all" and "Check for updates" button is disabled until it finishes

### Requirement: Safe failure
If reinstalling a plugin fails or is cancelled, the system SHALL leave the profile with the plugin still installed, at its previous version and with its previous install source. The plugin SHALL NOT end up removed or half-installed. Its card SHALL show "failed" with the error message.

#### Scenario: Install from main fails
- **WHEN** installing the new version fails, for example because of a network error or a build script blocked by pnpm
- **THEN** the previous version is still installed and loaded, and the plugin's card shows "failed" with the reason

### Requirement: Restart notice
When the harness reports that an update was installed but needs a restart to take effect, the system SHALL tell the user that a restart is required, in a notice under the Installed plugins heading. The notice SHALL list which updated plugins are affected.

#### Scenario: Restart required
- **WHEN** an update finishes and the harness reports that the change needs a restart
- **THEN** a "restart required" notice under the Installed plugins heading names the updated plugin

### Requirement: No self-update
If the updater plugin is itself installed from GitHub and has an update available, the system SHALL report that update. It SHALL NOT offer to update itself. Its card SHALL tell the user to update it from the harness's plugin manager instead. "Update all" SHALL skip it.

#### Scenario: Updater has an update
- **WHEN** the updater plugin is installed from GitHub and its `main` version is newer
- **THEN** its card shows "update available" with no "Update" button and a hint to use the plugin manager, and "Update all" does not include it

### Requirement: Install source after update
After an update, the plugin's recorded install source SHALL point at the same GitHub repository, tracking `main`. A previous `#ref` pin SHALL be replaced. Before an update of a pinned plugin runs, from its card, its detail page or "Update all", the system SHALL ask the user to confirm and SHALL say that the plugin will track `main` from then on.

#### Scenario: Pinned plugin updated
- **WHEN** the user updates a plugin installed from `github:acme/dsh-foo#v1.0.0` and confirms the pin warning
- **THEN** the plugin's install source becomes `github:acme/dsh-foo#main`, and its version matches `main`'s `package.json`

#### Scenario: Pin warning declined
- **WHEN** the user presses "Update" on a pinned plugin and declines the pin warning
- **THEN** nothing is reinstalled, and the plugin stays pinned

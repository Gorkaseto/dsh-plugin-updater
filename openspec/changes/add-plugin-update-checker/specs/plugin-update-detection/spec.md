# Spec Delta

## Purpose

Tells the user which plugins installed from GitHub are out of date. For each one it compares the installed version with the version declared in `package.json` on the latest commit of the repository's `main` branch.

## ADDED Requirements

### Requirement: Identify GitHub-installed plugins
The system SHALL check the current profile's installed plugin bundles whose install source is a GitHub repository. GitHub sources are the `github:owner/repo` shorthand, `git+https://github.com/owner/repo(.git)` and `https://github.com/owner/repo(.git)`, each with or without a `#ref` suffix. Bundles installed from any other source (registry, local folder, tarball, other git hosts) SHALL NOT be checked, and their cards SHALL NOT change.

#### Scenario: GitHub plugin is checked
- **WHEN** the profile has a bundle installed from `github:acme/dsh-foo`
- **THEN** that bundle is checked, and its card in the Installed plugins section shows its update status when there is one to show

#### Scenario: Non-GitHub plugin is excluded
- **WHEN** the profile has bundles installed from the npm registry and from a local `link:` folder
- **THEN** neither bundle is checked, and their cards show nothing extra

#### Scenario: No GitHub plugins installed
- **WHEN** no installed bundle comes from GitHub
- **THEN** a line under the Installed plugins heading explains that no GitHub-installed plugins were found

### Requirement: Compare installed version with latest main
For each GitHub-installed plugin, the system SHALL read the `version` field of `package.json` at the latest commit of the repository's `main` branch. It SHALL compare that version with the installed version using semantic-version precedence. A plugin SHALL be reported as having an update available only when the `main` version is strictly greater than the installed version. This SHALL hold even when the plugin was installed with a `#ref` pinning another branch, tag or commit.

#### Scenario: Newer version on main
- **WHEN** the installed version is `1.2.0` and `package.json` on `main` declares `1.3.0`
- **THEN** the plugin is reported as "update available", with latest `1.3.0`

#### Scenario: Same version on main
- **WHEN** the installed version and the `main` version are both `1.2.0`
- **THEN** the plugin is reported as "up to date"

#### Scenario: Installed version is ahead of main
- **WHEN** the installed version is `2.0.0` and `main` declares `1.9.0`
- **THEN** the plugin is reported as "up to date" and no update is offered

#### Scenario: Pinned install
- **WHEN** a plugin was installed from `github:acme/dsh-foo#v1.0.0` and `main` declares a greater version
- **THEN** the plugin is reported as "update available", and its card shows that the current install is pinned to `v1.0.0`

### Requirement: Report check failures per plugin
If the system cannot get or parse a plugin's `main` `package.json`, or a version is not valid semver, it SHALL report that plugin as "unknown" with a short reason on its card. It SHALL still report the other plugins normally. Causes include the repository being unreachable, the repository being private, there being no `main` branch, there being no `package.json`, and a network error.

#### Scenario: Repository unreachable
- **WHEN** reading `package.json` from `main` fails for one plugin with a not-found or network error
- **THEN** that plugin's card shows "unknown" with the reason, and the other plugins show their real status

#### Scenario: Invalid version string
- **WHEN** `main`'s `package.json` declares a `version` that is not valid semver
- **THEN** the plugin's card shows "unknown", and no update is offered for it

### Requirement: Automatic check at startup
The system SHALL run one update check automatically each time the profile starts, without user action. The check SHALL NOT block or slow down startup. When it finds at least one plugin with an update available, the system SHALL show a non-blocking notice. The notice SHALL give the number of updates and offer a way to open the Plugins page.

#### Scenario: Updates found at startup
- **WHEN** the app starts and the automatic check finds 2 plugins with updates available
- **THEN** a dismissible notice says that 2 plugin updates are available and links to the Plugins page

#### Scenario: Nothing to update at startup
- **WHEN** the automatic check finds no updates, or every check fails
- **THEN** no notice is shown, and the results are still shown in the Installed plugins section

### Requirement: Manual check
The Installed plugins section SHALL provide a "Check for updates" button next to its heading. The button SHALL re-run the check for every GitHub-installed plugin and refresh the cards. While a check is running, the button SHALL be disabled and SHALL show that a check is in progress. The time of the last completed check SHALL be shown next to the button.

#### Scenario: Manual re-check
- **WHEN** the user presses "Check for updates"
- **THEN** each GitHub plugin's status is refreshed from the latest `main`, and the "last checked" time updates

#### Scenario: Concurrent check request
- **WHEN** a check is already running, either the startup check or a manual one, and another check is requested
- **THEN** no second check is started, and the request resolves with the running check's results

### Requirement: Integrated in the native Installed plugins section
The update functionality SHALL live inside the existing **Installed plugins** section of the native Plugins page's **Installed** tab. The system SHALL NOT add a tab, window, panel or Settings section for it:
- The check, "Update all" and last-checked controls SHALL be shown next to the section heading.
- On the card of each plugin reported as "update available", the system SHALL add an "Update available" tag with the latest version, plus an "Update" button.
- On the detail page of such a plugin, the system SHALL add an "Update available" badge with the latest version beside its title, plus an "Update" action. Both SHALL appear as soon as the update is detected.
- Cards and detail pages of plugins that are not updatable SHALL show no update tag, badge or button.

#### Scenario: No separate Updates tab
- **WHEN** the user opens the Plugins page from the sidebar
- **THEN** there is no "Updates" tab, and the Installed plugins heading shows "Check for updates" and the last-checked time

#### Scenario: Update tag on an outdated card
- **WHEN** a card in Installed plugins belongs to a plugin whose `main` version `1.3.0` is newer than installed `1.2.0`
- **THEN** the card shows an "Update available · 1.3.0" tag and an "Update" button next to its switch

#### Scenario: Update button on an outdated plugin's page
- **WHEN** the user opens the detail page of a plugin whose `main` version `1.3.0` is newer than installed `1.2.0`
- **THEN** the page shows an "Update available · 1.3.0" badge beside its title and an "Update" action among its head controls

#### Scenario: Nothing extra on other plugins
- **WHEN** a plugin is up to date, unknown, or not installed from GitHub
- **THEN** neither its card nor its detail page shows an update tag, badge or button

#### Scenario: Startup notice opens the Plugins page
- **WHEN** the user picks "View" on the startup notice
- **THEN** the native Plugins page opens on its Installed tab, with the Installed plugins section in view

### Requirement: Unsupported harness
When the harness does not provide the plugin management service needed to list and reinstall bundles, the system SHALL show a clear "unsupported harness version" line under the Installed plugins heading, and add no controls to the cards. It SHALL NOT fail the profile startup.

#### Scenario: Older dsh without plugin manager
- **WHEN** the plugin is loaded in a dsh build that has no plugin management service
- **THEN** the Installed plugins section explains that this dsh version is not supported, and the rest of the app works normally

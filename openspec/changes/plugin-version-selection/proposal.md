# Proposal

## Why

When installing or managing plugins from GitHub in dsh, plugins typically default to the latest commit on the `main` branch or require manually formatting a `#ref` string. Users have no built-in way to see which release tags exist for a repository, cannot select a specific version from a dropdown when installing a new plugin, and cannot easily switch between available versions from the plugin's detail page. Checking repository tags and offering a version selector gives users full control over plugin versioning, defaulting to stable tagged releases while keeping access to the latest untagged changes on `main`.

## What Changes

- **Repository Tag & Version Discovery:** Query GitHub repository tags to discover all tagged releases for a plugin repository, sort them by SemVer precedence, and determine the latest tagged release.
- **"Latest Untagged" Option:** Automatically generate a `latest untagged` option representing the latest commit on the default branch (`main`), catering to repositories that do not tag releases or when `main` has new commits ahead of the latest tag.
- **Installation Version Dropdown:** When installing a new plugin from GitHub, provide a version dropdown in the installation flow. Default the selection to the latest available tagged version (or `latest untagged` if no tags exist), while allowing the user to choose any available tagged version or `latest untagged`.
- **Detail View Version Dropdown:** Display a dropdown with all available versions (all tags plus `latest untagged`) on each plugin's detail page, showing the currently active version and allowing the user to switch or update to any other version with one click.
- **Version Installation & Switching:** Handle installing and reinstalling plugins pinned to the chosen tag or branch ref via the harness plugin manager.

## Capabilities

### New Capabilities
- `plugin-version-discovery`: Queries GitHub repository tags, parses and sorts version releases, identifies the default latest tagged version, and produces the `latest untagged` branch reference.
- `plugin-version-selection`: Provides interactive dropdown controls for version selection during new plugin installation and in the plugin detail view, and executes installation or switching to the selected version.

### Modified Capabilities
<!-- None: no existing specs modified. -->

## Impact

- **Host Service (`index.js`):** Adds methods to query available versions for a given GitHub repository (`pluginupdater/versions`) and to install/switch a plugin to a specific version or ref (`pluginupdater/installVersion`).
- **GitHub API & Network:** Makes API requests to `https://api.github.com/repos/{owner}/{repo}/tags` (with token support when configured and rate limit handling).
- **Client UI (`client.js`):** Extends the UI to inject a version dropdown in the plugin installation interface and adds a version selector in the plugin detail view slots.
- **Locales (`locale/*.json`):** Adds localization keys for version dropdown labels, "latest untagged" tag descriptions, and version switching status notices.

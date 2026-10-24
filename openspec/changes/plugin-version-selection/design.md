# Design

## Context

dsh plugins installed from GitHub (`github:owner/repo`) currently default to tracking the `main` branch or require manually appending `#tag` or `#commit` to the source string. The existing `dsh-plugin-updater` service lists GitHub plugins, compares installed versions against `package.json` on `main`, and automates single or batch updates. However, it offers no repository release tag discovery, has no mechanism to choose an explicit version upon installing a new plugin, and provides no version dropdown on the plugin detail view. See `proposal.md` for motivation.

## Goals / Non-Goals

**Goals:**
- Query GitHub repository tags via API to detect all released versions.
- Sort tags descending by SemVer 2.0 precedence and identify the highest tagged release as the default.
- Create a `latest untagged` option representing the head of `main` for untagged repositories or when `main` has newer untagged changes.
- Provide a version dropdown selector during new plugin installation.
- Provide a version dropdown selector on the native plugin detail page with the ability to switch versions.
- Reinstall the chosen version via dsh's `pluginManager` with automatic rollback on error.

**Non-Goals:**
- Supporting non-GitHub hosts (GitLab, Bitbucket, Gitea) or private git repositories without credentials.
- SemVer range resolution (such as evaluating `^1.0.0` or `>=2.0.0`); users select concrete tags or `latest untagged`.
- Markdown release notes or changelog parsing inside the dropdown.

## Decisions

### 1. GitHub Tags Querying & Caching
The host will add a helper `fetchRepoVersions(owner, repo, options)`:
- Requests `GET https://api.github.com/repos/{owner}/{repo}/tags?per_page=100`.
- Also checks the latest commit on `main` (via `commits/main` or head SHA) to determine if `main` has commits beyond the latest tag or if the repo has no tags.
- Includes `Authorization: Bearer <token>` when `githubToken` is configured.
- Short in-memory cache (5-minute TTL per repo) to avoid exhausting the 60 requests/hour unauthenticated rate limit during frequent UI interactions.

*Alternatives considered:*
- `git ls-remote --tags`: Heavyweight, requires local git binary or git CLI spawn, and fails in environments without git installed.
- Scraping GitHub HTML releases page: Fragile, against terms of service, prone to markup breakage.

### 2. Version Sorting & "Latest Untagged" Representation
- Discovered tags are parsed using SemVer (`parseVersion`). Tags are stripped of leading `v` or `V` for comparison.
- Tags are sorted descending by SemVer precedence. Valid SemVer tags precede non-semver tags.
- The highest SemVer tag is designated as `latestTagged`.
- A synthetic entry `latest untagged` is generated:
  - If no tags exist on the repo: `latest untagged` is the sole and default selection.
  - If tags exist: `latest untagged` is listed alongside tags (e.g. at the top or after latest tagged) to allow users to track the bleeding edge on `main`.
- Each option in the versions list is structured as:
  `{ label: string, ref: string, isLatestTagged: boolean, isLatestUntagged: boolean, sha?: string }`

### 3. Remote Gateway Protocol Methods
Add two remote methods to `index.js`:
- `pluginupdater/versions`: `{ owner, repo } => { versions: [...], defaultRef: string, latestTagged: string | null }`
- `pluginupdater/installVersion`: `{ name, repo, ref, enabled } => { accepted: boolean }`

### 4. UI: New Plugin Installation Version Dropdown
- When a user initiates adding a new GitHub plugin, or when a GitHub spec `github:owner/repo` / URL is typed, the UI fetches available versions for that repo.
- A `<select>` or native-styled dropdown appears with all available versions.
- The default value is pre-selected to `latestTagged.ref` (or `latest untagged` if no tags exist).
- Installing the plugin executes `pluginManager.installBundle('github:owner/repo#' + selectedRef)`.

### 5. UI: Plugin Detail View Version Dropdown
- On the plugin detail page (`plugins.detail.actions` or a companion detail slot), inject a Version Selector component.
- Fetches available versions for the current plugin's repository.
- Renders a dropdown displaying all versions, clearly indicating the currently installed version (e.g., "v1.2.0 (current)").
- Selecting a different version displays a "Switch Version" / "Install Version" button (or triggers confirmation).
- Confirms the switch, uninstalls the current bundle, and installs the bundle with `#selectedRef`.

### 6. Failure Handling and Rollback
- If installing the chosen version fails, the system automatically reinstalls the previously installed version (from locked commit SHA in `pnpm-lock.yaml` or previous source spec).
- The detail view and card reason line report the error.

## Risks / Trade-offs

- **GitHub API Rate Limit:** Unauthenticated requests are limited to 60/hr per IP.
  - *Mitigation:* Cache repo version lists in memory for 5 minutes. If rate-limited, fall back to offering `latest untagged` (`main`) and explain the rate limit in the UI.
- **Large Number of Tags:** A repo with hundreds of tags could flood the UI.
  - *Mitigation:* Fetch the 100 most recent tags via `per_page=100`, which covers all active versions.
- **Rollback Failures:** If uninstallation succeeds but both target and previous re-installations fail, the plugin may remain uninstalled.
  - *Mitigation:* Preserve previous bundle configuration and locked commit SHA, logging explicit manual recovery commands if rollback fails.

## Migration Plan

- Purely additive feature within `dsh-plugin-updater`.
- Compatible with existing installed plugins and settings.
- Rollback: Reverting to the previous plugin updater bundle leaves existing installed plugins unaffected.

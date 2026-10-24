# Tasks

## 1. Repository Tags and Version Discovery

- [ ] 1.1 Implement `fetchRepoVersions` in `index.js` to query GitHub repository tags (`/repos/{owner}/{repo}/tags`) with token support and rate-limit fallback; verify with unit tests in `test/updater.test.js`
- [ ] 1.2 Implement version parsing, SemVer descending sorting, identification of the default `latestTagged` release, and generation of the `latest untagged` option; verify with unit tests covering repositories with multiple tags, non-semver tags, and zero tags
- [ ] 1.3 Expose the `pluginupdater/versions` remote RPC method in `index.js` and verify with tests that it returns the sorted version list, `defaultRef`, and `latestTagged` status

## 2. Version Installation and Switching Service

- [ ] 2.1 Implement `installVersion` in `index.js` to reinstall a plugin pinned to a selected tag or branch ref via `pluginManager`; verify with unit tests in `test/updater.test.js`
- [ ] 2.2 Implement rollback in `installVersion` restoring the previously installed version if the target version installation fails; verify with unit tests covering rollback failure scenarios

## 3. Client UI Version Selection

- [ ] 3.1 Create the `VersionDropdown` component in `client.js` displaying available versions, distinguishing `latest untagged`, and pre-selecting the default version; verify with unit tests in `test/client.test.js`
- [ ] 3.2 Integrate the version dropdown into the new plugin install flow, defaulting to the latest tagged release or `latest untagged`; verify with DOM mounting tests in `test/client.test.js`
- [ ] 3.3 Integrate the version dropdown into the plugin detail page (`plugins.detail.actions`), showing the currently installed version and allowing switching; verify detail view tests in `test/client.test.js`

## 4. Localization and Documentation

- [ ] 4.1 Add translation strings for version selection, `latest untagged`, and version switching status to `locale/en.json` and `locale/es.json`; verify all keys are synchronized
- [ ] 4.2 Update `README.md` to document repository tag checking, the install-time version dropdown, and version switching in the detail view; verify docs match implemented capabilities

## 5. Integration Verification

- [ ] 5.1 Run the full test suite with `npm test` to verify all new and existing tests pass cleanly without regressions

# Spec Delta

## Purpose

Provides interactive dropdown controls for version selection during new plugin installation and in the plugin detail view, and executes installation or switching to the selected version.

## ADDED Requirements

### Requirement: Install-Time Version Dropdown
The system SHALL present an interactive version dropdown when installing a new plugin from a GitHub repository, pre-selecting the latest tagged release by default.

#### Scenario: Installing repository with tagged versions
- **WHEN** a user prepares to install a GitHub plugin whose repository has tagged releases
- **THEN** the version dropdown lists all tagged releases and the `latest untagged` option, pre-selecting the highest tagged release

#### Scenario: Installing repository with no tagged versions
- **WHEN** a user prepares to install a GitHub plugin whose repository has no tags
- **THEN** the version dropdown defaults to and selects `latest untagged`

#### Scenario: User chooses a specific version or latest untagged
- **WHEN** the user selects an older tag or `latest untagged` from the install dropdown and confirms installation
- **THEN** the system installs the plugin pinned to the selected tag or branch reference

### Requirement: Detail View Version Dropdown
The system SHALL display an interactive version dropdown in the plugin's detail view containing all available versions and identifying the currently active version.

#### Scenario: Viewing plugin with available tags
- **WHEN** a user navigates to the detail page of an installed GitHub plugin
- **THEN** the detail view displays a dropdown containing all repository tags, the `latest untagged` entry, and marks the currently installed version

#### Scenario: Switching version from detail view
- **WHEN** the user selects a different version from the dropdown in the detail view and confirms the change
- **THEN** the system reinstalls the plugin pinned to the chosen version reference

#### Scenario: Version switch failure rollback
- **WHEN** reinstalling the plugin to the chosen version fails
- **THEN** the system restores the previously active version and displays an error message explaining the failure

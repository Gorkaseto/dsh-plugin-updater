# Spec Delta

## Purpose

Discovers and resolves available versions and release tags for GitHub plugin repositories, determines the default latest tagged release, and generates the latest untagged reference.

## ADDED Requirements

### Requirement: Repository Tag Fetching
The system SHALL query GitHub repository tags to discover all available release tags for a specified GitHub plugin repository.

#### Scenario: Successfully fetching repository tags
- **WHEN** version discovery is requested for a valid GitHub repository
- **THEN** the system retrieves all release tags with their names and target commit references

#### Scenario: Repository without tags
- **WHEN** version discovery is requested for a repository that has no tags
- **THEN** the system returns an empty list of tags without raising an error

#### Scenario: Rate limiting or network error during tag fetch
- **WHEN** the GitHub API responds with HTTP 403, 429 or network errors while fetching tags
- **THEN** the system reports a descriptive check failure indicating the network or rate limit condition

### Requirement: Version Sorting and Latest Tag Identification
The system SHALL parse tags into Semantic Versioning representations, sort them in descending precedence, and identify the latest available tagged version.

#### Scenario: Multiple semver tags present
- **WHEN** repository tags include multiple semver releases such as `v1.0.0`, `v1.2.0`, and `v1.1.5`
- **THEN** the system sorts them descending with `v1.2.0` identified as the default latest tagged version

#### Scenario: Non-semver or mixed tags
- **WHEN** repository tags contain a mix of valid semver tags and arbitrary strings
- **THEN** the system prioritizes valid semver tags in descending order, placing non-semver tags at the end

### Requirement: Latest Untagged Option Generation
The system SHALL include a `latest untagged` option representing the head of the default `main` branch alongside tagged versions.

#### Scenario: Repository with existing release tags
- **WHEN** a repository has one or more release tags and a default `main` branch
- **THEN** the system provides the available tagged versions and includes a `latest untagged` entry pointing to `main`

#### Scenario: Repository with no release tags
- **WHEN** a repository has no release tags at all
- **THEN** the system designates `latest untagged` as the sole and default version option

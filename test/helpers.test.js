import { test } from 'node:test'
import assert from 'node:assert/strict'
import { __test__ } from '../index.js'

const { parseGithubSource, compareVersions, parseVersion, lockedCommit } = __test__

test('parseGithubSource: GitHub forms', () => {
  assert.deepEqual(parseGithubSource('github:acme/dsh-foo'), { owner: 'acme', repo: 'dsh-foo', pinnedRef: null })
  assert.deepEqual(parseGithubSource('github:acme/dsh-foo#v1.0.0'), { owner: 'acme', repo: 'dsh-foo', pinnedRef: 'v1.0.0' })
  assert.deepEqual(parseGithubSource('github:acme/dsh-foo#main'), { owner: 'acme', repo: 'dsh-foo', pinnedRef: null })
  assert.deepEqual(parseGithubSource('git+https://github.com/acme/dsh-foo.git'), { owner: 'acme', repo: 'dsh-foo', pinnedRef: null })
  assert.deepEqual(parseGithubSource('https://github.com/acme/dsh.foo#abc123'), { owner: 'acme', repo: 'dsh.foo', pinnedRef: 'abc123' })
  assert.deepEqual(parseGithubSource('git+ssh://git@github.com/acme/dsh-foo.git#dev'), { owner: 'acme', repo: 'dsh-foo', pinnedRef: 'dev' })
  assert.deepEqual(parseGithubSource('git@github.com:acme/dsh-foo.git'), { owner: 'acme', repo: 'dsh-foo', pinnedRef: null })
  assert.deepEqual(parseGithubSource('github:acme/dsh-foo#semver:^1.0.0'), { owner: 'acme', repo: 'dsh-foo', pinnedRef: null })
})

test('parseGithubSource: subdirectory installs are unsupported', () => {
  assert.deepEqual(parseGithubSource('github:acme/mono#path:/packages/foo'), { owner: 'acme', repo: 'mono', unsupported: 'path' })
  assert.deepEqual(parseGithubSource('github:acme/mono#main&path:/packages/foo'), { owner: 'acme', repo: 'mono', unsupported: 'path' })
})

test('parseGithubSource: non-GitHub specs', () => {
  for (const spec of ['@scope/pkg', '@scope/pkg@1.2.3', 'link:C:/x/y', 'file:../foo', 'gitlab:acme/foo',
    'git+https://gitlab.com/acme/foo.git', 'https://example.com/foo.tgz', '', undefined]) {
    assert.equal(parseGithubSource(spec), null, String(spec))
  }
})

test('compareVersions: precedence', () => {
  assert.equal(compareVersions('1.2.0', '1.3.0'), -1)
  assert.equal(compareVersions('1.3.0', '1.2.0'), 1)
  assert.equal(compareVersions('1.2.0', '1.2.0'), 0)
  assert.equal(compareVersions('2.0.0', '1.9.0'), 1)
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1)
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1)
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1)
  assert.equal(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.beta'), -1)
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.11'), -1)
  assert.equal(compareVersions('1.0.0+build.1', '1.0.0+build.2'), 0)
  assert.equal(compareVersions('v1.0.0', '1.0.0'), 0)
})

test('compareVersions: invalid strings', () => {
  for (const bad of ['1.0', 'latest', '01.0.0', '1.0.0-', '', null]) {
    assert.equal(parseVersion(bad), null, String(bad))
    assert.equal(compareVersions(bad, '1.0.0'), null)
  }
})

const SHA = 'a'.repeat(40), OTHER = 'b'.repeat(40)

test('lockedCommit: importer codeload entry', () => {
  const lock = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      '@acme/dsh-foo':
        specifier: github:acme/dsh-foo
        version: https://codeload.github.com/acme/dsh-foo/tar.gz/${SHA}
      other:
        specifier: github:acme/other
        version: https://codeload.github.com/acme/other/tar.gz/${OTHER}
`
  assert.equal(lockedCommit(lock, '@acme/dsh-foo'), SHA)
  assert.equal(lockedCommit(lock, 'other'), OTHER)
  assert.equal(lockedCommit(lock, 'missing'), null)
})

test('lockedCommit: git resolution in packages section', () => {
  const lock = `packages:

  '@acme/dsh-foo@git+https://git@github.com:acme/dsh-foo.git#${SHA}':
    resolution: {commit: ${SHA}, repo: git+https://git@github.com:acme/dsh-foo.git, type: git}
    version: 1.0.0
`
  assert.equal(lockedCommit(lock, '@acme/dsh-foo'), SHA)
  assert.equal(lockedCommit('', '@acme/dsh-foo'), null)
})

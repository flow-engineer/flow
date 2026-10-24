# Releasing

Every release, 0.x included, has release notes with a **Migration notes** section ([stability.md](stability.md)).

## Checklist

1. Every change since the last release is in `CHANGELOG.md`, under a new section for this version
   (template below).
2. **Migration notes** is filled: each breaking change named, with what an agent must change. When
   nothing breaks, it says "None." A breaking change is anything on [stability.md](stability.md)'s
   list that is renamed, removed or changes meaning, or a default that changes what an agent does.
3. A deprecated name still works, and its note says what replaces it and when it goes.
4. `README.md`, `docs/` and the coding-agent skills in `coding-agents/` match the release.
5. The version in `package.json` (and `package-lock.json`) is bumped and the commit is tagged
   `v<version>`.
6. `npm test`, `npm test --prefix simulators` and `npm test --prefix flow-messaging` pass.
7. `npm run test:conformance` (the delivery guarantees' suite, conformance/; not in npm test).
8. Push the release tag. The [npm publishing workflow](../.github/workflows/npm-publish.yml) runs
   the release checks and `scripts/release.sh` on GitHub, then confirms the version is available
   as npm's `latest`. The tag must point to a commit already merged into `main`.

## Publishing through GitHub Actions

After merging the version, lockfile and release notes into `main`, tag that clean commit and push:

```sh
version=$(node -p "require('./package.json').version")
git tag -a "v$version" -m "Flow Framework $version"
git push origin "v$version"
gh run list --workflow npm-publish.yml
```

The workflow uses npm trusted publishing through GitHub OIDC; it needs no `NPM_TOKEN` or local
npm login. It runs typecheck, conformance and the three test suites before publishing. A version
tag must match `package.json`, and the tagged source must belong to `main`. The workflow waits
for npm's registry to finish processing the package before confirming `latest`.

A failed run before publication can be retried with GitHub's rerun UI, or dispatched on its tag:

```sh
version=$(node -p "require('./package.json').version")
gh workflow run npm-publish.yml --ref "v$version"
```

Check the registry before retrying a run that reached publishing: an accepted npm version cannot
be overwritten. The tag must include the workflow file; dispatching on a branch refuses to publish.

### One-time trusted publisher setup

In npm's package settings for `@flow-engineer/flow`, add a GitHub Actions trusted publisher with
organization `flow-engineer`, repository `flow`, workflow filename `npm-publish.yml` and no
environment name. Enable direct `npm publish`; staging permission alone does not authorize this
workflow. No separate `npm dist-tag` permission is needed. Saving this grant may ask the package
maintainer to authenticate once. [npm's setup guide](https://docs.npmjs.com/trusted-publishers/)

Local publishing remains available for recovery: after the same release checks, run
`scripts/release.sh` from the clean tagged commit and complete npm's publishing authentication.

## Template

```md
## <version> (<date>)

### Changes

- <what changed, for someone building an agent>

### Migration notes

None.
<!-- or, one entry per breaking change: -->
- **<what changed>.** <What breaks.> To move: <what to change, with the old and new code>.
```

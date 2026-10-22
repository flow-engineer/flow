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
8. `scripts/release.sh` publishes from the clean, tagged commit.

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

# makefun-github-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Hoshine-yosa/makefun-github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Hoshine-yosa/makefun-github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node.js process (stdlib only): REST v3, GraphQL, MCP, and hand-written git smart HTTP (upload-pack v2, receive-pack v0) over one in-memory store. Deterministic replays, byte-identical state exports.

## Run it

```sh
node --experimental-strip-types serve-local.ts
```

## Practice

Local grade (`grade-local`, `--driver process`, 3 practice trials, verified 2026-11-17):

- trial-0: 928 (feature 600, agent 200, perf 128)
- trial-1: 941 (feature 600, agent 200, perf 141)
- trial-2: 965 (feature 600, agent 200, perf 165)
- **mean: 944.7** (90% interval 913–976); all 120 conformance checks pass on every trial; every replay is byte-identical.

Design notes: one Node 22 process, stdlib only, no git binary, no model calls. A single in-memory store backs all four surfaces (REST, GraphQL, MCP, git smart HTTP), so the same objects and ids are visible everywhere. Git packs are written and read by hand (upload-pack v2, receive-pack v0). State exports are deterministic: no timestamps, no random ids, no map-order leaks.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

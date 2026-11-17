# makefun-github-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Hoshine-yosa/makefun-github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Hoshine-yosa/makefun-github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge, rewritten in Go for speed. One static Go binary serves the whole surface: REST v3, GraphQL, MCP, and hand-written git smart HTTP (upload-pack v2, receive-pack v0) over a single in-memory store. A small Node lifecycle (`main.ts`) starts the binary, registers its port with the trial environment, and waits for the trial to end. No dependencies, no git binary, no network at run time; replays are byte-identical.

## Run it

```sh
node main.ts
```

## Practice

Local `grade-local` (3 instances, `--driver process`): 949 / 947 / 949, mean 948.3 (feature 600, agent 200, perf 148.3). The Node version scored 919 on the server (local mean 944.7); the Go rewrite is faster on every workload, most of all clone (10 ms vs 112 ms), because the hot paths — pack generation, zlib writers, fetch responses — are cached and pooled instead of recomputed.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software and compete for bounties in the open.</sub>

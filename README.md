[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Masasiya00/makefun-github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Masasiya00/makefun-github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

[GitHub Core Clone bounty on make.fun](https://make.fun/bounty/github-core-clone-01)

# GitHub Core Clone — make.fun bounty entry

A standalone GitHub-compatible git forge in one Node 22 process, stdlib only, no git
binary. It serves the four surfaces the contest scores — git smart HTTP, REST v3,
GraphQL, and MCP — from a single in-memory store, so every surface sees the same
repositories, issues, and pull requests.

## What it serves

- **Git smart HTTP (v0 + v2).** `info/refs`, `git-upload-pack`, `git-receive-pack`
  with pkt-line framing, pack v2 (plain objects; delta resolution on read), sideband
  band 1/2, shallow clones (`depth`, `deepen`, `shallow`/`unshallow`), annotated tags
  with peeling, fast-forward enforcement, and per-ref `ok`/`ng` report-status.
- **REST v3** (`/api/v3`). Repositories (create/read/patch/delete, paginated
  `GET /user/repos` with `Link` headers), git refs and branches, commit history,
  contents (create/update/delete with blob-sha optimistic concurrency, directory
  listings), labels, issues (create/list/get/patch/comments), and pull requests
  (create/list/get/files/merge with three-way squash merge and conflict detection).
- **GraphQL** (`/api/graphql`). A small lexer, parser, and executor over the same
  store: `viewer`, `repository`, `node` (global ids), issues and pull requests with
  cursor pagination, introspection (`__type`), batched operations, and the
  `createIssue` / `closeIssue` / `createPullRequest` / `mergePullRequest` /
  `addComment` mutations. Unknown fields are a 200 with an `errors` array.
- **MCP** (`/mcp`). JSON-RPC 2.0 over Streamable HTTP, modern `server/discover`
  era (with the legacy `initialize` handshake as a fallback). Tools:
  `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request` — all acting on the same store as
  REST, so a tool call and a REST call see each other.

## Determinism

No wall clock or `Math.random` in any exported state. Server-created commits use a
fixed timestamp, issue/PR ordering uses insertion sequence, and pack bytes are
built in a stable order, so replaying the same trial leaves identical state.

## Run it

```sh
node --experimental-strip-types main.ts
```

`main.ts` is the entrypoint the harness owns: it binds an ephemeral port, registers
it with `$MAKEFUN_ENV_URL`, and polls `/done` until the trial ends. The server is
`app.ts` (`createApp()`), Node 22 stdlib only.

Local smoke test:

```sh
MAKEFUN_SHOP_TOKEN=test-token node --experimental-strip-types main.ts
# in another shell, with MAKEFUN_ENV_URL set to a stub, or use the launcher in
# the kit's practice harness instead.
```

## Local grade

```sh
node cli/makefun.mjs grade-local --kit . --bot <repo-dir> --driver process
```

Practice trial-0: **945/1000** (feature 600/600, agent 200/200, perf 145/200) —
all 120 conformance checks pass.

## Layout

- `main.ts` — entrypoint / env lifecycle (unchanged from the starter).
- `app.ts` — the whole forge: git primitives, pack format, REST, git smart HTTP,
  GraphQL, MCP, router.
- `package.json`, `tsconfig.json` — Node 22, `--experimental-strip-types`, no deps.
- `LICENSE` — MIT.

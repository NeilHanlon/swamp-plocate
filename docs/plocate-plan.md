# @kneel/plocate — Extension Plan & Implementation Hand-off

Status: **planned, not yet built** (read-only research complete 2026-07-14)
Collective: `@kneel` (confirmed via `swamp auth whoami` → collectives: `shrug`, `kneel`)
Target file: `extensions/models/plocate.ts` + `manifest.yaml` entry + `extensions/docs/` / repo `README`

---

## 1. What this is and why a model extension

A swamp **extension model** that wraps [plocate](https://plocate.sesse.net/) so other
extensions / tools / agents can **query filesystem contents fast without walking
directory trees**. It owns the full index lifecycle — build, refresh, query, clear —
plus **cache-freshness policy** (knowing when an index is "too old", configurable).

**Primitive choice — settled.** A custom extension model is the sanctioned piece:

- Registry search (`swamp extension search plocate|locate|filesystem`) → **no existing
  extension** covers this. `@whyvez/disk-usage` is unrelated (df-style stats).
- Local type search (`swamp model type search locate|file`) → empty.
- CLAUDE.md **Rule 1** forbids `command/shell` for "wrapping a CLI tool or building an
  integration" — that is exactly this. So a custom model in `extensions/models/*.ts`
  is correct. Not a workflow (single tool), not a report (it acts, not just analyzes).
- Pattern precedent: the S3/VPC scanner scenarios spawn `Deno.Command("aws", …)`. We do
  the same with `plocate` / `updatedb`, wrapped in a transport prefix (below).

**The elegant fit:** the "too old" requirement is a **native swamp primitive**. Store the
index-metadata resource with `lifetime: <maxAge>`. When it expires, `data.latest(...)`
returns nothing → every downstream consumer automatically sees "no fresh index" with
zero custom age math. That is swamp earning its keep.

### Fit rating: **7 / 10** (honest split)

- **Index lifecycle & freshness (build/refresh/clear/status): ~9/10.** Textbook swamp — a
  CLI-wrapper resource whose TTL *is* the cache-invalidation requirement, whose metadata
  becomes CEL-referenceable.
- **Hot query path: ~5/10.** plocate exists for sub-millisecond lookups; wrapping each
  query in `swamp model method run` (process spawn + per-model lock + data write + a
  container hop) adds overhead that partly defeats the point. An agent wanting raw speed
  will just run `toolbox run -c fedora plocate …` directly. Swamp's value is **owning the
  index and its freshness** and making results referenceable — not being in the query loop.

Blended: clearly worth building, clearly the right primitive; the caveat that keeps it out
of 9–10 is that swamp is the *manager*, not the *accelerator*.

---

## 2. Environment facts (verified on Neil's box, 2026-07-14)

- **plocate is NOT on the host** — only `/bin/updatedb` from mlocate/findutils (2022), whose
  DB format is **incompatible** with plocate. Do not use it.
- **plocate 1.1.23 + `updatedb (plocate) 1.1.23` live in the `fedora` toolbox container**
  (`registry.fedoraproject.org/fedora-toolbox:42`, currently running). Reachable
  non-interactively via `toolbox run -c fedora <cmd>` (verified) or `podman exec fedora`.
- **`$HOME` is shared** host↔container (verified: host wrote `~/.cache/<probe>`, container
  read it). So a user-owned DB at `~/.cache/swamp-plocate/*.db` is visible on both sides —
  build inside the container, and the `.db` is readable everywhere.
- plocate's `updatedb` supports: `--require-visibility FLAG (-l)`, `--database-root PATH
  (-U)`, `--output FILE (-o)`, `--prunepaths PATHS`, `--add-prunepaths PATHS (-e)`.
- The system DB `/var/lib/plocate/plocate.db` lives *inside the container*, is root-built,
  and does not currently exist on the host path.

**Deployment requirement to surface in README:** for the default `local` transport, the
consumer must have `plocate` + plocate's `updatedb` on `PATH`. For `become: true`, the
transport target needs **passwordless sudo** (normal for toolbox containers).

---

## 3. Decisions locked with Neil

| Decision | Answer |
|---|---|
| DB scope | **Both** — user-owned corpus DBs *and* optional read-only query of a system DB |
| Query output | **Persist** matches as a `results` resource (CEL-referenceable) |
| Collective | `@kneel` |
| Default transport | **`local`** (NOT toolbox). Accept any transport. |
| Privilege escalation | Ansible-style **`become: bool`** (default `false`), stacks `sudo` |

---

## 4. Execution model — transport + become

The model runs on the **host**. Every plocate/updatedb call is assembled as a prefix stack:

```
argv = [ ...transportPrefix, ...(become ? ["sudo"] : []), bin, ...flags ]
```

**Transport resolution (in order):**
1. If `commandPrefix` (string[]) is set → use it verbatim. This is the escape hatch that
   "accepts whatever transport" (ssh, `nsenter`, `docker exec`, a wrapper script).
2. Else map `runtime` enum:
   - `local` (**default**) → `[]`
   - `toolbox` → `["toolbox", "run", "-c", container]`
   - `podman`  → `["podman", "exec", container]`
3. `become` appends `["sudo"]` **after** the transport prefix, so escalation happens on the
   target (e.g. `toolbox run -c fedora sudo updatedb` — root inside the container, which is
   where the system DB lives).

`become` maps onto the Both-scope answer:
- **User corpus DBs** → `become:false`, `--require-visibility 0 -o ~/.cache/... -U <root>`. No sudo.
- **System DB build** → `become:true` (`sudo updatedb`). Query of system DB is usually fine
  unprivileged (plocate is setgid `plocate`).

Neil's box will set `runtime: toolbox, container: fedora` (or `commandPrefix:
["toolbox","run","-c","fedora"]`) in the instance `input.yaml`. Default stays honest for
anyone else who has plocate locally.

---

## 5. Model shape

**Type:** `@kneel/plocate`. **One model instance = one named index** (swamp-idiomatic 1:1
resource representation; the resource *is* a plocate index).

### Global arguments (Zod)

| arg | type | default | notes |
|---|---|---|---|
| `roots` | `string[]` | — | dirs to index; one DB per root (queryable together via `db1:db2`) |
| `dbDir` | `string` | `~/.cache/swamp-plocate` | where user DBs live (expand `~`) |
| `maxAge` | `string` | `24h` | freshness threshold; drives `index` resource `lifetime` |
| `requireVisibility` | `0 \| 1` | `0` | plocate `--require-visibility` |
| `prunePaths` | `string[]` | `[]` | `--prunepaths` |
| `pruneNames` | `string[]` | `[]` | `--prunenames` |
| `runtime` | `"local" \| "toolbox" \| "podman"` | `"local"` | transport |
| `container` | `string` | `""` | required for toolbox/podman |
| `commandPrefix` | `string[]` | `[]` | escape hatch; overrides `runtime` when set |
| `become` | `boolean` | `false` | global default; per-method arg can override |
| `systemDb` | `string` | `/var/lib/plocate/plocate.db` | for query-only system scope |
| `plocateBin` | `string` | `"plocate"` | binary name/path on the target |
| `updatedbBin` | `string` | `"updatedb"` | plocate's updatedb on the target |

### Resources

| spec (instance) | schema (key fields) | lifetime |
|---|---|---|
| `index` (`main`, or per-root dynamic name) | `dbPath, roots, builtAt, sizeBytes, fileCount, maxAge, stale` | **`maxAge`** ← native staleness |
| `results` (per query, e.g. `q-<hash>`) | `pattern, matches: string[], count, ranAt, dbPaths, stale` | `1h` |

Resource spec keys must not contain hyphens. Declare referenced fields explicitly (not
`.passthrough()` only) so CEL validators resolve them.

### Methods

| method | args | behavior |
|---|---|---|
| `build` / `refresh` | `{ become? }` | run plocate `updatedb` per root → user DB(s); write `index` (lifetime=maxAge). Throw before writing on failure. |
| `refresh_all` | `{ become? }` | **fan-out (Rule 6):** rebuild every configured root in ONE execution / one lock; write one `index` instance per root with dynamic instance names. |
| `query` | `{ pattern, limit?, regex?, ignoreCase?, refreshIfStale?, scope?: "user"\|"system" }` | if `refreshIfStale` and DB mtime older than `maxAge` → rebuild first (self-heal); run `plocate --database <db(:db…)>`; **persist `results`**; return matches. `scope:"system"` queries `systemDb` read-only. |
| `status` | `{}` | read DB mtime(s); return `{ stale, ageSeconds, builtAt, fileCount }`. Consider also exposing as a pre-flight `check` labelled `live`. |
| `clear` | `{}` | **verify `dbPath` (Rule 5)** then delete DB file(s) + `deleteResource("index")`. |

**Freshness = three layers:** (1) `index` TTL = passive expiry; (2) `query
refreshIfStale` = self-healing; (3) a cron/timer workflow calling `refresh_all` = proactive
nightly rebuild (mirror Neil's existing NTS-report cron).

### plocate flag reference for the implementer (verify with `plocate --help` in-container)

- Build: `updatedb --require-visibility <0|1> -o <dbPath> -U <root> [--prunepaths …] [--add-prunepaths …]`
- Query: `plocate --database <db>[:<db>…] [-i] [-r|--regexp] [-l <N>|--limit <N>] [-c|--count] <pattern>`
- Use `-0`/null-sep parsing if paths may contain newlines; otherwise split stdout on `\n`.

---

## 6. README example catalog (write these as runnable blocks)

Each example = instance `input.yaml` (global args incl. `runtime`/`become`) + the
`method run` invocation + the CEL that consumes the output. Doubles as usage docs AND a
pattern catalog. Go **beyond indexing swamp itself.**

**Swamp-native workloads**
1. **Fan-out over matches** — index a corpus once; another model's `forEach` iterates
   `data.latest("rpm-index","results").matches` instead of walking dirs. (The core
   tree-walk-avoidance, concrete.)
2. **Pre-flight existence check** — a deploy model's `check` queries the index to confirm a
   built asset / cert / patch exists before acting — no filesystem crawl in the hot path.
3. **Freshness gate in a workflow** — a step conditions on `status.stale == false`, else
   runs `refresh` first; wire via `model.<idx>.resource.index.main.attributes.builtAt`.
4. **Cross-model CEL wiring** — model B reads `…index.main.attributes.dbPath`, runs its own
   targeted `plocate --database`, or gates on `maxAge`.
5. **RPM/build driver** — index `../fedora/rpms/swamp`, query `*.spec` / patches to feed a
   build workflow.
6. **Nightly proactive refresh** — cron/timer workflow calling `refresh_all`.
7. **Multi-root query** — `plocate --database a:b:c` across several corpus DBs in one call.

**General / beyond swamp**
8. **Agent "where is X"** — index `~/dev` + `~/Nextcloud`, query by name/regex for instant
   path resolution.
9. **Backup verification** — index a backup target, confirm expected files present.
10. **Monorepo discovery** — index a huge repo once, resolve paths without `find`.
11. **Security sweep** — index a tree, query for `*.pem`, `id_rsa`, `*.env`, stray secrets.
12. **Media library** — index a Nextcloud photo/media tree, find by filename fast.

---

## 7. Testing plan

- **Smoke** (source mode, before any push): `swamp extension source add`, create an instance
  pointed at `runtime: toolbox, container: fedora` with `roots: [<repo>/extensions]`, run
  `refresh` then `query pattern:plocate` — expect the `.ts` file in matches; assert `index`
  and `results` resources written; assert `status.stale == false` right after build.
- **Unit** (`@systeminit/swamp-testing`, `createModelTestContext`): mock `Deno.Command`;
  verify (a) transport+become argv assembly for each `runtime` and `commandPrefix`; (b)
  `refreshIfStale` triggers a build when mtime > maxAge; (c) `clear` verifies path before
  delete; (d) failure path throws *before* `writeResource`.
- **Validation:** `swamp doctor extensions`, `swamp extension fmt`, `swamp extension quality`,
  `swamp extension push --dry-run`.
- **Do NOT `swamp extension push`** until Neil reviews (standing rule — see memory
  `no-push-extensions-without-review`).

---

## 8. HAND-OFF — instructions for the implementing (coordinator) agent

You are the coordinator. Fan out with subagents. **Land the shared contract first**, then
parallelize. Everything below is the source of truth; also read this repo's `CLAUDE.md`,
`AGENTS.md`, and load the `swamp-extension-model` + `swamp-extension-publish` skills.

### Dependency graph
```
WS1 (contract: arg schema + transport/become command-builder + resource specs)  ← MUST land first
        │
        ├── WS2 (lifecycle methods: build/refresh/refresh_all/status/clear)  ┐
        ├── WS3 (query method + results + refreshIfStale self-heal)          ├─ parallel
        ├── WS4 (README example catalog)                                     │  (all consume WS1 contract)
        └── WS5 (manifest.yaml + unit tests + smoke test harness)           ┘
                        │
                   WS6 (integration smoke test in `fedora` toolbox, validate, quality, dry-run)  ← after WS2/WS3/WS5
```

### Shared contract (WS1 — define exactly, others code against it)
- Export `const model = { type: "@kneel/plocate", version: "<YYYY.MM.DD.1>", globalArguments,
  resources, methods }`.
- `import { z } from "npm:zod@4";` (never bare `zod`).
- Implement `buildArgv(globalArgs, { become?, bin, flags }): string[]` per §4. Unit-testable
  in isolation. This is the seam every other method calls — freeze its signature first.
- Declare the `index` and `results` Zod schemas per §5 with explicit fields.
- Version string is date-based `YYYY.MM.DD.N` (see forgejo `2026.04.13.1`).

### Workstream briefs
- **WS2 — lifecycle methods.** Implement `build`/`refresh` (alias), `refresh_all` (fan-out,
  one execution, dynamic instance names), `status`, `clear`. Use `Deno.Command` via
  `buildArgv`. Throw before writing on failure. `clear` reads the stored `index` to get the
  real `dbPath`, verifies it, then deletes. Set `index` lifetime override = `maxAge`.
- **WS3 — query.** Implement `query` with self-heal (`refreshIfStale` → call the build path
  when `now - dbMtime > maxAge`), `scope: user|system`, multi-DB `a:b:c`, persist `results`
  (lifetime `1h`), return matches. Respect `limit`/`regex`/`ignoreCase`.
- **WS4 — README.** Write §6's 12 examples as runnable `input.yaml` + `method run` + CEL
  blocks. Include the deployment requirement (§2) and the transport/become table (§4).
- **WS5 — manifest + tests.** Add `manifest.yaml` (`manifestVersion: 1`, `name:
  "@kneel/plocate"`, `models: [plocate.ts]`, labels `[plocate, locate, filesystem, index,
  search]`). Write the unit tests from §7. Provide the smoke-test script.
- **WS6 — integrate & validate.** Source-load, smoke test in `fedora` toolbox (§7), then
  `swamp doctor extensions`, `fmt`, `quality`, `push --dry-run`. **Stop before real push.**

### Guardrails (do not violate)
- No `swamp extension push` — dry-run only; Neil reviews first.
- No bare `zod` imports; pin `npm:` versions on any other deps (bundler inlines them).
- Resource spec keys: no hyphens; instance names unique across specs (prefix with spec name).
- Verify paths before `clear`/delete (Rule 5). Prefer fan-out `refresh_all` over N calls
  (Rule 6).
- plocate is only in the `fedora` toolbox on this box — smoke tests must set
  `runtime: toolbox, container: fedora`, not `local`.
```

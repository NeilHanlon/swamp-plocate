# @kneel/plocate

A swamp extension model that wraps [plocate](https://plocate.sesse.net/) so
other extensions, workflows, and agents can **query filesystem contents fast
without walking directory trees**. It owns the full index lifecycle
(`build` / `refresh` / `refresh_all` / `status` / `clear` / `query`) plus the
**cache-freshness policy**: the `index` resource is stored with
`lifetime == maxAge`, so when it expires `data.latest(...)` returns nothing and
every consumer automatically sees "no fresh index" with zero custom age math.
One model instance = one named index (a set of plocate DBs, one per root).

- **Type:** `@kneel/plocate`
- **Version:** `2026.07.15.1`

---

## 1. Deployment requirements

plocate does the work; this model only orchestrates it. The transport target
(where the binary actually runs — see §2) must have:

- **`plocate`** and **plocate's own `updatedb`** on `PATH`.
  plocate's `updatedb` writes a DB format that is **NOT compatible** with the
  `mlocate` / GNU findutils `updatedb`. A stray `/usr/bin/updatedb` from
  findutils will *not* produce a queryable plocate DB — point `updatedbBin` at
  plocate's updatedb if both are installed.
- For **`become: true`** (system-DB builds, `sudo updatedb`): the target needs
  **passwordless sudo**. This is normal inside toolbox containers.

### This box

plocate is only installed inside the **`fedora` podman toolbox** here — the host
has only findutils `updatedb` (incompatible). So instances on this machine must
set:

```yaml
runtime: toolbox
container: fedora
```

`$HOME` is shared host↔container, so a DB built inside the container at
`~/.cache/swamp-plocate/*.db` is readable on both sides — `status`/`clear` stat
the file host-side, while `updatedb`/`plocate` run in the container.

---

## 2. Execution model — transport + `become`

The model process runs on the **host**. Every `plocate` / `updatedb` invocation
is assembled as a prefix stack:

```
argv = [ ...transportPrefix, ...(become ? ["sudo"] : []), bin, ...flags ]
```

`transportPrefix` decides *where* the binary runs; `become` stacks `sudo`
**after** the transport prefix, so escalation happens on the target (e.g.
`toolbox run -c fedora sudo updatedb` → root inside the container, where the
system DB lives).

| `runtime` | resulting prefix |
|---|---|
| `local` (default) | *(none)* — binary must be on the host `PATH` |
| `toolbox` | `toolbox run -c <container>` |
| `podman` | `podman exec <container>` |
| *(any)* + `commandPrefix` set | **`commandPrefix` verbatim** — overrides `runtime` entirely (e.g. `["ssh","host"]`, `["nsenter", ...]`) |

`toolbox` and `podman` both require a non-empty `container`. A per-method
`become` argument overrides the global `become` for that one call.

---

## 3. Global arguments

Set on the instance (via `--global-arg` flags or an `input.yaml`).

| arg | type | default | notes |
|---|---|---|---|
| `roots` | `string[]` (min 1, **required**) | — | dirs to index; one DB per root, queryable together as `db1:db2` |
| `dbDir` | `string` | `~/.cache/swamp-plocate` | where user DBs live; `~` expands to `$HOME` |
| `maxAge` | `string` | `24h` | freshness threshold; drives `index` lifetime and `refreshIfStale` |
| `requireVisibility` | `0 \| 1` | `0` | `updatedb --require-visibility` |
| `prunePaths` | `string[]` | `[]` | `updatedb --prunepaths` |
| `pruneNames` | `string[]` | `[]` | `updatedb --prunenames` |
| `runtime` | `local \| toolbox \| podman` | `local` | transport (see §2) |
| `container` | `string` | `""` | required for `toolbox` / `podman` |
| `commandPrefix` | `string[]` | `[]` | verbatim transport override |
| `become` | `boolean` | `false` | stack `sudo`; per-method arg can override |
| `systemDb` | `string` | `/var/lib/plocate/plocate.db` | read-only DB for `query scope:"system"` |
| `plocateBin` | `string` | `plocate` | plocate binary on the target |
| `updatedbBin` | `string` | `updatedb` | plocate's updatedb on the target |

## 4. Methods

| method | args | behavior |
|---|---|---|
| `build` | `{ become? }` | rebuild every root's DB in one execution; write aggregate `index` instance `main` (lifetime = `maxAge`). Throws before writing on failure. |
| `refresh` | `{ become? }` | alias for `build`. |
| `refresh_all` | `{ become? }` | **fan-out (Rule 6):** rebuild every root in ONE execution / one lock; write one `index` instance **per root** (instance name = slug of the root path) **plus** aggregate `main`. |
| `status` | `{}` | stat DB mtime(s) host-side, compare to `maxAge`, write `index` `main` with computed `stale`. Does not rebuild. |
| `clear` | `{}` | verify each DB path is inside `dbDir` (Rule 5), delete the user DB file(s), overwrite `index` `main` with a cleared marker (`stale:true, fileCount:0`). Does not touch the system DB. |
| `query` | `{ pattern, limit?, regex?, ignoreCase?, refreshIfStale?, scope?, label? }` | query the index; persist a `results` instance (`q-<label>`, or `q-<hash>` when no `label`); return matches. Self-heals (rebuilds) first when `refreshIfStale` and the user index is stale. `scope: "user"` (default) queries the per-root corpus DBs; `scope: "system"` queries the read-only `systemDb`. |

### Resources (CEL-referenceable fields)

`data.latest(...)`'s second argument is the **instance name** (the data
artifact name), not the spec name:

| spec | instance name(s) | fields | lifetime |
|---|---|---|---|
| `index` | `main` (aggregate) and per-root path slugs (from `refresh_all`) | `dbPath, roots, builtAt, sizeBytes, fileCount, maxAge, stale` | `maxAge` |
| `results` | `q-<label>` when `--arg label=<label>` is passed, else `q-<hash>` | `pattern, matches, count, ranAt, dbPaths, stale` | `1h` |

Prefer the `data.latest(...)` form (repo Rule 4). Reference the index by its
instance name `main`, and results by a **stable `label` you pass to `query`**
(the default `q-<hash>` is deterministic but not easily predictable, so pass
`--arg label=<name>` whenever another model consumes the results):

```
data.latest("<model>", "main").attributes.builtAt          # the index
data.latest("<model>", "q-<label>").attributes.matches     # results of `query --arg label=<label>`
```

The deprecated
`model.<model>.resource.index.main.attributes.<field>` form still resolves
(shown once in Example 3 for reference), but `data.latest` is preferred.

---

## 5. Example catalog

Every block below is a real instance + `method run` + the CEL that consumes the
output. On this box, `runtime: toolbox, container: fedora` is required (§1); the
defaults stay honest for anyone with plocate on their host `PATH`.

### 1. Fan-out over matches

Index a corpus once, then let another model iterate the matches instead of
walking directories.

```bash
swamp model create @kneel/plocate rpm-index \
  --global-arg roots='["/home/neil/dev/fedora/rpms/swamp"]' \
  --global-arg runtime=toolbox \
  --global-arg container=fedora

swamp model method run rpm-index build
swamp model method run rpm-index query --arg pattern='.spec' --arg label=specs
```

```
# consuming model's forEach source:
data.latest("rpm-index", "q-specs").attributes.matches
```

### 2. Pre-flight existence check

A deploy model's `check` confirms a built asset exists before acting — no
filesystem crawl in the hot path.

```bash
swamp model create @kneel/plocate artifacts \
  --global-arg roots='["/var/www/releases"]' \
  --global-arg maxAge=1h

swamp model method run artifacts query \
  --arg pattern='app-v2.3.1.tar.gz' \
  --arg limit=1 \
  --arg refreshIfStale=true \
  --arg label=asset
```

```
# gate the deploy step on a nonzero match count:
data.latest("artifacts", "q-asset").attributes.count > 0
```

### 3. Freshness gate in a workflow

A step conditions on the index being fresh; otherwise it runs `refresh` first.

```bash
swamp model method run artifacts status
```

```yaml
# workflow step condition (only proceed when the index is fresh):
when: 'data.latest("artifacts", "main").attributes.stale == false'

# equivalent deprecated form, for reference:
# when: 'model.artifacts.resource.index.main.attributes.stale == false'
```

### 4. Cross-model CEL wiring

Model B reads the DB path this model owns and runs its own targeted query, or
gates on the configured `maxAge`.

```
# hand another model the exact DB path set:
data.latest("rpm-index", "main").attributes.dbPath   # "/home/.../swamp.db"
data.latest("rpm-index", "main").attributes.maxAge   # "24h"
data.latest("rpm-index", "main").attributes.roots
```

### 5. RPM / build-driver indexing

Index the Fedora RPM tree and query for spec files / patches to feed a build
workflow.

```bash
swamp model create @kneel/plocate swamp-rpms \
  --global-arg roots='["/home/neil/dev/fedora/rpms/swamp"]' \
  --global-arg runtime=toolbox \
  --global-arg container=fedora \
  --global-arg pruneNames='[".git"]'

swamp model method run swamp-rpms build
swamp model method run swamp-rpms query --arg pattern='.patch' --arg label=patches
```

```
data.latest("swamp-rpms", "q-patches").attributes.matches
```

### 6. Nightly proactive `refresh_all`

A cron/timer workflow rebuilds every root in one execution / one lock — the
proactive freshness layer (mirrors Neil's NTS-report cron).

`input.yaml`:

```yaml
roots:
  - /home/neil/dev
  - /home/neil/Nextcloud
runtime: toolbox
container: fedora
maxAge: 24h
pruneNames:
  - .git
  - node_modules
```

```bash
swamp model create @kneel/plocate home-index --input input.yaml
# scheduled nightly:
swamp model method run home-index refresh_all
```

`refresh_all` writes one `index` instance per root (slugged path names) plus
`main`. Reference the aggregate's freshness:

```
data.latest("home-index", "main").attributes.builtAt
```

### 7. Multi-root query

One `plocate --database a:b:c` call spans every corpus DB — the multi-root
instance from Example 6 answers a single query across both roots.

```bash
swamp model method run home-index query \
  --arg pattern='README.md' \
  --arg ignoreCase=true \
  --arg label=readmes
```

```
data.latest("home-index", "q-readmes").attributes.matches
data.latest("home-index", "q-readmes").attributes.dbPaths   # both root DBs
```

### 8. Agent "where is X" over ~/dev + ~/Nextcloud

Instant path resolution by name or regex — self-heals if the index went stale.

```bash
swamp model method run home-index query \
  --arg pattern='plocate.*\.ts$' \
  --arg regex=true \
  --arg refreshIfStale=true \
  --arg label=find-plocate
```

```
data.latest("home-index", "q-find-plocate").attributes.matches
```

### 9. Backup verification

Index a backup target and confirm expected files are present.

```bash
swamp model create @kneel/plocate backup-check \
  --global-arg roots='["/mnt/backup/nightly"]' \
  --global-arg maxAge=6h

swamp model method run backup-check refresh
swamp model method run backup-check query --arg pattern='postgres-dump.sql.gz' --arg label=dump
```

```
data.latest("backup-check", "q-dump").attributes.count == 1
```

### 10. Monorepo discovery

Index a huge repo once, resolve paths without `find`.

```bash
swamp model create @kneel/plocate monorepo \
  --global-arg roots='["/home/neil/dev/big-monorepo"]' \
  --global-arg pruneNames='[".git","node_modules","target","dist"]'

swamp model method run monorepo build
swamp model method run monorepo query --arg pattern='Dockerfile' --arg label=dockerfiles
```

```
data.latest("monorepo", "q-dockerfiles").attributes.matches
```

### 11. Security sweep for stray secrets

Index a tree and query for likely secret material.

```bash
swamp model create @kneel/plocate secscan \
  --global-arg roots='["/home/neil/dev","/srv"]' \
  --global-arg runtime=toolbox \
  --global-arg container=fedora

swamp model method run secscan build
swamp model method run secscan query --arg pattern='.pem'   --arg label=pem
swamp model method run secscan query --arg pattern='id_rsa' --arg label=idrsa
swamp model method run secscan query --arg pattern='.env'   --arg label=dotenv
```

```
# any hit is worth a look (one results instance per label):
data.latest("secscan", "q-pem").attributes.matches
data.latest("secscan", "q-idrsa").attributes.matches
data.latest("secscan", "q-dotenv").attributes.matches
```

### 12. Media library by filename

Index a Nextcloud media tree and find by filename fast.

```bash
swamp model create @kneel/plocate media \
  --global-arg roots='["/home/neil/Nextcloud/Photos"]' \
  --global-arg maxAge=7d \
  --global-arg pruneNames='[".stversions",".thumbnails"]'

swamp model method run media refresh
swamp model method run media query \
  --arg pattern='IMG_2021' \
  --arg ignoreCase=true \
  --arg label=img2021
```

```
data.latest("media", "q-img2021").attributes.matches
```

---

## 6. Testing / smoke

Source-load the extension and point an instance at the `fedora` toolbox (plocate
is only there on this box — never `local`):

```bash
swamp model create @kneel/plocate smoke \
  --global-arg roots='["/home/neil/dev/swamp/extensions"]' \
  --global-arg runtime=toolbox \
  --global-arg container=fedora
swamp model method run smoke refresh
swamp model method run smoke query --arg pattern=plocate
swamp model method run smoke status   # expect stale == false right after build
```

Expect the `plocate.ts` file among the matches, `index` + `results` resources
written, and `status.stale == false`.

### Freshness = three layers

1. **Passive expiry** — the `index` resource's `lifetime == maxAge`; when it
   expires, `data.latest(...)` returns nothing and consumers see no fresh index.
2. **Self-heal** — `query --arg refreshIfStale=true` rebuilds the user index in
   place before querying when the DB is older than `maxAge`.
3. **Proactive** — a cron/timer workflow calling `refresh_all` keeps every root
   rebuilt on a schedule (Example 6).

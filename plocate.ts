import { z } from "npm:zod@4";

// ─────────────────────────────────────────────────────────────────────────────
// @kneel/plocate — a swamp extension model wrapping plocate (https://plocate.sesse.net/)
//
// Owns the filesystem index lifecycle (build / refresh / query / clear) and the
// cache-freshness policy so other extensions and agents can query filesystem
// contents fast without walking directory trees.
//
// One model instance == one named index. The `index` resource IS the plocate
// database's metadata; its TTL (== `maxAge`) is the cache-invalidation primitive:
// when it expires, `data.latest(...)` returns nothing → consumers see "no fresh
// index" with zero custom age math.
//
// Every plocate/updatedb invocation is assembled as a prefix stack:
//   argv = [ ...transportPrefix, ...(become ? ["sudo"] : []), bin, ...flags ]
// The model runs on the host; the transport decides where the binary actually
// runs (local, toolbox, podman, or a verbatim commandPrefix escape hatch).
// ─────────────────────────────────────────────────────────────────────────────

// ── Global arguments (Zod) ────────────────────────────────────────────────────

const GlobalArgsSchema = z.object({
  roots: z.array(z.string()).min(1).describe(
    "Directories to index. One plocate DB is built per root; roots are queryable together (db1:db2).",
  ),
  dbDir: z.string().default("~/.cache/swamp-plocate").describe(
    "Directory holding user-owned plocate DBs. '~' is expanded to $HOME.",
  ),
  maxAge: z.string().default("24h").describe(
    "Freshness threshold. Drives the `index` resource lifetime (native staleness) and refreshIfStale self-heal.",
  ),
  requireVisibility: z.union([z.literal(0), z.literal(1)]).default(0).describe(
    "plocate updatedb --require-visibility. 0 = report all files without a visibility check (user corpus DBs).",
  ),
  prunePaths: z.array(z.string()).default([]).describe(
    "Paths to omit from the index (updatedb --prunepaths).",
  ),
  pruneNames: z.array(z.string()).default([]).describe(
    "Directory names to omit from the index (updatedb --prunenames).",
  ),
  runtime: z.enum(["local", "toolbox", "podman"]).default("local").describe(
    "Transport for running plocate/updatedb. 'local' runs on PATH; toolbox/podman hop into a container.",
  ),
  container: z.string().default("").describe(
    "Container name — required when runtime is 'toolbox' or 'podman'.",
  ),
  commandPrefix: z.array(z.string()).default([]).describe(
    "Escape hatch: verbatim transport prefix (e.g. ['ssh','host'] or ['nsenter',...]). Overrides `runtime` when non-empty.",
  ),
  become: z.boolean().default(false).describe(
    "Ansible-style privilege escalation: prepend 'sudo' after the transport prefix. Per-method `become` overrides this.",
  ),
  systemDb: z.string().default("/var/lib/plocate/plocate.db").describe(
    "Path to a system-wide plocate DB, for read-only queries with scope:'system'.",
  ),
  plocateBin: z.string().default("plocate").describe(
    "plocate binary name/path on the transport target.",
  ),
  updatedbBin: z.string().default("updatedb").describe(
    "plocate's updatedb binary name/path on the transport target.",
  ),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

// ── Resource schemas (declare referenced fields explicitly for CEL) ───────────

const IndexSchema = z.object({
  dbPath: z.string().describe(
    "Colon-joined DB path(s) this index covers (plocate --database <a:b:c>).",
  ),
  roots: z.array(z.string()).describe("Root directories indexed."),
  builtAt: z.iso.datetime().describe("ISO timestamp the index was (re)built."),
  sizeBytes: z.number().describe("Total size of the DB file(s) in bytes."),
  fileCount: z.number().describe(
    "Number of paths in the index (0 when cleared/unknown).",
  ),
  maxAge: z.string().describe("Configured freshness threshold for this index."),
  stale: z.boolean().describe(
    "True when the DB is older than maxAge, missing, or cleared.",
  ),
});

const ResultsSchema = z.object({
  pattern: z.string().describe("The query pattern."),
  matches: z.array(z.string()).describe("Matching paths."),
  count: z.number().describe("Number of matches returned."),
  ranAt: z.iso.datetime().describe("ISO timestamp the query ran."),
  dbPaths: z.array(z.string()).describe("DB file(s) queried."),
  stale: z.boolean().describe(
    "True if the queried index was stale at query time.",
  ),
});

// ── Transport + become command builder (WS1 frozen seam) ──────────────────────

// Resolve the transport prefix per §4: commandPrefix wins; else map the runtime enum.
function transportPrefix(g) {
  if (Array.isArray(g.commandPrefix) && g.commandPrefix.length > 0) {
    return [...g.commandPrefix];
  }
  switch (g.runtime) {
    case "toolbox":
      if (!g.container) {
        throw new Error(
          "runtime 'toolbox' requires a non-empty `container` global argument.",
        );
      }
      return ["toolbox", "run", "-c", g.container];
    case "podman":
      if (!g.container) {
        throw new Error(
          "runtime 'podman' requires a non-empty `container` global argument.",
        );
      }
      return ["podman", "exec", g.container];
    case "local":
    default:
      return [];
  }
}

/**
 * Assemble the argv for a plocate/updatedb invocation as a transport prefix stack:
 * `[ ...transportPrefix, ...(become ? ["sudo"] : []), bin, ...flags ]`.
 *
 * The per-method `become` overrides the global `become` when defined, and `sudo`
 * is appended AFTER the transport prefix so escalation happens on the target
 * (e.g. `toolbox run -c fedora sudo updatedb`). This is the single seam every
 * method calls, and is unit-tested in isolation.
 *
 * @param globalArgs The model's resolved global arguments (runtime, container,
 *   commandPrefix, become, …).
 * @param opts `{ become?, bin, flags }` — optional escalation override, the
 *   binary to run, and its flags.
 * @returns The full argv array, ready for `new Deno.Command(argv[0], { args: argv.slice(1) })`.
 */
export function buildArgv(globalArgs, opts) {
  const { become, bin, flags } = opts;
  const escalate = become === undefined
    ? Boolean(globalArgs.become)
    : Boolean(become);
  return [
    ...transportPrefix(globalArgs),
    ...(escalate ? ["sudo"] : []),
    bin,
    ...flags,
  ];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function expandHome(p) {
  if (p === "~") return Deno.env.get("HOME") ?? p;
  if (p.startsWith("~/")) {
    const home = Deno.env.get("HOME");
    if (home) return `${home}/${p.slice(2)}`;
  }
  return p;
}

// Deterministic per-root DB filename slug (used as the DB basename and, for
// refresh_all, the per-root index instance name).
function rootSlug(root) {
  const slug = expandHome(root)
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug.length > 0 ? slug : "root";
}

function dbPathForRoot(dbDir, root) {
  return `${expandHome(dbDir).replace(/\/$/, "")}/${rootSlug(root)}.db`;
}

// Parse a duration string (e.g. "24h", "30m", "7d", "1mo", "90s") to milliseconds.
function durationToMs(s) {
  const m = String(s).trim().match(/^(\d+)\s*(ms|s|m|h|d|w|mo|y)$/);
  if (!m) {
    // Fall back to a conservative default rather than throwing on a soft field.
    return 24 * 60 * 60 * 1000;
  }
  const n = Number(m[1]);
  const unit = m[2];
  const table = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
    mo: 30 * 24 * 60 * 60 * 1000,
    y: 365 * 24 * 60 * 60 * 1000,
  };
  return n * table[unit];
}

// Host-side stat of a DB file (user DBs live in the shared $HOME, so no
// container hop is needed to read mtime/size). Returns null if unreadable.
async function statDb(dbPath) {
  try {
    const info = await Deno.stat(dbPath);
    return {
      sizeBytes: info.size,
      mtimeMs: info.mtime ? info.mtime.getTime() : 0,
    };
  } catch {
    return null;
  }
}

// Run a command built from buildArgv; throw (before any resource write) on failure.
async function run(globalArgs, { become, bin, flags }, logger) {
  const argv = buildArgv(globalArgs, { become, bin, flags });
  logger?.info("exec {argv}", { argv: argv.join(" ") });
  const cmd = new Deno.Command(argv[0], {
    args: argv.slice(1),
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  const out = new TextDecoder().decode(stdout);
  const err = new TextDecoder().decode(stderr);
  if (code !== 0) {
    throw new Error(
      `command failed (exit ${code}): ${argv.join(" ")}\n${err || out}`,
    );
  }
  return { out, err };
}

// updatedb flags for one root -> user DB.
function updatedbFlags(globalArgs, root, dbPath) {
  const flags = [
    "--require-visibility",
    String(globalArgs.requireVisibility),
    "-o",
    dbPath,
    "-U",
    expandHome(root),
  ];
  if (globalArgs.prunePaths.length > 0) {
    flags.push("--prunepaths", globalArgs.prunePaths.join(" "));
  }
  if (globalArgs.pruneNames.length > 0) {
    flags.push("--prunenames", globalArgs.pruneNames.join(" "));
  }
  return flags;
}

// Build every configured root's DB (one execution). Returns per-root build info.
async function buildAllRoots(globalArgs, become, logger) {
  const dbDir = expandHome(globalArgs.dbDir);
  // Ensure the DB directory exists (host-side; shared $HOME).
  try {
    await Deno.mkdir(dbDir, { recursive: true });
  } catch (e) {
    if (!(e instanceof Deno.errors.AlreadyExists)) throw e;
  }
  const built = [];
  for (const root of globalArgs.roots) {
    const dbPath = dbPathForRoot(globalArgs.dbDir, root);
    await run(
      globalArgs,
      {
        become,
        bin: globalArgs.updatedbBin,
        flags: updatedbFlags(globalArgs, root, dbPath),
      },
      logger,
    );
    const st = await statDb(dbPath);
    // Count files in this DB (cheap; runs on the transport target).
    let fileCount = 0;
    try {
      const { out } = await run(
        globalArgs,
        {
          become: false,
          bin: globalArgs.plocateBin,
          flags: ["--database", dbPath, "--count", "/"],
        },
        logger,
      );
      fileCount = Number(out.trim()) || 0;
    } catch {
      fileCount = 0;
    }
    built.push({
      root,
      dbPath,
      sizeBytes: st?.sizeBytes ?? 0,
      fileCount,
    });
  }
  return built;
}

// ── Query helpers ─────────────────────────────────────────────────────────────

function queryFlags(dbPaths, args) {
  const flags = ["--database", dbPaths.join(":")];
  if (args.ignoreCase) flags.push("-i");
  if (args.regex) flags.push("--regexp");
  if (args.limit && args.limit > 0) flags.push("-l", String(args.limit));
  flags.push("-0"); // NUL-delimit so paths with newlines survive.
  flags.push(args.pattern);
  return flags;
}

function stableHash(s) {
  // Small deterministic hash for results instance names (q-<hash>).
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

// ── Model ─────────────────────────────────────────────────────────────────────

/**
 * `@kneel/plocate` — a swamp extension model that owns a fast filesystem index.
 *
 * One instance == one named index (one plocate DB per configured root). Methods
 * cover the full lifecycle: `build`/`refresh` and the fan-out `refresh_all`
 * (re)build the DBs; `status` reports freshness; `clear` verifies and removes
 * them; `query` looks up patterns, self-heals a stale index on demand, and
 * persists matches as a CEL-referenceable `results` resource. The `index`
 * resource is stored with `lifetime == maxAge`, so expiry itself is the
 * cache-staleness signal.
 */
export const model = {
  type: "@kneel/plocate",
  version: "2026.07.15.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    index: {
      description:
        "Metadata for a built plocate index. Lifetime == maxAge, so expiry IS the staleness signal.",
      schema: IndexSchema,
      lifetime: "24h", // default; overridden per-write to the instance's maxAge
      garbageCollection: 5,
    },
    results: {
      description: "Persisted matches from a query, referenceable via CEL.",
      schema: ResultsSchema,
      lifetime: "1h",
      garbageCollection: 10,
    },
  },

  methods: {
    // ── WS2: lifecycle ────────────────────────────────────────────────────────
    build: {
      description:
        "Build (or rebuild) the plocate DB for every configured root in one execution, then write the aggregate `index` resource (lifetime == maxAge).",
      arguments: z.object({
        become: z.boolean().optional().describe(
          "Override the global `become` for this build (sudo on the transport target).",
        ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        context.logger.info("Building index for {n} root(s)", {
          n: g.roots.length,
        });
        const built = await buildAllRoots(g, args.become, context.logger);

        const dbPaths = built.map((b) => b.dbPath);
        const totalSize = built.reduce((a, b) => a + b.sizeBytes, 0);
        const totalCount = built.reduce((a, b) => a + b.fileCount, 0);
        const handle = await context.writeResource(
          "index",
          "main",
          {
            dbPath: dbPaths.join(":"),
            roots: g.roots,
            builtAt: new Date().toISOString(),
            sizeBytes: totalSize,
            fileCount: totalCount,
            maxAge: g.maxAge,
            stale: false,
          },
          { lifetime: g.maxAge },
        );
        context.logger.info("Index built: {count} files across {n} root(s)", {
          count: totalCount,
          n: g.roots.length,
        });
        return { dataHandles: [handle] };
      },
    },

    refresh: {
      description:
        "Alias for `build`: rebuild every configured root and rewrite the aggregate `index`.",
      arguments: z.object({
        become: z.boolean().optional().describe(
          "Override the global `become` for this refresh.",
        ),
      }),
      execute: async (args, context) => {
        return await model.methods.build.execute(args, context);
      },
    },

    refresh_all: {
      description:
        "Fan-out rebuild (Rule 6): rebuild every configured root in ONE execution / one lock, writing one `index` instance PER root (dynamic names) plus the aggregate `main`, for granular CEL referencing.",
      arguments: z.object({
        become: z.boolean().optional().describe(
          "Override the global `become` for this rebuild.",
        ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        context.logger.info(
          "refresh_all: rebuilding {n} root(s) in one execution",
          {
            n: g.roots.length,
          },
        );
        const built = await buildAllRoots(g, args.become, context.logger);

        const handles = [];
        for (const b of built) {
          const h = await context.writeResource(
            "index",
            rootSlug(b.root),
            {
              dbPath: b.dbPath,
              roots: [b.root],
              builtAt: new Date().toISOString(),
              sizeBytes: b.sizeBytes,
              fileCount: b.fileCount,
              maxAge: g.maxAge,
              stale: false,
            },
            { lifetime: g.maxAge },
          );
          handles.push(h);
        }
        // Aggregate instance for whole-corpus consumers.
        const mainHandle = await context.writeResource(
          "index",
          "main",
          {
            dbPath: built.map((b) => b.dbPath).join(":"),
            roots: g.roots,
            builtAt: new Date().toISOString(),
            sizeBytes: built.reduce((a, b) => a + b.sizeBytes, 0),
            fileCount: built.reduce((a, b) => a + b.fileCount, 0),
            maxAge: g.maxAge,
            stale: false,
          },
          { lifetime: g.maxAge },
        );
        handles.push(mainHandle);
        context.logger.info("refresh_all wrote {n} index instances", {
          n: handles.length,
        });
        return { dataHandles: handles };
      },
    },

    status: {
      description:
        "Report index freshness without rebuilding: reads DB mtime(s) host-side and compares against maxAge. Use `status.stale` to gate workflows.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const maxAgeMs = durationToMs(g.maxAge);
        const now = Date.now();

        let newestMtime = 0;
        let totalSize = 0;
        let present = 0;
        const dbPaths = [];
        for (const root of g.roots) {
          const dbPath = dbPathForRoot(g.dbDir, root);
          dbPaths.push(dbPath);
          const st = await statDb(dbPath);
          if (st) {
            present += 1;
            totalSize += st.sizeBytes;
            if (st.mtimeMs > newestMtime) newestMtime = st.mtimeMs;
          }
        }

        const missing = present < g.roots.length;
        const ageSeconds = newestMtime > 0
          ? Math.floor((now - newestMtime) / 1000)
          : null;
        const stale = missing || newestMtime === 0 ||
          (now - newestMtime) > maxAgeMs;

        // Try to read the stored index for builtAt/fileCount context.
        let builtAt = newestMtime > 0
          ? new Date(newestMtime).toISOString()
          : null;
        let fileCount = 0;
        try {
          const stored = await context.readResource("main");
          if (stored) {
            if (typeof stored.builtAt === "string") builtAt = stored.builtAt;
            if (typeof stored.fileCount === "number") {
              fileCount = stored.fileCount;
            }
          }
        } catch {
          // no stored index yet
        }

        const handle = await context.writeResource(
          "index",
          "main",
          {
            dbPath: dbPaths.join(":"),
            roots: g.roots,
            builtAt: builtAt ?? new Date(0).toISOString(),
            sizeBytes: totalSize,
            fileCount,
            maxAge: g.maxAge,
            stale,
          },
          { lifetime: g.maxAge },
        );
        context.logger.info(
          "status: stale={stale} ageSeconds={age} present={present}/{total}",
          {
            stale,
            age: ageSeconds ?? -1,
            present,
            total: g.roots.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    clear: {
      description:
        "Verify each DB path (Rule 5) then delete the user DB file(s) and overwrite `index` with a cleared marker (stale:true, fileCount:0). Does NOT touch the system DB.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const g = context.globalArgs;
        const deleted = [];
        const dbPaths = [];
        for (const root of g.roots) {
          const dbPath = dbPathForRoot(g.dbDir, root);
          dbPaths.push(dbPath);
          // Rule 5: verify the path exists and is inside dbDir before deleting.
          const dbDir = expandHome(g.dbDir).replace(/\/$/, "");
          if (!dbPath.startsWith(dbDir + "/")) {
            throw new Error(
              `refusing to delete '${dbPath}': outside dbDir '${dbDir}'`,
            );
          }
          const st = await statDb(dbPath);
          if (st) {
            await Deno.remove(dbPath);
            deleted.push(dbPath);
            context.logger.info("deleted {dbPath}", { dbPath });
          } else {
            context.logger.info("skip {dbPath}: not present", { dbPath });
          }
        }

        // Overwrite index with a durable cleared marker so consumers see stale.
        const handle = await context.writeResource(
          "index",
          "main",
          {
            dbPath: dbPaths.join(":"),
            roots: g.roots,
            builtAt: new Date().toISOString(),
            sizeBytes: 0,
            fileCount: 0,
            maxAge: g.maxAge,
            stale: true,
          },
          { lifetime: g.maxAge },
        );
        context.logger.info("clear: removed {n} DB file(s)", {
          n: deleted.length,
        });
        return { dataHandles: [handle] };
      },
    },

    // ── WS3: query + self-heal ──────────────────────────────────────────────────
    query: {
      description:
        "Query the index for a pattern; persist matches as a `results` resource and return them. Self-heals (rebuilds) first when refreshIfStale and the DB is older than maxAge. scope:'system' queries the read-only systemDb.",
      arguments: z.object({
        pattern: z.string().describe(
          "Search pattern (glob-ish substring by default; regexp when regex:true).",
        ),
        limit: z.number().int().positive().optional().describe(
          "Stop after N matches (plocate -l).",
        ),
        regex: z.boolean().default(false).describe(
          "Interpret pattern as a basic regexp (plocate --regexp).",
        ),
        ignoreCase: z.boolean().default(false).describe(
          "Case-insensitive match (plocate -i).",
        ),
        refreshIfStale: z.boolean().default(false).describe(
          "If the user index is older than maxAge, rebuild it before querying (self-heal). Ignored for scope:'system'.",
        ),
        scope: z.enum(["user", "system"]).default("user").describe(
          "'user' queries the per-root corpus DBs; 'system' queries the read-only systemDb.",
        ),
        label: z.string().optional().describe(
          'Stable name for the persisted results instance, referenced as data.latest("<model>", "q-<label>"). Defaults to a deterministic hash of the query args.',
        ),
      }),
      execute: async (args, context) => {
        const g = context.globalArgs;
        const maxAgeMs = durationToMs(g.maxAge);
        const now = Date.now();

        let dbPaths;
        let stale = false;

        if (args.scope === "system") {
          dbPaths = [g.systemDb];
        } else {
          dbPaths = g.roots.map((r) => dbPathForRoot(g.dbDir, r));

          // Determine staleness from the newest existing DB.
          let newestMtime = 0;
          let present = 0;
          for (const dbPath of dbPaths) {
            const st = await statDb(dbPath);
            if (st) {
              present += 1;
              if (st.mtimeMs > newestMtime) newestMtime = st.mtimeMs;
            }
          }
          const missing = present < dbPaths.length;
          stale = missing || newestMtime === 0 ||
            (now - newestMtime) > maxAgeMs;

          if (stale && args.refreshIfStale) {
            context.logger.info("query: index stale, self-healing via rebuild");
            await buildAllRoots(g, undefined, context.logger);
            stale = false;
          }
        }

        // Run the query. plocate exits 1 with no output when there are no matches.
        let matches = [];
        try {
          const { out } = await run(
            context.globalArgs,
            {
              become: false,
              bin: g.plocateBin,
              flags: queryFlags(dbPaths, args),
            },
            context.logger,
          );
          matches = out.split("\0").filter((s) => s.length > 0);
        } catch (e) {
          // Distinguish "no matches" (acceptable) from a real failure.
          const msg = String(e && e.message ? e.message : e);
          if (/exit 1\)/.test(msg)) {
            matches = [];
          } else {
            throw e;
          }
        }

        // Results instances are always `q-`-prefixed so they can never collide
        // with `index` instances (main / per-root slugs) on disk. A caller-supplied
        // `label` gives a predictable CEL handle; otherwise a deterministic hash.
        const key = args.label
          ? args.label.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "")
          : stableHash(
            `${args.scope}|${args.pattern}|${args.regex}|${args.ignoreCase}|${
              args.limit ?? ""
            }`,
          );
        const instance = `q-${key || "results"}`;
        const handle = await context.writeResource("results", instance, {
          pattern: args.pattern,
          matches,
          count: matches.length,
          ranAt: new Date().toISOString(),
          dbPaths,
          stale,
        });
        context.logger.info("query '{pattern}' -> {count} match(es)", {
          pattern: args.pattern,
          count: matches.length,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};

#!/usr/bin/env bash
#
# smoke.sh — integration smoke test for the @kneel/plocate extension model.
#
# Implements the plan §7 smoke protocol against the `fedora` toolbox (plocate
# lives ONLY in that container on Neil's box). Idempotent and self-cleaning:
# it deletes any prior throwaway instance, sources the local extension, creates
# a fresh `plocate-smoke` instance pointed at this repo's `extensions/` tree,
# runs refresh → status → query, inspects the written resources, and tears
# everything down (instance, added source, temp DB dir) on exit — pass or fail.
#
# Run from anywhere:  ./extensions/plocate/smoke.sh
# Owned/run by WS6 — do NOT run during WS5.
#
# Requirements on the executing host:
#   - swamp CLI on PATH
#   - python3 (JSON/YAML munging; pyyaml)
#   - a running `fedora` toolbox container with plocate + plocate's updatedb
#     (override the container name with PLOCATE_SMOKE_CONTAINER=<name>)
#
# NOTE for WS6: `--global-arg` stores every value as a STRING, so the `roots`
# array cannot be passed that way (it would fail the z.array schema). We instead
# scaffold the instance with `swamp model create`, capture its definition path
# from --json, and patch the full globalArguments block (roots + transport) into
# the YAML with python/pyyaml. If the definition file format ever changes, this
# patch step is the thing to revisit.

set -uo pipefail

# ── Locations ────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)" # extensions/plocate -> repo root
export SWAMP_REPO_DIR="$REPO"

MODEL_NAME="plocate-smoke"
CONTAINER="${PLOCATE_SMOKE_CONTAINER:-fedora}"
ROOTS_DIR="$REPO/extensions"
DBDIR="$(mktemp -d "${TMPDIR:-/tmp}/plocate-smoke-db.XXXXXX")"
# A path we know exists under ROOTS_DIR and should appear in query matches.
EXPECT_PATH_FRAGMENT="plocate.ts"

PASS=0
FAIL=0
SOURCE_ADDED=0

pass() {
  echo "PASS: $*"
  PASS=$((PASS + 1))
}
fail() {
  echo "FAIL: $*"
  FAIL=$((FAIL + 1))
}
info() { echo "  ... $*"; }

# ── Cleanup (always) ─────────────────────────────────────────────────────────
cleanup() {
  echo "──────────────────────────────────────────────"
  echo "cleanup"
  swamp model delete "$MODEL_NAME" --force >/dev/null 2>&1 &&
    info "deleted instance $MODEL_NAME" || true
  if [ "$SOURCE_ADDED" = "1" ]; then
    swamp extension source rm "$REPO" >/dev/null 2>&1 &&
      info "removed extension source $REPO" || true
  fi
  rm -rf "$DBDIR"
  echo "══════════════════════════════════════════════"
  echo "SMOKE SUMMARY: ${PASS} passed, ${FAIL} failed"
  echo "══════════════════════════════════════════════"
  if [ "$FAIL" -eq 0 ] && [ "$PASS" -gt 0 ]; then
    echo "RESULT: PASS"
    echo "══════════════════════════════════════════════"
    exit 0
  fi
  echo "RESULT: FAIL"
  echo "══════════════════════════════════════════════"
  exit 1
}
trap cleanup EXIT

# Extract the first boolean value stored under a "stale" key, anywhere in a JSON
# document (data get/query shapes vary). Prints "true"/"false"/"null".
extract_stale() {
  python3 -c '
import sys, json
def walk(o):
    if isinstance(o, dict):
        v = o.get("stale")
        if isinstance(v, bool):
            return v
        for x in o.values():
            r = walk(x)
            if r is not None:
                return r
    elif isinstance(o, list):
        for x in o:
            r = walk(x)
            if r is not None:
                return r
    return None
try:
    d = json.load(sys.stdin)
except Exception:
    print("null"); sys.exit(0)
print(json.dumps(walk(d)))
'
}

# Print the first data-instance name starting with "q-" (the results resource).
extract_results_name() {
  python3 -c '
import sys, json
found = []
def walk(o):
    if isinstance(o, dict):
        n = o.get("name")
        if isinstance(n, str) and n.startswith("q-"):
            found.append(n)
        for x in o.values():
            walk(x)
    elif isinstance(o, list):
        for x in o:
            walk(x)
try:
    d = json.load(sys.stdin)
except Exception:
    d = None
walk(d)
print(found[0] if found else "")
'
}

echo "══════════════════════════════════════════════"
echo "@kneel/plocate smoke test"
echo "  repo       : $REPO"
echo "  roots      : $ROOTS_DIR"
echo "  container  : $CONTAINER (runtime=toolbox)"
echo "  dbDir      : $DBDIR"
echo "══════════════════════════════════════════════"

# Ensure a clean slate if a previous run aborted mid-way.
swamp model delete "$MODEL_NAME" --force >/dev/null 2>&1 || true

# ── Step 1: source the local extension ───────────────────────────────────────
echo "── step 1: extension source add"
if swamp extension source list 2>/dev/null | grep -qF "$REPO"; then
  info "source already configured: $REPO"
else
  if swamp extension source add "$REPO" >/dev/null 2>&1; then
    SOURCE_ADDED=1
    info "added source $REPO"
  else
    fail "extension source add $REPO"
    exit 1
  fi
fi
if swamp model type search plocate --json 2>/dev/null | grep -qF "@kneel/plocate"; then
  pass "type @kneel/plocate is discoverable"
else
  fail "type @kneel/plocate not discoverable after source add"
  exit 1
fi

# Best-effort: clear any cached bundle for this model so a fresh build runs.
find "$REPO/.swamp/bundles" -name 'plocate*' -prune -exec rm -rf {} + 2>/dev/null || true

# ── Step 2: create the throwaway instance + patch globalArguments ────────────
echo "── step 2: create instance"
CREATE_JSON="$(swamp model create @kneel/plocate "$MODEL_NAME" --json 2>/dev/null)"
DEF_PATH="$(printf '%s' "$CREATE_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("path",""))' 2>/dev/null)"
if [ -z "$DEF_PATH" ] || [ ! -f "$DEF_PATH" ]; then
  fail "model create (no definition path returned)"
  exit 1
fi
info "definition: $DEF_PATH"

python3 - "$DEF_PATH" "$ROOTS_DIR" "$CONTAINER" "$DBDIR" <<'PY'
import sys, yaml
path, root, container, dbdir = sys.argv[1:5]
with open(path) as f:
    d = yaml.safe_load(f) or {}
d["globalArguments"] = {
    "roots": [root],
    "runtime": "toolbox",
    "container": container,
    "dbDir": dbdir,
    "maxAge": "24h",
    "requireVisibility": 0,
}
with open(path, "w") as f:
    yaml.safe_dump(d, f, sort_keys=False)
PY

if swamp model validate "$MODEL_NAME" >/dev/null 2>&1; then
  pass "instance created and validates"
else
  fail "model validate $MODEL_NAME"
  exit 1
fi

# ── Step 3: refresh (build every root's DB) ──────────────────────────────────
echo "── step 3: refresh"
if swamp model method run "$MODEL_NAME" refresh --json >/dev/null 2>&1; then
  pass "refresh ran"
else
  fail "refresh method run"
fi

# ── Step 4: status — assert stale == false immediately after refresh ─────────
echo "── step 4: status (expect stale=false)"
swamp model method run "$MODEL_NAME" status --json >/dev/null 2>&1 || true
STALE="$(swamp data get "$MODEL_NAME" main --json 2>/dev/null | extract_stale)"
info "index/main stale = ${STALE}"
if [ "$STALE" = "false" ]; then
  pass "index is fresh (stale=false) right after refresh"
else
  fail "expected stale=false after refresh, got '${STALE}'"
fi

# ── Step 5: query pattern=plocate — expect the plocate.ts path in matches ────
echo "── step 5: query pattern=plocate"
if swamp model method run "$MODEL_NAME" query --input pattern=plocate --json >/dev/null 2>&1; then
  info "query ran"
else
  fail "query method run"
fi
RESULTS_NAME="$(swamp data list "$MODEL_NAME" --json 2>/dev/null | extract_results_name)"
if [ -n "$RESULTS_NAME" ]; then
  info "results resource: $RESULTS_NAME"
  RJSON="$(swamp data get "$MODEL_NAME" "$RESULTS_NAME" --json 2>/dev/null)"
  if printf '%s' "$RJSON" | grep -qF "$EXPECT_PATH_FRAGMENT"; then
    pass "query matched '$EXPECT_PATH_FRAGMENT'"
  else
    fail "query results did not contain '$EXPECT_PATH_FRAGMENT'"
  fi
else
  fail "no results resource (q-*) written by query"
fi

# ── Step 6: inspect all resources ────────────────────────────────────────────
echo "── step 6: inspect resources (swamp model get)"
if swamp model get "$MODEL_NAME" --json >/dev/null 2>&1; then
  pass "swamp model get returned the instance"
  info "resource data listing:"
  swamp data list "$MODEL_NAME" --json 2>/dev/null | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
    print(json.dumps(d, indent=2)[:1200])
except Exception:
    print("(could not parse data list)")
' 2>/dev/null || true
else
  fail "swamp model get $MODEL_NAME"
fi

# cleanup() runs on EXIT and sets the final exit status.
exit 0

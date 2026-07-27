#!/usr/bin/env bash
# Assert that every model the codex_local adapter offers is a model the CLI
# baked into the runtime image actually has metadata for.
#
# Why this exists: the catalog (server code) and the CLI (container image) are
# versioned independently and drifted apart unnoticed for 25 days. gpt-5.6-luna
# was added to the picker on 2026-07-11; agent-runtime-codex:v3 was built
# 2026-07-02 with codex 0.142.5, which had no metadata for it. Customers picked
# the model from our own dropdown and every run opened with an item of type
# "error". Nothing failed, so nothing alerted.
#
# How it detects: the "Model metadata not found" warning is emitted client-side
# at session start, BEFORE the first API call, so an obviously-invalid API key
# is enough to observe it. The run then dies on auth, which we ignore.
#
# Usage: verify-model-catalog.sh <codex-image-ref>
set -uo pipefail

IMAGE="${1:?usage: verify-model-catalog.sh <codex-image-ref>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
CATALOG="$REPO_ROOT/packages/adapters/codex-local/src/index.ts"
BASELINE="$HERE/codex-model-baseline.txt"

# Model ids from the `export const models = [...]` array. DEFAULT_CODEX_LOCAL_MODEL
# is referenced rather than quoted, so resolve it from its own declaration.
DEFAULT_MODEL="$(sed -n 's/^export const DEFAULT_CODEX_LOCAL_MODEL *= *"\([^"]*\)".*/\1/p' "$CATALOG" | head -1)"
MODELS="$(
  sed -n '/^export const models/,/^\];/p' "$CATALOG" \
    | sed -n 's/.*{ *id: *"\([^"]*\)".*/\1/p'
  [ -n "$DEFAULT_MODEL" ] && echo "$DEFAULT_MODEL"
)"
MODELS="$(echo "$MODELS" | sed '/^$/d' | sort -u)"

if [ -z "$MODELS" ]; then
  echo "FAIL: parsed zero models out of $CATALOG -- the parser broke, not the catalog." >&2
  exit 1
fi

echo "image:   $IMAGE"
echo "catalog: $(echo "$MODELS" | wc -l | tr -d ' ') models from ${CATALOG#"$REPO_ROOT"/}"
echo

measured_unknown=""
for m in $MODELS; do
  out="$(
    docker run --rm \
      -e OPENAI_API_KEY=sk-invalid-model-catalog-probe \
      -e CODEX_HOME=/tmp/codex-probe \
      --entrypoint sh "$IMAGE" -c \
      "mkdir -p /tmp/codex-probe && timeout 25 codex exec --json --skip-git-repo-check --model '$m' hi 2>&1 | head -40" \
      2>/dev/null
  )"
  if printf '%s' "$out" | grep -qF "Model metadata for"; then
    echo "  UNKNOWN  $m"
    measured_unknown="$measured_unknown$m"$'\n'
  elif printf '%s' "$out" | grep -q '"type":"thread.started"'; then
    echo "  ok       $m"
  else
    # No thread.started at all means the probe never reached model selection
    # (image broken, docker failure, network block). Treat as fatal: a silent
    # pass here would recreate exactly the blind spot this script closes.
    echo "  ERROR    $m: probe produced no thread.started; output was:" >&2
    printf '%s\n' "$out" | head -10 >&2
    exit 1
  fi
done

measured_unknown="$(printf '%s' "$measured_unknown" | sed '/^$/d' | sort -u)"
baseline_unknown="$(grep -vE '^\s*(#|$)' "$BASELINE" | sort -u)"

echo
if [ "$measured_unknown" = "$baseline_unknown" ]; then
  echo "PASS: unknown-model set matches ${BASELINE#"$REPO_ROOT"/}."
  exit 0
fi

echo "FAIL: the set of models the pinned CLI does not know has changed." >&2
echo >&2
newly_unknown="$(comm -23 <(printf '%s\n' "$measured_unknown") <(printf '%s\n' "$baseline_unknown"))"
newly_known="$(comm -13 <(printf '%s\n' "$measured_unknown") <(printf '%s\n' "$baseline_unknown"))"
if [ -n "$newly_unknown" ]; then
  echo "  Newly UNKNOWN (the catalog offers a model this CLI cannot resolve --" >&2
  echo "  either bump the pinned CLI version or drop the model from the catalog):" >&2
  printf '    %s\n' $newly_unknown >&2
fi
if [ -n "$newly_known" ]; then
  echo "  Now KNOWN (good news -- remove these lines from the baseline):" >&2
  printf '    %s\n' $newly_known >&2
fi
exit 1

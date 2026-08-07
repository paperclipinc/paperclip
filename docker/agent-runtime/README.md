# Agent Runtime Image Family

<<<<<<< HEAD
Paperclip.inc publishes container images for remote agents. Images are named `agent-runtime-{adapterType}:{paperclipVersion}` and distributed via `ghcr.io/paperclipinc/`.
=======
Container images for running coding-agent harnesses in sandboxed environments (for example the kubernetes sandbox provider, stage 1 of the k8s contribution). Images are named `agent-runtime-{harness}:{version}` and published to `ghcr.io/paperclipai/` by the `agent-runtime-images` workflow. The registry is overridable: every reference flows through the `REGISTRY` bake variable.
>>>>>>> origin/master

## Image Lineup

- **`agent-runtime-base`**: Foundation. Ubuntu 22.04 + Node 22 + git + tini + non-root user (uid 1000) + the agent shim.
- **`agent-runtime-opencode`**: Extends base with `opencode-ai` globally installed.
- **`agent-runtime-pi`**: Extends base with `@mariozechner/pi-coding-agent`.
- **`agent-runtime-codex`**: Extends base with `@openai/codex`.
- **`agent-runtime-gemini`**: Extends base with `@google/gemini-cli` plus headless auth-mode settings.
- **`agent-runtime-claude`**: Extends base with `@anthropic-ai/claude-code` (symlinked as `claude-code`).
- **`agent-runtime-hermes`**: Dockerfile included in the bake group, not in the default publish scope (stub until a CLI package exists).

## Base Image Contents

**OS & Runtime:**
- Ubuntu 22.04
- Node.js 22 (via NodeSource APT repo)
- git
- tini (PID-1 init, ensures signal propagation)
- Non-root user `paperclip` (uid/gid 1000)

<<<<<<< HEAD
**Paperclip Binaries:**
- `/usr/local/bin/paperclip-agent-shim` — Go binary compiled from `tools/agent-shim/`. Reads `/run/paperclip/runtime-command.json` and `syscall.Exec`s the adapter CLI.
- `/usr/local/bin/paperclip-workspace-init` — Node script entry point. Used by init container to bootstrap the workspace.

**Defaults:**
- `USER`: 1000:1000 (paperclip, non-root)
- `WORKDIR`: `/workspace` — PVCs are mounted here
=======
The NodeSource install puts `node` on the default `PATH`. The agent shim in this
image runs the harness directly with that `PATH`. The shim does not source a
login profile, and the runtime never writes a profile or an rc file. Some
sandbox providers instead wrap each command in a login shell. That shell sources
`/etc/profile` and the user profile files to read an owner-supplied `PATH`. No
exec path sources `nvm`. For the full exec-path contract, see
`packages/plugins/sandbox-providers/SANDBOX-REQUIREMENTS.md`.

**Paperclip Binaries:**
- `/usr/local/bin/paperclip-agent-shim`: Go binary compiled from `tools/agent-shim/`. Reads `/run/paperclip/runtime-command.json` and `syscall.Exec`s the harness CLI.

**Defaults:**
- `USER`: 1000:1000 (paperclip, non-root)
- `WORKDIR`: `/workspace` (mount workspace volumes here)
>>>>>>> origin/master
- `ENTRYPOINT`: `/usr/bin/tini --` (PID-1 reaper, forwards signals)
- `CMD`: `/usr/local/bin/paperclip-agent-shim`

## Building Locally

<<<<<<< HEAD
### Multi-architecture (amd64 + arm64)

```bash
docker buildx bake -f docker/agent-runtime/buildx-bake.hcl --push
```

### Host-only (faster iteration)

Replace the architecture with your machine's native platform:

```bash
docker buildx bake -f docker/agent-runtime/buildx-bake.hcl \
  --set "*.platforms=linux/$(uname -m | sed s/x86_64/amd64/)" \
  --load
=======
All targets build `linux/amd64` by default (see `buildx-bake.hcl`). Derived images chain off the `base` target through bake `contexts`, so the literal registry in each `FROM` line is overridden at build time and the whole family builds in one pass without pushing intermediates.

```bash
docker buildx bake -f docker/agent-runtime/buildx-bake.hcl --load
>>>>>>> origin/master
```

### Custom tag or registry

```bash
<<<<<<< HEAD
docker buildx bake -f docker/agent-runtime/buildx-bake.hcl \
  --set "*.tags=myregistry/agent-runtime-base:mytag" \
  --load
=======
REGISTRY=myregistry VERSION=mytag \
  docker buildx bake -f docker/agent-runtime/buildx-bake.hcl --load
>>>>>>> origin/master
```

## Quickstart Smoke Test

Build and verify the `agent-runtime-claude` image runs locally:

```bash
<<<<<<< HEAD
docker buildx bake -f docker/agent-runtime/buildx-bake.hcl \
  --set "*.platforms=linux/$(uname -m | sed s/x86_64/amd64/)" \
  --load
docker run --rm ghcr.io/paperclipinc/agent-runtime-claude:dev claude-code --version
```

## Init Container (workspace-init)

The init container prepares the workspace before the agent starts. It reads environment variables, bootstraps the workspace directory tree, and exits.

**Environment Variables:**
- `PAPERCLIP_WORKSPACE_REQUEST` — JSON serialized workspace request (required)
- `PAPERCLIP_WORKSPACE_ROOT` — Where to write workspace state (default: `/workspace`)
- `BOOTSTRAP_TOKEN` — Authentication token for workspace API (required)
- `PAPERCLIP_PUBLIC_URL` — Public endpoint for workspace callbacks (required)

**Failure Modes:**
Missing or invalid env vars → exit code 1. Pod init never repeats; failure blocks agent startup.

## Agent Container (paperclip-agent-shim)

The main agent runs as the shim process (PID 1 under tini). The shim:

1. Reads `/run/paperclip/runtime-command.json` — a JSON file mounted by the Job controller
2. Parses `{ command, args, ... }` — the adapter CLI and arguments
3. `syscall.Exec`s the adapter process, replacing itself
4. SIGTERM from kubelet propagates directly to the adapter (no process zombie)
=======
docker buildx bake -f docker/agent-runtime/buildx-bake.hcl base claude --load
docker run --rm ghcr.io/paperclipai/agent-runtime-claude:dev claude-code --version
```

## Agent Container (paperclip-agent-shim)

The main agent process runs as the shim (PID 1 under tini). The shim:

1. Reads `/run/paperclip/runtime-command.json` (path overridable via `-spec`), a JSON file mounted by whatever schedules the run
2. Parses `{ "command", "args" }`: the harness CLI and arguments
3. Resolves the command on PATH and `syscall.Exec`s it, replacing itself
4. SIGTERM from the kubelet propagates directly to the harness (no zombie processes)
>>>>>>> origin/master

**runtime-command.json Contract:**
```json
{
  "command": "claude-code",
  "args": ["--token", "xyz", "--workspace", "/workspace"]
}
```

<<<<<<< HEAD
The shim makes no assumptions about command structure; it is adapter-agnostic. Future adapters swap the command/args; the image remains the same.

## Security Model

- **Non-root execution** — user 1000:1000, no capability grant
- **PSS Restricted compatible** — no privileged containers, no host mounts, read-only filesystem (except `/workspace` + `/tmp`)
- **No secrets baked in** — API tokens, credentials come from per-Job ephemeral Secrets mounted as env vars or files
- **Image signing** — cosign keyless OIDC in CI (see Task 29)

## Versioning Policy

**agent-runtime-base:**
- Version tag `vX.Y.Z` published when the shim or workspace-init source changes
- Includes all base layer content (OS, Node, git, tini, non-root user)

**agent-runtime-claude:**
- Builds on top of base at the same version tag
- Version tag bumps independently when a new `@anthropic-ai/claude-code` release is pinned
- Currently uses `npm install @anthropic-ai/claude-code@latest` for the `dev` tag; CI workflow (Task 29) will pin exact semver versions per release

## Multi-arch Caveats

- Both amd64 and arm64 images are built in CI; local builds require `--load` on single-arch or `--push` for multi-arch
- Go shim cross-compilation is automatic via `GOARCH` (see Dockerfile.base Stage 1)
- Node modules are platform-agnostic; workspace-init rebuilds without issues across architectures
=======
The shim makes no assumptions about command structure; it is harness-agnostic. New harnesses swap the command/args; the base image stays the same.

## Security Model

- **Non-root execution**: user 1000:1000, no capability grants
- **PSS Restricted compatible**: no privileged containers, no host mounts; works with a read-only root filesystem (writable `/workspace` + `/tmp` mounts)
- **No secrets baked in**: API tokens and credentials come from per-run ephemeral Secrets mounted as env vars or files
- **Image signing**: cosign keyless OIDC in the publish workflow

## Publishing

`.github/workflows/agent-runtime-images.yml` builds and pushes the default scope (base, opencode, pi, codex, gemini, claude) on `workflow_dispatch` (with an explicit version tag) or on pushes to `master` touching these paths, then signs each digest with cosign keyless OIDC.
>>>>>>> origin/master

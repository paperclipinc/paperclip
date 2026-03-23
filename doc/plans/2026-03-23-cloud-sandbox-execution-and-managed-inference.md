# Cloud Sandbox Execution & Managed Inference Platform

## Context

Paperclip currently runs agent runtimes (Claude Code, Codex, OpenCode, etc.) as
local subprocesses on the same machine as the server. Git worktrees provide
file-level isolation but there is no container, network, or resource isolation
between agents.

For a hosted multi-tenant Kubernetes deployment, this model is insufficient:

1. **Security** — agents run shell commands, install packages, and mutate the
   filesystem. Without container isolation, one tenant's agent could access
   another's data or destabilize the host.
2. **Scalability** — the server process is the bottleneck. Agent runs cannot be
   distributed across nodes.
3. **LLM billing** — users must bring their own API keys. There is no path to
   managed inference with margin.
4. **Onboarding friction** — configuring an adapter, model, and API key in the
   wizard is a multi-step process that loses users.

The `cloud_sandbox` execution workspace strategy is already defined in the schema
but not implemented. This plan fills that gap.

## Goal

Ship a hosted Paperclip platform where:

- New users go from sign-up to a running agent in under 60 seconds
- Agent runtimes execute in isolated Kubernetes pods
- LLM inference is managed by default (with BYOK as an option)
- OAuth connection tokens and company secrets are securely injected

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  Paperclip Server (StatefulSet)                             │
│  ┌───────────────┐  ┌──────────────┐  ┌──────────────────┐ │
│  │ Heartbeat      │  │ Connections  │  │ Secrets          │ │
│  │ Service        │  │ Service      │  │ Service          │ │
│  └───────┬───────┘  └──────┬───────┘  └────────┬─────────┘ │
│          │                 │                    │           │
│          ▼                 ▼                    ▼           │
│  ┌─────────────────────────────────────────────────────────┐│
│  │           Environment Resolution Layer                  ││
│  │  • Resolve connection_ref → fresh OAuth token           ││
│  │  • Resolve secret_ref → decrypted value                 ││
│  │  • Inject managed/BYOK LLM API key                      ││
│  │  • Build pod env vars + volumes                          ││
│  └───────────────────────┬─────────────────────────────────┘│
└──────────────────────────┼──────────────────────────────────┘
                           │ creates / reuses
                           ▼
              ┌────────────────────────┐
              │  Agent Sandbox Pod     │
              │  (long-running, per    │
              │   agent or per issue)  │
              │                        │
              │  ┌──────────────────┐  │
              │  │ Agent Runtime    │  │
              │  │ (Claude Code,   │  │
              │  │  Codex, etc.)   │  │
              │  └────────┬────────┘  │
              │           │           │
              │           ▼           │
              │  LLM API calls ───────┼──→ Anthropic / OpenAI / OpenRouter
              │                       │
              │  Env vars:            │
              │  ANTHROPIC_API_KEY    │
              │  GITHUB_TOKEN         │
              │  SLACK_TOKEN          │
              │  LINEAR_API_KEY       │
              │                       │
              │  Workspace:           │
              │  /workspace (PVC)     │
              └────────────────────────┘
```

## Design Decisions

### Decision 1: Cloud Sandbox Adapter — Long-Running Pods

A new `cloud_sandbox` server adapter that manages **long-running Kubernetes
Pods** (one per agent, or one per active issue) rather than ephemeral Jobs.

**Why long-running Pods, not Jobs:**

Agent runs are not simple batch tasks. Within a heartbeat cycle, an agent
session may involve:
- Multi-turn LLM interactions with tool use
- Approval prompts that pause and resume
- Session state (Claude Code `--resume`) that must persist across follow-ups
- Workspace filesystem state between consecutive runs on the same issue

A Job dies on completion. Restarting the full environment (clone repo,
install deps, warm up CLI) per heartbeat tick would be slow and wasteful.

Instead, sandbox pods are **warm** — one shared pod per company, kept
alive while any agent in the company has active work, reused across all
heartbeat runs, and torn down after an idle timeout.

**Pod lifecycle:**

```
First agent run in company
       │
       ▼
  Company pod created (init container clones repos)
       │
       ▼
  ┌─ Pod running ──────────────────────────────────────────┐
  │  Heartbeat: CEO run      → exec claude code in pod     │
  │  Heartbeat: Engineer run → exec codex in same pod      │
  │  Heartbeat: CEO run 2    → exec claude code, resumes   │
  │  ...                                                   │
  │  (all agents idle for {idleTimeoutMin})                │
  └────────────────────────────────────────────────────────┘
       │
       ▼
  Pod terminated (workspace volumes lost or PVC retained)
```

**Pod spec:**

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: pci-sandbox-{companyId-short}
  namespace: {instance-namespace}
  labels:
    paperclip.inc/instance: {instance-name}
    paperclip.inc/company-id: {companyId}
    paperclip.inc/role: agent-sandbox
spec:
  containers:
    - name: sandbox
      image: {agent-runtime-image}     # agent-multi by default
      command: ["sleep", "infinity"]   # kept alive, adapter execs into it
      env:
        # Company-level credentials (shared by all agents)
        - name: ANTHROPIC_API_KEY
          value: {resolved — managed or BYOK}
        - name: GITHUB_TOKEN
          value: {resolved from connection_ref}
        # Paperclip server coordinates
        - name: PAPERCLIP_API_URL
          value: http://{server-service}:{port}
        - name: PAPERCLIP_COMPANY_ID
          value: {companyId}
      resources:
        requests: {cpu: 500m, memory: 1Gi}
        limits: {cpu: 4, memory: 8Gi}
      volumeMounts:
        - name: workspaces
          mountPath: /workspaces
        - name: agent-homes
          mountPath: /home/agents
  volumes:
    - name: workspaces
      emptyDir: {}            # or PVC for persistence
    - name: agent-homes
      emptyDir: {}            # per-agent session state
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
```

**Execution model:**

The adapter doesn't spawn the CLI as a subprocess on the server. Instead:

1. Heartbeat resolves env bindings (connections, secrets, LLM key)
2. Cloud sandbox adapter ensures the **company pod** exists (create if
   needed, update shared env vars if credentials changed)
3. Prepares the agent's workspace inside the pod:
   - `/workspaces/{project}/` — shared by agents on the same project
     (equivalent of `project_primary`), or
   - `/workspaces/{project}.wt/{agentId}/` — git worktree per agent
     (equivalent of `git_worktree`)
   - `/home/agents/{agentId}/` — per-agent CLI config and session state
4. Executes the agent CLI **inside the running pod** via the K8s exec API
   (`/exec` WebSocket — equivalent to `kubectl exec`), setting per-exec
   env vars for `PAPERCLIP_AGENT_ID`, `PAPERCLIP_RUN_ID`, and the cwd
5. Streams stdout/stderr back to Paperclip's log system in real time
6. When exec completes, extracts `AdapterExecutionResult` from stdout JSON
7. Pod stays alive for the next heartbeat tick from any agent
8. Idle reaper deletes pod after configurable timeout with no exec
   activity from any agent (default 30 min)

**Env var updates between runs:**

Company-level credentials (LLM key, connection tokens) are shared pod
env vars. Per-agent values (agent ID, run ID, cwd) are passed as exec
env overrides on each invocation — no pod patch needed.

When connection tokens refresh, the adapter patches the pod's env vars.
Alternatively, the pod can fetch fresh credentials from the Paperclip API
at exec start using `PAPERCLIP_API_URL` and an agent auth token.

**Idle reaper:**

A background loop (or the heartbeat service itself) periodically checks
for company pods with no recent exec activity across any agent. Pods idle
beyond the configured timeout are deleted.

```
idleTimeoutMin: 30  (default, configurable per instance)
```

**Isolation tiers** (configurable per company or per instance):

| Tier | Pod scope | Use case |
|------|-----------|----------|
| `shared` (default) | One pod per company | Cost-efficient, mirrors local model |
| `isolated` | One pod per agent | Full container isolation, enterprise tier |

The `isolated` tier is a premium option for customers who need hard
security boundaries between agents. Most users won't need it.

**RBAC required** (add to operator):
```yaml
- apiGroups: [""]
  resources: ["pods", "pods/exec", "pods/log"]
  verbs: ["create", "get", "list", "watch", "delete", "patch"]
```

### Decision 2: Agent Runtime Images

Pre-built container images with agent CLIs installed. One image per
adapter type, published alongside Paperclip releases.

| Image | Contents | Base |
|-------|----------|------|
| `ghcr.io/paperclipinc/agent-claude` | Claude Code CLI + Node.js + git | node:22-bookworm-slim |
| `ghcr.io/paperclipinc/agent-codex` | Codex CLI + Node.js + git | node:22-bookworm-slim |
| `ghcr.io/paperclipinc/agent-opencode` | OpenCode + Go + git | golang:1.24-bookworm |
| `ghcr.io/paperclipinc/agent-multi` | All CLIs (larger, simpler) | ubuntu:24.04 |

The multi image is the default for managed deployments. Specific images
are for operators who want smaller pods.

### Decision 3: Managed Inference vs BYOK

Two LLM credential modes, configured per-company:

**Managed (default for hosted):**
- Platform provides the API key (e.g., OpenRouter with platform account)
- Token usage is tracked per-request via the existing cost events system
- Budget system enforces spend limits

**BYOK (Bring Your Own Key):**
- User stores their API key as a company secret
- Agent's `envConfig` binds `ANTHROPIC_API_KEY` → secret_ref
- Usage still tracked for budget enforcement

**V1:** No inference proxy. Inject the platform API key directly into the
pod env. The adapter already reports usage in `AdapterExecutionResult.usage`.
Per-request proxy metering is a V2 enhancement if needed.

### Decision 4: Onboarding Wizard Changes

Simplify the Agent step for hosted deployments:

```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│  ● Managed (recommended)                                │
│    Claude Sonnet 4.6 — billed to your Paperclip         │
│    account. No API key needed.                          │
│                                                         │
│  ○ Bring your own key                                   │
│    Use your own Anthropic, OpenAI, or other API key.    │
│    [expand: key input, model selector]                  │
│                                                         │
│  ○ Advanced                                             │
│    Self-hosted adapters: Claude Code, Codex, Cursor,    │
│    HTTP, OpenClaw Gateway.                              │
│    [expand: full existing adapter picker]               │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

- **Managed** is pre-selected. One click to proceed.
- Server-side: creates agent with `adapterType: "cloud_sandbox"`,
  `adapterConfig: { runtime: "claude", model: "claude-sonnet-4-6" }`.
  LLM key is injected by the platform at run time.
- **BYOK** expands a form: paste API key (stored as company secret),
  select model. Still uses `cloud_sandbox` adapter but env binds the
  user's key instead of the platform key.
- **Advanced** expands the existing adapter picker for self-hosters.

The wizard detects deployment mode: if `cloud_sandbox` is available
(hosted K8s with the operator), show the simplified flow. If not
(self-hosted/local), show the current adapter picker directly.

### Decision 5: Connection Token Injection

The environment resolution layer already handles `connection_ref` bindings:

```typescript
// In agent envConfig:
{
  "GITHUB_TOKEN": { type: "connection_ref", providerId: "github" },
  "SLACK_TOKEN": { type: "connection_ref", providerId: "slack" },
  "LINEAR_API_KEY": { type: "connection_ref", providerId: "linear" }
}
```

`secretService.resolveAdapterConfigForRuntime()` calls
`connectionService.resolveAccessToken()` for each `connection_ref`,
which auto-refreshes expired tokens. The resolved plaintext values are
passed as env vars to the cloud sandbox Job.

No changes needed to the resolution layer — it already works. The cloud
sandbox adapter just receives the resolved `config.env` object and maps
it to Kubernetes env vars.

### Decision 6: Workspace Model — Shared Pod, Per-Agent Directories

**Current local behavior:**

Today, agents share or isolate directories based on the workspace strategy:

| Strategy | Directory sharing | How it works |
|----------|------------------|--------------|
| `project_primary` | All agents on a project share one directory | Agents take turns; each has its own CLI session (`sessionId`) but works in the same `cwd` |
| `git_worktree` | Each agent (or issue) gets its own worktree branch | Isolated directories branched from the same base repo |

In both cases, each agent has a per-agent home at `~/.paperclip-agent/{agentId}/`
for CLI config, session state, and scratch files. CLI sessions are long-lived —
Claude Code uses `--resume {sessionId}` to pick up where it left off, and the
adapter stores the `sessionId` in the database across heartbeat runs.

**Cloud sandbox: one pod per company, same isolation model as local.**

The cloud model mirrors the local model exactly — one shared pod per
company, with filesystem-level isolation via directories and git worktrees:

```
Company "Acme"  →  Pod pci-sandbox-{companyId-short}
                   │
                   ├── /workspaces/
                   │   ├── project-alpha/                 (project_primary: shared by agents)
                   │   ├── project-alpha.wt/
                   │   │   ├── {ceo-id}/                  (git_worktree: CEO's branch)
                   │   │   └── {eng-id}/                  (git_worktree: Engineer's branch)
                   │   └── project-beta/                  (another project)
                   │
                   └── /home/agents/
                       ├── {ceo-id}/.claude/              (CEO session state)
                       ├── {eng-id}/.claude/              (Engineer session state)
                       └── {des-id}/.codex/               (Designer session state)
```

This works because:
- Heartbeat runs are sequential per agent — no two runs for the same
  agent overlap
- Each agent has its own home directory for session state (`--resume`)
- `project_primary` agents share the project directory and take turns
  (same as local)
- `git_worktree` agents get isolated branches under the same clone
  (same as local)
- The workspace strategy is configured per project, not per pod

**Why shared pods work:**

The concern with shared pods is concurrent filesystem access. But
Paperclip's heartbeat system is inherently sequential per agent — it
never runs two heartbeats for the same agent simultaneously. Multiple
agents CAN run concurrently in the same pod if they use `git_worktree`
strategy (separate directories) or work on different projects.

For `project_primary` mode, agents sharing a directory is intentional —
it's how the local model works today. The heartbeat scheduler serializes
access.

**Session continuity within a pod:**

Since pods are long-running, workspace and session state persist across
heartbeat runs within the same pod lifecycle:

1. Heartbeat run 1 (CEO): Claude Code runs in `/workspaces/project-alpha/`,
   produces `sessionId`, writes to `/home/agents/{ceo-id}/.claude/`
2. Heartbeat run 2 (Engineer): Codex runs in its own worktree
   `/workspaces/project-alpha.wt/{eng-id}/`
3. Heartbeat run 3 (CEO): Same pod, same cwd. `--resume {sessionId}`.
   Workspace is warm — `node_modules`, git state all intact.

When the pod is reaped (idle timeout), all sessions end. The next
activation clones fresh and starts new sessions. Database-level session
state is cleared so adapters don't try to `--resume` dead sessions.

**Storage:**

**V1:** `emptyDir` volumes — workspaces live as long as the pod. When
the idle reaper kills the pod, everything is lost. Acceptable because
agents push their work to git branches before sessions end.

**V2:** PVC-backed volumes — workspaces persist across pod restarts.
Useful for large repos where re-cloning is expensive, or companies with
many projects and heavy dependency trees.

## Schema Changes

### New adapter type constant

Add `"cloud_sandbox"` to the adapter type enum in shared constants.

### Cloud sandbox adapter config

```typescript
{
  runtime: "claude" | "codex" | "opencode" | "multi",
  model: string,
  runtimeImage?: string,          // override default image
  isolation?: "shared" | "isolated", // shared=pod per company (default), isolated=pod per agent
  resources?: {
    cpu?: string,
    memory?: string,
  },
  timeoutSec?: number,            // per-exec timeout
  idleTimeoutMin?: number,        // pod idle timeout (default 30)
}
```

### Company inference mode

Add `inferenceMode` to company model:

```typescript
{
  inferenceMode: "managed" | "byok",
  // When managed: platform key injected
  // When byok: user's secret_ref injected
}
```

## Delivery Plan

### Phase 1: Cloud Sandbox Adapter (foundation)

1. Implement `cloud_sandbox` server adapter in `server/src/adapters/cloud-sandbox/`
   - Pod lifecycle management (create, exec, idle reap)
   - K8s exec API integration for running CLI inside pod
   - Log streaming back to Paperclip
2. Build agent runtime Docker images (start with `agent-multi`)
3. Add RBAC for Pod/exec management to the operator
4. Wire into heartbeat execution path alongside existing adapters
5. Add `cloud_sandbox` to the operator CRD as a deployment option

### Phase 2: Managed Inference + BYOK

1. Add `inferenceMode` to company model
2. Platform API key injection in cloud sandbox adapter
3. BYOK flow: store user key as company secret, bind to agent env
4. Connection token injection verified end-to-end in sandbox pods

### Phase 3: Onboarding Simplification

1. Detect hosted mode (cloud_sandbox available)
2. Simplify wizard step 3: Managed / BYOK / Advanced radio
3. BYOK flow: secret input + model selector
4. Managed flow: one-click, pre-configured

### Phase 4: Production Hardening (V2)

1. PVC-backed persistent workspaces
2. Per-request inference proxy for real-time metering
3. Pod resource limits tuning and autoscaling
4. Multi-namespace isolation for enterprise tenants

## Non-Goals For This Change

- **Multi-region execution** — V1 runs in the same cluster as the server.
- **GPU workloads** — agent runtimes are CPU-bound (LLM runs remotely).
- **Custom base images** — V1 uses pre-built images. User Dockerfiles are V2.
- **Per-request inference proxy** — V1 relies on adapter-reported usage.
- **Billing model and pricing tiers** — separate plan, not covered here.

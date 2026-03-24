# Multi-Tenant SaaS Security Audit

**Date:** 2026-03-24
**Scope:** Full codebase audit for hosting Paperclip as multi-tenant SaaS via the `paperclipinc/paperclip-operator` on Kubernetes.

---

## Architecture Context

The operator deploys Paperclip as a **shared-infrastructure model**:
- Single StatefulSet (default 3 replicas), only pod-0 runs the heartbeat scheduler
- Single shared PostgreSQL database — tenant isolation is row-level via `companyId`
- Agent execution via **cloud sandbox**: per-company Kubernetes pods with NetworkPolicy, non-root, all capabilities dropped, `automountServiceAccountToken: false`
- Two isolation tiers: `shared` (one pod per company, multiple agents) and `isolated` (one pod per agent)

---

## Critical

### 1. No rate limiting anywhere

No rate limiting on any endpoint — auth, API, webhooks, or public triggers. This enables:
- Brute-force attacks on login/password reset
- API abuse and resource exhaustion by a single tenant
- Webhook endpoint flooding

**Affected:** All routes, especially `/api/auth/*`, public webhook endpoints, cost reporting.

### 2. Fallback dev secrets may reach production

`BETTER_AUTH_SECRET` falls back to `"paperclip-dev-secret"` if unset. `PAPERCLIP_AGENT_JWT_SECRET` falls back to the same. In a misconfigured deployment, all agent JWTs and sessions would be signed with a known secret.

**Affected:** `server/src/config.ts`, `server/src/agent-auth-jwt.ts`

**Fix:** Refuse to start in `authenticated` deployment mode without explicitly configured secrets.

### 3. Cost events are not tamper-proof

Agents self-report their own cost events (`POST /api/costs`). There's no server-side verification of token counts or cost amounts against the LLM provider. A malicious or compromised agent could:
- Under-report costs to evade budget limits
- Over-report costs to trigger budget incidents on other agents in the same company

**Affected:** `server/src/services/costs.ts`, `server/src/routes/costs.ts`

### 4. Archived companies remain queryable

`companies.status = "archived"` is set on archive, but queries don't consistently filter by status. Archived company data may remain accessible to members.

**Affected:** `server/src/services/companies.ts` — no status filter in `getById` or list queries.

---

## High

### 5. Plugin system lacks company isolation

Several plugin tables have no `companyId` column:
- `pluginJobRuns` — references `jobId` and `pluginId` only
- `pluginLogs` — references `pluginId` only
- `pluginEntities` — references `pluginId` only

Plugin state uses `scopeKind` + `scopeId`, but a plugin with `instance` scope can read state across all companies.

**Affected:** `packages/db/src/schema/plugin_jobs.ts`, `plugin_logs.ts`, `plugin_entities.ts`, `plugin_state.ts`

### 6. Shared-pod agent isolation is weak

In `isolation: "shared"` mode (the default), all agents in a company share a single pod. Agents can:
- Kill each other's processes (`kill`, `pkill`)
- Read/write each other's workspaces under `/workspaces/`
- Bind to ports that conflict with other agents' runtime services

This is acceptable for trusted single-company setups but risky for multi-tenant SaaS where customers control agent instructions.

**Affected:** Cloud sandbox adapter, `server/src/adapters/cloud-sandbox/`

**Mitigation:** Default to `isolation: "isolated"` in SaaS, or document the trust boundary clearly.

### 7. No per-company resource quotas beyond agent count

The subscription plan enforces `maxAgents` but nothing else:
- No storage quota (unlimited asset uploads)
- No limit on issues, projects, routines, or webhook triggers
- No per-company database connection or query time limits
- Cost aggregation queries are unbounded (no `LIMIT`)

A single tenant could exhaust shared infrastructure resources.

**Affected:** `server/src/middleware/plan-limits.ts`, `server/src/services/assets.ts`, `server/src/routes/costs.ts`

### 8. No Row-Level Security (RLS) in PostgreSQL

All tenant isolation is application-layer. If the database is accessed directly (admin tools, debugging, backup scripts, or a SQL injection in a future dependency), there's no defense-in-depth.

**Affected:** All tables in `packages/db/src/schema/`

**Recommendation:** Enable RLS as a safety net. Pattern: `CREATE POLICY company_isolation ON <table> USING (company_id = current_setting('app.company_id')::uuid)`.

### 9. Agent JWT uses shared signing secret

All agents across all companies share one JWT signing secret (`PAPERCLIP_AGENT_JWT_SECRET`). A compromised agent JWT from company A is valid for any agent in the instance (subject to claims verification). If the server-side claims check has a bug, there's no additional cryptographic boundary between tenants.

**Affected:** `server/src/agent-auth-jwt.ts`

---

## Medium

### 10. Running agents not cancelled on company archive

`archive()` sets status to `"archived"` but doesn't cancel in-flight heartbeat runs or pending wakeups. Agents continue executing after their company is archived.

Budget hard-stop does cancel work (`cancelBudgetScopeWork`), but archival does not.

**Affected:** `server/src/services/companies.ts` `archive()` method

### 11. Company deletion may leave orphans

The `remove()` transaction deletes 17+ tables explicitly, but several tables are missing:
- `issueWorkProducts`
- `documentRevisions`
- `workspaceOperations`
- `budgetPolicies`, `budgetIncidents`
- `companySubscriptions`

Some of these may cascade via FK constraints, but this isn't verified.

**Affected:** `server/src/services/companies.ts` `remove()` method

### 12. Webhook payloads stored in full

Plugin webhook deliveries store the entire request body (`payload` column) and headers. External webhooks may contain PII or secrets. No sanitization, truncation, or retention policy.

**Affected:** `packages/db/src/schema/plugin_webhooks.ts`, `server/src/routes/plugins.ts`

### 13. No CORS or security headers configured

No explicit CORS middleware, no `Content-Security-Policy`, `X-Frame-Options`, `Strict-Transport-Security`, or `X-Content-Type-Options` headers found.

**Affected:** `server/src/app.ts`

### 14. 48-hour agent JWT TTL

Agent JWTs are valid for 48 hours by default. In a SaaS context where agents are managed by customers, a leaked JWT provides a long exploitation window.

**Affected:** `server/src/agent-auth-jwt.ts` — `PAPERCLIP_AGENT_JWT_TTL_SECONDS`

### 15. No global heartbeat run timeout

There's no server-enforced timeout on heartbeat runs. Timeouts depend entirely on the adapter implementation. A hung adapter or long-running agent process could hold resources indefinitely.

**Affected:** `server/src/services/heartbeat.ts`

### 16. Health endpoint leaks global metrics

`/api/health` returns the total count of active heartbeat runs across all companies. While not a data leak, it reveals instance utilization to any authenticated user.

**Affected:** `server/src/routes/health.ts`

---

## Low / Informational

### 17. Master key stored on disk

The secrets master key is stored at `data/secrets/master.key` with `0o600` permissions. In a containerized deployment, this is in the pod's volume. No integration with external KMS (AWS KMS, GCP KMS, Vault) is implemented — the stubs exist but are not complete.

### 18. Plugin signature verification is plugin-side

Webhook signature verification (HMAC) is delegated to the plugin worker, not enforced by the host. A poorly implemented plugin could skip signature validation.

### 19. OAuth client credentials are shared across tenants

OAuth providers (GitHub, Slack, etc.) use a single set of client credentials (`PAPERCLIP_OAUTH_{PROVIDER}_CLIENT_ID/SECRET`) for the entire instance. All companies' OAuth tokens are issued under the same OAuth application. This is standard for multi-tenant SaaS but means a provider-level revocation affects all tenants.

### 20. No audit log for destructive operations

Company deletion, agent termination, secret rotation, and approval resolution are not logged to a dedicated tamper-evident audit trail. The `activityLog` table captures some events but is deleted along with the company.

### 21. 10MB JSON body limit is generous

`express.json({ limit: "10mb" })` applies globally. Combined with no rate limiting, this allows rapid submission of large payloads.

---

## What's Already Solid

| Area | Assessment |
|------|------------|
| **Tenant data isolation** | Every company-scoped table has `companyId` with proper indexes. All routes enforce access via `assertCompanyAccess`/`hasCompanyAccess`. |
| **Existence oracle prevention** | `hasCompanyAccess` returns uniform 404 for "not found" and "wrong tenant" (fixed in this session). |
| **SSRF protection** | Plugin HTTP fetches validate protocols, resolve DNS, block private IPs, and pin resolved addresses to prevent DNS rebinding. |
| **SQL injection** | Drizzle ORM throughout, no raw SQL, all queries parameterized. |
| **Secrets encryption** | AES-256-GCM with random IVs, master key with restricted file permissions, strict mode available. |
| **Agent API key security** | 192-bit randomness, SHA256 hashed at rest, timing-safe comparison, revocation support. |
| **Cloud sandbox pod hardening** | Non-root (UID 1000), all capabilities dropped, seccomp enabled, no service account token, strict egress NetworkPolicy. |
| **Workspace cross-references** | `assertValidProjectWorkspace` and `assertValidExecutionWorkspace` both verify `companyId` match before allowing assignment. |
| **CSRF protection** | Origin/Referer validation for browser mutations, HMAC-signed state tokens for OAuth. |
| **WebSocket isolation** | Upgrade requires auth, subscription is company-scoped. |
| **Asset storage isolation** | Object keys must be prefixed with `companyId/`, `..` blocked. |
| **Budget enforcement** | Three-tier system (soft warning, hard stop, approval workflow) with automatic work cancellation. |

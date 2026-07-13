# Fork: Managed-Experience Removal + PR A Adoption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the fork-only "managed experience" (forced opencode + hosted model) and adopt upstream PR A (lazy cloud-tenant onboarding), so cloud users get the self-hosted experience: real onboarding, free runtime choice, BYO keys.

**Architecture:** Two phases on one branch. Phase 1 cherry-picks the 8 PR A commits (upstream lazy onboarding — branch `contrib/cloud-tenant-lazy-onboarding`, https://github.com/paperclipai/paperclip/pull/9466). Phase 2 deletes the managed experience using `git diff origin/master -- <file>` as the authority: for every shared file, managed-related fork deltas are reverted to upstream's shape while non-managed fork deltas (cloud_tenant auth, seed CLI, cloud billing surfaces) are preserved. Fork-only managed/cloud-onboarding modules are deleted outright.

**Tech Stack:** Same as repo (Express/Drizzle/React/Vitest).

**Spec:** `docs/superpowers/specs/2026-07-12-cloud-onboarding-parity-design.md` §6.2 (fork deletions), §6.3, §7 "Fork-only PR" (on branch `feat/cloud-onboarding-parity-spec` in the main checkout; this plan is self-contained).

## Global Constraints

- Work in worktree `/Users/jannesstubbemann/repos/paperclip/wt-fork-managed-revert`, branch `feat/managed-experience-revert` (based on fork/main b57c11d7a).
- Never commit `pnpm-lock.yaml`. No DB migrations.
- **Preserve fork deltas that are NOT managed-experience:** cloud_tenant middleware additions, the seed CLI (`auth seed-instance-admin`), cloud billing UI/proxies (CloudTrialBanner, cloudBilling api, budgets checkout paths), `PAPERCLIP_CLOUD_MAX_CONCURRENT_RUNS_PER_COMPANY` and other cloud env reads, `PAPERCLIP_DEFAULT_THEME`, adapter model listing via `PAPERCLIP_ADAPTER_MODELS` (that env is removed in the MONO repo, not here — the code path is generic).
- **Preserve additional-company creation in cloud:** `ui/src/api/cloudCompanies.ts` stays. The wizard's cloud branch that creates ADDITIONAL companies via the gateway (`cloudCompaniesApi.create` → navigate to new stack URL) must survive, but ONLY for the case where the user already has ≥1 company; the first-company path must be upstream's `companiesApi.create` (PR A makes the server force the stack id). The rename-in-place branch and `ui/src/lib/cloud-onboarding.ts` (+ test) are deleted.
- Deletion authority: `git fetch origin master` then `git diff origin/master -- <file>`. A hunk is "managed" if it references managedExperience / ManagedAgentDefaults / ManagedRun / PAPERCLIP_MANAGED_* / managed-mode UI folding. When in doubt whether a hunk is managed vs other fork feature: STOP and report the hunk (do not guess).
- After Phase 2, `grep -rn "managedExperience\|ManagedAgentDefaults\|ManagedRun\|PAPERCLIP_MANAGED" server/src ui/src cli/src packages/shared/src` must return ZERO hits (excluding this plan file).
- Conventional commits. Each task ends green: `pnpm --filter @paperclipai/server typecheck && pnpm --filter @paperclipai/ui typecheck` plus the named suites.

---

### Task 1: Cherry-pick PR A (8 commits)

**Files:** the 8 commits touch `server/src/services/cloud-tenant-company.{ts,test.ts}`, `server/src/middleware/auth.ts` + `cloud-tenant-actor.test.ts`, `server/src/types/express.d.ts`, `server/src/routes/companies.ts` + `companies-cloud-create.test.ts`, `server/src/routes/access.ts`, `server/src/__tests__/auth-session-route.test.ts`, `ui/src/api/access.ts`, `ui/src/lib/cloud-zero-company.{ts,test.ts}`, `ui/src/components/{WorkspaceSetupPendingPage,CloudAccessGate,Layout,OnboardingWizard}.tsx`, `docs/deploy/deployment-modes.md`.

- [ ] Step 1: `git fetch fork contrib/cloud-tenant-lazy-onboarding && git fetch origin master`
- [ ] Step 2: `git cherry-pick 4cb219dd7^..72a413916` (the 8 PR A commits; resolve conflicts toward PR A's content — expected conflict sites: `auth.ts` (fork kept `resolveCloudTenantWsAuth` + `friendlyCloudCompanyName` which upstream lacks: keep `resolveCloudTenantWsAuth` (fork WS feature, re-point it at the imported `cloudTenantCompanyId`), delete `friendlyCloudCompanyName` + `issuePrefixForCloudStack` per PR A), `Layout.tsx`, `OnboardingWizard.tsx` (fork cloud branches collide with PR A's 409 catch — keep both PR A's catch AND the fork cloud-create branch for now; Task 4 rewrites it), `CloudAccessGate.tsx`.
- [ ] Step 3: Fork's own middleware tests (`cloud-tenant-actor.test.ts`) may have fork-added cases (multi-membership select) that PR A's rewrite dropped upstream — reconcile: keep PR A's suite; re-add fork-only cases ONLY if the fork code they test still exists (report what you decided).
- [ ] Step 4: `npx vitest run server/src/middleware/cloud-tenant-actor.test.ts server/src/services/cloud-tenant-company.test.ts server/src/routes/companies-cloud-create.test.ts server/src/__tests__/auth-session-route.test.ts && cd ui && npx vitest run src/lib/cloud-zero-company.test.ts` — all green; both typechecks green.
- [ ] Step 5: Commit state is the 8 cherry-picked commits (+ conflict resolutions inside them). No extra commit needed.

### Task 2: Delete managed-experience server code

**Files (delete):** `server/src/services/managed-agent-defaults.ts`, `server/src/services/managed-agent-defaults.test.ts`
**Files (revert managed hunks vs origin/master):** `server/src/services/heartbeat.ts` (~:266-267 import, ~:5488 `overrideAgentForManagedRun` in getAgent), `server/src/services/default-agent-instructions.ts` (:3, :39), `server/src/services/instance-settings.ts` (env-authoritative `managedExperience` block), `server/src/services/workspace-runtime.ts`, `server/src/index.ts`, `packages/shared/src/types/instance.ts`, `packages/shared/src/validators/instance.ts`, and the agent create/hire route(s) calling `applyManagedAgentDefaults` (grep — earlier at `server/src/routes/agents.ts`).
**Tests:** `server/src/__tests__/instance-settings-service.test.ts`, `server/src/__tests__/workspace-runtime.test.ts` — remove managed-specific cases (compare with origin/master versions; if the whole test exists upstream, revert to upstream's version).

- [ ] Step 1: For each file run `git diff origin/master -- <file>`, revert exactly the managed hunks (method in Global Constraints). Delete the two fork-only files.
- [ ] Step 2: `grep -rn "managedExperience\|ManagedAgentDefaults\|ManagedRun\|PAPERCLIP_MANAGED" server/src packages/shared/src` → zero hits.
- [ ] Step 3: `pnpm --filter @paperclipai/server typecheck && npx vitest run server/src/__tests__/instance-settings-service.test.ts server/src/__tests__/workspace-runtime.test.ts server/src/services` — green.
- [ ] Step 4: Commit `revert(managed): remove managed-experience server enforcement and flag`.

### Task 3: Delete managed-experience UI code

**Files (revert managed hunks vs origin/master):** `ui/src/components/AgentConfigForm.tsx` (+ `.test.tsx`), `ui/src/components/OnboardingWizard.tsx` (+ `.test.tsx`; ONLY managed hunks here — cloud branches are Task 4), `ui/src/components/NewAgentDialog.tsx`, `ui/src/pages/Dashboard.tsx`, `ui/src/components/CloudTrialBanner.test.tsx` (managed refs only — the banner itself is cloud billing, KEEP), `ui/src/pages/InstanceExperimentalSettings.test.tsx`.

- [ ] Step 1: Revert managed hunks per file (adapter/model pickers render unconditionally, managed-mode copy removed, `omitManagedAdapterAndModel` logic removed, hire payload always includes adapterType/adapterConfig).
- [ ] Step 2: `grep -rn "managedExperience\|managed" ui/src --include="*.tsx" --include="*.ts" | grep -iv "management\|manager"` → review every remaining hit is non-managed-experience (report the list).
- [ ] Step 3: `pnpm --filter @paperclipai/ui typecheck && cd ui && npx vitest run src/components/AgentConfigForm.test.tsx src/components/OnboardingWizard.test.tsx src/components/CloudTrialBanner.test.tsx src/pages/InstanceExperimentalSettings.test.tsx` — green (adapt tests that asserted managed folding).
- [ ] Step 4: Commit `revert(managed): unconditional runtime/model pickers in UI`.

### Task 4: Cloud onboarding fork-artifact cleanup (post-PR A shape)

**Files:** delete `ui/src/lib/cloud-onboarding.ts` + `ui/src/lib/cloud-onboarding.test.ts`; rewrite the wizard's cloud branch in `OnboardingWizard.tsx`; check `ui/src/App.tsx` / `ui/src/lib/onboarding-route.ts` for fork-only cloud onboarding wiring vs origin/master and revert non-PR-A deltas.

- [ ] Step 1: Delete `cloud-onboarding.ts` + test; remove any imports (`grep -rn "cloud-onboarding" ui/src`).
- [ ] Step 2: Rewrite `handleConfirmMission`'s cloud logic to exactly this decision: `const isCloud = health?.deploymentMode === "authenticated"` (or the wizard's existing cloud detection); if `isCloud && companies.length > 0` → existing gateway path (`cloudCompaniesApi.create()` + `window.location.assign(created.url)`, keep its 402/409 error handling); otherwise → upstream/PR A path (`companiesApi.create({ name })`, which in cloud creates the stack company server-side). Delete the rename-in-place branch (`createdCompanyId` early-return stays — that's upstream — but the fork's "rename existing cloud company" logic goes).
- [ ] Step 3: `cd ui && npx vitest run src/components/OnboardingWizard.test.tsx && pnpm --filter @paperclipai/ui typecheck` — green; adapt wizard tests asserting the rename branch.
- [ ] Step 4: Commit `revert(cloud-onboarding): first company onboards via standard wizard; gateway path only for additional companies`.

### Task 5: Full sweep + fork PR via staging

- [ ] Step 1: `pnpm typecheck && pnpm test` — triage: known master-side flake (heartbeat-process-recovery "bounded retries"), pre-existing env failures (heartbeat-workspace-branch-containment /tmp realpath, workspace-runtime adopt-live-auto-port) are ignorable; anything touching managed/cloud-onboarding files is ours.
- [ ] Step 2: Grep gate from Global Constraints (zero managed refs repo-wide).
- [ ] Step 3: Push to the fork's staging branch: `git push fork feat/managed-experience-revert:staging --force-with-lease` (staging branch currently = fork/main + docker.yml staging channel commit; force-with-lease is expected — RE-APPLY the docker.yml staging-channel commit first: cherry-pick `845e14d` from `fork/staging` so the image channel survives). Verify a `staging-*` image builds (gh run list --branch staging).
- [ ] Step 4: STOP — hand back to the controller for staging.paperclip.inc verification (image auto-rolls via Flux; controller runs diag-staging + browser checks) before any fork-main PR.

### Task 6 (controller, after staging verification): fork PR

- `gh pr create` on paperclipinc/paperclip: base `main`, head `feat/managed-experience-revert`, title `revert(managed): remove managed experience; adopt upstream lazy cloud onboarding (PR A)`. Body: what/why, staging verification evidence, hard-cut note for existing tenants, follow-ups (mono env cleanup). Merge per fork policy (`--squash --admin`) after CI.

## Self-Review Notes

- The wizard is the riskiest file (PR A cherry-pick conflict + managed hunks + cloud-branch rewrite touch the same function). Tasks 1/3/4 are ordered so each rewrite lands on a green, committed state.
- `PAPERCLIP_ADAPTER_MODELS` model-listing code is generic and stays; only the MONO env value is removed later (spec §6.6).
- CloudTrialBanner/billing surfaces are cloud-billing (area 4), not managed experience — preserved.

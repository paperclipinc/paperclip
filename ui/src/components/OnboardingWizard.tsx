import { useEffect, useRef, useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestResult
} from "@paperclipai/shared";
import type { AdapterCredentialSetup } from "@paperclipai/adapter-utils";
import { useLocation, useNavigate, useParams } from "@/lib/router";
import { ApiError } from "@/api/client";
import { restoreOnboardingState } from "@/lib/onboarding-state";
import { trackStep } from "@/telemetry";
import {
  credentialFailureKey,
  credentialRejectionMessage,
  deriveCredentialConnected,
  findCredentialAuthFailureCheck,
  findMatchingCompanySecret,
} from "@/lib/credential-connected";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { ApiError } from "../api/client";
import { companiesApi } from "../api/companies";
import { cloudCompaniesApi } from "../api/cloudCompanies";
import { healthApi } from "../api/health";
import { goalsApi } from "../api/goals";
import { agentsApi } from "../api/agents";
import { approvalsApi } from "../api/approvals";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { secretsApi } from "../api/secrets";
import { queryKeys } from "../lib/queryKeys";
import { Dialog, DialogPortal } from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";
import {
  extractModelName,
  extractProviderIdWithFallback
} from "../lib/model-utils";
import { getUIAdapter } from "../adapters";
import { listUIAdapters } from "../adapters";
import { isVisualAdapterChoice } from "../adapters/metadata";
import { useDisabledAdaptersSync, useAdapterRegistryLoaded } from "../adapters/use-disabled-adapters";
import { useAdapterCapabilities } from "../adapters/use-adapter-capabilities";
import { getAdapterDisplay } from "../adapters/adapter-display-registry";
import { buildFixedClaudeOAuthBinding } from "./environment-variables-editor/model";
import { defaultCreateValues } from "./agent-config-defaults";
import { parseOnboardingGoalInput } from "../lib/onboarding-goal";
import { restoreOnboardingState } from "../lib/onboarding-state";
import { composeCeoInstructions } from "../lib/ceo-instructions";
import {
  buildOnboardingIssuePayload,
  buildOnboardingProjectPayload,
  selectDefaultCompanyGoalId,
  selectReusableOnboardingProject,
} from "../lib/onboarding-launch";
import { buildNewAgentRuntimeConfig } from "../lib/new-agent-runtime-config";
import { DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX } from "@paperclipai/adapter-codex-local";
import { DEFAULT_CURSOR_LOCAL_MODEL } from "@paperclipai/adapter-cursor-local";
import { DEFAULT_GEMINI_LOCAL_MODEL } from "@paperclipai/adapter-gemini-local";
import { DEFAULT_KIMI_LOCAL_MODEL } from "@paperclipai/adapter-kimi-local";
import { DEFAULT_OPENCODE_LOCAL_MODEL, isValidOpenCodeModelId } from "@paperclipai/adapter-opencode-local";
import {
  canGoBackFromOnboardingStep,
  canJumpToOnboardingStep,
  companyPrefixFromOnboardingPath,
  resolveRouteOnboardingOptions,
} from "../lib/onboarding-route";
import { useCompanyMission } from "../hooks/useCompanyMission";
import { useCloudInstance } from "../hooks/useCloudInstance";
import {
  isExistingCompanyMissionUnresolved,
  planMissionPersistence,
} from "../lib/onboarding-mission";
import { AsciiArtAnimation } from "./AsciiArtAnimation";
import { FrontDoor } from "./FrontDoor";
import { AgentCapsule } from "./AgentCapsule";
import { AdapterCredentialConnect } from "./AdapterCredentialConnect";
import { Badge } from "@/components/ui/badge";
import {
  Building2,
  Bot,
  ListTodo,
  ArrowLeft,
  ArrowRight,
  Sparkles,
  Check,
  Loader2,
  ChevronDown,
} from "lucide-react";

type Step = 0 | 1 | 2 | 3 | 4 | 5;
// Plugin/external adapters use arbitrary type ids, so this mirrors the master
// wizard's registry-driven approach rather than a fixed union.
type AdapterType = string;

const MISSION_PROMPT_CHIPS = [
  "Build a SaaS product",
  "Scale a content business",
  "Launch a marketplace"
];

type CredentialBinding = { type: "secret_ref"; secretId: string };

/**
 * Merges guided-credential-connect bindings into a base adapter config's
 * `env`, scoped to the *current* adapter's credential-setup envKeys.
 *
 * `credentialBindings` accumulates across the whole wizard session (a user
 * can pick claude_local, bind ANTHROPIC_API_KEY, then switch to
 * gemini_local) — without filtering, a binding collected under a
 * previously-selected adapter would leak into the config of whichever
 * adapter the user ends up hiring. Only entries whose envKey appears in the
 * current adapter's `credentialSetup` options survive the merge.
 *
 * Also merges on top of `baseConfig.env` (rather than replacing it) so
 * unrelated env entries already produced by `buildAdapterConfig` — notably
 * the `forceUnsetAnthropicApiKey` plain-value marker — survive alongside
 * the bindings. If there's nothing to merge (no matching bindings and no
 * base env), `env` is omitted entirely to preserve the existing
 * regression-guarded "no env key when nothing is bound" behavior.
 */
function mergeCredentialBindings(
  baseConfig: Record<string, unknown>,
  bindings: Record<string, CredentialBinding>,
  setup: AdapterCredentialSetup | undefined
): Record<string, unknown> {
  const allowedEnvKeys = new Set((setup?.options ?? []).map((option) => option.envKey));
  const filteredBindings = Object.fromEntries(
    Object.entries(bindings).filter(([envKey]) => allowedEnvKeys.has(envKey))
  );
  const baseEnv =
    typeof baseConfig.env === "object" &&
    baseConfig.env !== null &&
    !Array.isArray(baseConfig.env)
      ? (baseConfig.env as Record<string, unknown>)
      : undefined;

  if (Object.keys(filteredBindings).length === 0 && !baseEnv) {
    return baseConfig;
  }

  return {
    ...baseConfig,
    env: { ...(baseEnv ?? {}), ...filteredBindings }
  };
}

function buildMissionFromQuestionnaire(q1: string, q2: string, q3: string, q4: string): string {
  const parts: string[] = [];
  if (q1.trim()) parts.push(q1.trim());
  if (q2.trim()) parts.push(`We serve ${q2.trim().toLowerCase()}.`);
  if (q3.trim()) parts.push(`Our biggest challenge is ${q3.trim().toLowerCase()}.`);
  if (q4.trim()) parts.push(`Success looks like ${q4.trim().toLowerCase()}.`);
  return parts.join(" ");
}

const ONBOARDING_STORAGE_KEY = "paperclip-onboarding-state";
// Skill (by key) that teaches the governance-aware agent-hiring flow. Attached to
// the onboarding CEO so it can fulfil its seed task of hiring the first engineer.
const ONBOARDING_CEO_SKILL_KEY = "paperclip-create-agent";
const DEFAULT_TASK_TITLE = "Hire your first engineer and create a hiring plan";
const DEFAULT_TASK_DESCRIPTION = `You are the CEO. You set the direction for the company.

const INCOMPLETE_ONBOARDING_STATE_MESSAGE =
  "Onboarding state is incomplete. Please restart onboarding and try again.";

/**
 * Thin gate in front of {@link OnboardingWizardInner}. The inner component's
 * ~20 `useState(saved?.x ?? default)` initializers only read `saved` on their
 * very first render, so it must never mount before the restored draft is
 * final — otherwise every field locks to its default and the draft is lost
 * for good. restoreOnboardingState requires the SETTLED companies list (see
 * its JSDoc), so when a saved blob exists we wait for `companiesLoading` to
 * clear before computing `saved` and mounting the inner component at all.
 */
export function OnboardingWizard() {
  const { companies, loading: companiesLoading } = useCompany();

  // Parsed once (not re-parsed by the cleanup effect below) so the restored
  // value and the "should we wipe the blob" decision always agree.
  const rawBlob = useMemo(() => {
    const raw = localStorage.getItem(ONBOARDING_STORAGE_KEY);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null; // malformed: treated as stale below, same as before
    }
  }, []);

  const { saved, staleStateDetected } = useMemo(() => {
    if (rawBlob === undefined) return { saved: null, staleStateDetected: false };
    // Companies not settled yet: restoreOnboardingState must not be called
    // (see its CONTRACT). Not stale, just not decidable yet.
    if (companiesLoading) return { saved: null, staleStateDetected: false };
    if (rawBlob === null) return { saved: null, staleStateDetected: true };
    const restored = restoreOnboardingState(rawBlob, companies);
    return { saved: restored, staleStateDetected: restored === null };
  }, [rawBlob, companiesLoading, companies]);

  // A discarded/malformed state should not sit in storage waiting to confuse
  // the next onboarding attempt (e.g. a different signed-in user).
  useEffect(() => {
    if (staleStateDetected) {
      localStorage.removeItem(ONBOARDING_STORAGE_KEY);
    }
  }, [staleStateDetected]);

  // A saved blob exists but companies haven't settled yet: wait rather than
  // mount the inner wizard with a premature (and unrecoverable) guess.
  if (rawBlob !== undefined && companiesLoading) {
    return null;
  }

  return <OnboardingWizardInner saved={saved} />;
}

function OnboardingWizardInner({
  saved,
}: {
  saved: Record<string, unknown> | null;
}) {
  const {
    onboardingOpen,
    onboardingOptions,
    closeOnboarding,
    onboardingRouteDismissed: routeDismissed,
    setOnboardingRouteDismissed: setRouteDismissed,
  } = useDialog();
  const { companies, setSelectedCompanyId, loading: companiesLoading } = useCompany();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { companyPrefix: matchedCompanyPrefix } = useParams<{ companyPrefix?: string }>();
  // This component renders beside `<Routes>`, not inside it (`App.tsx`), so it
  // has no route match and `useParams()` gives nothing. Read the prefix from
  // the pathname, which `useLocation()` supplies without a match. The param is
  // kept first so a future move inside the route tree needs no change here.
  const companyPrefix =
    matchedCompanyPrefix ?? companyPrefixFromOnboardingPath(location.pathname);
  // Managed stacks create organizations on Cloud, so the route below never
  // resolves into the create wizard there — see resolveRouteOnboardingOptions.
  const cloudInstance = useCloudInstance();

  // Support opening the wizard from a route (e.g. /onboarding or an existing
  // company's "add agent" entry point) in addition to the dialog context.
  // The company the path names, resolved before the mission lookup below so it
  // has something to ask about. Same match the resolver makes.
  const routeMatchedCompanyId =
    companyPrefix && !companiesLoading
      ? companies.find(
          (company) => company.issuePrefix.toUpperCase() === companyPrefix.toUpperCase(),
        )?.id ?? null
      : null;
  // The mission lookup used to gate this: the step was applied once and not
  // revised, so opening before the answer arrived left the customer on the
  // wrong step. The step no longer depends on the answer, so the wait bought
  // nothing but a slower open. Companies still gate it — the resolver needs
  // them to match the prefix at all.
  const routeOnboardingOptions =
    companyPrefix && companiesLoading
      ? null
      : resolveRouteOnboardingOptions({
          pathname: location.pathname,
          companyPrefix,
          companies,
          cloudManaged: Boolean(cloudInstance),
        });
  const effectiveOnboardingOpen =
    onboardingOpen || (routeOnboardingOptions !== null && !routeDismissed);
  const effectiveOnboardingOptions = onboardingOpen
    ? onboardingOptions
    : routeOnboardingOptions ?? {};

  // Sync disabled adapter types only when the wizard is visible. The wizard is
  // mounted globally, including on /auth, where protected adapter routes are
  // expected to reject signed-out browsers.
  const disabledTypes = useDisabledAdaptersSync({ enabled: effectiveOnboardingOpen });
  const adapterRegistryLoaded = useAdapterRegistryLoaded({ enabled: effectiveOnboardingOpen });

  const initialStep = effectiveOnboardingOptions.initialStep ?? 0;
  const existingCompanyId = effectiveOnboardingOptions.companyId;

  const [step, setStep] = useState<Step>((saved?.step as Step) ?? initialStep);
  // The step this run *entered* on, which bounds how far back it can walk.
  // Captured once, when the wizard opens, for the same reason the step itself
  // is: it derives from queries, so a live read would move the floor under a
  // customer mid-flow — and here that would quietly re-open the "create a
  // company" step to a run that already holds one.
  const [entryStep, setEntryStep] = useState<number>((saved?.step as Step) ?? initialStep);
  const [onboardingPath, setOnboardingPath] = useState<"create" | "grow" | null>((saved?.onboardingPath as "create" | "grow" | null) ?? null);

  // Cloud UI telemetry: record wizard step transitions (step number + time
  // spent on the previous step; never any field content). trackStep is a
  // no-op off-cloud, so this costs nothing in plain installs.
  const stepTelemetryRef = useRef<{ step: Step; at: number } | null>(null);
  useEffect(() => {
    if (!effectiveOnboardingOpen) {
      stepTelemetryRef.current = null;
      return;
    }
    const prev = stepTelemetryRef.current;
    if (prev?.step === step) return;
    trackStep("onboarding", step, prev?.step, prev ? Date.now() - prev.at : undefined);
    stepTelemetryRef.current = { step, at: Date.now() };
  }, [effectiveOnboardingOpen, step]);

  // "Grow existing" questionnaire fields
  const [growWorkflows, setGrowWorkflows] = useState((saved?.growWorkflows as string) ?? "");
  const [growPainPoints, setGrowPainPoints] = useState((saved?.growPainPoints as string) ?? "");
  const [growAutomate, setGrowAutomate] = useState((saved?.growAutomate as string) ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // True only while `error` holds the additional-company plan-gate message
  // (the 402 upgrade_required case). Lets the error banner offer an
  // actionable "Subscribe" link (to /account) instead of a dead end (mirrors
  // NewCompanyDialog's inline upgrade prompt). Always reset at the top of
  // handleConfirmMission, the only place that sets it true, so it can never
  // linger onto an unrelated later error.
  const [companyUpgradeRequired, setCompanyUpgradeRequired] = useState(false);
  // True only while `error` holds the additional-company slot-required message
  // (the 402 slot_required case: an active subscriber must buy another company
  // slot before this one is created, confirm-first billing). Lets the error
  // banner offer an "Add a company slot" link instead of a dead end. Reset at
  // the top of handleConfirmMission alongside companyUpgradeRequired.
  const [companySlotRequired, setCompanySlotRequired] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");

  // Step 1
  const [companyName, setCompanyName] = useState((saved?.companyName as string) ?? "");
  const [companyGoal, setCompanyGoal] = useState((saved?.companyGoal as string) ?? "");
  const [missionPath, setMissionPath] = useState<"direct" | "questionnaire" | null>((saved?.missionPath as "direct" | "questionnaire" | null) ?? null);
  const [missionConfirmed, setMissionConfirmed] = useState((saved?.missionConfirmed as boolean) ?? false);
  // Questionnaire answers
  const [q1, setQ1] = useState((saved?.q1 as string) ?? ""); // What do you do?
  const [q2, setQ2] = useState((saved?.q2 as string) ?? ""); // Who do you serve?
  const [q3, setQ3] = useState((saved?.q3 as string) ?? ""); // Biggest bottleneck?
  const [q4, setQ4] = useState((saved?.q4 as string) ?? ""); // What would success look like?

  // Step 2
  // The name is not defaulted: a pre-filled "Chief of staff" is a choice made
  // on the customer's behalf that they then have to notice and undo. It is the
  // step's only question, and its CTA gates on it.
  const [agentName, setAgentName] = useState((saved?.agentName as string) ?? "");
  // Defaults to `general` rather than empty. The arc stopped asking for a role
  // — a customer naming their first agent is describing what it does, not
  // filing it — but the hire still needs one, and the guard below returns
  // silently when it is missing. An unset role there would mean Connect
  // appearing to work and hiring nobody.
  const [agentRole, setAgentRole] = useState<AgentRole>(
    // `||`, not `??`: the empty string was this field's default before the arc
    // stopped asking for a role, so every draft saved by an earlier build holds
    // `agentRole: ""`. `??` passes that straight through, and an empty role
    // reaches the silent return in the hire — the exact failure the default
    // exists to prevent, arriving through a restored draft instead of a fresh
    // one.
    (saved?.agentRole as AgentRole) || DEFAULT_AGENT_ROLE,
  );
  const [adapterType, setAdapterType] = useState<AdapterType>(() =>
    restoreOnboardingAdapterType(saved?.adapterType),
  );
  /**
   * Whether a model source has been chosen, as opposed to which one
   * `adapterType` happens to hold.
   *
   * The two are not the same, and reading the second as the first is what made
   * this step arrive with a tile already lit and its input already open: the
   * hire needs an adapter, so `adapterType` always carries one, restored or
   * defaulted. A customer who never touched the row could reach the end of the
   * step having chosen nothing.
   *
   * Restored true when the draft names a source. Someone returning here has
   * already answered, and asking again would throw that answer away.
   */
  const [sourcePicked, setSourcePicked] = useState<boolean>(
    () => typeof saved?.adapterType === "string" && saved.adapterType.length > 0,
  );
  const savedNativeRunnerDraft = saved?.adapterType === "paperclip_runner";
  const [cwd, setCwd] = useState((saved?.cwd as string) ?? "");
  // Native drafts may carry provider-specific configuration that is invalid
  // for the legacy adapter selected above. Keep the portable working
  // directory, but clear runner-specific execution fields while restoring.
  const [model, setModel] = useState(
    savedNativeRunnerDraft ? "" : (saved?.model as string) ?? "",
  );
  const [command, setCommand] = useState(
    savedNativeRunnerDraft ? "" : (saved?.command as string) ?? "",
  );
  const [args, setArgs] = useState(
    savedNativeRunnerDraft ? "" : (saved?.args as string) ?? "",
  );
  const [url, setUrl] = useState(
    savedNativeRunnerDraft ? "" : (saved?.url as string) ?? "",
  );
  const [adapterEnvResult, setAdapterEnvResult] =
    useState<AdapterEnvironmentTestResult | null>(null);
  const [adapterEnvError, setAdapterEnvError] = useState<string | null>(null);
  const [adapterEnvLoading, setAdapterEnvLoading] = useState(false);
  const [forceUnsetAnthropicApiKey, setForceUnsetAnthropicApiKey] =
    useState(false);
  const [unsetAnthropicLoading, setUnsetAnthropicLoading] = useState(false);
  const [showMoreAdapters, setShowMoreAdapters] = useState(false);
  // Session-only: never restored from localStorage. A restored binding names a
  // secret id that can belong to another company, which the server rejects.
  const [credentialBindings, setCredentialBindings] = useState<
    Record<string, { type: "secret_ref"; secretId: string }>
  >({});
  // envKeys whose most recent post-bind live probe came back with the
  // provider explicitly rejecting the credential (see
  // findCredentialAuthFailureCheck). Cleared for an envKey the moment a
  // fresh bind attempt starts for it; excludes that envKey from
  // deriveCredentialConnected regardless of session bindings or the
  // (possibly still-present) server-side secret.
  const [failedCredentialEnvKeys, setFailedCredentialEnvKeys] = useState<
    Set<string>
  >(new Set());
  // Plain-language copy for the most recent rejection, shown on the
  // credential-connect card. Never the raw provider/CLI message — see
  // credentialRejectionMessage.
  const [credentialProbeError, setCredentialProbeError] = useState<
    string | null
  >(null);

  // Created entity IDs — pre-populate from existing company when skipping step 1
  const [createdCompanyId, setCreatedCompanyId] = useState<string | null>(
    existingCompanyId ?? (saved?.createdCompanyId as string) ?? null
  );
  const [createdCompanyPrefix, setCreatedCompanyPrefix] = useState<
    string | null
  >((saved?.createdCompanyPrefix as string) ?? null);
  const [createdAgentId, setCreatedAgentId] = useState<string | null>((saved?.createdAgentId as string) ?? null);
  const [createdCompanyGoalId, setCreatedCompanyGoalId] = useState<string | null>(
    (saved?.createdCompanyGoalId as string) ?? null
  );
  const [createdProjectId, setCreatedProjectId] = useState<string | null>(
    (saved?.createdProjectId as string) ?? null
  );
  const [createdIssueRef, setCreatedIssueRef] = useState<string | null>(
    (saved?.createdIssueRef as string) ?? null
  );

  // The company the *route* last supplied, so a navigation that stops naming
  // one can drop it without touching a company the wizard created itself.
  const routeCompanyIdRef = useRef<string | null>(null);
  // The current company, mirrored so the sync effect can read it without
  // taking it as a dependency. Depending on it would re-run the effect on
  // every company change, and the effect also calls setStep - it would drag
  // the user back to the route's initial step mid-flow.
  const createdCompanyIdRef = useRef<string | null>(null);
  // In flight, synchronously. `loading` cannot answer this: it is state, so a
  // second caller in the same tick — key repeat holding Enter down — reads the
  // value the first has not written yet. `createdCompanyId` cannot answer it
  // either, because it is not set until the request it guards has resolved. A
  // ref is written before the request goes out, so the second caller sees it.
  const creatingCompanyRef = useRef(false);
  // Same shape for the hire. Greptile (round-3 PR): with "Test now" gone the
  // Connect handler re-runs a cached failed probe — and two overlapping
  // submissions could then both pass the fresh probe and both hire. `loading`
  // cannot stop the second caller for the same reason as above.
  const hiringAgentRef = useRef(false);
  // True when the last `adapterEnvResult` came from a config that carried
  // the fixed Claude login binding (see `hireAdapterConfig` in
  // `handleGiveHeartbeat`). A cached result from a config that did not carry
  // the binding cannot answer for a config that now does — see the reuse
  // check in `handleGiveHeartbeat`.
  const adapterEnvResultAppliedStoredLoginRef = useRef(false);
  /**
   * The secret a key typed on this step was stored as, remembered for the key it
   * holds. Connect can be pressed more than once — a hire that fails leaves the
   * customer on the step to try again — and without this each press would store
   * another copy of the same credential.
   */
  const apiKeySecretRef = useRef<{ key: string } | null>(null);
  createdCompanyIdRef.current = createdCompanyId;

  // The mission of the company actually in hand, which is not always the one
  // the route named - the dashboard opens the wizard with a company too. Same
  // query key as the route lookup above, so when they agree this is one cache
  // entry and no second request.
  const {
    mission: existingCompanyMission,
    settled: existingMissionSettled,
    fetching: existingMissionFetching,
  } = useCompanyMission(createdCompanyId);

  // Seed the mission field from the company's own goal.
  //
  // A company that already has its mission opens on the agent step, so steps 1
  // and 2 never run and `companyGoal` stays empty. It is not only a display
  // field: the Review checklist reads it, and `composeCeoInstructions` seeds
  // the lead agent's instructions from it. Left empty, the agent is hired
  // knowing nothing of the mission the customer gave at signup - which is the
  // answer this whole flow exists to carry forward.
  //
  // Only when the field is empty, so a customer editing their mission is never
  // overwritten by the stored copy.
  const hydratedMissionForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!effectiveOnboardingOpen || !createdCompanyId) return;
    if (hydratedMissionForRef.current === createdCompanyId) return;
    if (!existingMissionSettled || existingMissionFetching) return;
    hydratedMissionForRef.current = createdCompanyId;
    if (!existingCompanyMission.goalInput) return;
    setCompanyGoal((current) => (current.trim() ? current : existingCompanyMission.goalInput));
    setCreatedCompanyGoalId((current) => current ?? existingCompanyMission.goalId);
  }, [
    effectiveOnboardingOpen,
    createdCompanyId,
    existingMissionSettled,
    existingMissionFetching,
    existingCompanyMission.goalInput,
    existingCompanyMission.goalId,
  ]);

  // Hiring seeds the agent's instructions from `companyGoal`, so it must not
  // run while that field is still waiting to be hydrated - the agent would be
  // created with an empty or foreign mission and nothing would report it.
  const missionUnresolvedForHire = isExistingCompanyMissionUnresolved({
    existingCompanyId: createdCompanyId,
    goalsLoaded: existingMissionSettled,
    goalsFetching: existingMissionFetching,
  });
  // The step the request wants, mirrored for the same reason. `initialStep` is
  // *derived* - from the company list, and now from the goal list behind
  // `useCompanyMission` - so its value changes whenever one of those queries
  // does: a retry, a background refetch, a cache invalidation. An effect that
  // depended on it would re-run on every such change and call setStep, moving
  // a customer who is already mid-flow. Reading it through a ref breaks that
  // dependency, so the effect runs when the wizard *opens* or when the company
  // changes, and takes whatever the step is at that moment.
  const initialStepRef = useRef<Step | undefined>(undefined);
  initialStepRef.current = effectiveOnboardingOptions.initialStep;

  // Reset the route-dismissed flag when navigating to a different path.
  useEffect(() => {
    setRouteDismissed(false);
  }, [location.pathname]);

  /**
   * Forget everything that describes one particular company.
   *
   * Called when the wizard stops holding a company - the route replaced it, or
   * withdrew it. Both are the same event, and clearing only part of it is what
   * lets the next company skip work it has not done: a kept goal id reads as
   * "this company's mission is already written", and the launch path would
   * link the next company's project to the previous company's goal.
   *
   * The name and the prefix are cleared here too and backfilled again from the
   * company list by the effects below, so they always describe the company in
   * hand rather than the one before it.
   */
  function clearCompanyScopedState() {
    setCreatedCompanyPrefix(null);
    setCompanyName("");
    setCompanyGoal("");
    // The marker travels with the field it describes. It means "companyGoal
    // holds this company's hydrated mission", so it is cleared wherever that
    // field is - here and in `reset()`. Left behind, the next run believes a
    // mission it no longer holds was already fetched, and hires the lead agent
    // without one.
    hydratedMissionForRef.current = null;
    setMissionPath(null);
    setMissionConfirmed(false);
    setCreatedCompanyGoalId(null);
    setCreatedProjectId(null);
    setCreatedIssueRef(null);
    setCreatedAgentId(null);
  }

  // Sync step and company when onboarding opens with explicit options.
  // Only override saved state when explicit options provide values.
  //
  // The step belongs to the request that opened the wizard, not to the latest
  // value of the expression that produced it - see `initialStepRef` above for
  // why those differ. This effect is therefore keyed on the two things that
  // make a *new* request: the wizard opening, and the company changing.
  // Navigating from one company's onboarding path to another re-decides the
  // step; the same request re-deriving a fresher value does not.
  useEffect(() => {
    if (!effectiveOnboardingOpen) return;
    // If explicit options are provided, they take precedence over saved state
    if (initialStepRef.current) {
      setStep(initialStepRef.current);
      setEntryStep(initialStepRef.current);
    }
    const routeCompanyId = effectiveOnboardingOptions.companyId ?? null;
    if (routeCompanyId) {
      // Claim ownership only when the route *introduces* a company. A route
      // that merely names the one already in hand - the wizard created it,
      // then the user navigated to that company's onboarding path - has not
      // supplied anything, so it must not take ownership of it. Otherwise
      // navigating on to `/onboarding` would clear work the wizard did.
      if (routeCompanyId !== createdCompanyIdRef.current) {
        setCreatedCompanyId(routeCompanyId);
        clearCompanyScopedState();
      }
      // Ownership is recorded either way, including when the route merely
      // names the company already in hand. Only the clearing above is
      // conditional.
      //
      // This is a deliberate change to the rule the comment above described.
      // Not recording ownership there protected wizard-created work from a
      // later `/onboarding`, but it also meant that company was never
      // withdrawn: create a company on step 1, visit its own onboarding path,
      // then go to `/onboarding`, and the wizard shows "create a company"
      // while still holding the previous one. The next confirmation then
      // writes that customer's new mission into the old company - which is
      // exactly the failure the withdrawal branch below was written to
      // prevent, reached by a path it could not see.
      //
      // Losing the step-1 progress on `/onboarding` is the better error:
      // `/onboarding` is a request to start a company, so honouring it beats
      // silently writing into a different one.
      routeCompanyIdRef.current = routeCompanyId;
      return;
    }
    if (routeCompanyIdRef.current) {
      // The route named a company and now does not - the user navigated from
      // an existing company's onboarding to `/onboarding`, or to a prefix that
      // matches nothing. Drop it. Keeping it leaves the wizard showing step 1,
      // "create a company", while still holding the previous one, so the next
      // confirmation writes into that company instead of making a new one.
      //
      // Only a company this route supplied is cleared. One the wizard created
      // itself, or restored from saved state, is left alone: the ref is null
      // in those cases, and clearing them would discard real progress.
      //
      // Withdrawing a company clears the same state that replacing one does.
      // The two are the same event - this company is no longer the wizard's -
      // and clearing only half of it leaves ids that make the *next* company
      // skip work it has not done.
      setCreatedCompanyId(null);
      routeCompanyIdRef.current = null;
      clearCompanyScopedState();
    }
  }, [effectiveOnboardingOpen, effectiveOnboardingOptions.companyId]);

  // Backfill issue prefix for an existing company once companies are loaded.
  useEffect(() => {
    if (!effectiveOnboardingOpen || !createdCompanyId || createdCompanyPrefix) return;
    const company = companies.find((c) => c.id === createdCompanyId);
    if (company) setCreatedCompanyPrefix(company.issuePrefix);
  }, [effectiveOnboardingOpen, createdCompanyId, createdCompanyPrefix, companies]);

  // When onboarding skips the naming step (initialStep >= 2: an existing/auto-
  // created company entered via the /<prefix>/onboarding route), the company
  // already has a name. Backfill it so the mission header, the "Confirm mission"
  // guard, and the review checklist reflect the real name instead of a blank.
  // We never prefill on the initialStep 1 rename path — there the user names it
  // fresh.
  useEffect(() => {
    if (!effectiveOnboardingOpen || initialStep < 2 || companyName || !createdCompanyId) {
      return;
    }
    const company = companies.find((c) => c.id === createdCompanyId);
    if (company?.name) setCompanyName(company.name);
  }, [effectiveOnboardingOpen, initialStep, companyName, createdCompanyId, companies]);

  // credentialBindings is company-scoped even though it isn't persisted: if
  // createdCompanyId changes while the wizard stays mounted (an in-SPA company
  // switch, no page reload), a binding collected under the previous company
  // must not read as "connected" for the new one.
  useEffect(() => {
    setCredentialBindings({});
    setFailedCredentialEnvKeys(new Set());
    setCredentialProbeError(null);
  }, [createdCompanyId]);

  // Persist wizard state to localStorage on every change
  useEffect(() => {
    if (!effectiveOnboardingOpen) return;
    const state = {
      step, companyName, companyGoal, missionPath, missionConfirmed,
      q1, q2, q3, q4, agentName, agentRole, adapterType, cwd, model, command, args, url,
      // The mode, never the key: this blob is localStorage.
      credentialMode,
      createdCompanyId, createdCompanyPrefix, createdAgentId,
      createdCompanyGoalId, createdProjectId, createdIssueRef,
      onboardingPath, growWorkflows, growPainPoints, growAutomate,
    };
    onboardingDraftStorage.write(JSON.stringify(state));
  }, [
    effectiveOnboardingOpen, step, companyName, companyGoal, missionPath, missionConfirmed,
    q1, q2, q3, q4, agentName, agentRole, adapterType, cwd, model, command, args, url,
    credentialMode,
    createdCompanyId, createdCompanyPrefix, createdAgentId,
    createdCompanyGoalId, createdProjectId, createdIssueRef,
    onboardingPath, growWorkflows, growPainPoints, growAutomate,
  ]);

  const {
    data: adapterModels,
    error: adapterModelsError,
    isLoading: adapterModelsLoading,
    isFetching: adapterModelsFetching
  } = useQuery({
    // The wizard doesn't expose an environment selector, so models always
    // resolve against the local Paperclip host (environmentId = null).
    queryKey: createdCompanyId
      ? queryKeys.agents.adapterModels(createdCompanyId, adapterType, null)
      : ["agents", "none", "adapter-models", adapterType, null],
    queryFn: () => agentsApi.adapterModels(createdCompanyId!, adapterType, { environmentId: null }),
    // Models are picked on step 4 (Connect a model).
    enabled: Boolean(createdCompanyId) && effectiveOnboardingOpen && step === 4
  });
  // Server-side truth for "is a credential connected". Company scoped, so a
  // secret from another company cannot appear here.
  const { data: companySecrets } = useQuery({
    // Shared with Secrets.tsx's identical list call so both share one cache
    // entry instead of the wizard keeping its own ad hoc copy.
    queryKey: createdCompanyId
      ? queryKeys.secrets.list(createdCompanyId)
      : ["secrets", "__disabled__"],
    queryFn: () => secretsApi.list(createdCompanyId as string),
    enabled: Boolean(createdCompanyId),
    staleTime: 0,
  });
  // Cloud (authenticated) mode: the native POST /api/companies collection-create
  // is blocked by the hosting gateway (409 use_cloud_company_create). Creating an
  // ADDITIONAL company in cloud must go through the gateway's POST
  // /api/cloud/companies, which provisions a separate control-plane tenant on its
  // own stack and returns a URL to navigate to. So the wizard's inline
  // create-then-goal-then-hire flow (which assumes one stack) cannot run in cloud:
  // when the user starts a brand-new company, we hand off to the cloud endpoint and
  // full-page navigate to the new tenant, where its own first-run wizard takes over.
  const { data: health } = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    staleTime: 5 * 60 * 1000,
  });
  const isCloud = health?.deploymentMode === "authenticated";
  const getCapabilities = useAdapterCapabilities();
  const adapterCaps = getCapabilities(adapterType);

  // Resolve the login environment at render time, so the wizard can decide
  // whether to show the login panel before any adapter test runs. This
  // mirrors the agent configuration form's own resolution, including the
  // managed-sandbox-only redirect (see AgentConfigForm.tsx:618-640). A render
  // must not throw, so a resolver error yields no login environment rather
  // than an error boundary.
  const { data: loginEnvironmentList = [] } = useQuery({
    queryKey: createdCompanyId
      ? queryKeys.environments.list(createdCompanyId)
      : ["environments", "none"],
    queryFn: () => environmentsApi.list(createdCompanyId!),
    enabled: Boolean(createdCompanyId) && effectiveOnboardingOpen && step === 4,
  });
  const { data: instanceSettingsForLogin } = useQuery({
    queryKey: queryKeys.instance.settings,
    queryFn: () => instanceSettingsApi.get(),
    enabled: effectiveOnboardingOpen && step === 4,
  });
  // Wanted across the whole arc, not just the connect step. The progress strip
  // reads it too — see `enteredFromCloud` — and a value fetched only on step 4
  // would let the strip change length as the customer walked through it.
  const { data: experimentalSettingsForLogin } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
    enabled: effectiveOnboardingOpen && step >= 3 && step <= 5,
  });
  const resolvedLoginEnvironmentId = useMemo(() => {
    try {
      return resolveAdapterTestEnvironmentId({
        agentDefaultEnvironmentId: null,
        instanceDefaultEnvironmentId: instanceSettingsForLogin?.defaultEnvironmentId ?? null,
        localDefaultEnvironmentId: resolveLocalDefaultEnvironmentId(loginEnvironmentList),
        managedSandboxOnly: experimentalSettingsForLogin?.enableManagedSandboxOnly === true,
        managedSandboxEnvironmentId: resolveManagedSandboxEnvironmentId(loginEnvironmentList),
        visibleEnvironmentIds: loginEnvironmentList.map((environment) => environment.id),
      });
    } catch {
      return null;
    }
  }, [
    instanceSettingsForLogin?.defaultEnvironmentId,
    loginEnvironmentList,
    experimentalSettingsForLogin?.enableManagedSandboxOnly,
  ]);
  const resolvedLoginEnvironment = useMemo(
    () =>
      loginEnvironmentList.find((environment) => environment.id === resolvedLoginEnvironmentId) ??
      null,
    [loginEnvironmentList, resolvedLoginEnvironmentId],
  );
  // Sandbox provider capabilities for the login pseudo-terminal gate, loaded
  // only when the adapter declares a login capability — the same query the
  // agent configuration form runs (AgentConfigForm.tsx:652-658).
  const { data: loginEnvironmentCapabilities } = useQuery({
    queryKey: createdCompanyId
      ? queryKeys.environments.capabilities(createdCompanyId)
      : ["environment-capabilities", "none"],
    queryFn: () => environmentsApi.capabilities(createdCompanyId!),
    enabled:
      Boolean(createdCompanyId) &&
      adapterCaps.login != null &&
      effectiveOnboardingOpen &&
      step === 4,
  });
  const loginEnvironmentProvider =
    typeof resolvedLoginEnvironment?.config?.provider === "string"
      ? resolvedLoginEnvironment.config.provider
      : null;
  const loginProviderSupportsPty =
    loginEnvironmentProvider != null &&
    loginEnvironmentCapabilities?.sandboxProviders?.[loginEnvironmentProvider]?.supportsLoginPty ===
      true;
  // The same capability gate the agent configuration form uses to show its
  // login panel (AgentConfigForm.tsx:1064), minus the form's fourth input — a
  // full adapter test result. The cheap auth signal below stands in for that
  // input here, so this gate alone only decides whether the login mechanism
  // could ever apply to the current adapter and environment.
  const canShowAdapterLogin = Boolean(
    adapterCaps.login != null &&
      resolvedLoginEnvironment?.driver === "sandbox" &&
      resolvedLoginEnvironmentId &&
      createdCompanyId &&
      loginProviderSupportsPty,
  );
  // The cheap signal, re-read whenever the adapter type or the resolved login
  // environment changes (both are part of the query key). It reports whether
  // the host already holds a usable credential, with no adapter environment
  // test. The route reads only host-local state, so a login baked into a
  // sandbox image rather than held on the host reads as `absent` even though
  // the owner could already sign in — the panel then shows for one extra step
  // it did not strictly need, never the reverse.
  const authSignalQuery = useQuery({
    queryKey: createdCompanyId
      ? queryKeys.agents.authSignal(createdCompanyId, adapterType, resolvedLoginEnvironmentId)
      : ["agents", "none", "auth-signal", adapterType, resolvedLoginEnvironmentId],
    queryFn: () =>
      agentsApi.getAdapterAuthSignal(
        createdCompanyId!,
        adapterType,
        resolvedLoginEnvironmentId ?? undefined,
      ),
    enabled:
      Boolean(createdCompanyId) && effectiveOnboardingOpen && step === 4 && canShowAdapterLogin,
  });
  const authSignalStatus = authSignalQuery.data?.status ?? null;
  const showAdapterLoginPanel =
    canShowAdapterLogin && (authSignalStatus === "absent" || authSignalStatus === "unknown");
  /**
   * The signal is being fetched and has not answered yet.
   *
   * Worth its own state rather than folding into "no panel to show". Until it
   * answers, `authSignalStatus` is null and every not-signed-in customer looks
   * momentarily identical to a signed-in one — so the card would assert that
   * they are already signed in, for exactly as long as the request takes, and
   * then replace it with a sign-in prompt. A reassurance that is wrong and then
   * withdrawn is worse than saying nothing for a beat.
   */
  const authSignalUndecided = canShowAdapterLogin && authSignalStatus === null;

  const isLocalAdapterCaps =
    adapterCaps.supportsInstructionsBundle ||
    adapterCaps.supportsSkills ||
    adapterCaps.supportsLocalAgentJwt;
  const isLocalAdapter =
    isLocalAdapterCaps ||
    adapterType === "claude_local" ||
    adapterType === "codex_local" ||
    adapterType === "gemini_local" ||
    adapterType === "kimi_local" ||
    adapterType === "opencode_local" ||
    adapterType === "pi_local" ||
    adapterType === "cursor";
  const credentialSetup = getUIAdapter(adapterType)?.credentialSetup;
  // Gate activation on a connected credential: if the adapter advertises
  // credential options, the user must bind at least one before we let them
  // bring the agent to life (otherwise its heartbeat runs fail auth forever).
  const requiresCredential = Boolean(credentialSetup && credentialSetup.options.length > 0);
  const credentialConnected =
    !requiresCredential ||
    deriveCredentialConnected(
      credentialSetup,
      companySecrets,
      credentialBindings,
      adapterType,
      failedCredentialEnvKeys,
    );
  // Scope the credential card's error banner to the CURRENT adapter: only
  // show it when one of this adapter's own credential options is the one
  // that was rejected, so switching to an unrelated adapter never carries
  // over a stale message.
  const credentialCardError =
    credentialProbeError &&
    (credentialSetup?.options ?? []).some((option) =>
      failedCredentialEnvKeys.has(credentialFailureKey(adapterType, option.envKey)),
    )
      ? credentialProbeError
      : null;
  // Build adapter grids dynamically from the UI registry + display metadata.
  // External/plugin adapters automatically appear with generic defaults, and
  // server-disabled types are filtered out.
  const { recommendedAdapters, moreAdapters } = useMemo(() => {
    const all = listUIAdapters()
      .filter((a) =>
        !ONBOARDING_EXCLUDED_ADAPTER_TYPES.has(a.type) &&
        !disabledTypes.has(a.type) &&
        isVisualAdapterChoice(a.type)
      )
      .map((a) => ({ ...getAdapterDisplay(a.type), type: a.type }));

    return {
      recommendedAdapters: all.filter((a) => a.recommended),
      moreAdapters: all.filter((a) => !a.recommended),
    };
  }, [disabledTypes]);

  // The default (or a saved) adapterType can name an adapter the server has
  // since disabled — e.g. a cloud sandbox registry without claude_local. The
  // grid hides it, so without this snap the wizard would silently keep an
  // invisible selection and create an agent that can never acquire a lease.
  useEffect(() => {
    const visible = [...recommendedAdapters, ...moreAdapters].filter(
      (a) => !a.comingSoon,
    );
    if (visible.length === 0) return;
    if (visible.some((a) => a.type === adapterType)) return;
    const next = visible[0].type as AdapterType;
    setAdapterType(next);
    if (next === "codex_local") return;
    if (next === "opencode_local") {
      setModel(DEFAULT_OPENCODE_LOCAL_MODEL);
      return;
    }
    if (next === "gemini_local") {
      setModel(DEFAULT_GEMINI_LOCAL_MODEL);
      return;
    }
    if (next === "cursor") {
      setModel(DEFAULT_CURSOR_LOCAL_MODEL);
      return;
    }
    setModel("");
  }, [recommendedAdapters, moreAdapters, adapterType]);

  const COMMAND_PLACEHOLDERS: Record<string, string> = {
    claude_local: "claude",
    codex_local: "codex",
    gemini_local: "gemini",
    kimi_local: "kimi",
    pi_local: "pi",
    cursor: "agent",
    opencode_local: "opencode",
  };
  const effectiveAdapterCommand =
    command.trim() ||
    (COMMAND_PLACEHOLDERS[adapterType] ?? adapterType.replace(/_local$/, ""));

  // Throw the cached probe away whenever the thing it probed changes. Every
  // input to `buildAdapterConfig` belongs in this list, `credentialMode` and
  // `apiKey` included: the Connect handler reuses a passing result instead of
  // re-probing, so a dependency missing here is a hire that skips the check.
  //
  // That is reachable rather than theoretical. The hire runs after the probe
  // inside one try/catch, so a hire that fails — a network error, a server
  // error — leaves the pass sitting in state. Switch to an API key, paste one,
  // press Connect again, and without these two the wizard would hire against a
  // key nothing ever tested.
  useEffect(() => {
    if (step !== 4) return;
    setAdapterEnvResult(null);
    adapterEnvResultAppliedStoredLoginRef.current = false;
    setAdapterEnvError(null);
  }, [step, adapterType, model, command, args, url, credentialMode, apiKey]);

  const selectedModel = (adapterModels ?? []).find((m) => m.id === model);
  const hasAnthropicApiKeyOverrideCheck =
    adapterEnvResult?.checks.some(
      (check) =>
        check.code === "claude_anthropic_api_key_overrides_subscription"
    ) ?? false;
  const shouldSuggestUnsetAnthropicApiKey =
    adapterType === "claude_local" &&
    adapterEnvResult?.status === "fail" &&
    hasAnthropicApiKeyOverrideCheck;
  const filteredModels = useMemo(() => {
    const query = modelSearch.trim().toLowerCase();
    return (adapterModels ?? []).filter((entry) => {
      if (!query) return true;
      const provider = extractProviderIdWithFallback(entry.id, "");
      return (
        entry.id.toLowerCase().includes(query) ||
        entry.label.toLowerCase().includes(query) ||
        provider.toLowerCase().includes(query)
      );
    });
  }, [adapterModels, modelSearch]);
  const groupedModels = useMemo(() => {
    if (adapterType !== "opencode_local") {
      return [
        {
          provider: "models",
          entries: [...filteredModels].sort((a, b) => a.id.localeCompare(b.id))
        }
      ];
    }
    const groups = new Map<string, Array<{ id: string; label: string }>>();
    for (const entry of filteredModels) {
      const provider = extractProviderIdWithFallback(entry.id);
      const bucket = groups.get(provider) ?? [];
      bucket.push(entry);
      groups.set(provider, bucket);
    }
    return Array.from(groups.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([provider, entries]) => ({
        provider,
        entries: [...entries].sort((a, b) => a.id.localeCompare(b.id))
      }));
  }, [filteredModels, adapterType]);

  function reset() {
    onboardingDraftStorage.clear();
    // Cleared with `companyGoal` below - see `clearCompanyScopedState`.
    hydratedMissionForRef.current = null;
    setStep(0);
    setOnboardingPath(null);
    setGrowWorkflows("");
    setGrowPainPoints("");
    setGrowAutomate("");
    setLoading(false);
    setError(null);
    setCompanyUpgradeRequired(false);
    setCompanyName("");
    setCompanyGoal("");
    setMissionPath(null);
    setMissionConfirmed(false);
    setQ1("");
    setQ2("");
    setQ3("");
    setQ4("");
    // Back to the mount defaults: an empty name (the step's only question, and
    // what its CTA gates on) and the neutral role every onboarding hire uses.
    setAgentName("");
    setAgentRole(DEFAULT_AGENT_ROLE);
    setAdapterType("claude_local");
    setModel("");
    setCommand("");
    setArgs("");
    setUrl("");
    setAdapterEnvResult(null);
    adapterEnvResultAppliedStoredLoginRef.current = false;
    setAdapterEnvError(null);
    setAdapterEnvLoading(false);
    setForceUnsetAnthropicApiKey(false);
    setUnsetAnthropicLoading(false);
    setClaudeOAuthStatus(null);
    setCreatedCompanyId(null);
    setCreatedCompanyPrefix(null);
    setCreatedAgentId(null);
    setCreatedCompanyGoalId(null);
    setCreatedProjectId(null);
    setCreatedIssueRef(null);
  }

  function handleClose() {
    reset();
    closeOnboarding();
    // On the /onboarding route the wizard is also kept open by the route
    // itself, so closing the dialog must mark the route dismissed — otherwise
    // effectiveOnboardingOpen stays true and the wizard re-renders instead of
    // handing off to the launcher card (PAP-52).
    setRouteDismissed(true);
  }

  /**
   * Whether the company an async handler started for is still the one in hand.
   *
   * A route change can switch companies while a request is in flight, and the
   * switch clears the created resource ids so the new company starts clean. A
   * write that lands afterwards would put them back, and hand that company the
   * previous one's goal, project, issue or agent — which is exactly what the
   * clearing exists to prevent.
   *
   * Every async write below asks this before it attributes anything. It never
   * cancels the server work, which is done and correct either way; it declines
   * only to record it against a company it does not belong to.
   */
  function stillTheSameCompany(companyIdAtStart: string | null) {
    return createdCompanyIdRef.current === companyIdAtStart;
  }

  /**
   * Whether a just-created company can still be committed to this wizard.
   *
   * Company-list refreshes can make the surrounding app adopt the POST result
   * before the continuation runs. That is the same successful transition, not
   * a takeover. A different id still means navigation moved the wizard to a
   * different organization while the request was in flight.
   */
  function canCommitCreatedCompany(
    companyIdAtStart: string | null,
    returnedCompanyId: string,
  ) {
    const companyIdNow = createdCompanyIdRef.current;
    if (companyIdNow === companyIdAtStart || companyIdNow === returnedCompanyId) {
      return true;
    }
    setError("Organization created, but onboarding switched to another organization.");
    return false;
  }

  async function handleLaunchToDashboard() {
    if (!createdCompanyId || !createdAgentId) {
      setError(INCOMPLETE_ONBOARDING_STATE_MESSAGE);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      let goalId = createdCompanyGoalId;
      if (!goalId) {
        const goals = await goalsApi.list(createdCompanyId);
        goalId = selectDefaultCompanyGoalId(goals);
        if (stillTheSameCompany(createdCompanyId)) setCreatedCompanyGoalId(goalId);
      }

      let projectId = createdProjectId;
      if (!projectId) {
        const projects = await projectsApi.list(createdCompanyId);
        const existingOnboardingProject = selectReusableOnboardingProject(projects);
        if (existingOnboardingProject) {
          projectId = existingOnboardingProject.id;
        } else {
          const project = await projectsApi.create(
            createdCompanyId,
            buildOnboardingProjectPayload(goalId)
          );
          projectId = project.id;
          queryClient.invalidateQueries({
            queryKey: queryKeys.projects.list(createdCompanyId)
          });
        }
        if (stillTheSameCompany(createdCompanyId)) setCreatedProjectId(projectId);
      }

      let issueRef = createdIssueRef;
      if (!issueRef) {
        const issue = await issuesApi.create(
          createdCompanyId,
          buildOnboardingIssuePayload({
            title: DEFAULT_TASK_TITLE,
            description: DEFAULT_TASK_DESCRIPTION,
            assigneeAgentId: createdAgentId,
            projectId,
            goalId
          })
        );
        issueRef = issue.identifier ?? issue.id;
        if (stillTheSameCompany(createdCompanyId)) setCreatedIssueRef(issueRef);
        queryClient.invalidateQueries({
          queryKey: queryKeys.issues.list(createdCompanyId)
        });
      }

      // Everything above is server work and stands on its own: the company has
      // its goal, its onboarding project and its first task. What follows is
      // this wizard finishing — selecting a company, discarding its own state
      // and navigating. None of that is right for a customer who has moved to
      // another company in the meantime: it would take them back, and `reset()`
      // would discard the progress they had started there.
      if (!stillTheSameCompany(createdCompanyId)) return;

      const prefix = createdCompanyPrefix;
      // Select the new company as a route sync, not a manual switch: the
      // explicit navigate below is the intended destination, so page-memory's
      // "restore last page" (which falls back to /dashboard) must not fire and
      // clobber the first-task URL. See PAP-404.
      setSelectedCompanyId(createdCompanyId, { source: "route_sync" });
      reset();
      closeOnboarding();
      // Drop the user straight into the first task's detail page (not the
      // dashboard) so they land on the conversation the agent will start in.
      navigate(prefix ? `/${prefix}/issues/${issueRef}` : `/issues/${issueRef}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to launch first task");
    } finally {
      setLoading(false);
    }
  }

  /**
   * Store the typed key as the customer's own user secret, and report whether it
   * is in place.
   *
   * A user secret rather than a company one, to match the subscription half of
   * this very step: signing in stores the Claude token as a user secret and
   * binds a `user_secret_ref`. Two credential modes on one step that scoped
   * their secrets differently would be hard to justify and easy to get wrong
   * later. It also keeps the key to the person who typed it instead of exposing
   * it to everyone with company secret access, and agent runs still resolve it
   * through the company's responsible user.
   *
   * A user secret needs a definition to hang off. The Claude token's is fixed
   * and server-owned; there is no such definition for API keys, so onboarding
   * creates one on first use. That needs company owner or admin rights, which
   * whoever just created this company in onboarding has.
   *
   * Returns false on failure, having set the error. Callers must treat false as
   * a stop: there is deliberately no path that hands the raw key back, because
   * the only thing left to do with it would be to embed it.
   */
  async function storeApiKeyUserSecret(companyId: string): Promise<boolean> {
    const key = apiKey.trim();
    const envKey = apiKeyEnvKeyFor(adapterType);
    if (apiKeySecretRef.current?.key === key) return true;
    try {
      const entries = await secretsApi.listMyUserSecrets(companyId);
      const existing = entries.find((entry) => entry.definition.key === envKey);
      const definitionId =
        existing?.definition.id ??
        (
          await secretsApi.createUserSecretDefinition(companyId, {
            key: envKey,
            name: `${envKey} for onboarding`,
            description: "Created while connecting a model during onboarding.",
          })
        ).id;
      // Rotate rather than create when a value is already stored, because
      // creating a second value for one definition is what the server refuses.
      if (existing?.secret) {
        await secretsApi.rotateMyUserSecret(companyId, existing.secret.id, { value: key });
      } else {
        await secretsApi.createMyUserSecret(companyId, {
          definitionId,
          definitionKey: envKey,
          value: key,
        });
      }
      apiKeySecretRef.current = { key };
      return true;
    } catch (err) {
      setError(
        err instanceof Error
          ? `Could not store the API key: ${err.message}`
          : "Could not store the API key.",
      );
      return false;
    }
  }

  function buildAdapterConfig(bindApiKey = false): Record<string, unknown> {
    const adapter = getUIAdapter(adapterType);
    const config = adapter.buildAdapterConfig({
      ...defaultCreateValues,
      adapterType,
      model:
        adapterType === "gemini_local"
          ? model || DEFAULT_GEMINI_LOCAL_MODEL
          : adapterType === "kimi_local"
            ? model || DEFAULT_KIMI_LOCAL_MODEL
          : adapterType === "cursor"
            ? model || DEFAULT_CURSOR_LOCAL_MODEL
            : adapterType === "opencode_local"
              ? model || DEFAULT_OPENCODE_LOCAL_MODEL
              : model,
      command,
      args,
      url,
      dangerouslySkipPermissions:
        adapterType === "claude_local" || adapterType === "opencode_local",
      dangerouslyBypassSandbox:
        adapterType === "codex_local"
          ? DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX
          : defaultCreateValues.dangerouslyBypassSandbox
    });
    if (adapterType === "claude_local" && forceUnsetAnthropicApiKey) {
      const env =
        typeof config.env === "object" &&
        config.env !== null &&
        !Array.isArray(config.env)
          ? { ...(config.env as Record<string, unknown>) }
          : {};
      env.ANTHROPIC_API_KEY = { type: "plain", value: "" };
      config.env = env;
    }
    // A key typed on this step is the credential the agent is being hired with,
    // so it has to reach the configuration the hire sends — and the same one the
    // environment test probes, or the test would pass on a config the hire does
    // not use. Only when the mode asks for it: leaving a stale reference in the
    // config after switching back to a subscription is what the server rejects
    // alongside the Claude OAuth binding.
    //
    // A reference, never the key itself. The adapter configuration is
    // persisted and revisioned, so a `{ type: "plain", value }` here would leave
    // a live credential at rest in every copy of it. This mirrors
    // `buildFixedClaudeOAuthBinding`, which holds a reference to the stored
    // Claude token for the same reason.
    //
    // Guarded on the caller having stored the secret, not on the key being
    // present. If storing failed this stays false, and the right outcome is a
    // configuration with no credential — which the hire then blocks on — rather
    // than one that quietly falls back to embedding the value.
    if (credentialMode === "api" && bindApiKey) {
      const env =
        typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
          ? { ...(config.env as Record<string, unknown>) }
          : {};
      env[apiKeyEnvKeyFor(adapterType)] = {
        type: "user_secret_ref",
        key: apiKeyEnvKeyFor(adapterType),
        version: "latest",
      };
      config.env = env;
    }
    return config;
  }

  async function runAdapterEnvironmentTest(
    adapterConfigOverride?: Record<string, unknown>,
    appliedStoredClaudeLoginBinding = false
  ): Promise<AdapterEnvironmentTestResult | null> {
    if (!createdCompanyId) {
      setAdapterEnvError(
        "Create or select an organization before testing adapter environment."
      );
      return null;
    }
    setAdapterEnvLoading(true);
    setAdapterEnvError(null);
    try {
      // Probe the environment a real run would use, so the Test matches a real
      // run. The wizard has no agent yet, so the agent-default tier is always
      // null; resolve the instance default and the instance local default. A
      // settings-resolution failure surfaces an error instead of a silent host
      // probe, which would report a false result.
      let environmentList: Environment[];
      let settings: InstanceSettings;
      let managedSandboxOnly: boolean;
      try {
        const [list, generalSettings, experimentalSettings] = await Promise.all([
          queryClient.ensureQueryData({
            queryKey: queryKeys.environments.list(createdCompanyId),
            queryFn: () => environmentsApi.list(createdCompanyId),
          }),
          queryClient.ensureQueryData({
            queryKey: queryKeys.instance.settings,
            queryFn: () => instanceSettingsApi.get(),
          }),
          queryClient.ensureQueryData({
            queryKey: queryKeys.instance.experimentalSettings,
            queryFn: () => instanceSettingsApi.getExperimental(),
          }),
        ]);
        environmentList = list;
        settings = generalSettings;
        managedSandboxOnly = experimentalSettings?.enableManagedSandboxOnly === true;
      } catch {
        setAdapterEnvError(
          "Could not load environment settings to determine which environment to test in. Retry the test.",
        );
        return null;
      }
      // Mirror the server run-time resolution, including the managed-sandbox-only
      // redirect: when the resolution lands on the local environment and the
      // policy is on, probe the managed sandbox the real run uses instead. The
      // resolver throws when no managed sandbox is available, which the outer
      // catch surfaces as a fail-closed error rather than a local host probe.
      const environmentId = resolveAdapterTestEnvironmentId({
        agentDefaultEnvironmentId: null,
        instanceDefaultEnvironmentId: settings?.defaultEnvironmentId ?? null,
        localDefaultEnvironmentId: resolveLocalDefaultEnvironmentId(environmentList),
        managedSandboxOnly,
        managedSandboxEnvironmentId: resolveManagedSandboxEnvironmentId(environmentList),
        // The policy hides the local environment, so an instance default that
        // still points at the hidden local row names no visible environment.
        // Pass the visible ids so the resolver redirects that stale local
        // default to the managed sandbox instead of sending the hidden local id.
        visibleEnvironmentIds: environmentList.map((environment) => environment.id),
      });
      const result = await agentsApi.testEnvironment(
        createdCompanyId,
        adapterType,
        {
          adapterConfig:
            adapterConfigOverride ??
            mergeCredentialBindings(buildAdapterConfig(), credentialBindings, credentialSetup)
        }
      );
      setAdapterEnvResult(result);
      adapterEnvResultAppliedStoredLoginRef.current = appliedStoredClaudeLoginBinding;
      return result;
    } catch (err) {
      // The server's raw message can be an internal implementation detail
      // (e.g. "Secret must belong to same company") that must never render
      // verbatim — log it for support, show the operator a plain sentence.
      // This check "cannot run" case stays permissive by design: it does
      // not touch credentialBindings, so a prior successful bind still
      // reads as connected.
      // eslint-disable-next-line no-console
      console.log(
        "[onboarding] adapter environment test request failed:",
        err instanceof Error ? err.message : err,
      );
      setAdapterEnvError(
        "We could not run the adapter check right now. You can continue and retry the test later."
      );
      return null;
    } finally {
      setAdapterEnvLoading(false);
    }
  }

  // Best-effort: disable a secret whose bound value was just rejected by the
  // provider. Without this, the secret stays "active" server-side and, on a
  // fresh mount (page reload), deriveCredentialConnected's company-secrets
  // fallback would match it by name and silently re-open the heartbeat gate
  // — the in-session failedCredentialEnvKeys marker that blocks it here
  // does not survive a reload. A failure to disable is logged, not thrown:
  // the in-session gate still holds for the current session either way, and
  // AdapterCredentialConnect's existing 409-name-collision retry (the "-2"
  // suffix) already tolerates the name staying taken by an old secret
  // regardless of its status.
  async function disableRejectedCredentialSecret(secretId: string, envKey: string) {
    try {
      await secretsApi.disable(secretId);
      if (createdCompanyId) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.secrets.list(createdCompanyId),
        });
      }
    } catch (disableErr) {
      // eslint-disable-next-line no-console
      console.log(
        "[onboarding] failed to disable a rejected credential secret; it may remain active server-side until disabled manually",
        envKey,
        secretId,
        disableErr,
      );
    }
  }

  // Guided BYOK credential connect (step 4): bind an env key to a freshly
  // created company secret, then re-run the environment check with the
  // fresh binding included (passed explicitly rather than relying on
  // credentialBindings state, which wouldn't have re-rendered yet).
  //
  // If the live probe comes back with the provider explicitly rejecting the
  // credential (checks[].authFailure, classified server-side where the
  // actual provider response is visible): undo the binding and disable the
  // just-created secret so deriveCredentialConnected reads it as NOT
  // connected — both in this session AND after a reload — and the
  // heartbeat gate cannot open on its strength; show a plain-language error
  // on the card. AdapterCredentialConnect's existing 409-name-collision
  // retry (the "-2" suffix) absorbs a re-paste regardless of the disabled
  // secret's continued (inactive) existence. Any other outcome (pass, or a
  // non-auth warn/fail) keeps the existing permissive behavior — this is
  // what onboarding did before this fix and must keep working for
  // transient/infra probe failures.
  async function handleCredentialBind(envKey: string, secretId: string) {
    const failureKey = credentialFailureKey(adapterType, envKey);
    const nextBindings = {
      ...credentialBindings,
      [envKey]: { type: "secret_ref" as const, secretId }
    };
    setCredentialBindings(nextBindings);
    setAdapterEnvResult(null);
    setCredentialProbeError(null);
    setFailedCredentialEnvKeys((prev) => {
      if (!prev.has(failureKey)) return prev;
      const next = new Set(prev);
      next.delete(failureKey);
      return next;
    });
    if (createdCompanyId) {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.secrets.list(createdCompanyId),
      });
    }
    const result = await runAdapterEnvironmentTest(
      mergeCredentialBindings(buildAdapterConfig(), nextBindings, credentialSetup)
    );
    const rejection = findCredentialAuthFailureCheck(result);
    if (!rejection) return;
    // eslint-disable-next-line no-console
    console.log(
      "[onboarding] credential probe rejected the just-bound value for",
      envKey,
      rejection,
    );
    setCredentialBindings((prev) => {
      const { [envKey]: _removed, ...rest } = prev;
      return rest;
    });
    setFailedCredentialEnvKeys((prev) => {
      const next = new Set(prev);
      next.add(failureKey);
      return next;
    });
    setCredentialProbeError(credentialRejectionMessage(rejection));
    await disableRejectedCredentialSecret(secretId, envKey);
  }

  // Step 2 → 3 ("Confirm mission"): create the company + its company-level
  // goal, then advance to naming the team lead. Guarded so revisiting the
  // mission step (e.g. via Back) doesn't create a duplicate company.
  async function handleConfirmMission() {
    if (createdCompanyId) {
      // The company already exists (auto-created in cloud_tenant mode, or carried
      // in from the "add another agent" entry point). Naming + goal were handled
      // on entry, so just advance to creating the team lead.
      setStep(3);
      return;
    }
    if (isCloud && companies.length > 0) {
      // Cloud, and the user already has a stack company: creating an ADDITIONAL
      // company must go through the gateway's POST /api/cloud/companies, which
      // provisions a separate control-plane tenant on its own stack and returns
      // a URL. Hard-navigate to it (a client-side navigate would not trigger the
      // gateway to inject the new company's stack); the new tenant's own first-run
      // wizard then handles naming + goal + lead agent. The FIRST company instead
      // falls through to companiesApi.create below (PR A makes the server create
      // the stack company for the cloud tenant).
      setLoading(true);
      setError(null);
      setCompanyUpgradeRequired(false);
      setCompanySlotRequired(false);
      try {
        const created = await cloudCompaniesApi.create({ name: companyName.trim() });
        await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
        window.location.assign(created.url);
      } catch (err) {
        if (err instanceof ApiError && err.status === 402) {
          // Three outcomes share the 402: the trial plan gate (upgrade_required),
          // an active subscriber who must buy another company slot first
          // (slot_required, confirm-first billing), and a failed per-company
          // billing update for an already-paying user (billing_update_failed).
          const body = err.body as { error?: string; limit?: number } | null;
          const code = body?.error;
          if (code === "slot_required") {
            setCompanySlotRequired(true);
            const limit = body?.limit;
            setError(
              limit != null
                ? `Your subscription covers ${limit} ${
                    limit === 1 ? "company" : "companies"
                  }. Add another company slot to create this one.`
                : "Your subscription does not cover another company yet. Add a company slot to create this one.",
            );
          } else {
            const upgradeRequired = code !== "billing_update_failed";
            setCompanyUpgradeRequired(upgradeRequired);
            setError(
              code === "billing_update_failed"
                ? "We could not update your billing for the new company. No company was created and you have not been charged. Try again or contact support."
                : "Your trial includes one company. Subscribe to add more; each company is 10 euro per month.",
            );
          }
        } else if (err instanceof ApiError && err.status === 409) {
          setError("You have reached the fair use company limit. Contact us to raise it.");
        } else {
          setError(
            err instanceof Error ? err.message : "Failed to create company",
          );
        }
        setLoading(false);
      }
      return;
    }
    setLoading(true);
    setError(null);
    const companyIdAtStart = createdCompanyIdRef.current;
    try {
      const company = await companiesApi.create({ name: companyName.trim() });
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      // Same guard as the others, from the other end: nothing was in hand when
      // this started, so "unchanged" means still nothing. A route that supplied
      // a company while the request was open has taken over the wizard, and
      // adopting the company just created would fight it — and would leave the
      // customer on a company they never navigated to.
      if (!canCommitCreatedCompany(companyIdAtStart, company.id)) return;
      setCreatedCompanyId(company.id);
      // Keep the mirror current here rather than waiting for the next render.
      // The goal write below asks `stillTheSameCompany(company.id)`, and a ref
      // that still held the pre-create value would answer "no" to the handler
      // that just did the creating - so the goal would never be attributed and
      // the wizard would sit on the mission step it had just completed.
      createdCompanyIdRef.current = company.id;
      setCreatedCompanyPrefix(company.issuePrefix);
      setSelectedCompanyId(company.id);

      const parsedGoal = parseOnboardingGoalInput(companyGoal);
      const goal = await goalsApi.create(company.id, {
        title: parsedGoal.title,
        ...(parsedGoal.description
          ? { description: parsedGoal.description }
          : {}),
        level: "company",
        status: "active"
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.goals.list(company.id)
      });
      if (!stillTheSameCompany(company.id)) return;
      setCreatedCompanyGoalId(goal.id);

      setStep(3); // → Create your team lead
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Another owner/admin finished setting this workspace up first.
        queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
        setError(
          "This workspace was already set up by a teammate. Close this wizard to jump into the company.",
        );
      } else {
        setError(err instanceof Error ? err.message : "Failed to create company");
      }
    } finally {
      setLoading(false);
    }
  }

  // Step 1 → 3 ("Name your company"): create the company, then go straight to
  // the first agent.
  //
  // This work used to live at the end of `handleConfirmMission`, because step 1
  // led to the mission step and the company was created when that step was
  // confirmed. Onboarding no longer asks for the mission, so step 1 has to do
  // its own creating — routing 1 → 3 without this left the wizard on the agent
  // step with no company to hire into, and nothing said so.
  //
  // No goal is written here. That is the difference from the path this was
  // taken from, and it is deliberate: the mission is collected later, in the
  // tenant app, so writing an empty one now would only give the company a goal
  // it did not choose.
  async function handleCreateCompany() {
    if (createdCompanyId) {
      setStep(3);
      return;
    }
    if (creatingCompanyRef.current) return;
    creatingCompanyRef.current = true;
    setLoading(true);
    setError(null);
    const companyIdAtStart = createdCompanyIdRef.current;
    try {
      const company = await companiesApi.create({ name: companyName.trim() });
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      // Nothing was in hand when this started, so "unchanged" means still
      // nothing. A route that supplied a company while the request was open has
      // taken over the wizard, and adopting the company just created would
      // fight it — and would leave the customer on a company they never
      // navigated to.
      if (!canCommitCreatedCompany(companyIdAtStart, company.id)) return;
      setCreatedCompanyId(company.id);
      // Keep the mirror current rather than waiting for the next render, for
      // the same reason the mission path does: anything downstream that asks
      // `stillTheSameCompany` in this tick would otherwise be told no.
      createdCompanyIdRef.current = company.id;
      setCreatedCompanyPrefix(company.issuePrefix);
      setSelectedCompanyId(company.id);
      setStep(3);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create organization");
    } finally {
      creatingCompanyRef.current = false;
      setLoading(false);
    }
  }


  // Step 4 → 5 ("Give it a heartbeat"): hire the lead agent + seed its
  // instructions, then advance to Review. Guarded so revisiting step 4
  // doesn't hire a second agent.
  async function handleGiveHeartbeat() {
    if (!createdCompanyId) return;
    // The grid and restore path both exclude native runner. Keep this final
    // guard at the mutation boundary so a stale or modified client cannot use
    // first-run onboarding to create a native agent.
    if (adapterType === "paperclip_runner") {
      setAdapterType("claude_local");
      setModel("");
      setError("Paperclip Runner is not available during onboarding. Choose a legacy adapter.");
      return;
    }
    // Guarded at the button and the Enter path too; repeated here because this
    // seeds the agent's instructions from `companyGoal`, and hiring with an
    // unhydrated mission fails silently - the agent exists, and simply never
    // learns what the company is for.
    if (missionUnresolvedForHire) return;
    if (createdAgentId) {
      setStep(5);
      return;
    }
    if (hiringAgentRef.current) return;
    hiringAgentRef.current = true;
    setLoading(true);
    setError(null);
    try {
      // The heartbeat gate (credentialConnected) can read "connected"
      // purely off deriveCredentialConnected's company-secrets fallback —
      // e.g. right after a page reload, before the user has bound anything
      // THIS session. That fallback proves an active secret exists, but it
      // never puts anything into credentialBindings. Left alone, the probe
      // below and the hire payload would both run through
      // mergeCredentialBindings with an EMPTY bindings map: the probe would
      // only ever see the soft "please log in" case (no authFailure, since
      // no credential is present to reject) and the hire would create an
      // agent with no credential binding at all — exactly the "first run
      // fails after onboarding" bug this whole fix exists for, just via a
      // different path (a valid key on a fresh reload gets the same
      // treatment as a rejected one). Materialize the match into an actual
      // binding — reusing the exact name-matching logic
      // deriveCredentialConnected uses, via findMatchingCompanySecret — so
      // the probe actually tests it and the hire payload actually carries
      // it. Also persist it to credentialBindings state so later renders
      // (and the rejection-handling branch below) see it too.
      let materializedBindings = credentialBindings;
      let justMaterializedBinding = false;
      if (requiresCredential && credentialSetup) {
        const alreadyBoundThisSession = credentialSetup.options.some((option) =>
          Boolean(credentialBindings[option.envKey]),
        );
        if (!alreadyBoundThisSession) {
          const match = findMatchingCompanySecret(credentialSetup, companySecrets, adapterType);
          if (match) {
            materializedBindings = {
              ...credentialBindings,
              [match.envKey]: { type: "secret_ref" as const, secretId: match.secretId },
            };
            justMaterializedBinding = true;
            setCredentialBindings(materializedBindings);
          }
        }
      }

      if (adapterType === "opencode_local") {
        const selectedModelId = model.trim();
        if (!isValidOpenCodeModelId(selectedModelId)) {
          setError(
            "OpenCode requires an explicit model in provider/model format."
          );
          return;
        }
        if (adapterModelsError) {
          setError(
            adapterModelsError instanceof Error
              ? adapterModelsError.message
              : "Failed to load OpenCode models."
          );
          return;
        }
        if (adapterModelsLoading || adapterModelsFetching) {
          setError(
            "OpenCode models are still loading. Please wait and try again."
          );
          return;
        }
        const discoveredModels = adapterModels ?? [];
        if (!discoveredModels.some((entry) => entry.id === selectedModelId)) {
          setError(
            discoveredModels.length === 0
              ? "No OpenCode models discovered. Run `opencode models` and authenticate providers."
              : `Configured OpenCode model is unavailable: ${selectedModelId}`
          );
          return;
        }
      }

      // Onboarding applies a stored Claude subscription login automatically,
      // with no extra control. A new user who signs in, leaves, and returns
      // should not sign in a second time — that is the board's direction.
      // The binding is a reference to the owner's stored value, never the
      // value itself (see buildFixedClaudeOAuthBinding). The server rejects
      // that binding together with a configured ANTHROPIC_API_KEY, so this
      // checks the built configuration first and asks the status route only
      // when there is no such conflict.
      //
      // Read the stored-login status before the environment test below, and
      // fold it into one adapter configuration. The test must probe the same
      // configuration the hire sends — a config without the binding can
      // report missing authentication for a user the binding would have
      // covered.
      // Store the key before anything is built from it, so both the probe and the
      // hire describe it the same way — as a reference. A failure here stops the
      // hire rather than falling through to a configuration with no credential.
      let apiKeyStored = false;
      if (credentialMode === "api" && apiKey.trim()) {
        apiKeyStored = await storeApiKeyUserSecret(createdCompanyId);
        if (!apiKeyStored) return;
      }
      const baseAdapterConfig = buildAdapterConfig(apiKeyStored);
      let storedClaudeLogin: ClaudeOAuthTokenStatusResponse | null = null;
      if (
        adapterType === "claude_local" &&
        !adapterConfigHasAnthropicApiKey(baseAdapterConfig)
      ) {
        try {
          storedClaudeLogin = await agentsApi.getClaudeOAuthTokenStatus(createdCompanyId);
        } catch (err) {
          // A fixed 404 means the owner has no stored value. It is not a
          // failure.
          if (!(err instanceof ApiError) || err.status !== 404) throw err;
          storedClaudeLogin = null;
        }
        if (stillTheSameCompany(createdCompanyId)) setClaudeOAuthStatus(storedClaudeLogin);
      }
      const shouldApplyStoredClaudeLogin = storedClaudeLogin !== null;
      const hireAdapterConfig = shouldApplyStoredClaudeLogin
        ? {
            ...baseAdapterConfig,
            env: {
              ...(isEnvRecord(baseAdapterConfig.env) ? baseAdapterConfig.env : {}),
              ...buildFixedClaudeOAuthBinding(),
            },
          }
        : baseAdapterConfig;

      if (isLocalAdapter) {
        // If we just materialized a binding above, the cached adapterEnvResult
        // (if any) was necessarily produced before that binding existed — it
        // could only have seen the soft "please log in" case, never a real
        // pass/fail for this credential. Force a fresh probe against
        // materializedBindings rather than trusting the stale cache.
        const envConfigForProbe = mergeCredentialBindings(
          buildAdapterConfig(),
          materializedBindings,
          credentialSetup
        );
        const result = justMaterializedBinding
          ? await runAdapterEnvironmentTest(envConfigForProbe)
          : adapterEnvResult ?? (await runAdapterEnvironmentTest(envConfigForProbe));
        if (!result) return;
        // Defense in depth: normally a rejected credential never gets this
        // far because handleCredentialBind already undid the binding and
        // disabled the secret. This still catches drift — e.g. the disable
        // call above failed and the gate re-opened off a stale active
        // secret after a reload, the key was rotated bad after a successful
        // bind, or (the case this fresh-probe-forcing fix above closes) the
        // gate opened purely from an orphaned active company secret this
        // session never bound. Never hire against a credential the fresh
        // probe just told us the provider rejected.
        const rejection = findCredentialAuthFailureCheck(result);
        if (rejection) {
          // eslint-disable-next-line no-console
          console.log(
            "[onboarding] refusing to hire: the fresh environment probe reports the bound credential was rejected",
            rejection,
          );
          const adapterEnvKeys = (credentialSetup?.options ?? []).map((option) => option.envKey);
          const boundEnvKeysForAdapter = adapterEnvKeys.filter((envKey) =>
            Boolean(materializedBindings[envKey]),
          );
          // Disable only the ones we have a secretId for (a live or
          // just-materialized session binding, including the one we may
          // have just materialized above). A gate that's STILL open purely
          // via an orphaned active secret with no matching binding at all
          // would mean findMatchingCompanySecret found nothing to
          // materialize in the first place, so there is nothing left
          // un-disabled here.
          await Promise.all(
            boundEnvKeysForAdapter.map((envKey) => {
              const binding = materializedBindings[envKey];
              return binding
                ? disableRejectedCredentialSecret(binding.secretId, envKey)
                : Promise.resolve();
            }),
          );
          if (boundEnvKeysForAdapter.length > 0) {
            setCredentialBindings((prev) => {
              const next = { ...prev };
              for (const envKey of boundEnvKeysForAdapter) delete next[envKey];
              return next;
            });
          }
          // Mark EVERY envKey this adapter advertises as failed, not just
          // the ones with a live session binding, so the gate closes for
          // the rest of this session even in the orphaned-secret case above
          // (a later reload could still re-open it until that secret is
          // disabled some other way — see the report's concerns section).
          setFailedCredentialEnvKeys((prev) => {
            const next = new Set(prev);
            for (const envKey of adapterEnvKeys) {
              next.add(credentialFailureKey(adapterType, envKey));
            }
            return next;
          });
          setCredentialProbeError(credentialRejectionMessage(rejection));
          setError(credentialRejectionMessage(rejection));
          return;
        }
      }

      // `agentRole` always holds a value now (see its default), so this is a
      // type narrowing rather than a gate — but it stays, because a future
      // path that clears the role must not reach a hire that silently no-ops.
      if (!agentRole) return;

      const hire = await agentsApi.hire(createdCompanyId, {
        // The name is optional; an agent that reaches here without one is
        // named for the job it was hired to do rather than left blank.
        name: agentName.trim() || AGENT_ROLE_LABELS[agentRole],
        role: agentRole,
        adapterType,
        adapterConfig: mergeCredentialBindings(buildAdapterConfig(), materializedBindings, credentialSetup),
        runtimeConfig: buildNewAgentRuntimeConfig(),
        // The onboarding CEO's seed task is to hire the first engineer. Attach the
        // create-agent skill so its run session exposes the governance-aware hiring
        // flow (POST /api/companies/:id/agent-hires); without it the agent does not
        // know the sanctioned route and hits "Route not allowed" on guessed ones.
        desiredSkills: [ONBOARDING_CEO_SKILL_KEY],
      });
      if (hire.approval) {
        await approvalsApi.approve(
          hire.approval.id,
          "Approved during onboarding first-agent setup."
        );
        queryClient.invalidateQueries({
          queryKey: queryKeys.approvals.list(createdCompanyId)
        });
      }
      const agent = hire.agent;
      queryClient.invalidateQueries({
        queryKey: queryKeys.agents.list(createdCompanyId)
      });
      // Seed the CEO's agent instructions file so the agent always has
      // company context + a hiring-plan output format rule. Non-fatal on
      // failure — the agent can still function with adapter defaults.
      //
      // Before the ownership check below on purpose. This agent exists now,
      // and it needs its instructions whatever this wizard goes on to show.
      // Guarding server work rather than attribution would leave a hired agent
      // with adapter defaults because the customer changed pages.
      try {
        const bundle = await agentsApi.instructionsBundle(agent.id, createdCompanyId);
        await agentsApi.saveInstructionsFile(
          agent.id,
          {
            path: bundle.entryFile,
            content: composeCeoInstructions({
              companyName,
              companyGoal,
              growPath: onboardingPath === "grow",
              growWorkflows,
              growPainPoints,
              growAutomate,
              q1, q2, q3, q4,
            }),
          },
          createdCompanyId,
        );
      } catch (err) {
        console.warn("Failed to seed CEO instructions:", err);
      }

      if (!stillTheSameCompany(createdCompanyId)) return;
      setCreatedAgentId(agent.id);
      // Advance to the Review step — the lead is now online. The user drives
      // strategy + hiring from the planning chat after "Get started".
      setStep(5);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create agent");
    } finally {
      hiringAgentRef.current = false;
      setLoading(false);
    }
  }

  async function handleUnsetAnthropicApiKey() {
    if (!createdCompanyId || unsetAnthropicLoading) return;
    setUnsetAnthropicLoading(true);
    setError(null);
    setAdapterEnvError(null);
    setForceUnsetAnthropicApiKey(true);

    const configWithUnset = (() => {
      const config = buildAdapterConfig();
      const env =
        typeof config.env === "object" &&
        config.env !== null &&
        !Array.isArray(config.env)
          ? { ...(config.env as Record<string, unknown>) }
          : {};
      env.ANTHROPIC_API_KEY = { type: "plain", value: "" };
      config.env = env;
      return config;
    })();

    try {
      if (createdAgentId) {
        await agentsApi.update(
          createdAgentId,
          { adapterConfig: configWithUnset },
          createdCompanyId
        );
        queryClient.invalidateQueries({
          queryKey: queryKeys.agents.list(createdCompanyId)
        });
      }

      const result = await runAdapterEnvironmentTest(configWithUnset);
      if (result?.status === "fail") {
        setError(
          "Retried with ANTHROPIC_API_KEY unset in adapter config, but the environment test is still failing."
        );
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to unset ANTHROPIC_API_KEY and retry."
      );
    } finally {
      setUnsetAnthropicLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    // Something nearer the key already dealt with it. The company-name field
    // handles Enter itself and does not check for a modifier, so Cmd+Enter in
    // that field reaches both handlers — and both would start creating a
    // company. The `loading` guard below cannot catch that: `setLoading(true)`
    // has not landed while the same event is still bubbling, so the second
    // caller reads the value the first one has not written yet. Two companies,
    // one keystroke.
    if (e.defaultPrevented) return;
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      // Every button below is disabled while a request is in flight. The
      // keyboard has to honour the same rule, or a second Enter re-enters a
      // handler whose guard is a piece of state the first one has not set
      // yet — two goals for one mission, two agents for one hire.
      if (loading) return;
      if (step === 0) return; // front door requires click
      if (step === 1 && companyName.trim()) {
        if (skipsMissionStep) void handleCreateCompany();
        else setStep(2);
      }
      else if (step === 2 && companyName.trim() && companyGoal.trim()) handleConfirmMission();
      else if (step === 3 && agentName.trim()) setStep(4);
      else if (step === 4 && agentName.trim() && credentialConnected) handleGiveHeartbeat();
      else if (step === 5) handleLaunchToDashboard();
    }
  }

  if (!effectiveOnboardingOpen) return null;

  // The arc strip stands in for the full-length bar only when the run began on
  // the arc — the Cloud-first path, where the company already exists and steps
  // 1-2 never happen. A run that started at step 1 keeps one continuous count.
  // Step 2 is two different screens wearing one number: the grow path's "tell us
  // about your team" questionnaire, and the create path's mission step.
  // Onboarding stopped asking for the mission, but the questionnaire is still
  // how a grow run describes the team it is levelling up — its answers seed the
  // lead agent — so only the create path skips ahead.
  const skipsMissionStep = onboardingPath !== "grow";

  // Back lands on whatever came before this step *for this run*, which is not
  // always `step - 1`. A create run went 1 → 3, so stepping blindly would walk
  // it into the mission screen it never saw. Two runs still belong on step 2
  // going back: a grow run, whose step 2 is the questionnaire rather than the
  // mission, and a run that *entered* on the mission step because something
  // opened it there — it has seen that screen, so Back owes it the way back.
  function backStepFrom(current: Step): Step {
    if (current === 3 && skipsMissionStep && entryStep !== 2) return 1;
    return (current - 1) as Step;
  }

  const isAgentArcStep = agentArcStepFor(step) !== null;
  /**
   * True when the organization was named in Cloud rather than here.
   *
   * `enableManagedSandboxOnly` is the cloud-tenant shape — the connect step
   * already resolves its login environment through it. A tenant wearing it did
   * not ask for the organization's name, because Cloud did, so the walk the
   * customer is on is four steps and this is the second.
   *
   * A self-hosted run that enters at the agent step is a different case with
   * the same `entryStep`: an existing company that has no agents yet. There was
   * no naming screen before it, so its walk really is three, and it keeps the
   * shorter strip.
   */
  const enteredFromCloud = experimentalSettingsForLogin?.enableManagedSandboxOnly === true;
  const showsAgentArcStepper = isAgentArcStep && entryStep >= 3 && !enteredFromCloud;

  const launchStateIncomplete = step === 5 && (!createdCompanyId || !createdAgentId);
  const visibleError = error ?? (launchStateIncomplete ? INCOMPLETE_ONBOARDING_STATE_MESSAGE : null);

  return (
    <Dialog
      open={effectiveOnboardingOpen}
      onOpenChange={(open) => {
        if (!open) {
          handleClose();
        }
      }}
    >
      <DialogPortal>
        {/* Plain div instead of DialogOverlay — Radix's overlay wraps in
            RemoveScroll which blocks wheel events on our custom (non-DialogContent)
            scroll container. A plain div preserves the background without scroll-locking. */}
        <div className="fixed inset-0 z-50 bg-background" />
        <div className="fixed inset-0 z-50 flex" data-surface="onboarding" onKeyDown={handleKeyDown}>
          {/* Close button */}
          <button
            onClick={handleClose}
            className="absolute top-4 left-4 z-10 rounded-sm p-1.5 text-muted-foreground/60 hover:text-foreground transition-colors"
          >
            <X className="h-5 w-5" />
            <span className="sr-only">Close</span>
          </button>

          {/* Step 0: Front Door — full-screen choice */}
          {step === 0 && (
            <div className="w-full flex flex-col overflow-y-auto">
              <FrontDoor onChoose={(path) => {
                setOnboardingPath(path);
                setStep(1);
              }} />
            </div>
          )}

          {/* Left half — form (steps 1+) */}
          {step !== 0 && (
          <div
            className={cn(
              "w-full flex flex-col overflow-y-auto transition-(--tp-width) duration-500 ease-in-out",
              step === 2 ? "md:w-1/2" : "md:w-full"
            )}
          >
            <div
              className={cn(
                // my-auto, not items-center on the column: they look identical
                // until a step is taller than the window, where centring by
                // alignment overflows in both directions and the top cannot be
                // scrolled to. Auto margins collapse to zero with no free space.
                "mx-auto my-auto shrink-0",
                // No card. The steps sit on the page ground rather than in a
                // bordered, filled frame — the frame was drawing a box around
                // content that is already the only thing on screen, and its
                // edge competed with the tiles' own strokes. The two branches
                // now differ only in measure. One element styled two ways, not
                // two wrappers, so the step content below renders exactly once.
                // Step 1 takes the arc's measure too. Its footer is now the
                // same pair, and a pair styled identically but sitting 96px
                // narrower than the next screen's makes the whole frame jump on
                // Continue — which is the thing that read as "off" to begin
                // with, and is more obvious once the buttons match.
                // 68px sides, so the column inside the 560px frame is 424px —
                // the measure the design draws every arc step to. It was 40px
                // (a 480px column), which is wide enough that the two model
                // tiles stretch and the name field sits under a question far
                // narrower than itself.
                isAgentArcStep || step === 1
                  ? "w-(--sz-560px) max-w-full px-8 py-10 sm:px-(--sz-68px) sm:py-11"
                  : "w-full max-w-md px-8 py-12",
              )}
            >
              {/* Full-length progress bar (brand .wsteps/.wstep) — segment N
                  filled once step ≥ N. Completed segments jump back.
                  Hidden for a run that entered on the agent arc: the arc strip
                  below counts that run's three steps, and showing both put two
                  progress bars on the same screen. A run that started at step 1
                  keeps this one throughout, so its count never restarts.

                  Step 2 is absent: onboarding no longer asks for the mission, so
                  a segment for it would be one the run can never fill, and the
                  count would visibly skip from 1 to 3. */}
              {!showsAgentArcStepper && (
                <Stepper
                  step={onboardingStepPositionFor(step)}
                  total={ONBOARDING_WIZARD_STEPS.length}
                  labels={ONBOARDING_STEP_LABELS}
                  canJumpToStep={(target) =>
                    canJumpToOnboardingStep({
                      targetStep: ONBOARDING_WIZARD_STEPS[target - 1]!,
                      currentStep: step,
                      entryStep,
                    })
                  }
                  onJumpToStep={(target) =>
                    setStep(ONBOARDING_WIZARD_STEPS[target - 1]! as Step)
                  }
                />
              )}

              {/* The agent arc's progress strip. Numbered 1–3 over the wizard's
                  steps 3–5, because company creation already happened in Cloud
                  and the mission step is skipped when it did. */}
              {showsAgentArcStepper && (
                <Stepper
                  step={agentArcStepFor(step)!}
                  canJumpToStep={(target) =>
                    canJumpToOnboardingStep({
                      targetStep: AGENT_ARC_WIZARD_STEPS[target - 1]!,
                      currentStep: step,
                      entryStep,
                    })
                  }
                  onJumpToStep={(target) => setStep(AGENT_ARC_WIZARD_STEPS[target - 1]! as Step)}
                />
              )}

              {/* The hero, above the heading: one PillGuy held in the same tree
                  slot across steps 3–5, so React reuses the DOM node and moving
                  between steps never replays the entrance. It is dormant while
                  the agent is being specified and wakes on Review. */}
              {step >= 3 && step <= 5 && (
                // reducedMotion="user" defers to the OS setting, so the hero
                // arrives in place for anyone who asked for less movement. The
                // token layer zeroes the CSS durations; this covers the JS half.
                <MotionConfig reducedMotion="user">
                  {/* mb-6 continues the prototype's single rhythm past this
                      block: it groups the hero and heading, and the step's own
                      controls sit a step below on the same spacing. */}
                  {/* The gap under the agent — its name to the step's title —
                      is tighter than the step's other rows on purpose. The name
                      labels the character directly above it, so the two read as
                      one object; at the full row rhythm the name floated between
                      the character and the title and belonged to neither. 24px
                      against the 36px used elsewhere, a little over a third
                      less. `mb-9` still holds the block off the step content. */}
                  <div className="mb-9 space-y-6">
                    <motion.div
                      initial={capsuleHeroMotion.initial}
                      animate={capsuleHeroMotion.animate}
                      transition={capsuleHeroMotion.transition}
                      className="flex flex-col items-center gap-2"
                    >
                      {/* Dormant until the agent is actually hired. Review is
                          the first step where one exists, so that is where it
                          wakes — the arc's payoff, not a flourish along it. */}
                      {/* `relative` is load-bearing: the sleep marks anchor
                          to this box and travel out past its top-right
                          corner. */}
                      <div className="relative size-(--sz-72px)">
                        <PillGuy
                          state={step === 5 ? "alive" : "dormant"}
                          className="size-full"
                        />
                        {/* Only while it is actually asleep. A still grey
                            silhouette reads as a placeholder that failed to
                            load rather than as something waiting its turn. */}
                        {step < 5 && <SleepingZs />}
                      </div>
                      <AgentPreview agentName={agentName} agentRole="" />
                    </motion.div>

                    <OnboardingHeading
                      center
                      title={
                        step === 3
                          ? "Create your first agent"
                          : step === 4
                            ? "Connect a model"
                            : "Let's get started..."
                      }
                      // The agent step carries no lede, as the prototype has it:
                      // the capsule and the heading say what this is, and a
                      // sentence restating it only pushes the fields down.
                      lede={
                        step === 3 ? undefined : step === 4 ? (
                          <>Paperclip works with your subscription or API keys.</>
                        ) : (
                          <>{agentName.trim() || "Your first agent"} is ready to work!</>
                        )
                      }
                    />
                  </div>
                </MotionConfig>
              )}

              {/* Step content */}
              {step === 2 && onboardingPath === "grow" && (
                <div className="space-y-8">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="bg-muted/50 p-2">
                      <Sparkles className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <h3 className="font-medium">Tell us about your team</h3>
                      <p className="text-xs text-muted-foreground">
                        We'll use this to set up your lead agent and plan which agents to add.
                      </p>
                    </div>
                  </div>
                  <div className="group">
                    <label className="text-xs text-muted-foreground mb-1 block">What does your team work on?</label>
                    <input
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                      placeholder="e.g. We create educational YouTube content about AI"
                      value={q1}
                      onChange={(e) => setQ1(e.target.value)}
                    />
                  </div>
                  <div className="group">
                    <label className="text-xs text-muted-foreground mb-1 block">What are your current workflows?</label>
                    <textarea
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 resize-none min-h-(--sz-60px)"
                      placeholder="e.g. Manual content creation, spreadsheet tracking, email outreach"
                      value={growWorkflows}
                      onChange={(e) => setGrowWorkflows(e.target.value)}
                    />
                  </div>
                  <div className="group">
                    <label className="text-xs text-muted-foreground mb-1 block">What pain points would you solve with AI?</label>
                    <textarea
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 resize-none min-h-(--sz-60px)"
                      placeholder="e.g. Can't produce content fast enough, no time for social media"
                      value={growPainPoints}
                      onChange={(e) => setGrowPainPoints(e.target.value)}
                    />
                  </div>
                  <div className="group">
                    <label className="text-xs text-muted-foreground mb-1 block">What would you automate first?</label>
                    <input
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                      placeholder="e.g. Social media scheduling and content repurposing"
                      value={growAutomate}
                      onChange={(e) => setGrowAutomate(e.target.value)}
                    />
                  </div>
                  {companyName.trim() && q1.trim() && (
                    <>
                      {!companyGoal.trim() && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            const parts = [q1.trim()];
                            if (growPainPoints.trim()) parts.push(`Key challenge: ${growPainPoints.trim()}`);
                            if (growAutomate.trim()) parts.push(`First priority: automate ${growAutomate.trim().toLowerCase()}`);
                            setCompanyGoal(parts.join(". "));
                          }}
                        >
                          Generate mission from answers
                        </Button>
                      )}
                      {companyGoal.trim() && (
                        <div className="group">
                          <label className="text-xs text-foreground mb-1 block">Generated mission — edit however you like:</label>
                          <textarea
                            className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 resize-none min-h-(--sz-60px)"
                            value={companyGoal}
                            onChange={(e) => setCompanyGoal(e.target.value)}
                          />
                        </div>
                      )}
                    </>
                  )}
                  <button
                    className="text-(length:--text-micro) text-muted-foreground hover:text-foreground transition-colors"
                    onClick={() => { setOnboardingPath(null); setStep(0); }}
                  >
                    ← Back to start
                  </button>
                </div>
              )}

              {/* Step 1: name the organization (both paths).
                  Dressed as the arc steps that follow it — centred heading, no
                  lede, and the same footer pair — because a customer walks
                  straight from here into them, and one screen reading as a
                  different product is more jarring than this one no longer
                  matching the funnel's naming screen exactly. The question
                  itself is still the funnel's, so the ask has not changed.

                  The lede went because it said what the field already says: a
                  labelled "Name" under "What is the name of your organization?"
                  does not need a sentence explaining that it names the
                  organization. */}
              {step === 1 && (
                <div className="mx-auto w-full space-y-9">
                  <OnboardingHeading
                    center
                    title="What is the name of your organization?"
                  />
                  {/* The field takes the agent step's measure rather than the
                      column's, so the two questions the wizard asks — name the
                      organization, name the agent — present the same target.
                      The heading stays full width above it, as it does there. */}
                  <div className="group mx-auto w-full max-w-(--sz-320px)">
                    <label
                      className={cn(
                        "text-xs mb-1 block transition-colors",
                        companyName.trim()
                          ? "text-foreground"
                          : "text-muted-foreground group-focus-within:text-foreground"
                      )}
                    >
                      Name
                    </label>
                    <input
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                      placeholder="Name your company"
                      value={companyName}
                      onChange={(e) => setCompanyName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && companyName.trim()) {
                          e.preventDefault();
                          if (skipsMissionStep) void handleCreateCompany();
                          else setStep(2);
                        }
                      }}
                      autoFocus
                    />
                  </div>
                </div>
              )}

              {/* Step 2: Define your mission */}
              {step === 2 && onboardingPath !== "grow" && (
                <div className="space-y-8">
                  <div className="flex items-center gap-3 mb-1">
                    <div className="bg-muted/50 p-2">
                      <Building2 className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <h3 className="font-medium">Define your mission</h3>
                      <p className="text-xs text-muted-foreground">
                        Your mission guides everything — your lead agent, who you bring on, and the work <strong>{companyName}</strong> takes on.
                      </p>
                    </div>
                  </div>

                  {/* Mission path selector */}
                  <div className="space-y-3 pt-3">
                    <label className="text-xs text-foreground block">
                      How would you like to define your mission?
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        className={cn(
                          "flex flex-col items-center gap-1.5 rounded-md border p-3 text-xs transition-colors",
                          missionPath === "direct"
                            ? "border-foreground bg-accent/50"
                            : "border-border hover:bg-accent/50"
                        )}
                        onClick={() => setMissionPath("direct")}
                      >
                        <Sparkles className="h-4 w-4" />
                        <span className="font-medium">I know my mission</span>
                        <span className="text-muted-foreground text-(length:--text-nano)">
                          Type it directly
                        </span>
                      </button>
                      <button
                        className={cn(
                          "flex flex-col items-center gap-1.5 rounded-md border p-3 text-xs transition-colors",
                          missionPath === "questionnaire"
                            ? "border-foreground bg-accent/50"
                            : "border-border hover:bg-accent/50"
                        )}
                        onClick={() => setMissionPath("questionnaire")}
                      >
                        <ListTodo className="h-4 w-4" />
                        <span className="font-medium">Help me figure it out</span>
                        <span className="text-muted-foreground text-(length:--text-nano)">
                          Answer a few questions
                        </span>
                      </button>
                    </div>
                  </div>

                  {/* Direct mission input */}
                  {missionPath === "direct" && (
                    <div className="space-y-3 animate-in fade-in duration-200">
                      <div className="group">
                        <label
                          className={cn(
                            "text-xs mb-1 block transition-colors",
                            companyGoal.trim()
                              ? "text-foreground"
                              : "text-muted-foreground group-focus-within:text-foreground"
                          )}
                        >
                          Mission
                        </label>
                        <textarea
                          className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 resize-none min-h-(--sz-60px)"
                          placeholder="What is your team trying to achieve?"
                          value={companyGoal}
                          onChange={(e) => setCompanyGoal(e.target.value)}
                          autoFocus
                        />
                      </div>
                      {/* Prompt chips for inspiration */}
                      <div className="flex flex-wrap gap-1.5">
                        {MISSION_PROMPT_CHIPS.map((chip) => (
                          <button
                            key={chip}
                            className={cn(
                              "rounded-full border px-2.5 py-1 text-(length:--text-micro) transition-colors",
                              companyGoal === chip
                                ? "border-foreground bg-accent text-foreground"
                                : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/50"
                            )}
                            onClick={() => setCompanyGoal(chip)}
                          >
                            {chip}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Questionnaire path */}
                  {missionPath === "questionnaire" && !missionConfirmed && (
                    <div className="space-y-3 animate-in fade-in duration-200">
                      <div className="group">
                        <label className="text-xs text-muted-foreground mb-1 block">
                          What does your team work on?
                        </label>
                        <input
                          className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                          placeholder="e.g. We create educational YouTube content about AI"
                          value={q1}
                          onChange={(e) => setQ1(e.target.value)}
                          autoFocus
                        />
                      </div>
                      <div className="group">
                        <label className="text-xs text-muted-foreground mb-1 block">
                          Who do you serve?
                        </label>
                        <input
                          className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                          placeholder="e.g. Non-technical professionals curious about AI tools"
                          value={q2}
                          onChange={(e) => setQ2(e.target.value)}
                        />
                      </div>
                      <div className="group">
                        <label className="text-xs text-muted-foreground mb-1 block">
                          What's your biggest bottleneck right now?
                        </label>
                        <input
                          className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                          placeholder="e.g. Can't produce content fast enough across multiple channels"
                          value={q3}
                          onChange={(e) => setQ3(e.target.value)}
                        />
                      </div>
                      <div className="group">
                        <label className="text-xs text-muted-foreground mb-1 block">
                          What would success look like in 6 months?
                        </label>
                        <input
                          className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                          placeholder="e.g. Publishing daily content across 4 platforms with a team of AI agents"
                          value={q4}
                          onChange={(e) => setQ4(e.target.value)}
                        />
                      </div>
                      {q1.trim() && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setCompanyGoal(buildMissionFromQuestionnaire(q1, q2, q3, q4));
                            setMissionConfirmed(true);
                          }}
                        >
                          Generate my mission
                        </Button>
                      )}
                    </div>
                  )}

                  {/* Questionnaire result — editable mission */}
                  {missionPath === "questionnaire" && missionConfirmed && (
                    <div className="space-y-3 animate-in fade-in duration-200">
                      <div className="group">
                        <label className="text-xs text-foreground mb-1 block">
                          Here's your draft mission — edit it however you like:
                        </label>
                        <textarea
                          className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 resize-none min-h-(--sz-80px)"
                          value={companyGoal}
                          onChange={(e) => setCompanyGoal(e.target.value)}
                          autoFocus
                        />
                      </div>
                      <button
                        className="text-(length:--text-micro) text-muted-foreground hover:text-foreground transition-colors"
                        onClick={() => { setMissionConfirmed(false); setCompanyGoal(""); }}
                      >
                        ← Back to questions
                      </button>
                    </div>
                  )}

                  {/* Confirm mission note */}
                  {companyGoal.trim() && (
                    <p className="text-(length:--text-micro) text-muted-foreground italic">
                      You can always change your mission later in settings.
                    </p>
                  )}
                </div>
              )}

              {/* Step 3: the name, and only the name. The role picker went with
                  the question it was asking — a customer naming their first
                  agent is describing what it does, and the placeholder carries
                  the range of answers that fit. Hiring uses the neutral
                  `general` role; a specific one can be set later, where there
                  is context to choose it in. */}
              {step === 3 && (
                <div className="mx-auto flex w-full flex-col gap-9">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="onboarding-agent-name">Agent name</Label>
                    {/*
                      Filled, not outlined, and the column's full width — the
                      same field the naming step before the hand-off draws.
                      `bg-muted` is the design's field surface; the default
                      Input is a hairline border over `bg-input/30`, which on
                      this ground reads as an empty outline rather than a place
                      to type. The border is kept but made transparent so the
                      focus ring, which colours the border, still has one.
                    */}
                    <Input
                      id="onboarding-agent-name"
                      className="h-(--sz-44px) rounded-lg border-transparent bg-muted shadow-none dark:bg-muted"
                      placeholder="e.g. Chief of staff, Designer, Ron..."
                      value={agentName}
                      onChange={(e) => setAgentName(e.target.value)}
                      autoFocus
                    />
                  </div>
                </div>
              )}

              {/* Step 4: Connect a model — adapter + model + env check (capsule above) */}
              {step === 4 && (
                <div className="space-y-8">
                  {/* The two cards are self-describing; an "Adapter type"
                      eyebrow above them named the mechanism rather than the
                      choice. */}
                  <div>
                    {/* The row is `ModelSourceTiles`, the same component the
                        connect-step prototype is drawn with, so the shipped step
                        and the design under review cannot drift apart.

                        Sources come from `recommendedAdapters`, not a list
                        written here. That filter is `recommended` in the display
                        registry, which today means Claude Code and Codex and
                        nothing else — so the row stays two tiles because the
                        registry says so, and a third would appear here the day
                        someone marks one rather than the day someone remembers
                        to edit this file. */}
                    <ModelSourceTiles
                      label="Model source"
                      sources={recommendedAdapters.map((opt) => ({
                        id: opt.type,
                        label: opt.label,
                        icon: <ModelSourceMark type={opt.type} Fallback={opt.icon} />,
                      }))}
                      mode={credentialMode}
                      selectedId={
                        sourcePicked &&
                        recommendedAdapters.some((opt) => opt.type === adapterType)
                          ? adapterType
                          : null
                      }
                      onSelect={(id) => {
                        setSourcePicked(true);
                        setAdapterType(id);
                        if (id === "codex_local") return;
                        if (id === "opencode_local") {
                          setModel(DEFAULT_OPENCODE_LOCAL_MODEL);
                          return;
                        }
                        setModel("");
                      }}
                    />

                    {/* The credential switch stands where the adapter
                        disclosure used to. That disclosure existed to reach the
                        adapters this step does not offer, and with the row down
                        to the two that are supported it was a control whose
                        whole contents were out of scope. The question actually
                        left on this step is how the two are authenticated, so
                        that is what the line asks.

                        It names the destination rather than the state, which is
                        what a sentence has to do where a checkbox does not —
                        and it is only readable because the tiles' own tags,
                        directly above, say where you are. */}
                    <div className="-ml-3 mt-1">
                      <CredentialModeLink
                        mode={credentialMode}
                        onChange={setCredentialMode}
                      />
                    </div>

                  </div>

                  {/* One canvas under the tiles, holding whatever the current
                      choice needs: a browser-code login for Claude, a
                      displayed-code login for Codex, or a key field for either
                      when the mode is keys. Four inputs, one place — so the
                      Connect button below does not move every time the answer
                      changes.

                      Closed until a source is picked. `contentKey` is the
                      source and the mode together, because either one changing
                      means a different input, and that is what the canvas
                      swaps on. */}
                  <ConnectInputCanvas
                    open={canvasOpen}
                    contentKey={`${adapterType}:${credentialMode}`}
                  >
                    {credentialMode === "api" ? (
                      <ApiKeyField
                        envKey={apiKeyEnvKeyFor(adapterType)}
                        value={apiKey}
                        onChange={setApiKey}
                      />
                    ) : showAdapterLoginPanel &&
                      createdCompanyId &&
                      resolvedLoginEnvironmentId ? (
                      /* Shows as soon as the cheap auth signal reports no ready
                         credential, well before any adapter environment test
                         runs. Reuses the same panel the agent configuration
                         form shows after a test — see AdapterLoginPanel in
                         AgentConfigForm.tsx. No "Use saved login" control: the
                         hire step already applies a stored login on its own. */
                      <AdapterLoginPanel
                        key={`${adapterType}:${resolvedLoginEnvironmentId}`}
                        companyId={createdCompanyId}
                        adapterType={adapterType}
                        environmentId={resolvedLoginEnvironmentId}
                        onStored={() => {
                          queryClient.invalidateQueries({
                            queryKey: queryKeys.agents.authSignal(
                              createdCompanyId,
                              adapterType,
                              resolvedLoginEnvironmentId,
                            ),
                          });
                        }}
                      />
                    ) : (
                      /* No panel to show, and the two reasons for that are not
                         the same news. Saying either is better than an empty
                         card — the canvas is open because a source is selected,
                         and a blank one reads as something that failed to load —
                         but they must not be conflated: telling someone with no
                         sandbox that they are "already signed in" on it is
                         false, and it hides the one thing actually blocking
                         them. */
                      <p className="text-xs text-muted-foreground">
                        {authSignalUndecided
                          ? "Checking this source's credentials…"
                          : canShowAdapterLogin
                            ? "This source is already signed in on the managed sandbox."
                            : "No managed sandbox is available to sign in against yet."}
                      </p>
                    )}
                  </ConnectInputCanvas>

                  {/* Conditional adapter fields */}
                  {isLocalAdapter && (
                    <div className="space-y-3">
                      <div>
                        <label className="text-xs text-muted-foreground mb-1 block">
                          Model
                        </label>
                        <Popover
                          open={modelOpen}
                          onOpenChange={(next) => {
                            setModelOpen(next);
                            if (!next) setModelSearch("");
                          }}
                        >
                          <PopoverTrigger asChild>
                            <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-accent/50 transition-colors w-full justify-between">
                              <span
                                className={cn(
                                  !model && "text-muted-foreground"
                                )}
                              >
                                {selectedModel
                                  ? selectedModel.label
                                  : model ||
                                    (adapterType === "opencode_local"
                                      ? "Select model (required)"
                                      : "Default")}
                              </span>
                              <ChevronDown className="h-3 w-3 text-muted-foreground" />
                            </button>
                          </PopoverTrigger>
                          <PopoverContent
                            className="w-(--radix-popover-trigger-width) p-1"
                            align="start"
                          >
                            <input
                              className="w-full px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border mb-1 placeholder:text-muted-foreground/50"
                              placeholder="Search models..."
                              value={modelSearch}
                              onChange={(e) => setModelSearch(e.target.value)}
                              autoFocus
                            />
                            {adapterType !== "opencode_local" && (
                              <button
                                className={cn(
                                  "flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50",
                                  !model && "bg-accent"
                                )}
                                onClick={() => {
                                  setModel("");
                                  setModelOpen(false);
                                }}
                              >
                                Default
                              </button>
                            )}
                            <div className="max-h-(--sz-240px) overflow-y-auto">
                              {groupedModels.map((group) => (
                                <div
                                  key={group.provider}
                                  className="mb-1 last:mb-0"
                                >
                                  {adapterType === "opencode_local" && (
                                    <div className="px-2 py-1 text-(length:--text-nano) uppercase tracking-wide text-muted-foreground">
                                      {group.provider} ({group.entries.length})
                                    </div>
                                  )}
                                  {group.entries.map((m) => (
                                    <button
                                      key={m.id}
                                      className={cn(
                                        "flex items-center w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50",
                                        m.id === model && "bg-accent"
                                      )}
                                      onClick={() => {
                                        setModel(m.id);
                                        setModelOpen(false);
                                      }}
                                    >
                                      <span
                                        className="block w-full text-left truncate"
                                        title={m.id}
                                      >
                                        {adapterType === "opencode_local"
                                          ? extractModelName(m.id)
                                          : m.label}
                                      </span>
                                    </button>
                                  ))}
                                </div>
                              ))}
                            </div>
                            {filteredModels.length === 0 && (
                              <p className="px-2 py-1.5 text-xs text-muted-foreground">
                                No models discovered.
                              </p>
                            )}
                          </PopoverContent>
                        </Popover>
                      </div>
                    </div>
                  )}

                  {credentialSetup && createdCompanyId && (
                    <AdapterCredentialConnect
                      key={adapterType}
                      companyId={createdCompanyId}
                      adapterType={adapterType}
                      setup={credentialSetup}
                      boundEnvKeys={Object.keys(credentialBindings)}
                      onBind={handleCredentialBind}
                      externalError={credentialCardError}
                    />
                  )}

                  {isLocalAdapter && (
                    <div className="space-y-2 rounded-md border border-border p-3">
                      {adapterEnvError && (
                        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-(length:--text-micro) text-destructive">
                          {adapterEnvError}
                        </div>
                      )}

                      {adapterEnvResult && adapterEnvResult.status === "pass" ? (
                        <>
                          <div className="flex items-center gap-2 rounded-md border border-green-300 dark:border-green-500/40 bg-green-50 dark:bg-green-500/10 px-3 py-2 text-xs text-green-700 dark:text-green-300 animate-in fade-in slide-in-from-bottom-1 duration-300">
                            <Check className="h-3.5 w-3.5 shrink-0" />
                            <span className="font-medium">Passed</span>
                          </div>
                          {adapterEnvResult.checks.some(
                            (check) => check.level === "warn"
                          ) && (
                            <div className="rounded-md border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10 px-2.5 py-2 text-(length:--text-micro) text-amber-700 dark:text-amber-300 space-y-1">
                              {adapterEnvResult.checks
                                .filter((check) => check.level === "warn")
                                .map((check, idx) => (
                                  <AdapterEnvironmentCheckRow
                                    key={`${check.code}-${idx}`}
                                    check={check}
                                  />
                                ))}
                            </div>
                          )}
                        </>
                      ) : adapterEnvResult ? (
                        <AdapterEnvironmentResult result={adapterEnvResult} />
                      ) : null}

                      {shouldSuggestUnsetAnthropicApiKey && (
                        <div className="rounded-md border border-amber-300/60 bg-amber-50/40 px-2.5 py-2 space-y-2">
                          <p className="text-(length:--text-micro) text-amber-900/90 leading-relaxed">
                            Claude failed while{" "}
                            <span className="font-mono">ANTHROPIC_API_KEY</span>{" "}
                            is set. You can clear it in this adapter config
                            and retry the probe.
                          </p>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2.5 text-xs"
                            disabled={
                              adapterEnvLoading || unsetAnthropicLoading
                            }
                            onClick={() => void handleUnsetAnthropicApiKey()}
                          >
                            {unsetAnthropicLoading
                              ? "Retrying..."
                              : "Unset ANTHROPIC_API_KEY"}
                          </Button>
                        </div>
                      )}

                      {adapterEnvResult && adapterEnvResult.status === "fail" && (
                        <div className="rounded-md border border-border/70 bg-muted/20 px-2.5 py-2 text-(length:--text-micro) space-y-1.5">
                          <p className="font-medium">Manual debug</p>
                          <p className="text-muted-foreground font-mono break-all">
                            {adapterType === "cursor"
                              ? `${effectiveAdapterCommand} -p --mode ask --output-format json \"Respond with hello.\"`
                              : adapterType === "codex_local"
                              ? `${effectiveAdapterCommand} exec --json -`
                              : adapterType === "gemini_local"
                                ? `${effectiveAdapterCommand} --output-format json "Respond with hello."`
                              : adapterType === "kimi_local"
                                ? `${effectiveAdapterCommand} -p "Respond with hello." --output-format stream-json`
                              : adapterType === "opencode_local"
                                ? `${effectiveAdapterCommand} run --format json "Respond with hello."`
                              : `${effectiveAdapterCommand} --print - --output-format stream-json --verbose`}
                          </p>
                          <p className="text-muted-foreground">
                            Prompt:{" "}
                            <span className="font-mono">Respond with hello.</span>
                          </p>
                          {adapterType === "cursor" ||
                          adapterType === "codex_local" ||
                          adapterType === "gemini_local" ||
                          adapterType === "kimi_local" ||
                          adapterType === "opencode_local" ? (
                            <p className="text-muted-foreground">
                              If auth fails, set{" "}
                              <span className="font-mono">
                                {adapterType === "cursor"
                                  ? "CURSOR_API_KEY"
                                  : adapterType === "gemini_local"
                                    ? "GEMINI_API_KEY"
                                    : adapterType === "kimi_local"
                                      ? "KIMI_MODEL_NAME + KIMI_MODEL_API_KEY"
                                    : "OPENAI_API_KEY"}
                              </span>{" "}
                              in env or run{" "}
                              <span className="font-mono">
                                {adapterType === "cursor"
                                  ? "agent login"
                                  : adapterType === "codex_local"
                                    ? "codex login"
                                    : adapterType === "gemini_local"
                                      ? "gemini auth"
                                      : adapterType === "kimi_local"
                                        ? "kimi login"
                                      : "opencode auth login"}
                              </span>
                              .
                            </p>
                          ) : (
                            <p className="text-muted-foreground">
                              If login is required, run{" "}
                              <span className="font-mono">claude login</span>{" "}
                              and retry.
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {(adapterType === "http" ||
                    adapterType === "openclaw_gateway") && (
                    <div>
                      <label className="text-xs text-muted-foreground mb-1 block">
                        {adapterType === "openclaw_gateway"
                          ? "Gateway URL"
                          : "Webhook URL"}
                      </label>
                      <input
                        className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm font-mono outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                        placeholder={
                          adapterType === "openclaw_gateway"
                            ? "ws://127.0.0.1:18789"
                            : "https://..."
                        }
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                      />
                    </div>
                  )}
                </div>
              )}

              {/* Step 5: Review — lead is online (shared capsule above) */}
              {/* Step 5: nothing. The heading names the agent and says it is
                  ready, and the pill above has just woken to show it — a
                  checklist restating those in three rows only asked the
                  customer to audit work they watched happen. */}

              {/* Error */}
              {visibleError && (
                <div className="mt-3">
                  <p className="text-xs text-destructive">
                    {visibleError}
                    {companyUpgradeRequired && (
                      <>
                        {" "}
                        {/* Explicit non-destructive color: the surrounding error
                            paragraph is text-destructive, but this is a normal
                            navigation link, not a danger action (mirrors
                            NewCompanyDialog's muted-not-red Subscribe link). */}
                        <a href="/account" className="font-medium text-foreground underline">
                          Subscribe
                        </a>
                      </>
                    )}
                    {companySlotRequired && (
                      <>
                        {" "}
                        {/* Same non-destructive link treatment: buying another
                            company slot is a normal navigation, not a danger
                            action (mirrors NewCompanyDialog's slot-required
                            prompt). */}
                        <a
                          href="/subscribe?add=company"
                          className="font-medium text-foreground underline"
                        >
                          Add a company slot
                        </a>
                      </>
                    )}
                  </p>
                </div>
              )}

              {/* Step 1 shares the arc's footer so the pair keeps its shape and
                  position from the first screen onward. Its Back is the only one
                  that leaves the wizard's steps rather than walking them: step 1
                  is where a company is named, and behind it is the path chooser,
                  so `canGoBackFromOnboardingStep` — which bounds a run to the
                  steps it entered on — does not decide this one. */}
              {(isAgentArcStep || step === 1) && (
                <FooterNav
                  onBack={
                    step === 1
                      ? () => {
                          setOnboardingPath(null);
                          setStep(0);
                        }
                      : canGoBackFromOnboardingStep({ currentStep: step, entryStep })
                        ? () => setStep(backStepFrom(step))
                        : undefined
                  }
                  // The prototype's cloud flow hires on this step and calls the
                  // action "Create". Here the model step sits between, so this
                  // one advances — which is exactly the distinction the
                  // prototype's own local flow draws with "Next".
                  primaryLabel={
                    step === 1
                      ? "Continue"
                      : step === 5
                        ? "Get started"
                        : "Next"
                  }
                  loadingLabel={
                    step === 1
                      ? "Creating..."
                      : step === 4
                        ? "Connecting..."
                        : "Launching..."
                  }
                  loading={step === 3 ? false : loading}
                  primaryDisabled={
                    step === 1
                      ? !companyName.trim() || loading
                      : step === 3
                        ? !agentName.trim()
                        : step === 4
                          ? // Nothing is chosen on arrival, so the step cannot
                            // advance until something is. Without this a customer
                            // could pass the model step having touched none of
                            // it, and be hired against whatever the draft
                            // happened to carry. See `connectStepReady`, which
                            // Cmd+Enter asks as well.
                            !connectStepReady || loading
                          : loading || launchStateIncomplete
                  }
                  onPrimary={() => {
                    if (step === 1) {
                      if (skipsMissionStep) void handleCreateCompany();
                      else setStep(2);
                    } else if (step === 3) setStep(4);
                    else if (step === 4) handleGiveHeartbeat();
                    else handleLaunchToDashboard();
                  }}
                />
              )}

              {/* Footer navigation for the steps that still use the old pair. */}
              {!isAgentArcStep && step !== 1 && (
              <div className="flex items-center justify-between mt-8">
                <div>
                  {step > 1 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setStep(backStepFrom(step))}
                      disabled={loading}
                    >
                      <ArrowLeft className="h-3.5 w-3.5 mr-1" />
                      Back
                    </Button>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {step === 2 && (
                    <Button
                      size="sm"
                      disabled={(!companyName.trim() && !createdCompanyId) || !companyGoal.trim() || loading}
                      onClick={handleConfirmMission}
                    >
                      {loading ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <ArrowRight className="h-3.5 w-3.5 mr-1" />
                      )}
                      {loading ? "Creating..." : "Confirm mission"}
                    </Button>
                  )}
                  {step === 3 && (
                    <Button
                      size="sm"
                      disabled={!agentName.trim()}
                      onClick={() => setStep(4)}
                    >
                      Next
                      <ArrowRight className="h-3.5 w-3.5 ml-1" />
                    </Button>
                  )}
                  {step === 4 && (
                    <Button
                      size="sm"
                      disabled={
                        !agentName.trim() ||
                        loading ||
                        adapterEnvLoading ||
                        (requiresCredential && !credentialConnected)
                      }
                      onClick={handleGiveHeartbeat}
                    >
                      {loading ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <ArrowRight className="h-3.5 w-3.5 mr-1" />
                      )}
                      {loading ? "Connecting..." : "Connect"}
                    </Button>
                  )}
                  {step === 5 && (
                    <Button
                      size="sm"
                      onClick={handleLaunchToDashboard}
                      disabled={loading || launchStateIncomplete}
                    >
                      {loading ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                      ) : (
                        <ArrowRight className="h-3.5 w-3.5 mr-1" />
                      )}
                      {loading ? "Launching..." : "Get started"}
                    </Button>
                  )}
                </div>
              </div>
              )}
            </div>
          </div>
          )}

          {/* Right half — ASCII art (hidden on mobile, only for the team
              name + mission steps) */}
          <div
            className={cn(
              "hidden md:block overflow-hidden bg-muted text-muted-foreground transition-(--tp-width-opacity) duration-500 ease-in-out",
              step === 2 ? "w-1/2 opacity-100" : "w-0 opacity-0"
            )}
          >
            <AsciiArtAnimation />
          </div>
        </div>
      </DialogPortal>
    </Dialog>
  );
}

function AdapterEnvironmentResult({
  result
}: {
  result: AdapterEnvironmentTestResult;
}) {
  const statusLabel =
    result.status === "pass"
      ? "Passed"
      : result.status === "warn"
      ? "Warnings"
      : "Failed";
  const statusClass =
    result.status === "pass"
      ? "text-green-700 dark:text-green-300 border-green-300 dark:border-green-500/40 bg-green-50 dark:bg-green-500/10"
      : result.status === "warn"
      ? "text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10"
      : "text-red-700 dark:text-red-300 border-red-300 dark:border-red-500/40 bg-red-50 dark:bg-red-500/10";

  return (
    <div className={`rounded-md border px-2.5 py-2 text-(length:--text-micro) ${statusClass}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{statusLabel}</span>
        <span className="opacity-80">
          {new Date(result.testedAt).toLocaleTimeString()}
        </span>
      </div>
      <div className="mt-1.5 space-y-1">
        {result.checks.map((check, idx) => (
          <AdapterEnvironmentCheckRow
            key={`${check.code}-${idx}`}
            check={check}
          />
        ))}
      </div>
    </div>
  );
}

function AdapterEnvironmentCheckRow({
  check
}: {
  check: AdapterEnvironmentCheck;
}) {
  return (
    <div className="leading-relaxed break-words">
      <span className="font-medium uppercase tracking-wide opacity-80">
        {check.level}
      </span>
      <span className="mx-1 opacity-60">·</span>
      <span>{check.message}</span>
      {check.detail && (
        <span className="block opacity-75 break-all">
          ({check.detail})
        </span>
      )}
      {check.hint && (
        <span className="block opacity-90 break-words">
          Hint: {check.hint}
        </span>
      )}
    </div>
  );
}

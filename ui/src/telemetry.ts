/**
 * Cloud-overlay UI telemetry (paperclip.inc hosted layer only).
 *
 * Dependency-free interaction tracker for the fork's cloud surfaces
 * (onboarding wizard, credential connect, billing/trial gates). Batches
 * events to POST /api/telemetry/ui, which only exists behind the paperclip.inc
 * cloud gateway; in non-cloud installs `initTelemetry()` is a no-op (and the
 * endpoint would 404 anyway, which we silently ignore).
 *
 * Privacy rules (non-negotiable):
 * - NEVER capture input content or pixels. Paste events carry metadata only
 *   (lengths / whitespace booleans), and only for fields explicitly opted in
 *   via data-telemetry="sensitive".
 * - Only cloud-overlay surfaces are instrumented (via data-surface
 *   attributes); everything else falls into the generic "app" bucket with a
 *   short target id, never content.
 *
 * The tracker must never throw into app code: every listener body is wrapped
 * in try/catch and every network failure is swallowed.
 *
 * Events are also mirrored into PostHog (see ./analytics) so the funnel can be
 * followed across the marketing site and the app in one place. The first-party
 * ui_events pipeline stays the system of record; PostHog is the analysis view.
 */
import { captureAnalytics } from "./analytics";

const TELEMETRY_ENDPOINT = "/api/telemetry/ui";
const FLUSH_INTERVAL_MS = 5000;
const FLUSH_AT_EVENTS = 20;
/** Server-side batch cap; anything beyond this in one POST is dropped there. */
const MAX_BATCH_SIZE = 25;
const MAX_TARGET_LEN = 40;
const MAX_ERROR_TEXT_LEN = 200;

export type TelemetrySurface = "onboarding" | "credential_connect" | "billing" | "settings" | "app";
export type TelemetryEventType = "step" | "click" | "paste_meta" | "client_error" | "http_error";

const ALLOWED_SURFACES: ReadonlySet<string> = new Set([
  "onboarding",
  "credential_connect",
  "billing",
  "settings",
  "app",
]);

/** The server drops unknown meta keys; only ever send these. */
type TelemetryMeta = {
  step?: string | number;
  prev_step?: string | number;
  ms_on_step?: number;
  disabled?: boolean;
  len?: number;
  trimmed_len?: number;
  leading_ws?: boolean;
  trailing_ws?: boolean;
  has_newline?: boolean;
  valid?: boolean;
  message?: string;
  frame?: string;
  path?: string;
  status?: number;
  method?: string;
};

type TelemetryEvent = {
  surface: TelemetrySurface;
  eventType: TelemetryEventType;
  target?: string;
  meta?: TelemetryMeta;
  tsClient: number;
};

type TelemetryState = {
  initPromise: Promise<void> | null;
  installed: boolean;
  clientSession: string | null;
  queue: TelemetryEvent[];
  flushTimer: ReturnType<typeof setInterval> | null;
  /** Un-wrapped fetch, captured at install time, used for telemetry POSTs. */
  transportFetch: typeof fetch | null;
  wrappedFetch: typeof fetch | null;
  clickListener: ((event: MouseEvent) => void) | null;
  pasteListener: ((event: Event) => void) | null;
  errorListener: ((event: ErrorEvent) => void) | null;
  rejectionListener: ((event: PromiseRejectionEvent) => void) | null;
  pagehideListener: (() => void) | null;
};

const state: TelemetryState = {
  initPromise: null,
  installed: false,
  clientSession: null,
  queue: [],
  flushTimer: null,
  transportFetch: null,
  wrappedFetch: null,
  clickListener: null,
  pasteListener: null,
  errorListener: null,
  rejectionListener: null,
  pagehideListener: null,
};

function mintClientSession(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // fall through to the non-crypto fallback below
  }
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Stable click-target id. Priority: explicit data-track attribute > element
 * id > aria-label > trimmed textContent capped at 40 chars. Ancestors are
 * consulted (nearest first) because clicks usually land on inner spans/icons.
 */
export function deriveTargetId(target: Element): string {
  const tracked = target.closest("[data-track]");
  const trackAttr = tracked?.getAttribute("data-track")?.trim();
  if (trackAttr) return trackAttr.slice(0, MAX_TARGET_LEN);

  const withId = target.closest("[id]");
  if (withId?.id) return withId.id.slice(0, MAX_TARGET_LEN);

  const withAria = target.closest("[aria-label]");
  const aria = withAria?.getAttribute("aria-label")?.trim();
  if (aria) return aria.slice(0, MAX_TARGET_LEN);

  return (target.textContent ?? "").trim().slice(0, MAX_TARGET_LEN);
}

/** Nearest ancestor data-surface, validated against the server allowlist. */
export function deriveSurface(target: Element | null): TelemetrySurface {
  const surfaced = target?.closest("[data-surface]");
  const value = surfaced?.getAttribute("data-surface");
  if (value && ALLOWED_SURFACES.has(value)) return value as TelemetrySurface;
  return "app";
}

function deriveDisabled(target: Element): boolean {
  const actionable = target.closest("button,[role='button']") ?? target;
  for (const el of [target, actionable]) {
    if ((el as HTMLButtonElement).disabled === true) return true;
    if (el.getAttribute("aria-disabled") === "true") return true;
  }
  return false;
}

/** Replace uuid and all-digit path segments with ":id" so paths aggregate. */
export function templatePath(pathname: string): string {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return pathname
    .split("/")
    .map((segment) => (UUID_RE.test(segment) || /^\d+$/.test(segment) ? ":id" : segment))
    .join("/");
}

function truncate(value: unknown, max: number): string {
  return String(value ?? "").slice(0, max);
}

/** Top stack frame only (never the whole stack), truncated. */
function topStackFrame(stack: unknown): string | undefined {
  if (typeof stack !== "string" || !stack) return undefined;
  const frame = stack
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("at ") || line.includes("@"));
  return frame ? frame.slice(0, MAX_ERROR_TEXT_LEN) : undefined;
}

// Event types worth mirroring into PostHog for funnel analysis. "click" is
// deliberately excluded: PostHog autocaptures clicks already, so mirroring them
// would double-count every interaction. "paste_meta" is excluded because it
// exists to diagnose one specific credential-paste failure mode and has no
// place in a funnel.
const POSTHOG_MIRRORED_TYPES: ReadonlySet<TelemetryEventType> = new Set([
  "step",
  "client_error",
  "http_error",
]);

function enqueue(event: TelemetryEvent): void {
  if (!state.installed) return;
  state.queue.push(event);
  mirrorToPostHog(event);
  if (state.queue.length >= FLUSH_AT_EVENTS) flush();
}

// Every explicit instrumentation point in the cloud overlay already funnels
// through enqueue(), so mirroring here gets PostHog the whole existing event
// set rather than instrumenting the same components a second time. The meta
// shape is already a strict allowlist (see TelemetryMeta) with no field
// content in it, so nothing extra needs sanitising on the way out.
function mirrorToPostHog(event: TelemetryEvent): void {
  try {
    if (!POSTHOG_MIRRORED_TYPES.has(event.eventType)) return;
    captureAnalytics(`${event.surface}_${event.eventType}`, {
      ...event.meta,
      target: event.target,
    });
  } catch {
    // Never throw into app code.
  }
}

function takeBatch(): TelemetryEvent[] {
  return state.queue.splice(0, MAX_BATCH_SIZE);
}

function serializeBatch(events: TelemetryEvent[]): string {
  return JSON.stringify({ clientSession: state.clientSession, events });
}

function flush(): void {
  try {
    if (!state.installed || state.queue.length === 0) return;
    const events = takeBatch();
    const doFetch = state.transportFetch;
    if (!doFetch) return;
    void doFetch(TELEMETRY_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: serializeBatch(events),
      keepalive: true,
    }).catch(() => {
      // Telemetry is best-effort; a lost batch is fine (404 off-cloud, etc.).
    });
  } catch {
    // Never throw into app code.
  }
}

/** pagehide flush: sendBeacon survives page teardown where fetch may not. */
function flushOnPagehide(): void {
  try {
    if (!state.installed || state.queue.length === 0) return;
    const events = takeBatch();
    const body = serializeBatch(events);
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      navigator.sendBeacon(TELEMETRY_ENDPOINT, new Blob([body], { type: "application/json" }));
      return;
    }
    const doFetch = state.transportFetch;
    if (doFetch) {
      void doFetch(TELEMETRY_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => {});
    }
  } catch {
    // Never throw into app code.
  }
}

function handleClick(event: MouseEvent): void {
  try {
    const target = event.target;
    if (!(target instanceof Element)) return;
    enqueue({
      surface: deriveSurface(target),
      eventType: "click",
      target: deriveTargetId(target),
      meta: { disabled: deriveDisabled(target) },
      tsClient: Date.now(),
    });
  } catch {
    // Never throw into app code.
  }
}

function handlePaste(event: Event): void {
  try {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const tag = target.tagName;
    if (tag !== "INPUT" && tag !== "TEXTAREA") return;
    // Only fields explicitly opted in; every other paste is invisible to us.
    if (target.getAttribute("data-telemetry") !== "sensitive") return;
    const text = (event as ClipboardEvent).clipboardData?.getData("text") ?? "";
    // METADATA ONLY: lengths and whitespace shape. The pasted text itself
    // must never enter the queue.
    enqueue({
      surface: deriveSurface(target),
      eventType: "paste_meta",
      target: deriveTargetId(target),
      meta: {
        len: text.length,
        trimmed_len: text.trim().length,
        leading_ws: /^\s/.test(text),
        trailing_ws: /\s$/.test(text),
        has_newline: text.includes("\n"),
      },
      tsClient: Date.now(),
    });
  } catch {
    // Never throw into app code.
  }
}

function handleError(event: ErrorEvent): void {
  try {
    const message = truncate(event.message || (event.error as Error | undefined)?.message, MAX_ERROR_TEXT_LEN);
    const meta: TelemetryMeta = { message };
    const frame = topStackFrame((event.error as Error | undefined)?.stack);
    if (frame) meta.frame = frame;
    enqueue({ surface: "app", eventType: "client_error", meta, tsClient: Date.now() });
  } catch {
    // Never throw into app code.
  }
}

function handleRejection(event: PromiseRejectionEvent): void {
  try {
    const reason = event.reason as { message?: unknown; stack?: unknown } | undefined;
    const message = truncate(
      reason && typeof reason === "object" && "message" in reason ? reason.message : reason,
      MAX_ERROR_TEXT_LEN,
    );
    const meta: TelemetryMeta = { message };
    const frame = topStackFrame(reason && typeof reason === "object" ? reason.stack : undefined);
    if (frame) meta.frame = frame;
    enqueue({ surface: "app", eventType: "client_error", meta, tsClient: Date.now() });
  } catch {
    // Never throw into app code.
  }
}

function recordHttpError(input: RequestInfo | URL, init: RequestInit | undefined, status: number): void {
  try {
    const raw =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, window.location.href);
    if (url.origin !== window.location.origin) return;
    if (!url.pathname.startsWith("/api/")) return;
    // Infinite-loop guard: never record the telemetry endpoint itself.
    if (url.pathname === TELEMETRY_ENDPOINT) return;
    const method = (
      init?.method ??
      (typeof input === "object" && "method" in input ? input.method : undefined) ??
      "GET"
    ).toUpperCase();
    enqueue({
      surface: "app",
      eventType: "http_error",
      meta: { path: templatePath(url.pathname), status, method },
      tsClient: Date.now(),
    });
  } catch {
    // Never throw into app code.
  }
}

function installFetchWrapper(): void {
  const original = window.fetch.bind(window);
  state.transportFetch = original;
  const wrapped: typeof fetch = (input, init) => {
    const promise = original(input, init);
    // Observe non-2xx same-origin /api/* responses; never touch the body and
    // never alter what the caller sees (failures pass through untouched).
    promise.then(
      (res) => {
        if (!res.ok) recordHttpError(input as RequestInfo | URL, init, res.status);
      },
      () => {},
    );
    return promise;
  };
  state.wrappedFetch = wrapped;
  window.fetch = wrapped;
}

function install(): void {
  if (state.installed) return;
  state.installed = true;
  state.clientSession = mintClientSession();

  installFetchWrapper();

  state.clickListener = handleClick;
  window.addEventListener("click", handleClick, true);

  state.pasteListener = handlePaste;
  window.addEventListener("paste", handlePaste, true);

  state.errorListener = handleError;
  window.addEventListener("error", handleError);

  state.rejectionListener = handleRejection;
  window.addEventListener("unhandledrejection", handleRejection);

  state.pagehideListener = flushOnPagehide;
  window.addEventListener("pagehide", flushOnPagehide);

  state.flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
}

/**
 * Install the tracker once (idempotent). Only ever installs when the app is
 * running against the paperclip.inc cloud (the same deploymentMode ===
 * "authenticated" signal the cloud-overlay components key off, from
 * GET /api/health); in a non-cloud install this is a complete no-op.
 *
 * Returns a promise that resolves once the cloud probe settled (used by
 * tests; app callers just fire-and-forget).
 */
export function initTelemetry(): Promise<void> {
  if (state.initPromise) return state.initPromise;
  state.initPromise = (async () => {
    try {
      if (typeof window === "undefined" || typeof window.fetch !== "function") return;
      const res = await window.fetch("/api/health", {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return;
      const health = (await res.json()) as { deploymentMode?: string } | null;
      if (health?.deploymentMode !== "authenticated") return;
      install();
    } catch {
      // Off-cloud / offline / anything else: stay a no-op forever.
    }
  })();
  return state.initPromise;
}

/**
 * Explicit step transition on a wizard-like surface (e.g. onboarding).
 * No-op unless the tracker is installed (cloud mode).
 */
export function trackStep(
  surface: TelemetrySurface,
  step: string | number,
  prevStep?: string | number,
  msOnStep?: number,
): void {
  try {
    if (!state.installed) return;
    const meta: TelemetryMeta = { step };
    if (prevStep !== undefined) meta.prev_step = prevStep;
    if (msOnStep !== undefined) meta.ms_on_step = Math.max(0, Math.round(msOnStep));
    enqueue({ surface: deriveSurfaceValue(surface), eventType: "step", meta, tsClient: Date.now() });
  } catch {
    // Never throw into app code.
  }
}

function deriveSurfaceValue(surface: string): TelemetrySurface {
  return ALLOWED_SURFACES.has(surface) ? (surface as TelemetrySurface) : "app";
}

/** Test-only: current queue contents (never mutate from tests). */
export function __getTelemetryQueueForTests(): readonly TelemetryEvent[] {
  return state.queue;
}

/** Test-only: tear the tracker down and restore all globals. */
export function __resetTelemetryForTests(): void {
  if (state.clickListener) window.removeEventListener("click", state.clickListener, true);
  if (state.pasteListener) window.removeEventListener("paste", state.pasteListener, true);
  if (state.errorListener) window.removeEventListener("error", state.errorListener);
  if (state.rejectionListener) window.removeEventListener("unhandledrejection", state.rejectionListener);
  if (state.pagehideListener) window.removeEventListener("pagehide", state.pagehideListener);
  if (state.flushTimer !== null) clearInterval(state.flushTimer);
  if (state.transportFetch && state.wrappedFetch && window.fetch === state.wrappedFetch) {
    window.fetch = state.transportFetch;
  }
  state.initPromise = null;
  state.installed = false;
  state.clientSession = null;
  state.queue = [];
  state.flushTimer = null;
  state.transportFetch = null;
  state.wrappedFetch = null;
  state.clickListener = null;
  state.pasteListener = null;
  state.errorListener = null;
  state.rejectionListener = null;
  state.pagehideListener = null;
}

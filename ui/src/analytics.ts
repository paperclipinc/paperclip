// PostHog analytics for the hosted product app (cloud overlay), 2026-07-26.
//
// Fork-only. Upstream self-hosters, localhost and CI never load this: the gate
// below is hostname-based, so nothing needs to be threaded through the
// Dockerfile, the Vite config or CI as a build argument, and the whole delta is
// this file plus one import in main.tsx.
//
// Consent is NOT asked for again here. The hosted app is same-origin with
// paperclip.inc, so it reads the marketing site's stored choice from the same
// localStorage key. One banner, one decision, both surfaces. A visitor who
// reaches the app without ever having made a choice gets the anonymous tier and
// is never recorded.
import posthog from "posthog-js";

// Public, write-only ingest key: it ships in the client bundle by definition.
const POSTHOG_KEY = "phc_BZ6Z2tgcU9bcxVU7howP66CqvbqXnYyRKoVnn9sL4gxE";

// Same-origin first-party proxy, served by marketing and reserved at the
// gateway (services/cloud-gateway/src/reserved-paths.ts in the mono repo).
const API_HOST = "/ingest";

// Shared with the marketing consent banner. Must stay in sync with
// marketing/src/lib/analytics.ts.
const CONSENT_STORAGE_KEY = "pp_cookie_consent";

const HOSTS = new Set(["paperclip.inc", "staging.paperclip.inc"]);

// What a session recording must never show. These are selectors rather than
// className edits across the component tree, for two reasons: it touches no
// shared upstream file, so rebases stay clean, and a component added later is
// covered the moment it renders through one of these primitives instead of
// needing to be remembered.
//
//   .paperclip-markdown          every rendered markdown body: agent messages,
//                                issue and case descriptions, comments,
//                                documents, artifact bodies (57 call sites)
//   .paperclip-file-viewer-code  file preview contents
//   pre, code                    every run log, diff, payload and monospace
//                                block in the app, wherever it renders
//   textarea, [contenteditable]  rich editors, including the MDX editor, whose
//                                content is not an input value
const CONTENT_SELECTORS = [
  ".paperclip-markdown",
  ".paperclip-file-viewer-code",
  "pre",
  "code",
  "textarea",
  "[contenteditable]",
].join(", ");

function storedConsent(): "granted" | "denied" | null {
  try {
    const stored = localStorage.getItem(CONSENT_STORAGE_KEY);
    return stored === "granted" || stored === "denied" ? stored : null;
  } catch {
    return null;
  }
}

/** True only on the hosted deployment, outside the embedded marketing demo. */
function shouldLoad(): boolean {
  if (typeof window === "undefined") return false;
  if (!HOSTS.has(window.location.hostname)) return false;
  // The marketing homepage embeds a snapshot of this same bundle at /demo/app/
  // running on fixture data. Without these two guards the demo would record
  // itself and every fixture click would land in the funnel as real usage.
  if (window.location.pathname.startsWith("/demo/")) return false;
  if (window.self !== window.top) return false;
  return true;
}

let started = false;

export function initAnalytics(): void {
  if (started || !shouldLoad()) return;

  const consent = storedConsent();
  if (consent === "denied") return;
  const granted = consent === "granted";
  started = true;

  posthog.init(POSTHOG_KEY, {
    api_host: API_HOST,
    defaults: "2026-05-30",
    // No consent yet means nothing may be written to the device.
    persistence: granted ? "localStorage+cookie" : "memory",
    autocapture: granted,
    capture_heatmaps: granted,
    disable_session_recording: !granted,
    capture_pageview: true,
    capture_pageleave: granted,
    session_recording: {
      // Belt: no typed value is ever captured.
      maskAllInputs: true,
      // Braces: the regions that render customer and agent content are masked
      // wholesale. Navigation, buttons, wizard steps, settings chrome, empty
      // states and error banners stay readable, which is the part that tells us
      // where people get stuck.
      maskTextSelector: CONTENT_SELECTORS,
    },
  });

  // Registered synchronously rather than from the `loaded` callback, which runs
  // after the initial pageview has already been queued. It also has to be
  // re-registered on every page load: super-properties are persisted, and the
  // marketing site is served from this same origin, so it shares this storage.
  // Without an unconditional write here the app inherits `surface: "marketing"`
  // from whichever marketing page the user came through, and every app event is
  // filed under the wrong surface.
  posthog.register({ surface: "app" });
}

/**
 * Send a named event. A no-op unless initAnalytics() actually started PostHog,
 * so self-hosted installs and the embedded demo stay silent without every call
 * site having to know that.
 *
 * Properties must stay metadata: counts, step numbers, durations, identifiers.
 * Never field content. Callers are responsible for that, and the one caller
 * that matters (./telemetry) already enforces a strict meta allowlist.
 */
export function captureAnalytics(event: string, properties?: Record<string, unknown>): void {
  if (!started) return;
  try {
    posthog.capture(event, properties);
  } catch {
    // Analytics must never throw into app code.
  }
}

/**
 * Stitch this browser's earlier anonymous activity to the signed-in user, so a
 * funnel can run from a first marketing visit through to a completed run.
 *
 * The distinct id is the user id, never an email address: PostHog does not need
 * to hold contact details to draw a funnel, and a pseudonymous id is the
 * minimisation-friendly choice.
 *
 * Only ever called with consent. Without it PostHog is in memory persistence,
 * so there is no cross-visit identity to attach to in the first place.
 */
export function identifyUser(userId: string | null | undefined): void {
  if (!started || !userId) return;
  if (storedConsent() !== "granted") return;
  try {
    posthog.identify(userId);
  } catch {
    // Analytics must never throw into app code.
  }
}

// Exported for the tests; not part of the app's runtime surface.
export const __testing = { shouldLoad, storedConsent, CONTENT_SELECTORS, CONSENT_STORAGE_KEY };

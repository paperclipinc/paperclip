import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The gate in analytics.ts decides whether the hosted product app records a
// session at all, so every branch of it is asserted directly. A regression here
// either records a self-hoster who never asked for it, or records the fixture
// data in the marketing site's embedded demo as if it were real usage.
const posthogMock = {
  init: vi.fn(),
  register: vi.fn(),
};

vi.mock("posthog-js", () => ({ default: posthogMock }));

const CONSENT_KEY = "pp_cookie_consent";

async function loadAnalytics() {
  vi.resetModules();
  return import("./analytics");
}

function setEnvironment(opts: {
  hostname?: string;
  pathname?: string;
  framed?: boolean;
  consent?: string;
}) {
  const store = new Map<string, string>();
  if (opts.consent) store.set(CONSENT_KEY, opts.consent);
  const win: Record<string, unknown> = {
    location: {
      hostname: opts.hostname ?? "paperclip.inc",
      pathname: opts.pathname ?? "/acme/issues",
    },
  };
  win["self"] = win;
  win["top"] = opts.framed ? {} : win;
  vi.stubGlobal("window", win);
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
  return store;
}

describe("hosted app analytics gate", () => {
  beforeEach(() => {
    posthogMock.init.mockClear();
    posthogMock.register.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads on the hosted domains", async () => {
    for (const hostname of ["paperclip.inc", "staging.paperclip.inc"]) {
      posthogMock.init.mockClear();
      setEnvironment({ hostname, consent: "granted" });
      const { initAnalytics } = await loadAnalytics();
      initAnalytics();
      expect(posthogMock.init, hostname).toHaveBeenCalledTimes(1);
    }
  });

  it("stays dark for self-hosters, localhost and preview hosts", async () => {
    for (const hostname of ["localhost", "paperclip.example.com", "evil-paperclip.inc"]) {
      posthogMock.init.mockClear();
      setEnvironment({ hostname, consent: "granted" });
      const { initAnalytics } = await loadAnalytics();
      initAnalytics();
      expect(posthogMock.init, hostname).not.toHaveBeenCalled();
    }
  });

  it("does not record the marketing site's embedded demo", async () => {
    // /demo/app/ serves a snapshot of this same bundle on fixture data. Left
    // ungated it would both record itself and pollute the funnel with clicks
    // nobody made.
    setEnvironment({ pathname: "/demo/app/", consent: "granted" });
    const { initAnalytics } = await loadAnalytics();
    initAnalytics();
    expect(posthogMock.init).not.toHaveBeenCalled();
  });

  it("does not record when framed", async () => {
    setEnvironment({ framed: true, consent: "granted" });
    const { initAnalytics } = await loadAnalytics();
    initAnalytics();
    expect(posthogMock.init).not.toHaveBeenCalled();
  });

  it("inherits a decline made on the marketing site", async () => {
    setEnvironment({ consent: "denied" });
    const { initAnalytics } = await loadAnalytics();
    initAnalytics();
    expect(posthogMock.init).not.toHaveBeenCalled();
  });

  it("runs cookieless and unrecorded when no choice has been made", async () => {
    setEnvironment({});
    const { initAnalytics } = await loadAnalytics();
    initAnalytics();

    const [, config] = posthogMock.init.mock.calls[0];
    expect(config.persistence).toBe("memory");
    expect(config.disable_session_recording).toBe(true);
    expect(config.autocapture).toBe(false);
  });

  it("records with consent, masking inputs and every content region", async () => {
    setEnvironment({ consent: "granted" });
    const { initAnalytics } = await loadAnalytics();
    initAnalytics();

    const [, config] = posthogMock.init.mock.calls[0];
    expect(config.disable_session_recording).toBe(false);
    expect(config.persistence).toBe("localStorage+cookie");
    expect(config.session_recording.maskAllInputs).toBe(true);

    const masked = config.session_recording.maskTextSelector as string;
    // Each of these is a surface that renders customer or agent content. If one
    // is dropped from the selector list, recordings start capturing it.
    for (const selector of [
      ".paperclip-markdown",
      ".paperclip-file-viewer-code",
      "pre",
      "code",
      "textarea",
      "[contenteditable]",
    ]) {
      expect(masked.split(", ")).toContain(selector);
    }
  });

  it("routes ingestion through the first-party proxy", async () => {
    setEnvironment({ consent: "granted" });
    const { initAnalytics } = await loadAnalytics();
    initAnalytics();
    expect(posthogMock.init.mock.calls[0][1].api_host).toBe("/ingest");
  });

  it("tags events with the app surface synchronously, not from loaded()", async () => {
    // register() has to land before the initial pageview is queued, and it has
    // to run on every load: the marketing site shares this origin and therefore
    // this persisted super-property store, so without an unconditional write
    // the app inherits surface:"marketing" from the page the user arrived from.
    setEnvironment({ consent: "granted" });
    const { initAnalytics } = await loadAnalytics();
    initAnalytics();
    expect(posthogMock.register).toHaveBeenCalledWith({ surface: "app" });
    expect(posthogMock.init.mock.calls[0][1].loaded).toBeUndefined();
  });
});

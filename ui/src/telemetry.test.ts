// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __getTelemetryQueueForTests,
  __resetTelemetryForTests,
  deriveSurface,
  deriveTargetId,
  initTelemetry,
  templatePath,
  trackStep,
} from "./telemetry";

const TELEMETRY_ENDPOINT = "/api/telemetry/ui";

type RouteResponse = { status: number; body?: unknown };

function makeResponse(status: number, body: unknown = null): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** Route-table fetch mock; unmatched paths return 204. */
function installFetchMock(routes: Record<string, RouteResponse>) {
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(raw, window.location.href).pathname;
    const route = routes[path];
    if (route) return makeResponse(route.status, route.body ?? null);
    return makeResponse(204);
  });
  window.fetch = mock as unknown as typeof fetch;
  return mock;
}

async function initCloud(extraRoutes: Record<string, RouteResponse> = {}) {
  const mock = installFetchMock({
    "/api/health": { status: 200, body: { deploymentMode: "authenticated" } },
    ...extraRoutes,
  });
  await initTelemetry();
  return mock;
}

function telemetryPosts(mock: ReturnType<typeof vi.fn>) {
  return mock.mock.calls.filter(([input]) => input === TELEMETRY_ENDPOINT);
}

function clickOn(el: Element) {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function pasteOn(el: Element, text: string) {
  const event = new Event("paste", { bubbles: true });
  Object.defineProperty(event, "clipboardData", {
    value: { getData: () => text },
  });
  el.dispatchEvent(event);
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  __resetTelemetryForTests();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("deriveTargetId priority", () => {
  it("prefers data-track over id, aria-label, and text", () => {
    document.body.innerHTML =
      `<button data-track="cta-subscribe" id="btn-id" aria-label="Subscribe now"><span>Subscribe</span></button>`;
    const span = document.querySelector("span")!;
    expect(deriveTargetId(span)).toBe("cta-subscribe");
  });

  it("falls back to element id, then aria-label, then capped text", () => {
    document.body.innerHTML = `<button id="btn-id" aria-label="Subscribe now"><span>Subscribe</span></button>`;
    expect(deriveTargetId(document.querySelector("span")!)).toBe("btn-id");

    document.body.innerHTML = `<button aria-label="Subscribe now"><span>Subscribe</span></button>`;
    expect(deriveTargetId(document.querySelector("span")!)).toBe("Subscribe now");

    const longText = "x".repeat(120);
    document.body.innerHTML = `<button><span>  ${longText}  </span></button>`;
    const derived = deriveTargetId(document.querySelector("span")!);
    expect(derived).toBe("x".repeat(40));
    expect(derived.length).toBe(40);
  });
});

describe("deriveSurface", () => {
  it("uses the nearest allowlisted data-surface ancestor, else app", () => {
    document.body.innerHTML =
      `<div data-surface="onboarding"><div data-surface="credential_connect"><i id="a"></i></div></div>` +
      `<div data-surface="not-a-real-surface"><i id="b"></i></div>` +
      `<i id="c"></i>`;
    expect(deriveSurface(document.getElementById("a"))).toBe("credential_connect");
    expect(deriveSurface(document.getElementById("b"))).toBe("app");
    expect(deriveSurface(document.getElementById("c"))).toBe("app");
  });
});

describe("templatePath", () => {
  it("replaces uuid and numeric segments with :id", () => {
    expect(templatePath("/api/companies/42/agents/550e8400-e29b-41d4-a716-446655440000/runs")).toBe(
      "/api/companies/:id/agents/:id/runs",
    );
    expect(templatePath("/api/health")).toBe("/api/health");
  });
});

describe("cloud-mode gating", () => {
  it("is a complete no-op off-cloud (local_trusted)", async () => {
    const mock = installFetchMock({
      "/api/health": { status: 200, body: { deploymentMode: "local_trusted" } },
    });
    await initTelemetry();

    expect(window.fetch).toBe(mock); // fetch never wrapped
    document.body.innerHTML = `<button id="b">Go</button>`;
    clickOn(document.getElementById("b")!);
    trackStep("onboarding", 1);
    expect(__getTelemetryQueueForTests()).toHaveLength(0);
  });

  it("is a no-op when the health probe fails entirely", async () => {
    window.fetch = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    await expect(initTelemetry()).resolves.toBeUndefined();
    document.body.innerHTML = `<button id="b">Go</button>`;
    clickOn(document.getElementById("b")!);
    expect(__getTelemetryQueueForTests()).toHaveLength(0);
  });

  it("installs exactly once in cloud mode (idempotent)", async () => {
    await initCloud();
    await initTelemetry(); // second call must not double-install listeners
    document.body.innerHTML = `<button id="b">Go</button>`;
    clickOn(document.getElementById("b")!);
    expect(__getTelemetryQueueForTests()).toHaveLength(1);
  });
});

describe("click capture", () => {
  it("queues surface, target, and disabled flag", async () => {
    await initCloud();
    document.body.innerHTML =
      `<div data-surface="billing"><button aria-disabled="true" data-track="subscribe"><span>Subscribe</span></button></div>`;
    clickOn(document.querySelector("span")!);

    const queue = __getTelemetryQueueForTests();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      surface: "billing",
      eventType: "click",
      target: "subscribe",
      meta: { disabled: true },
    });
    expect(typeof queue[0].tsClient).toBe("number");
  });
});

describe("sensitive-field paste gating", () => {
  const SECRET = "sk-ant-oat01-super-secret-value\n";

  it("emits nothing for a paste on a non-marked field", async () => {
    await initCloud();
    document.body.innerHTML = `<input id="plain" type="password" />`;
    pasteOn(document.getElementById("plain")!, SECRET);
    expect(__getTelemetryQueueForTests()).toHaveLength(0);
  });

  it("emits metadata only (never content) for a marked field", async () => {
    await initCloud();
    document.body.innerHTML =
      `<div data-surface="credential_connect"><input id="cred" data-telemetry="sensitive" type="password" /></div>`;
    pasteOn(document.getElementById("cred")!, SECRET);

    const queue = __getTelemetryQueueForTests();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      surface: "credential_connect",
      eventType: "paste_meta",
      meta: {
        len: SECRET.length,
        trimmed_len: SECRET.trim().length,
        leading_ws: false,
        trailing_ws: true,
        has_newline: true,
      },
    });
    // The pasted content must not appear ANYWHERE in any queued event.
    expect(JSON.stringify(queue)).not.toContain("sk-ant-oat01");
    expect(JSON.stringify(queue)).not.toContain(SECRET.trim());
  });
});

describe("batching", () => {
  it("flushes at 20 events in a single POST with keepalive", async () => {
    const mock = await initCloud();
    document.body.innerHTML = `<button id="b">Go</button>`;
    for (let i = 0; i < 19; i++) clickOn(document.getElementById("b")!);
    expect(telemetryPosts(mock)).toHaveLength(0);

    clickOn(document.getElementById("b")!); // 20th event triggers the flush

    const posts = telemetryPosts(mock);
    expect(posts).toHaveLength(1);
    const [, init] = posts[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.keepalive).toBe(true);
    const payload = JSON.parse(init.body as string) as { clientSession: string; events: unknown[] };
    expect(payload.events).toHaveLength(20);
    expect(typeof payload.clientSession).toBe("string");
    expect(payload.clientSession.length).toBeGreaterThan(0);
    expect(__getTelemetryQueueForTests()).toHaveLength(0);
  });

  it("swallows transport failures silently", async () => {
    const mock = await initCloud();
    document.body.innerHTML = `<button id="b">Go</button>`;
    mock.mockImplementation(async (input: RequestInfo | URL) => {
      if (input === TELEMETRY_ENDPOINT) throw new Error("network down");
      return makeResponse(204);
    });
    expect(() => {
      for (let i = 0; i < 20; i++) clickOn(document.getElementById("b")!);
    }).not.toThrow();
  });
});

describe("client_error capture", () => {
  it("truncates message and keeps only the top stack frame", async () => {
    await initCloud();
    const error = new Error("boom");
    error.stack = `Error: boom\n    at ${"f".repeat(400)} (app.js:1:1)\n    at second (app.js:2:2)`;
    window.dispatchEvent(
      new ErrorEvent("error", { message: "m".repeat(500), error }),
    );

    const queue = __getTelemetryQueueForTests();
    expect(queue).toHaveLength(1);
    expect(queue[0].eventType).toBe("client_error");
    expect(queue[0].meta?.message).toBe("m".repeat(200));
    expect(queue[0].meta?.frame?.startsWith("at f")).toBe(true);
    expect(queue[0].meta?.frame?.length).toBeLessThanOrEqual(200);
    expect(JSON.stringify(queue[0])).not.toContain("at second");
  });

  it("captures unhandled rejections", async () => {
    await initCloud();
    const event = new Event("unhandledrejection");
    Object.defineProperty(event, "reason", { value: new Error("rejected-reason") });
    window.dispatchEvent(event);

    const queue = __getTelemetryQueueForTests();
    expect(queue).toHaveLength(1);
    expect(queue[0].eventType).toBe("client_error");
    expect(queue[0].meta?.message).toBe("rejected-reason");
  });
});

describe("fetch wrapper", () => {
  it("records non-2xx same-origin /api/* with a templated path", async () => {
    await initCloud({ "/api/companies/42/agents/550e8400-e29b-41d4-a716-446655440000": { status: 503 } });
    const res = await window.fetch(
      "/api/companies/42/agents/550e8400-e29b-41d4-a716-446655440000",
      { method: "POST" },
    );
    expect(res.status).toBe(503); // response passes through untouched
    await Promise.resolve(); // let the observer microtask run

    const queue = __getTelemetryQueueForTests();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      eventType: "http_error",
      meta: { path: "/api/companies/:id/agents/:id", status: 503, method: "POST" },
    });
  });

  it("ignores 2xx responses", async () => {
    await initCloud({ "/api/companies": { status: 200, body: [] } });
    await window.fetch("/api/companies");
    await Promise.resolve();
    expect(__getTelemetryQueueForTests()).toHaveLength(0);
  });

  it("never records the telemetry endpoint itself", async () => {
    await initCloud({ [TELEMETRY_ENDPOINT]: { status: 500 } });
    await window.fetch(TELEMETRY_ENDPOINT, { method: "POST", body: "{}" });
    await Promise.resolve();
    expect(__getTelemetryQueueForTests()).toHaveLength(0);
  });

  it("ignores cross-origin and non-/api/ URLs", async () => {
    const mock = await initCloud();
    mock.mockImplementation(async () => makeResponse(500));
    await window.fetch("https://example.com/api/things");
    await window.fetch("/assets/app.js");
    await Promise.resolve();
    expect(__getTelemetryQueueForTests()).toHaveLength(0);
  });
});

describe("trackStep", () => {
  it("queues step transitions with prev_step and ms_on_step", async () => {
    await initCloud();
    trackStep("onboarding", 2, 1, 4321);
    const queue = __getTelemetryQueueForTests();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      surface: "onboarding",
      eventType: "step",
      meta: { step: 2, prev_step: 1, ms_on_step: 4321 },
    });
  });

  it("omits prev_step and ms_on_step on the first step", async () => {
    await initCloud();
    trackStep("onboarding", 0);
    const queue = __getTelemetryQueueForTests();
    expect(queue[0].meta).toEqual({ step: 0 });
  });
});

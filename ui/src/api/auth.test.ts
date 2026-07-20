// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthApiError, authApi } from "./auth";

function jsonResponse(status: number, body: unknown, statusText = ""): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
  } as unknown as Response;
}

const validSessionBody = {
  session: { id: "sess-1", userId: "user-1" },
  user: { id: "user-1", email: "user@example.com", name: "User One", image: null },
};

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("authApi.getSession status classification", () => {
  // These two are the ONLY definitive "not authenticated" outcomes —
  // CloudAccessGate redirects to sign-in on exactly (and only) these.
  it("resolves to null on an explicit 401 (definitive: not authenticated)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { message: "unauthorized" }));
    await expect(authApi.getSession()).resolves.toBeNull();
  });

  // better-auth's OWN documented "no session" 200 response is a bare JSON
  // `null` body (see services/paperclip-id's vendored get-session handler:
  // no session cookie, or an expired/deleted session, both `return
  // ctx.json(null)` / bare `return null` — never `{session: null}` or any
  // other shape). This is the ONLY 200 body that means "not authenticated".
  it("resolves to null on better-auth's genuine unauthenticated 200 body (a bare JSON null)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, null));
    await expect(authApi.getSession()).resolves.toBeNull();
  });

  it("resolves the session on a valid 200", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, validSessionBody));
    await expect(authApi.getSession()).resolves.toEqual(validSessionBody);
  });

  // A 200 that is neither the documented null-session body NOR a valid
  // session is a CONTRACT MISMATCH — a server-side response-shape drift
  // (this bit us before as #189's empty-name authSessionSchema issue), not
  // a logout. Must throw (so the gate retries/backs off), never resolve to
  // null: silently treating this as "logged out" would log out every
  // signed-in user the moment a deploy drifts this shape.
  it("throws (does not resolve to null) on a 200 whose body matches neither the null-session shape nor a valid session", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { unrelated: "shape" }));
    let caught: unknown = null;
    try {
      await authApi.getSession();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AuthApiError);
    expect((caught as AuthApiError).status).toBe(200);
    expect((caught as AuthApiError).code).toBe("session_shape_mismatch");
  });

  it("throws on a 200 whose body is a session-shaped object missing a required field (e.g. a drifted user schema)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        session: { id: "sess-1", userId: "user-1" },
        // Missing `image`, which currentUserProfileSchema requires
        // (nullable but not optional) — exactly the #189 shape-drift class.
        user: { id: "user-1", email: "user@example.com", name: "User One" },
      }),
    );
    await expect(authApi.getSession()).rejects.toBeInstanceOf(AuthApiError);
  });

  // Everything below is NOT a definitive "not authenticated" answer — it
  // throws an AuthApiError with the real status attached instead of
  // resolving to null, specifically so CloudAccessGate can retry/back off
  // rather than treat it as a logout (see bounce-and-probe-investigation.md:
  // a rate-limited 429 here, with a completely valid session cookie,
  // previously triggered a hard redirect to sign-in).
  it("throws an AuthApiError instance carrying status 429 on a rate limit, never resolving to null", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(429, { message: "Too many requests. Please try again later." }),
    );
    let caught: unknown = null;
    try {
      await authApi.getSession();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AuthApiError);
    expect((caught as AuthApiError).status).toBe(429);
  });

  it("throws an AuthApiError carrying status 500 on a server error", async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { message: "internal error" }));
    await expect(authApi.getSession()).rejects.toMatchObject({ status: 500 });
  });

  it("throws an AuthApiError with status 0 on a network-layer failure (no HTTP response at all)", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(authApi.getSession()).rejects.toMatchObject({ status: 0 });
  });
});

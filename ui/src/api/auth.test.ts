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

  it("resolves to null on a 200 whose body doesn't parse into a session (definitive: not authenticated)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { unrelated: "shape" }));
    await expect(authApi.getSession()).resolves.toBeNull();
  });

  it("resolves the session on a valid 200", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, validSessionBody));
    await expect(authApi.getSession()).resolves.toEqual(validSessionBody);
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

import {
  authSessionSchema,
  currentUserProfileSchema,
  type AuthSession,
  type CurrentUserProfile,
  type UpdateCurrentUserProfile,
} from "@paperclipai/shared";
import { redactUrlSecrets } from "@/lib/redact-url-secrets";

type AuthErrorBody =
  | {
    code?: string;
    message?: string;
    error?: string | { code?: string; message?: string };
  }
  | null;

export class AuthApiError extends Error {
  status: number;
  code: string | null;
  body: unknown;

  constructor(message: string, status: number, body: unknown, code: string | null = null) {
    super(message);
    this.name = "AuthApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

function toSession(value: unknown): AuthSession | null {
  const direct = authSessionSchema.safeParse(value);
  if (direct.success) return direct.data;

  if (!value || typeof value !== "object") return null;
  const nested = authSessionSchema.safeParse((value as Record<string, unknown>).data);
  return nested.success ? nested.data : null;
}

function extractAuthError(payload: AuthErrorBody, status: number) {
  const nested =
    payload?.error && typeof payload.error === "object"
      ? payload.error
      : null;
  const code =
    typeof nested?.code === "string"
      ? nested.code
      : typeof payload?.code === "string"
        ? payload.code
        : null;
  const message =
    typeof nested?.message === "string" && nested.message.trim().length > 0
      ? nested.message
      : typeof payload?.message === "string" && payload.message.trim().length > 0
        ? payload.message
        : typeof payload?.error === "string" && payload.error.trim().length > 0
          ? payload.error
          : `Request failed: ${status}`;

  return new AuthApiError(message, status, payload, code);
}

// Rich diagnostics for auth requests. Network-layer failures (Safari
// "Load failed" / Chrome "Failed to fetch") throw a TypeError *before* any
// HTTP response, so they are indistinguishable from a bad password in the UI
// unless we log the resolved request URL + origin here. See PAP-13466.
function resolveAuthUrl(path: string) {
  const relative = `/api/auth${path}`;
  try {
    return new URL(relative, window.location.origin).href;
  } catch {
    return relative;
  }
}

function logAuthNetworkFailure(method: string, path: string, error: unknown) {
  // eslint-disable-next-line no-console
  console.error("[auth] request failed at the network layer (no HTTP response)", {
    method,
    requestUrl: resolveAuthUrl(path),
    pageOrigin: typeof window !== "undefined" ? window.location.origin : "(no window)",
    pageHref: typeof window !== "undefined" ? redactUrlSecrets(window.location.href) : "(no window)",
    credentials: "include",
    online: typeof navigator !== "undefined" ? navigator.onLine : "(no navigator)",
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: error instanceof Error ? error.message : String(error),
    error,
    hint:
      "This means the browser never got a response from the server. Common causes: " +
      "the page origin differs from the API host (mixed http/https, wrong hostname/port, " +
      "or a proxy/tunnel that only forwards the page but not /api), an SSL error, or the " +
      "connection was reset. A wrong password would instead return HTTP 401, not this.",
  });
}

function logAuthHttpError(method: string, path: string, status: number, statusText: string, body: unknown) {
  // eslint-disable-next-line no-console
  console.error("[auth] request returned an error status", {
    method,
    requestUrl: resolveAuthUrl(path),
    status,
    statusText,
    body,
  });
}

async function authPost(path: string, body: Record<string, unknown>) {
  let res: Response;
  try {
    res = await fetch(`/api/auth${path}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (networkError) {
    logAuthNetworkFailure("POST", path, networkError);
    throw networkError;
  }
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    logAuthHttpError("POST", path, res.status, res.statusText, payload);
    throw extractAuthError(payload as AuthErrorBody, res.status);
  }
  return payload;
}

async function authPatch<T>(path: string, body: Record<string, unknown>, parse: (value: unknown) => T): Promise<T> {
  const res = await fetch(`/api/auth${path}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    throw extractAuthError(payload as AuthErrorBody, res.status);
  }
  return parse(payload);
}

export const authApi = {
  // Distinguishes a DEFINITIVE "not authenticated" signal from every other
  // failure (429/5xx/network/malformed 200). Only the former resolves to
  // `null` — everything else throws an AuthApiError carrying the real
  // status, specifically so CloudAccessGate can tell "genuinely logged out"
  // apart from "the session-check request itself failed, or answered with
  // something we don't recognize" and retry instead of bouncing a still-
  // valid session to sign-in (see PAP bounce-and-probe-investigation.md: a
  // rate-limited 429 on this exact endpoint, with the session cookie
  // untouched, previously triggered a hard redirect).
  //
  // There are exactly two definitive-unauthenticated signals:
  //   1. An explicit 401.
  //   2. better-auth's own documented "no session" 200 response, which is a
  //      bare JSON `null` body (see the vendored get-session handler in
  //      services/paperclip-id/node_modules/better-auth/dist/api/routes/
  //      session.mjs: no session cookie, or an expired/deleted session, both
  //      `return ctx.json(null)` / bare `return null`) — never `{session:
  //      null}` or any other shape.
  // A 200 whose body is neither of those — including one that merely fails
  // authSessionSchema — is a CONTRACT MISMATCH (a server-side response-shape
  // drift, e.g. #189's empty-name bug), not a logout signal, and must not be
  // silently treated as one: a deploy that drifts this shape would otherwise
  // log out every signed-in user on their next reload. Throw instead, and
  // log the parse failure for diagnostics.
  getSession: async (): Promise<AuthSession | null> => {
    let res: Response;
    try {
      res = await fetch("/api/auth/get-session", {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
    } catch (networkError) {
      logAuthNetworkFailure("GET", "/get-session", networkError);
      // No HTTP response at all — status 0 signals "not a definitive
      // unauthenticated answer" to callers, same as any other non-2xx,
      // non-401 status below.
      throw new AuthApiError(
        networkError instanceof Error ? networkError.message : "Network error",
        0,
        null,
      );
    }
    if (res.status === 401) return null;
    // `undefined` (JSON parse failed — e.g. an empty body) is deliberately
    // distinct from a successfully-parsed literal `null`: only the latter is
    // better-auth's documented "no session" shape.
    const payload = await res.json().catch(() => undefined);
    if (!res.ok) {
      logAuthHttpError("GET", "/get-session", res.status, res.statusText, payload);
      throw new AuthApiError(`Failed to load session (${res.status})`, res.status, payload ?? null);
    }
    if (payload === null) return null;
    const direct = toSession(payload);
    if (direct) return direct;
    const nested = payload && typeof payload === "object" ? toSession((payload as Record<string, unknown>).data) : null;
    if (nested) return nested;
    const parsed = authSessionSchema.safeParse(payload);
    // eslint-disable-next-line no-console
    console.error(
      "[auth] /get-session returned a 200 whose body does not match the expected session shape (or the documented null-session shape) — treating as transient, not a logout",
      {
        payload,
        issues: parsed.success ? null : parsed.error.issues,
      },
    );
    throw new AuthApiError(
      "Session response did not match the expected shape",
      res.status,
      payload,
      "session_shape_mismatch",
    );
  },

  signInEmail: async (input: { email: string; password: string }) => {
    await authPost("/sign-in/email", input);
  },

  signUpEmail: async (input: { name: string; email: string; password: string }) => {
    await authPost("/sign-up/email", input);
  },

  getProfile: async (): Promise<CurrentUserProfile> => {
    const res = await fetch("/api/auth/profile", {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    const payload = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error((payload as { error?: string } | null)?.error ?? `Failed to load profile (${res.status})`);
    }
    return currentUserProfileSchema.parse(payload);
  },

  updateProfile: async (input: UpdateCurrentUserProfile): Promise<CurrentUserProfile> =>
    authPatch("/profile", input, (payload) => currentUserProfileSchema.parse(payload)),

  signOut: async () => {
    await authPost("/sign-out", {});
  },
};

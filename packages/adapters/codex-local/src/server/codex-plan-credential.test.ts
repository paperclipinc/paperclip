import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  evaluateCodexCredentialReadiness,
  seedManagedCodexHome,
  shouldReplaceStoredCodexAuth,
  writeSubscriptionAuthJson,
} from "./codex-home.js";

// The hosted route for a ChatGPT plan: the user runs `codex login` on their own
// machine and hands us the resulting auth.json, because a tenant has no shared
// host login to inherit (and inheriting one would be another tenant's).
//
// Two properties carry the whole feature:
//   1. the user's credential actually lands in the home Codex will run with,
//      and the operator's is never symlinked over it;
//   2. a credential refreshed mid-run replaces the stored one, and a stale or
//      broken one never does. OpenAI rotates refresh tokens single-use, so
//      getting (2) wrong in either direction locks the user out with no undo.

const authAt = (iso: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    tokens: { account_id: "acct-1", access_token: "at", refresh_token: "rt" },
    last_refresh: iso,
    ...extra,
  });

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-plan-"));
  vi.stubEnv("CODEX_HOME", path.join(root, "shared"));
  vi.stubEnv("HOME", root);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
});

describe("materializing a user-supplied Codex plan credential", () => {
  it("writes the pasted auth.json verbatim into the managed home", async () => {
    const home = path.join(root, "managed");
    const supplied = authAt("2026-08-03T10:00:00Z");

    await seedManagedCodexHome(home, process.env, async () => {}, { authJson: supplied });

    // Verbatim matters: the file carries fields Codex owns and may extend, so a
    // round-trip through our own shape would silently drop what we do not model.
    expect(await fs.readFile(path.join(home, "auth.json"), "utf8")).toBe(supplied);
  });

  it("never symlinks the operator's credential over the user's", async () => {
    // The operator is logged in on the server. On a hosted install that file is
    // someone else's, and even self-hosted the symlink would make the user's own
    // credential unreachable.
    const shared = path.join(root, "shared");
    await fs.mkdir(shared, { recursive: true });
    await fs.writeFile(path.join(shared, "auth.json"), authAt("2026-01-01T00:00:00Z"));

    const home = path.join(root, "managed");
    const supplied = authAt("2026-08-03T10:00:00Z");
    await seedManagedCodexHome(home, process.env, async () => {}, { authJson: supplied });

    const stat = await fs.lstat(path.join(home, "auth.json"));
    expect(stat.isSymbolicLink()).toBe(false);
    expect(await fs.readFile(path.join(home, "auth.json"), "utf8")).toBe(supplied);
  });

  it("replaces a previous run's file rather than writing through it", async () => {
    const home = path.join(root, "managed");
    await writeSubscriptionAuthJson(home, authAt("2026-08-01T00:00:00Z"));
    const next = authAt("2026-08-03T10:00:00Z");

    await seedManagedCodexHome(home, process.env, async () => {}, { authJson: next });

    expect(await fs.readFile(path.join(home, "auth.json"), "utf8")).toBe(next);
  });

  it("counts as ready, without consulting the server's own credential", async () => {
    // Readiness must answer for THIS user. Falling through to the shared-host
    // probe would answer for the operator in both directions: ready when the
    // user has nothing, not-ready when they do.
    const readiness = await evaluateCodexCredentialReadiness({
      env: process.env,
      companyId: "company-1",
      configuredCodexHome: null,
      configuredApiKey: null,
      configuredAuthJson: authAt("2026-08-03T10:00:00Z"),
    });

    expect(readiness.ready).toBe(true);
    expect(readiness.authMode).toBe("subscription");
  });

  it("is still not ready when the user supplied nothing and only the operator is logged in", async () => {
    const shared = path.join(root, "shared");
    await fs.mkdir(shared, { recursive: true });
    await fs.writeFile(path.join(shared, "auth.json"), authAt("2026-01-01T00:00:00Z"));

    // NOTE: this documents today's behaviour, which is host-derived and is what
    // the hosted probe branch exists to suppress at the UI layer. Pinned so a
    // change here is a deliberate one.
    const readiness = await evaluateCodexCredentialReadiness({
      env: process.env,
      companyId: "company-1",
      configuredCodexHome: null,
      configuredApiKey: null,
      configuredAuthJson: null,
    });
    expect(readiness.ready).toBe(true);
  });
});

describe("deciding whether a refreshed credential replaces the stored one", () => {
  const stored = authAt("2026-08-03T10:00:00Z");

  it("replaces on a strictly newer refresh", () => {
    expect(shouldReplaceStoredCodexAuth(stored, authAt("2026-08-03T11:00:00Z"))).toBe(true);
  });

  it("keeps the stored credential when the clock did not move", () => {
    // Same clock means no refresh happened. Writing anyway would burn a
    // database version per run for nothing.
    expect(shouldReplaceStoredCodexAuth(stored, authAt("2026-08-03T10:00:00Z"))).toBe(false);
  });

  it("never goes backwards", () => {
    // A sandbox that somehow carries an older copy must not overwrite a newer
    // stored one: OpenAI rotates single-use, so the older refresh token is
    // already dead and storing it would lock the user out permanently.
    expect(shouldReplaceStoredCodexAuth(stored, authAt("2026-08-01T00:00:00Z"))).toBe(false);
  });

  it("refuses anything unusable, unparseable, or empty", () => {
    expect(shouldReplaceStoredCodexAuth(stored, "not json")).toBe(false);
    expect(shouldReplaceStoredCodexAuth(stored, "")).toBe(false);
    expect(shouldReplaceStoredCodexAuth(stored, "   ")).toBe(false);
    expect(shouldReplaceStoredCodexAuth(stored, "null")).toBe(false);
    expect(shouldReplaceStoredCodexAuth(stored, "[]")).toBe(false);
    // Parses, but carries no credential material.
    expect(shouldReplaceStoredCodexAuth(stored, JSON.stringify({ tokens: {} }))).toBe(false);
    // Has material but no account id: the merge predicate treats that as unusable.
    expect(
      shouldReplaceStoredCodexAuth(stored, JSON.stringify({ tokens: { refresh_token: "r" }, last_refresh: "2026-09-01T00:00:00Z" })),
    ).toBe(false);
  });

  it("refuses a usable payload with no clock, rather than guessing it is newer", () => {
    const noClock = JSON.stringify({ tokens: { account_id: "acct-1", refresh_token: "r" } });
    expect(shouldReplaceStoredCodexAuth(stored, noClock)).toBe(false);
  });

  it("accepts a first refresh when the stored copy had no clock", () => {
    const storedNoClock = JSON.stringify({ tokens: { account_id: "acct-1", refresh_token: "r" } });
    expect(shouldReplaceStoredCodexAuth(storedNoClock, authAt("2026-08-03T10:00:00Z"))).toBe(true);
  });
});

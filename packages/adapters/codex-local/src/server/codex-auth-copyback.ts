import { open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { withDirectoryMergeLock } from "@paperclipai/adapter-utils/workspace-restore-merge";
import {
  isCodexAuthCacheEnabled,
  readSubscriptionAccountId,
  writeCodexAuthCacheEntry,
} from "./codex-auth-cache.js";
import { USE_SOURCE_EXIT, decideCodexAuthMerge } from "./codex-auth-merge-decision.js";

// The outbound copy-back reuses the exact same direction-agnostic decision
// predicate the inbound restore runs, through the shared `decideCodexAuthMerge`
// entry point. The predicate answers one question — "should the caller replace
// `destination` with `source`?" — purely by argument order (first = source,
// second = destination). For the copy-back the sandbox credential is the
// `source` and the shared host credential is the `destination`, so exit 10 (use
// source) means "install the sandbox copy onto the host" and exit 20 (keep
// destination) means "leave the host copy untouched". The predicate only ever
// reads the two files and exits with a code; it never prints token bytes.

/** Outcome of a copy-back attempt. No token material is ever surfaced. */
export type CopyBackCodexAuthOutcome = "copied" | "kept-host";

export interface CopyBackCodexAuthInput {
  /**
   * Reads the sandbox `auth.json` bytes back from the (about-to-be-destroyed)
   * sandbox. In production this is bound to the managed-runtime restore
   * context's `readFile` for `${assetDir}/auth.json`.
   */
  readSandboxAuth: () => Promise<Buffer>;
  /**
   * Absolute path of the shared host credential to (maybe) overwrite — the
   * symlink *source* the managed Codex homes point their `auth.json` at, never
   * an in-sandbox or per-agent symlink.
   */
  hostAuthPath: string;
  /** Non-leaking progress sink: receives decision/outcome lines only. */
  log: (line: string) => void | Promise<void>;
  /**
   * Resolves and ensures the per-identity cache slot path for a sandbox
   * `account_id`. When this is provided AND the cache off-switch is on, the
   * copy-back also writes the fresher, usable subscription credential into its
   * per-identity cache slot as a second, additive write, keyed by the real
   * `account_id`. This is independent of the host default overwrite: it can
   * write a cache slot for a different identity than the host holds (matrix rows
   * 1b, 3), and it never touches the host default store. When absent, no cache
   * write happens.
   */
  resolveCacheEntryPath?: (accountId: string) => Promise<string>;
  /** Environment for the cache off-switch read. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Guards, locks, and atomically installs a strictly-newer sandbox Codex
 * `auth.json` onto the shared host credential at teardown.
 *
 * Sequence, all under `withDirectoryMergeLock` on the host target's directory
 * so a concurrent inbound restore or another copy-back can't interleave:
 *   1. Read the sandbox credential bytes. A genuinely absent sandbox
 *      `auth.json` (ENOENT) means there is simply nothing to copy back, so it
 *      resolves to `kept-host` (benign no-op, host untouched); every other read
 *      error stays fail-loud.
 *   2. Stage them to a `0600` temp file on the **same filesystem** as the host
 *      target (its directory), which doubles as the predicate `source`. A host
 *      directory whose path is missing at any depth (ENOENT from the lock
 *      acquisition when an ancestor is absent, or from staging when the host
 *      directory itself is) resolves to `kept-host`: there is no shared store
 *      to merge into, and no part of the missing tree is ever created here (on
 *      a multi-tenant server that would leak one tenant's credential into the
 *      store every other managed home is seeded from).
 *   3. Run the Phase-3 decision predicate (`source` = sandbox temp, `destination`
 *      = host). Exit 10 → adopt the sandbox copy; exit 20 → keep the host copy.
 *   4. On exit 10, `rename` the staged temp over the host target — an atomic
 *      same-directory swap that preserves mode `0600`. On exit 20, discard it.
 * The staged temp is always removed (rename consumes it on the copy path; the
 * finally cleans it up otherwise), so a failure never leaves a partial file.
 * Never logs token bytes — only the decision outcome.
 */
export async function copyBackCodexAuth(input: CopyBackCodexAuthInput): Promise<CopyBackCodexAuthOutcome> {
  const { readSandboxAuth, hostAuthPath, log, resolveCacheEntryPath, env } = input;

  // Read first (outside the lock) — a read never mutates the host, so there is
  // nothing to serialize yet. A genuinely absent sandbox `auth.json` (ENOENT —
  // e.g. Codex removed it mid-run, or a non-provisioned edge) is a "nothing to
  // copy back" no-op, not a teardown failure: return `kept-host` and log the
  // benign outcome. Every other read error stays fail-loud so a real read fault
  // is never silently mistaken for "nothing to copy back".
  let sandboxAuthBytes: Buffer;
  try {
    sandboxAuthBytes = await readSandboxAuth();
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      await log(
        "[paperclip] Codex auth copy-back: no sandbox credential to copy back (absent auth.json); host credential kept.",
      );
      return "kept-host";
    }
    throw error;
  }

  const hostDir = path.dirname(hostAuthPath);
  try {
    const hostOutcome = await withDirectoryMergeLock(hostDir, async () => {
      // Stage on the same filesystem as the host target so both the predicate read
      // and the final rename stay device-local (rename across devices is not
      // atomic and would fail with EXDEV).
      const stagedTempPath = path.join(hostDir, `.auth.json.copyback-${process.pid}-${randomUUID()}.tmp`);
      // `wx` + explicit mode create the temp private (0600) and fail if it somehow
      // already exists, so we never write through a pre-existing symlink.
      const handle = await open(stagedTempPath, "wx", 0o600);
      try {
        await handle.writeFile(sandboxAuthBytes);
        await handle.close();

        const decision = await decideCodexAuthMerge(stagedTempPath, hostAuthPath, {
          errorLabel: "codex auth copy-back",
        });
        if (decision === USE_SOURCE_EXIT) {
          // Atomic same-directory swap; rename preserves the temp's 0600 mode.
          await rename(stagedTempPath, hostAuthPath);
          await log(
            "[paperclip] Codex auth copy-back: sandbox credential is strictly newer for the same subscription identity; installed to the host at mode 0600.",
          );
          return "copied";
        }

        await log(
          "[paperclip] Codex auth copy-back: host credential kept (sandbox copy is not a strictly-newer same-identity subscription credential).",
        );
        return "kept-host";
      } finally {
        // Close is idempotent-safe to skip after an explicit close; the temp is the
        // thing that must never linger. On the copy path rename already consumed it
        // (force makes the removal a no-op); on every other path this deletes the
        // staged credential bytes.
        await handle.close().catch(() => undefined);
        await rm(stagedTempPath, { force: true }).catch(() => undefined);
      }
    });

    // Additive cache write. Independent of the host default overwrite above: it
    // runs on its own directory lock, keys the slot by the real sandbox
    // `account_id`, and can write a slot for a different identity than the host
    // holds. It never touches the host default store. The off-switch (default on)
    // makes this a no-op when disabled. Only a usable subscription credential has
    // an identity to key; an api-key or unusable sandbox credential is skipped.
    //
    // The cache write is best-effort. The host copy-back above already finished
    // and set `hostOutcome`, so a failure of this additive write must not replace
    // that successful result. Catch the error, log it, and return `hostOutcome`.
    // The cache stays a hint: the next teardown re-attempts the write.
    if (resolveCacheEntryPath && isCodexAuthCacheEnabled(env)) {
      try {
        const sandboxAccountId = readSubscriptionAccountId(sandboxAuthBytes);
        if (sandboxAccountId) {
          const cacheEntryPath = await resolveCacheEntryPath(sandboxAccountId);
          await writeCodexAuthCacheEntry({ sandboxAuthBytes, cacheEntryPath, log, env });
        }
      } catch (error) {
        // Log only the errno code, never the error message. The message embeds the
        // cache slot path, and the slot path embeds the raw `account_id`; the code
        // (for example EACCES or ENOSPC) makes the failure diagnosable without a
        // leak. Token bytes never reach the log.
        const code = (error as NodeJS.ErrnoException | null)?.code ?? "unknown";
        // The host copy-back above already finished and set `hostOutcome`. This
        // diagnostic log is the last step, so a rejecting logger must not throw
        // and turn that successful result into a failed copy-back. Guard the log:
        // a rejection here is swallowed, and the function still returns
        // `hostOutcome` below.
        await Promise.resolve(
          log(
            `[paperclip] Codex auth cache: additive cache write failed (${code}); host copy-back result kept.`,
          ),
        ).catch(() => undefined);
      }
    }

    return hostOutcome;
  } catch (error) {
    // ENOENT anywhere in the locked host-side sequence means some part of the
    // shared host store's path is missing: the lock `mkdir` when an ANCESTOR of
    // the host directory is absent (the lock lives in a sibling of `hostDir`,
    // so a missing ancestor fails lock acquisition before staging even runs),
    // the staging `open` when the host directory itself is the missing leaf, or
    // the writeFile/rename if the directory vanishes mid-sequence. All shapes
    // mean the same thing: a shared codex home that never existed (e.g. a
    // multi-tenant cloud server whose credentials live only in managed
    // per-company homes) or one deleted between the caller's launch-time check
    // and teardown. There is nothing to merge into, so treat it exactly like
    // the absent-sandbox-auth branch above and keep the host. Deliberately NOT
    // `mkdir`: creating the shared directory here would leak this run's
    // credential into the store every other tenant's managed home is seeded
    // from. The decision predicate never surfaces a coded ENOENT (it rewraps
    // spawn failures into plain Errors), so every non-ENOENT failure stays
    // fail-loud.
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      await log(
        "[paperclip] Codex auth copy-back: no shared host credential store (host codex home path is absent); nothing to merge into, host left untouched.",
      );
      return "kept-host";
    }
    throw error;
  }
}

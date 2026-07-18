import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { PluginStateClient } from "@paperclipai/plugin-sdk";

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

export function signStubPayload(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

export function verifyStubSignature(secret: string, rawBody: string, signature: string | undefined): boolean {
  if (!signature || !/^[0-9a-f]+$/i.test(signature)) return false;
  const expected = Buffer.from(signStubPayload(secret, rawBody), "hex");
  let provided: Buffer;
  try {
    provided = Buffer.from(signature, "hex");
  } catch {
    return false;
  }
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(expected, provided);
}

/** Node lowercases inbound header names, but be defensive: case-insensitive lookup, first value wins. */
export function headerValue(headers: Record<string, string | string[]>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

const SECRET_STATE_KEY = "stub-webhook-secret";

/**
 * Per-install stub webhook secret: generated once, persisted in
 * instance-scoped plugin state. Never logged, never placed in config JSON.
 */
export async function ensureStubWebhookSecret(state: PluginStateClient): Promise<string> {
  const existing = await state.get({ scopeKind: "instance", stateKey: SECRET_STATE_KEY });
  if (typeof existing === "string" && /^[0-9a-f]{64}$/.test(existing)) return existing;
  const secret = randomBytes(32).toString("hex");
  await state.set({ scopeKind: "instance", stateKey: SECRET_STATE_KEY }, secret);
  return secret;
}

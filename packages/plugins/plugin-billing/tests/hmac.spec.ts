import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PluginStateClient } from "@paperclipai/plugin-sdk";
import { ensureStubWebhookSecret, headerValue, signStubPayload, verifyStubSignature } from "../src/hmac.js";

describe("stub HMAC", () => {
  it("signs with HMAC-SHA256 hex over the exact raw body", () => {
    const expected = createHmac("sha256", "s3cret").update("{\"a\":1}").digest("hex");
    expect(signStubPayload("s3cret", "{\"a\":1}")).toBe(expected);
  });

  it("verifies a valid signature and rejects tampered body, wrong secret, missing or malformed signature", () => {
    const body = JSON.stringify({ type: "payment.succeeded", subRef: "psub-1" });
    const sig = signStubPayload("s3cret", body);
    expect(verifyStubSignature("s3cret", body, sig)).toBe(true);
    expect(verifyStubSignature("s3cret", body + " ", sig)).toBe(false);
    expect(verifyStubSignature("other", body, sig)).toBe(false);
    expect(verifyStubSignature("s3cret", body, undefined)).toBe(false);
    expect(verifyStubSignature("s3cret", body, "zz-not-hex")).toBe(false);
    expect(verifyStubSignature("s3cret", body, sig.slice(0, 10))).toBe(false);
  });

  it("headerValue is case-insensitive and unwraps arrays", () => {
    const headers = { "X-Billing-Stub-Signature": ["abc", "def"], other: "x" };
    expect(headerValue(headers, "x-billing-stub-signature")).toBe("abc");
    expect(headerValue(headers, "missing")).toBeUndefined();
  });
});

describe("ensureStubWebhookSecret", () => {
  function fakeState(): { state: PluginStateClient; values: Map<string, unknown> } {
    const values = new Map<string, unknown>();
    const key = (input: { scopeKind: string; stateKey: string }) => `${input.scopeKind}:${input.stateKey}`;
    const state = {
      async get(input: { scopeKind: "instance"; stateKey: string }) { return values.get(key(input)) ?? null; },
      async set(input: { scopeKind: "instance"; stateKey: string }, value: unknown) { values.set(key(input), value); },
      async delete() {},
    } as unknown as PluginStateClient;
    return { state, values };
  }

  it("generates a 64-hex-char secret once and returns the same one afterwards", async () => {
    const { state } = fakeState();
    const first = await ensureStubWebhookSecret(state);
    const second = await ensureStubWebhookSecret(state);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
  });
});

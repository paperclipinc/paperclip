import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  resolveCompanyInferenceKey,
  applyCompanyInferenceKey,
  INFERENCE_AUTH_ENV_KEYS,
  __resetInferenceKeyCache,
} from "../../src/inference-key-resolver.js";

const RESOLVER_URL = "http://control-plane.paperclip.svc.cluster.local:8080";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  __resetInferenceKeyCache();
});

describe("resolveCompanyInferenceKey", () => {
  it("POSTs {companyId} to <url>/internal/bifrost-key and returns keyValue", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ keyValue: "vk-acme-123" }));
    const key = await resolveCompanyInferenceKey({
      resolverUrl: RESOLVER_URL,
      companyId: "acme",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(key).toBe("vk-acme-123");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${RESOLVER_URL}/internal/bifrost-key`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ companyId: "acme" });
  });

  it("tolerates a trailing slash on the resolver URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ keyValue: "vk-x" }));
    await resolveCompanyInferenceKey({
      resolverUrl: `${RESOLVER_URL}/`,
      companyId: "c1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl.mock.calls[0][0]).toBe(`${RESOLVER_URL}/internal/bifrost-key`);
  });

  it("caches by companyId for the process lifetime (no second round-trip)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ keyValue: "vk-cached" }));
    const a = await resolveCompanyInferenceKey({
      resolverUrl: RESOLVER_URL,
      companyId: "co",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const b = await resolveCompanyInferenceKey({
      resolverUrl: RESOLVER_URL,
      companyId: "co",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(a).toBe("vk-cached");
    expect(b).toBe("vk-cached");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("FAIL-CLOSED: throws on non-2xx (does not return a key)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: "nope" }, 500));
    await expect(
      resolveCompanyInferenceKey({
        resolverUrl: RESOLVER_URL,
        companyId: "acme",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/returned 500/);
  });

  it("FAIL-CLOSED: throws on a network error", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(
      resolveCompanyInferenceKey({
        resolverUrl: RESOLVER_URL,
        companyId: "acme",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/Failed to resolve per-company inference key/);
  });

  it("FAIL-CLOSED: throws when keyValue is missing or empty", async () => {
    const fetchEmpty = vi.fn().mockResolvedValue(jsonResponse({ keyValue: "" }));
    await expect(
      resolveCompanyInferenceKey({
        resolverUrl: RESOLVER_URL,
        companyId: "acme",
        fetchImpl: fetchEmpty as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/returned no keyValue/);

    __resetInferenceKeyCache();
    const fetchMissing = vi.fn().mockResolvedValue(jsonResponse({ other: "x" }));
    await expect(
      resolveCompanyInferenceKey({
        resolverUrl: RESOLVER_URL,
        companyId: "acme2",
        fetchImpl: fetchMissing as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/returned no keyValue/);
  });

  it("FAIL-CLOSED: a failed resolve is NOT cached (next call retries)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse({ keyValue: "vk-recovered" }));
    await expect(
      resolveCompanyInferenceKey({
        resolverUrl: RESOLVER_URL,
        companyId: "co",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow();
    const key = await resolveCompanyInferenceKey({
      resolverUrl: RESOLVER_URL,
      companyId: "co",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(key).toBe("vk-recovered");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("applyCompanyInferenceKey", () => {
  it("overrides only the auth keys that are present, leaving base URLs untouched", () => {
    const env = {
      ANTHROPIC_API_KEY: "shared-platform-vk",
      ANTHROPIC_BASE_URL: "http://bifrost:8080",
      SOME_OTHER: "keep",
    };
    const out = applyCompanyInferenceKey(env, "vk-company");
    expect(out).toEqual({
      ANTHROPIC_API_KEY: "vk-company",
      ANTHROPIC_BASE_URL: "http://bifrost:8080",
      SOME_OTHER: "keep",
    });
  });

  it("does NOT add auth keys that the adapter does not use (absent stays absent)", () => {
    const env = { ANTHROPIC_API_KEY: "shared", BASE: "x" };
    const out = applyCompanyInferenceKey(env, "vk");
    expect("OPENAI_API_KEY" in out).toBe(false);
    expect("GEMINI_API_KEY" in out).toBe(false);
  });

  it("overrides every present auth key (multi-provider adapter)", () => {
    const env = {
      ANTHROPIC_API_KEY: "a",
      OPENAI_API_KEY: "o",
      GEMINI_API_KEY: "g",
      OPENROUTER_API_KEY: "or",
    };
    const out = applyCompanyInferenceKey(env, "vk");
    expect(out.ANTHROPIC_API_KEY).toBe("vk");
    expect(out.OPENAI_API_KEY).toBe("vk");
    expect(out.GEMINI_API_KEY).toBe("vk");
    // OPENROUTER_API_KEY is not in the auth-override set; left as-is.
    expect(out.OPENROUTER_API_KEY).toBe("or");
  });

  it("does not mutate the input env", () => {
    const env = { ANTHROPIC_API_KEY: "shared" };
    applyCompanyInferenceKey(env, "vk");
    expect(env.ANTHROPIC_API_KEY).toBe("shared");
  });

  it("INFERENCE_AUTH_ENV_KEYS is exactly the three provider auth keys", () => {
    expect([...INFERENCE_AUTH_ENV_KEYS]).toEqual([
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GEMINI_API_KEY",
    ]);
  });
});

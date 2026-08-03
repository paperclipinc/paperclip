import { describe, expect, it } from "vitest";
import { codexLocalCredentialSetup } from "./credential-setup.js";

describe("codexLocalCredentialSetup", () => {
  it("exports credential options with correct envKeys", () => {
    const envKeys = codexLocalCredentialSetup.options.map(o => o.envKey);
    expect(envKeys).toEqual(["OPENAI_API_KEY", "CODEX_AUTH_JSON"]);
  });

  it("configures api_key option with correct label and setupUrl", () => {
    const apiKeyOption = codexLocalCredentialSetup.options.find(o => o.envKey === "OPENAI_API_KEY");
    expect(apiKeyOption).toBeDefined();
    expect(apiKeyOption?.kind).toBe("api_key");
    expect(apiKeyOption?.label).toBe("OpenAI API key");
    expect(apiKeyOption?.setupUrl).toBe("https://platform.openai.com/api-keys");
    expect(apiKeyOption?.placeholder).toBe("sk-…");
  });

  it("anchors valuePattern to OpenAI key shapes and rejects Anthropic keys", () => {
    const apiKeyOption = codexLocalCredentialSetup.options.find(o => o.envKey === "OPENAI_API_KEY");
    const pattern = new RegExp(apiKeyOption!.valuePattern!);

    // Legacy, project-scoped, and service-account OpenAI keys all pass.
    expect(pattern.test("sk-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKl")).toBe(true);
    expect(pattern.test("sk-proj-AbCdEfGhIjKlMnOpQrStUvWx_yz-0123456789AbCdEfGhIjKlMnOpQrStUvWxYz0123456789")).toBe(true);
    expect(pattern.test("sk-svcacct-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789")).toBe(true);

    // An Anthropic key shares the "sk-" prefix but must never bind to
    // OPENAI_API_KEY (it would fail every run with a 401).
    expect(pattern.test("sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789")).toBe(false);
    expect(pattern.test("sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789")).toBe(false);

    // Whitespace-corrupted pastes (terminal line-wrap) must not pass.
    expect(pattern.test("sk-proj-AbCdEf GhIjKlMnOpQrStUvWxYz0123456789")).toBe(false);
    expect(pattern.test("sk-proj-AbCdEf\nGhIjKlMnOpQrStUvWxYz0123456789")).toBe(false);
  });

  it("offers the plan route as a credential the USER supplies, not one read off the server", () => {
    // History worth keeping, because the distinction is the whole bug. The
    // api-key hint used to advertise "log in with `codex login` locally and
    // Paperclip's CODEX_HOME sync will ship the credential to remote runs",
    // and a test asserted that it did. That is true only when you self-host,
    // where the sync source is your own machine; on a hosted install it is the
    // shared server, so the promise was empty and cost us a customer.
    //
    // `codex login` is back, but inverted: the user runs it on their machine
    // and hands us the RESULT, which we store as their credential. Nothing is
    // read off the server. So the assertion is not "never mention codex login"
    // but "the plan route carries its own credential".
    const apiKeyOption = codexLocalCredentialSetup.options.find(o => o.envKey === "OPENAI_API_KEY");
    expect(apiKeyOption?.hint).not.toContain("CODEX_HOME");
    expect(apiKeyOption?.hint).not.toContain("codex login");

    const planOption = codexLocalCredentialSetup.options.find(o => o.envKey === "CODEX_AUTH_JSON");
    expect(planOption).toBeDefined();
    expect(planOption?.kind).toBe("subscription_token");
    expect(planOption?.setupCommand).toBe("codex login");
    // "on your own computer" is the load-bearing phrase: without it this reads
    // exactly like the instruction nobody could follow.
    expect(planOption?.hint).toContain("on your own computer");
    expect(planOption?.hint).toContain("auth.json");
  });

  it("accepts a pasted auth.json and rejects the things people paste by mistake", () => {
    const planOption = codexLocalCredentialSetup.options.find(o => o.envKey === "CODEX_AUTH_JSON");
    const pattern = new RegExp(planOption!.valuePattern!);

    expect(pattern.test('{"tokens":{"account_id":"a","refresh_token":"r"}}')).toBe(true);
    // Real files are pretty-printed and trail a newline.
    expect(pattern.test('\n{\n  "tokens": {\n    "account_id": "a"\n  }\n}\n')).toBe(true);

    // The two actual mistakes: pasting the key, or the path to the file.
    expect(pattern.test("sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789")).toBe(false);
    expect(pattern.test("~/.codex/auth.json")).toBe(false);
    expect(pattern.test("")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { codexLocalCredentialSetup } from "./credential-setup.js";

describe("codexLocalCredentialSetup", () => {
  it("exports credential options with correct envKeys", () => {
    const envKeys = codexLocalCredentialSetup.options.map(o => o.envKey);
    expect(envKeys).toEqual(["OPENAI_API_KEY"]);
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

  it("does not offer `codex login` as a ChatGPT-subscription route", () => {
    // This assertion used to be its exact inverse: the hint advertised
    // "log in with `codex login` locally and Paperclip's CODEX_HOME sync will
    // ship the credential to remote runs", and this test held it in place.
    //
    // That is true only when you self-host, where the sync source is your own
    // machine. On a hosted install the source is the shared server, so there is
    // no login a customer could perform and no credential of theirs to ship. A
    // paying customer followed the promise, found nothing, and asked for a
    // refund. The hint must offer the key, and must not imply a plan will do.
    const apiKeyOption = codexLocalCredentialSetup.options.find(o => o.envKey === "OPENAI_API_KEY");
    expect(apiKeyOption?.hint).not.toContain("codex login");
    expect(apiKeyOption?.hint).not.toContain("CODEX_HOME");
    expect(apiKeyOption?.hint).toContain("credit");
    expect(apiKeyOption?.hint).toContain("ChatGPT Plus or Pro plan does not cover this");
  });
});

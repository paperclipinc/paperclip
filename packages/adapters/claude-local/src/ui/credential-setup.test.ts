import { describe, expect, it } from "vitest";
import { claudeLocalCredentialSetup } from "./credential-setup.js";

describe("claudeLocalCredentialSetup", () => {
  it("exports credential options with correct envKeys", () => {
    const envKeys = claudeLocalCredentialSetup.options.map(o => o.envKey);
    expect(envKeys).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]);
  });

  it("configures subscription_token option with setupCommand", () => {
    const tokenOption = claudeLocalCredentialSetup.options.find(o => o.envKey === "CLAUDE_CODE_OAUTH_TOKEN");
    expect(tokenOption).toBeDefined();
    expect(tokenOption?.kind).toBe("subscription_token");
    expect(tokenOption?.setupCommand).toBe("claude setup-token");
  });

  it("anchors valuePatterns to the full token shape while keeping api/oat disambiguation", () => {
    const [apiOption, oatOption] = claudeLocalCredentialSetup.options;
    const apiPattern = new RegExp(apiOption.valuePattern!);
    const oatPattern = new RegExp(oatOption.valuePattern!);

    expect(apiPattern.test("sk-ant-api03-AbCdEf_GhIjKl-MnOpQrStUvWx")).toBe(true);
    expect(oatPattern.test("sk-ant-oat01-AbCdEf_GhIjKl-MnOpQrStUvWx")).toBe(true);

    // Whitespace-corrupted pastes (terminal line-wrap) must not pass.
    expect(oatPattern.test("sk-ant-oat01-AbCdEf  GhIjKl")).toBe(false);
    expect(oatPattern.test("sk-ant-oat01-AbCdEf\nGhIjKl")).toBe(false);
    expect(apiPattern.test("sk-ant-api03-AbCdEf  GhIjKl")).toBe(false);

    // A subscription token must still never match the API key option.
    expect(apiPattern.test("sk-ant-oat01-AbCdEfGhIjKlMnOp")).toBe(false);
    expect(oatPattern.test("sk-ant-api03-AbCdEfGhIjKlMnOp")).toBe(false);
  });

  it("includes hint text mentioning both quota and extra usage for subscription_token", () => {
    const tokenOption = claudeLocalCredentialSetup.options.find(o => o.envKey === "CLAUDE_CODE_OAUTH_TOKEN");
    expect(tokenOption?.hint).toContain("quota");
    expect(tokenOption?.hint).toContain("extra usage");
  });
});

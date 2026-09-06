import { describe, expect, it } from "vitest";
import { mergeInheritedCredentialEnv, planCompanyCredentialBackfill } from "../services/agent-credential-inheritance.js";

describe("mergeInheritedCredentialEnv (new agents inherit the company credential)", () => {
  const donorCred = { type: "secret_ref", secretId: "sec-1", version: "latest" };

  it("inherits a donor secret_ref the new agent does not have", () => {
    expect(mergeInheritedCredentialEnv({ CLAUDE_CODE_OAUTH_TOKEN: donorCred }, {})).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: { type: "secret_ref", secretId: "sec-1", version: "latest" },
    });
  });

  it("never overrides an env key the request already set (even to a different value)", () => {
    const requested = { CLAUDE_CODE_OAUTH_TOKEN: { type: "secret_ref", secretId: "own" } };
    expect(mergeInheritedCredentialEnv({ CLAUDE_CODE_OAUTH_TOKEN: donorCred }, requested)).toEqual(requested);
  });

  it("only inherits secret_ref bindings (ignores plain/string/non-secret env)", () => {
    const donorEnv = {
      CLAUDE_CODE_OAUTH_TOKEN: donorCred,
      SOME_FLAG: "plain-value",
      OTHER: { type: "plain", value: "x" },
    };
    expect(mergeInheritedCredentialEnv(donorEnv, {})).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: { type: "secret_ref", secretId: "sec-1", version: "latest" },
    });
  });

  it("preserves projectionClass / projectionAllowlistKey / version verbatim", () => {
    const donorEnv = {
      ANTHROPIC_API_KEY: {
        type: "secret_ref",
        secretId: "sec-2",
        version: 3,
        projectionClass: "class3_static_lease",
        projectionAllowlistKey: "allow-abc",
      },
    };
    expect(mergeInheritedCredentialEnv(donorEnv, {})).toEqual({
      ANTHROPIC_API_KEY: {
        type: "secret_ref",
        secretId: "sec-2",
        version: 3,
        projectionClass: "class3_static_lease",
        projectionAllowlistKey: "allow-abc",
      },
    });
  });

  it("is a no-op when the donor has no secret_ref credentials", () => {
    expect(mergeInheritedCredentialEnv({ FLAG: "x" }, { EXISTING: { type: "secret_ref", secretId: "e" } })).toEqual({
      EXISTING: { type: "secret_ref", secretId: "e" },
    });
  });

  it("keeps the new agent's own env alongside inherited credentials", () => {
    const merged = mergeInheritedCredentialEnv(
      { CLAUDE_CODE_OAUTH_TOKEN: donorCred },
      { MY_VAR: { type: "plain", value: "keep" } },
    );
    expect(merged).toEqual({
      MY_VAR: { type: "plain", value: "keep" },
      CLAUDE_CODE_OAUTH_TOKEN: { type: "secret_ref", secretId: "sec-1", version: "latest" },
    });
  });
});

// Inheritance used to run only when an agent was CREATED. The normal order of
// events is the opposite: a company (and its built-in agents) exist from
// signup, and the user connects a provider key afterwards. Every built-in agent
// therefore stayed credential-less forever, and a factory-config built-in agent
// could never run. A real hosted company hit exactly this: an active
// company-scoped Claude token bound only to the one agent the user made by
// hand, while the built-in Summarizer sat paused on "Connect a model key to run
// this agent."
describe("planCompanyCredentialBackfill (existing agents pick up a later-connected key)", () => {
  const cred = { type: "secret_ref", secretId: "sec-1", version: "latest" };
  const withCred = { env: { CLAUDE_CODE_OAUTH_TOKEN: cred } };

  it("gives the donor's credential to an agent that has none", () => {
    const plan = planCompanyCredentialBackfill([
      { id: "donor", role: "ceo", adapterConfig: withCred },
      { id: "summarizer", role: "worker", adapterConfig: { model: "x" } },
    ]);
    expect(plan).toEqual([
      { agentId: "summarizer", adapterConfig: { model: "x", env: { CLAUDE_CODE_OAUTH_TOKEN: cred } } },
    ]);
  });

  it("covers a built-in agent whose adapterConfig has no env at all", () => {
    const plan = planCompanyCredentialBackfill([
      { id: "donor", role: "worker", adapterConfig: withCred },
      { id: "builtin", role: "worker", adapterConfig: {} },
    ]);
    expect(plan.map((entry) => entry.agentId)).toEqual(["builtin"]);
    expect(plan[0]?.adapterConfig).toEqual({ env: { CLAUDE_CODE_OAUTH_TOKEN: cred } });
  });

  it("never touches an agent that already has its own credential", () => {
    const own = { type: "secret_ref", secretId: "sec-own", version: "latest" };
    const plan = planCompanyCredentialBackfill([
      { id: "donor", role: "ceo", adapterConfig: withCred },
      { id: "other", role: "worker", adapterConfig: { env: { CLAUDE_CODE_OAUTH_TOKEN: own } } },
    ]);
    expect(plan).toEqual([]);
  });

  it("does nothing when no agent in the company has a credential yet", () => {
    expect(planCompanyCredentialBackfill([
      { id: "a", role: "ceo", adapterConfig: {} },
      { id: "b", role: "worker", adapterConfig: { env: { SOME_FLAG: "plain" } } },
    ])).toEqual([]);
  });

  it("prefers the ceo as donor, like the create-time path", () => {
    const ceoCred = { type: "secret_ref", secretId: "sec-ceo", version: "latest" };
    const plan = planCompanyCredentialBackfill([
      { id: "worker-with-key", role: "worker", adapterConfig: withCred },
      { id: "ceo", role: "ceo", adapterConfig: { env: { CLAUDE_CODE_OAUTH_TOKEN: ceoCred } } },
      { id: "needs-key", role: "worker", adapterConfig: {} },
    ]);
    expect(plan).toEqual([
      { agentId: "needs-key", adapterConfig: { env: { CLAUDE_CODE_OAUTH_TOKEN: ceoCred } } },
    ]);
  });

  it("is a no-op on a second pass, so repeated connects do not rewrite agents", () => {
    const rows = [
      { id: "donor", role: "ceo", adapterConfig: withCred },
      { id: "needs-key", role: "worker", adapterConfig: {} },
    ];
    const first = planCompanyCredentialBackfill(rows);
    const settled = rows.map((row) => {
      const write = first.find((entry) => entry.agentId === row.id);
      return write ? { ...row, adapterConfig: write.adapterConfig } : row;
    });
    expect(planCompanyCredentialBackfill(settled)).toEqual([]);
  });
});

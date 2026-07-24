import type { AdapterCredentialSetup } from "@paperclipai/adapter-utils";

export const codexLocalCredentialSetup: AdapterCredentialSetup = {
  options: [
    {
      envKey: "OPENAI_API_KEY",
      kind: "api_key",
      label: "OpenAI API key",
      hint: "Create a key in the OpenAI API console. Alternatively, you can log in with `codex login` locally and Paperclip's CODEX_HOME sync will ship the credential to remote runs.",
      setupUrl: "https://platform.openai.com/api-keys",
      placeholder: "sk-…",
      // OpenAI keys are "sk-" plus a long url-safe body (sk-proj-…, sk-svcacct-…,
      // legacy sk-…). The lookahead rejects Anthropic "sk-ant-…" keys, which share
      // the "sk-" prefix and would otherwise bind silently to OPENAI_API_KEY and
      // fail every run with a 401.
      valuePattern: "^sk-(?!ant-)[A-Za-z0-9_-]{20,}$",
    },
  ],
};

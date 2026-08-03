import type { AdapterCredentialSetup } from "@paperclipai/adapter-utils";

export const codexLocalCredentialSetup: AdapterCredentialSetup = {
  options: [
    {
      envKey: "OPENAI_API_KEY",
      kind: "api_key",
      label: "OpenAI API key",
      // The `codex login` half of this hint was true only for a self-hosted
      // install, where "locally" means the machine running Paperclip and the
      // CODEX_HOME sync ships that operator's own credential outward. On a
      // hosted install the sync source is the shared server, which no tenant
      // can log into, so the sentence promised a route that does not exist and
      // sent at least one paying customer hunting for it until they gave up.
      hint: "Create a key in the OpenAI API console and make sure the account has credit. A ChatGPT Plus or Pro plan does not cover this and cannot be used here.",
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

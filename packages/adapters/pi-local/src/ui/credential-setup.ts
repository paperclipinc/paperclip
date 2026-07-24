import type { AdapterCredentialSetup } from "@paperclipai/adapter-utils";

export const piLocalCredentialSetup: AdapterCredentialSetup = {
  options: [
    {
      envKey: "ANTHROPIC_API_KEY",
      kind: "api_key",
      label: "Anthropic API key",
      setupUrl: "https://console.anthropic.com/settings/keys",
      placeholder: "sk-ant-…",
      // Anthropic credentials always start with "sk-ant-"; rejects OpenAI-style
      // "sk-…" keys pasted into the wrong slot.
      valuePattern: "^sk-ant-[A-Za-z0-9_-]+$",
    },
  ],
};

import type { AdapterCredentialSetup } from "@paperclipai/adapter-utils";

export const openCodeLocalCredentialSetup: AdapterCredentialSetup = {
  options: [
    {
      envKey: "ANTHROPIC_API_KEY",
      kind: "api_key",
      label: "Anthropic API key",
      hint: "OpenCode uses whichever provider API key matches the selected model.",
      valuePattern: "^sk-ant-[A-Za-z0-9_-]+$",
    },
    {
      envKey: "OPENAI_API_KEY",
      kind: "api_key",
      // The lookahead keeps the three "sk-" prefixed providers mutually
      // exclusive: sk-ant-… is Anthropic, sk-or-… is OpenRouter.
      label: "OpenAI API key",
      valuePattern: "^sk-(?!ant-|or-)[A-Za-z0-9_-]{20,}$",
    },
    {
      envKey: "OPENROUTER_API_KEY",
      kind: "api_key",
      label: "OpenRouter API key",
      valuePattern: "^sk-or-[A-Za-z0-9_-]+$",
    },
  ],
};

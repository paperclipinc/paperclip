import type { AdapterCredentialSetup } from "@paperclipai/adapter-utils";

export const geminiLocalCredentialSetup: AdapterCredentialSetup = {
  options: [
    {
      envKey: "GEMINI_API_KEY",
      kind: "api_key",
      label: "Gemini API key",
      setupUrl: "https://aistudio.google.com/apikey",
      placeholder: "AIza…",
      // Google API keys always start with "AIza"; rejects other providers' keys
      // (sk-…, sk-ant-…) pasted into the wrong slot.
      valuePattern: "^AIza[A-Za-z0-9_-]{10,}$",
    },
  ],
};

import type { AdapterCredentialSetup } from "@paperclipai/adapter-utils";

export const codexLocalCredentialSetup: AdapterCredentialSetup = {
  options: [
    {
      envKey: "OPENAI_API_KEY",
      kind: "api_key",
      label: "OpenAI API key",
      // The original hint pointed at `codex login` + CODEX_HOME sync, which is
      // real only when you self-host: the sync source is the machine running
      // Paperclip. On a hosted install that is the shared server, so the
      // sentence promised a route that did not exist and cost us a customer.
      // The plan route now exists as its own option below, where the user
      // supplies the credential instead of us reading one off the server.
      hint: "Create a key in the OpenAI API console and make sure the account has credit. Billed by usage, separately from any ChatGPT plan.",
      setupUrl: "https://platform.openai.com/api-keys",
      placeholder: "sk-…",
      // OpenAI keys are "sk-" plus a long url-safe body (sk-proj-…, sk-svcacct-…,
      // legacy sk-…). The lookahead rejects Anthropic "sk-ant-…" keys, which share
      // the "sk-" prefix and would otherwise bind silently to OPENAI_API_KEY and
      // fail every run with a 401.
      valuePattern: "^sk-(?!ant-)[A-Za-z0-9_-]{20,}$",
    },
    {
      envKey: "CODEX_AUTH_JSON",
      kind: "subscription_token",
      label: "ChatGPT Plus or Pro plan",
      hint: "Run `codex login` on your own computer, then paste the whole contents of ~/.codex/auth.json. Paperclip keeps it refreshed for you, so you only do this once.",
      setupCommand: "codex login",
      placeholder: '{"tokens":{"access_token":"…","refresh_token":"…","account_id":"…"}}',
      // Deliberately loose: this is a JSON document Codex owns and may extend,
      // so anchoring on today's exact fields would reject a valid credential the
      // day OpenAI adds one. This catches the two mistakes people actually make
      // (pasting an API key, or a file path instead of the file contents); the
      // real shape check runs server-side, where a bad payload can be explained
      // rather than silently refused by a regex.
      valuePattern: "^\\s*\\{[\\s\\S]*\\}\\s*$",
    },
  ],
};

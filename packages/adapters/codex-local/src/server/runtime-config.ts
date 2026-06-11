import fs from "node:fs/promises";
import path from "node:path";

type PreparedCodexRuntimeConfig = {
  notes: string[];
  cleanup: () => Promise<void>;
};

type ParsedCodexProvidersConfig = {
  providers: Record<string, Record<string, unknown>>;
  modelProvider: string | null;
};

// Marker comments delimiting the Paperclip-managed regions of config.toml.
// TOML requires root-level keys (model_provider) to appear before the first
// table header, while [model_providers.*] tables must not swallow the user's
// root keys, so the managed content is split into a root block prepended to
// the file and a tables block appended to it.
const MANAGED_ROOT_BEGIN = "# >>> paperclip codex providers (root) -- managed, do not edit >>>";
const MANAGED_ROOT_END = "# <<< paperclip codex providers (root) <<<";
const MANAGED_TABLES_BEGIN = "# >>> paperclip codex providers (tables) -- managed, do not edit >>>";
const MANAGED_TABLES_END = "# <<< paperclip codex providers (tables) <<<";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Recursively replace {env:VAR} placeholders with the resolved value. Used to bake
// gateway provider secrets into config.toml SERVER-SIDE, where the value is
// reliably present. Prefer codex's own `env_key` indirection (codex reads the
// named env var at request time); placeholder expansion exists for fields that
// must carry a literal value (e.g. http_headers). Unresolvable placeholders are
// left intact.
function expandEnvPlaceholders<T>(value: T, resolve: (name: string) => string | undefined): T {
  if (typeof value === "string") {
    return value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => {
      const resolved = resolve(name);
      return resolved !== undefined && resolved.length > 0 ? resolved : match;
    }) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => expandEnvPlaceholders(entry, resolve)) as unknown as T;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = expandEnvPlaceholders(entry, resolve);
    }
    return out as unknown as T;
  }
  return value;
}

// PAPERCLIP_CODEX_PROVIDERS is a JSON object that maps 1:1 onto codex's
// config.toml schema:
//
//   {
//     "providers": {
//       "<id>": {                      // -> [model_providers.<id>]
//         "name": "My gateway",        // optional display name
//         "base_url": "http://...",    // OpenAI-compatible endpoint
//         "env_key": "OPENAI_API_KEY", // env var codex reads the bearer key from
//         "wire_api": "responses",     // protocol codex speaks to the provider
//         ...                          // any other field codex supports
//         //                              (query_params, http_headers,
//         //                               env_http_headers, request_max_retries, ...)
//       }
//     },
//     "model_provider": "<id>"         // optional: top-level provider selection
//   }
//
// Scalar fields are emitted verbatim as TOML key = value pairs; plain-object
// fields (query_params, http_headers, ...) are emitted as inline tables and
// arrays of scalars as TOML arrays. String values may use {env:VAR}
// placeholders, expanded server-side against the run env and process.env.
function parseCodexProvidersConfig(
  raw: unknown,
  resolveEnv: (name: string) => string | undefined,
  notes: string[],
): ParsedCodexProvidersConfig | null {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Surface the misconfiguration instead of silently dropping the provider
    // config; an unparseable value would otherwise be undiagnosable.
    notes.push("PAPERCLIP_CODEX_PROVIDERS contains invalid JSON; custom providers ignored.");
    return null;
  }
  if (!isPlainObject(parsed)) {
    notes.push("PAPERCLIP_CODEX_PROVIDERS is set but is not a JSON object; custom providers ignored.");
    return null;
  }
  const rawProviders = parsed.providers;
  if (!isPlainObject(rawProviders)) {
    notes.push(
      'PAPERCLIP_CODEX_PROVIDERS has no "providers" object; custom providers ignored.',
    );
    return null;
  }
  // Only keep provider entries with non-empty names and object values; surface
  // the ones we drop so a malformed entry is just as diagnosable as malformed JSON.
  const providers: Record<string, Record<string, unknown>> = {};
  const skipped: string[] = [];
  for (const [key, value] of Object.entries(rawProviders)) {
    if (key.trim().length === 0 || !isPlainObject(value)) {
      skipped.push(key.trim().length === 0 ? "(empty name)" : key);
      continue;
    }
    providers[key] = expandEnvPlaceholders(value, resolveEnv);
  }
  if (Object.keys(providers).length === 0) {
    notes.push(
      `PAPERCLIP_CODEX_PROVIDERS "providers" contains no usable entries${
        skipped.length > 0
          ? ` (skipped provider(s) with empty names or non-object values: ${skipped.join(", ")})`
          : ""
      }; custom providers ignored.`,
    );
    return null;
  }
  if (skipped.length > 0) {
    notes.push(
      `PAPERCLIP_CODEX_PROVIDERS: skipped provider(s) with empty names or non-object values: ${skipped.join(", ")}.`,
    );
  }
  const modelProvider =
    typeof parsed.model_provider === "string" && parsed.model_provider.trim().length > 0
      ? parsed.model_provider.trim()
      : null;
  // A selector pointing at a provider that did not survive filtering (or was
  // never defined) would emit model_provider = "x" with no [model_providers.x]
  // table, which codex rejects at runtime with an error that points nowhere
  // near the env var. Treat it as the same class of misconfiguration as
  // malformed JSON: reject the whole block with a visible note.
  if (modelProvider !== null && !(modelProvider in providers)) {
    notes.push(
      `PAPERCLIP_CODEX_PROVIDERS: model_provider "${modelProvider}" does not match any usable provider entry; custom providers ignored.`,
    );
    return null;
  }
  return { providers, modelProvider };
}

function escapeTomlString(value: string): string {
  // TOML 1.0 basic strings require escaping U+0000-U+001F and U+007F (DEL).
  return value.replace(/[\\"\u0000-\u001f\u007f]/g, (char) => {
    switch (char) {
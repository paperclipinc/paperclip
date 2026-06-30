import fs from "node:fs/promises";
import { findActiveServerAdapter } from "../adapters/index.js";
import { resolveManagedRunDefaults } from "./managed-agent-defaults.js";

// Adapters that consume the managed instructions bundle (AGENTS.md) when an
// adapter module does not declare the capability flag explicitly. Mirrors the
// legacy fallback map in routes/agents.ts.
const DEFAULT_INSTRUCTIONS_BUNDLE_ADAPTER_TYPES = new Set([
  "acpx_local",
  "claude_local",
  "codex_local",
  "droid_local",
  "gemini_local",
  "opencode_local",
  "cursor",
  "pi_local",
]);

/** Whether the given adapter reads the managed instructions bundle at run time. */
export function adapterConsumesInstructionsBundle(adapterType: string): boolean {
  const adapter = findActiveServerAdapter(adapterType);
  if (adapter?.supportsInstructionsBundle !== undefined) return adapter.supportsInstructionsBundle;
  return DEFAULT_INSTRUCTIONS_BUNDLE_ADAPTER_TYPES.has(adapterType);
}

/**
 * Whether a newly created agent should have a default AGENTS.md bundle
 * materialized given its STORED adapter type.
 *
 * Returns true when the stored adapter itself reads the bundle, OR when managed
 * experience is enabled and the run will override the stored adapter (often the
 * inert "process" sentinel that the create schema defaults to) onto a managed
 * default adapter that reads the bundle. Without this, a managed lead agent
 * stored as "process" ships with no AGENTS.md and the run hits ENOENT once the
 * adapter is overridden at run time, leaving the agent with no instructions.
 */
export function shouldMaterializeDefaultInstructionsBundle(storedAdapterType: string): boolean {
  if (adapterConsumesInstructionsBundle(storedAdapterType)) return true;
  const managed = resolveManagedRunDefaults();
  return managed !== null && adapterConsumesInstructionsBundle(managed.adapterType);
}

const DEFAULT_AGENT_BUNDLE_FILES = {
  default: ["AGENTS.md"],
  ceo: ["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"],
} as const;

type DefaultAgentBundleRole = keyof typeof DEFAULT_AGENT_BUNDLE_FILES;

function resolveDefaultAgentBundleUrl(role: DefaultAgentBundleRole, fileName: string) {
  return new URL(`../onboarding-assets/${role}/${fileName}`, import.meta.url);
}

export async function loadDefaultAgentInstructionsBundle(role: DefaultAgentBundleRole): Promise<Record<string, string>> {
  const fileNames = DEFAULT_AGENT_BUNDLE_FILES[role];
  const entries = await Promise.all(
    fileNames.map(async (fileName) => {
      const content = await fs.readFile(resolveDefaultAgentBundleUrl(role, fileName), "utf8");
      return [fileName, content] as const;
    }),
  );
  return Object.fromEntries(entries);
}

export function resolveDefaultAgentInstructionsBundleRole(role: string): DefaultAgentBundleRole {
  return role === "ceo" ? "ceo" : "default";
}

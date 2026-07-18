import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { StandingCommand } from "./domain.js";

export interface StandingSetInput {
  status: "active" | "grace" | "blocked";
  reason: string;
  message: string;
  actionUrl?: string;
}

export interface StandingWriter {
  set(companyId: string, input: StandingSetInput): Promise<void>;
  clear(companyId: string): Promise<void>;
}

/**
 * PR-3 host API surface on ctx.companies
 * (2026-07-18-settings-visibility-and-plugin-enablement-design.md §5.2).
 * The published SDK type does not include it until PR-3 lands, so this is the
 * single cast site in the plugin. Delete the cast when PR-3 merges.
 */
interface CompaniesStandingClient {
  setStanding(companyId: string, input: StandingSetInput): Promise<void>;
  clearStanding(companyId: string): Promise<void>;
}

export function standingWriterFromContext(ctx: PluginContext): StandingWriter {
  const client = ctx.companies as unknown as CompaniesStandingClient;
  return {
    set: (companyId, input) => client.setStanding(companyId, input),
    clear: (companyId) => client.clearStanding(companyId),
  };
}

export async function applyStandingCommand(
  writer: StandingWriter,
  companyId: string,
  command: StandingCommand,
): Promise<void> {
  if (command.kind === "clear") {
    await writer.clear(companyId);
    return;
  }
  await writer.set(companyId, {
    status: command.status,
    reason: command.reason,
    message: command.message,
    ...(command.actionUrl === undefined ? {} : { actionUrl: command.actionUrl }),
  });
}

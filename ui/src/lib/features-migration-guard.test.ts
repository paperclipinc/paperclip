import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Admin-only surfaces that legitimately keep the admin instance-settings API.
const ALLOWLIST = new Set([
  join(SRC_ROOT, "api", "instanceSettings.ts"),
  join(SRC_ROOT, "pages", "InstanceExperimentalSettings.tsx"),
  join(SRC_ROOT, "pages", "InstanceGeneralSettings.tsx"),
  join(SRC_ROOT, "pages", "InstanceAccess.tsx"),
  join(SRC_ROOT, "components", "access", "CompanySurfaceVisibilityCard.tsx"),
  join(SRC_ROOT, "components", "StatusCardsExperimentalGate.tsx"),
  join(SRC_ROOT, "pages", "agent-skills", "AgentSkillsTab.tsx"),
  join(SRC_ROOT, "components", "AgentConfigForm.tsx"),
  join(SRC_ROOT, "components", "BuiltInAgentGate.tsx"),
  join(SRC_ROOT, "components", "IsolatedWorkspacesRouteGate.tsx"),
  join(SRC_ROOT, "components", "Layout.tsx"),
  join(SRC_ROOT, "components", "OnboardingWizard.tsx"),
  join(SRC_ROOT, "components", "SidebarAccountMenu.tsx"),
  join(SRC_ROOT, "components", "SidebarAgents.tsx"),
  join(SRC_ROOT, "hooks", "useClassicTaskInterfaceEnabled.ts"),
  join(SRC_ROOT, "hooks", "useManagedSandboxOnly.ts"),
  // Upstream-owned legacy/production shells and the streamlined-UI probe still
  // read the admin endpoint. They are upstream files the fork does not fork, and
  // useStreamlinedUiEnabled deliberately fails open on a read error, so the
  // board-access migration does not cover them.
  join(SRC_ROOT, "components", "Layout.production.tsx"),
  join(SRC_ROOT, "components", "LegacyIssuesList.tsx"),
  join(SRC_ROOT, "components", "Sidebar.production.tsx"),
  join(SRC_ROOT, "components", "SidebarAgents.production.tsx"),
  join(SRC_ROOT, "hooks", "useStreamlinedUiEnabled.ts"),
  join(SRC_ROOT, "pages", "AgentDetail.production.tsx"),
  join(SRC_ROOT, "pages", "AgentDetail.tsx"),
  join(SRC_ROOT, "pages", "Agents.production.tsx"),
  join(SRC_ROOT, "pages", "LegacyInbox.tsx"),
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe("capabilities.features migration guard", () => {
  it("no non-admin source file reads /instance/settings directly", () => {
    const offenders = walk(SRC_ROOT).filter((file) => {
      if (ALLOWLIST.has(file)) return false;
      const text = readFileSync(file, "utf8");
      return /instanceSettingsApi\.(get|getGeneral|getExperimental)\(/.test(text);
    });
    expect(offenders).toEqual([]);
  });
});

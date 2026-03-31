import type { UIAdapterModule } from "./types";
import { claudeLocalUIAdapter } from "./claude-local";
import { codexLocalUIAdapter } from "./codex-local";
import { cursorLocalUIAdapter } from "./cursor";
import { geminiLocalUIAdapter } from "./gemini-local";
import { hermesLocalUIAdapter } from "./hermes-local";
import { openCodeLocalUIAdapter } from "./opencode-local";
import { piLocalUIAdapter } from "./pi-local";
import { openClawGatewayUIAdapter } from "./openclaw-gateway";
import { processUIAdapter } from "./process";
import { httpUIAdapter } from "./http";

/** Map cloud sandbox runtime names to their local adapter counterparts for transcript parsing. */
const runtimeParserMap: Record<string, UIAdapterModule> = {
  claude: claudeLocalUIAdapter,
  codex: codexLocalUIAdapter,
  opencode: openCodeLocalUIAdapter,
  gemini: geminiLocalUIAdapter,
  pi: piLocalUIAdapter,
  hermes: hermesLocalUIAdapter,
  cursor: cursorLocalUIAdapter,
};

/** Cloud sandbox adapter — config is handled by CloudSandboxFields in AgentConfigForm */
const cloudSandboxUIAdapter: UIAdapterModule = {
  type: "cloud_sandbox",
  label: "Cloud Sandbox",
  parseStdoutLine: claudeLocalUIAdapter.parseStdoutLine,
  ConfigFields: () => null,
  buildAdapterConfig: () => ({ runtime: "claude" }),
};

const uiAdapters: UIAdapterModule[] = [
  claudeLocalUIAdapter,
  codexLocalUIAdapter,
  geminiLocalUIAdapter,
  hermesLocalUIAdapter,
  openCodeLocalUIAdapter,
  piLocalUIAdapter,
  cursorLocalUIAdapter,
  openClawGatewayUIAdapter,
  cloudSandboxUIAdapter,
  processUIAdapter,
  httpUIAdapter,
];

const adaptersByType = new Map<string, UIAdapterModule>(
  uiAdapters.map((a) => [a.type, a]),
);

export function getUIAdapter(type: string): UIAdapterModule {
  return adaptersByType.get(type) ?? processUIAdapter;
}

/** Get the parser for a cloud sandbox runtime (e.g. "claude", "codex", "opencode"). */
export function getCloudSandboxRuntimeParser(runtime: string): UIAdapterModule {
  return runtimeParserMap[runtime] ?? claudeLocalUIAdapter;
}

export function listUIAdapters(): UIAdapterModule[] {
  return [...uiAdapters];
}

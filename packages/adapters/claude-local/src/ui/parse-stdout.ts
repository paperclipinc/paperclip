import type { TranscriptEntry } from "@paperclipai/adapter-utils";
import { parseAcpxStdoutLine } from "@paperclipai/adapter-utils/acpx-engine/ui";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = asRecord(value);
  if (!rec) return "";
  const msg =
    (typeof rec.message === "string" && rec.message) ||
    (typeof rec.error === "string" && rec.error) ||
    (typeof rec.code === "string" && rec.code) ||
    "";
  if (msg) return msg;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function parseClaudeStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }

  const type = typeof parsed.type === "string" ? parsed.type : "";
  if (type.startsWith("acpx.")) {
    return parseAcpxStdoutLine(line, ts);
  }

  // Claude Code emits high-frequency control frames alongside the message stream
  // (rate-limit polls, partial-message token estimates). They carry no transcript
  // value and, when rendered raw, dump JSON between the nicely-formatted messages.
  // Suppress them in "nice" mode (raw mode still shows the full log).
  if (type === "rate_limit_event") return [];

  if (type === "system") {
    const subtype = typeof parsed.subtype === "string" ? parsed.subtype : "";
    if (subtype === "init") {
      return [
        {
          kind: "init",
          ts,
          model: typeof parsed.model === "string" ? parsed.model : "unknown",
          sessionId: typeof parsed.session_id === "string" ? parsed.session_id : "",
        },
      ];
    }
    // Streaming token-estimate deltas are pure noise (one per partial message).
    if (subtype === "thinking_tokens") return [];
    // Sub-task lifecycle and any other system event: render a compact one-line
    // note instead of the raw JSON.
    if (subtype === "task_started") {
      const desc = typeof parsed.description === "string" ? parsed.description : "";
      return [{ kind: "system", ts, text: desc ? `task started: ${desc}` : "task started" }];
    }
    if (subtype === "task_notification") {
      const status = typeof parsed.status === "string" ? parsed.status : "";
      return [{ kind: "system", ts, text: status ? `task ${status}` : "task update" }];
    }
    return [{ kind: "system", ts, text: subtype ? `system: ${subtype}` : "system event" }];
  }

  if (type === "assistant") {
    const message = asRecord(parsed.message) ?? {};
    const content = Array.isArray(message.content) ? message.content : [];
    const entries: TranscriptEntry[] = [];
    for (const blockRaw of content) {
      const block = asRecord(blockRaw);
      if (!block) continue;
      const blockType = typeof block.type === "string" ? block.type : "";
      if (blockType === "text") {
        const text = typeof block.text === "string" ? block.text : "";
        if (text) entries.push({ kind: "assistant", ts, text });
      } else if (blockType === "thinking") {
        const text = typeof block.thinking === "string" ? block.thinking : "";
        if (text) entries.push({ kind: "thinking", ts, text });
      } else if (blockType === "tool_use") {
        entries.push({
          kind: "tool_call",
          ts,
          name: typeof block.name === "string" ? block.name : "unknown",
          toolUseId:
            typeof block.id === "string"
              ? block.id
              : typeof block.tool_use_id === "string"
                ? block.tool_use_id
                : undefined,
          input: block.input ?? {},
        });
      }
    }
    return entries.length > 0 ? entries : [];
  }

  if (type === "user") {
    const message = asRecord(parsed.message) ?? {};
    const content = Array.isArray(message.content) ? message.content : [];
    const entries: TranscriptEntry[] = [];
    for (const blockRaw of content) {
      const block = asRecord(blockRaw);
      if (!block) continue;
      const blockType = typeof block.type === "string" ? block.type : "";
      if (blockType === "text") {
        const text = typeof block.text === "string" ? block.text : "";
        if (text) entries.push({ kind: "user", ts, text });
      } else if (blockType === "tool_result") {
        const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
        const isError = block.is_error === true;
        let text = "";
        if (typeof block.content === "string") {
          text = block.content;
        } else if (Array.isArray(block.content)) {
          const parts: string[] = [];
          for (const part of block.content) {
            const p = asRecord(part);
            if (p && typeof p.text === "string") parts.push(p.text);
          }
          text = parts.join("\n");
        }
        entries.push({ kind: "tool_result", ts, toolUseId, content: text, isError });
      }
    }
    if (entries.length > 0) return entries;
    // user message with no recognized blocks: nothing to show in "nice" mode.
    return [];
  }

  if (type === "result") {
    const usage = asRecord(parsed.usage) ?? {};
    const inputTokens = asNumber(usage.input_tokens);
    const outputTokens = asNumber(usage.output_tokens);
    const cachedTokens = asNumber(usage.cache_read_input_tokens);
    const costUsd = asNumber(parsed.total_cost_usd);
    const subtype = typeof parsed.subtype === "string" ? parsed.subtype : "";
    const isError = parsed.is_error === true;
    const errors = Array.isArray(parsed.errors) ? parsed.errors.map(errorText).filter(Boolean) : [];
    const text = typeof parsed.result === "string" ? parsed.result : "";
    return [{
      kind: "result",
      ts,
      text,
      inputTokens,
      outputTokens,
      cachedTokens,
      costUsd,
      subtype,
      isError,
      errors,
    }];
  }

  // Unrecognized JSON event: render a compact note if it is typed, otherwise drop
  // it. Never dump raw JSON into the "nice" transcript (non-JSON plain-text lines,
  // e.g. "[paperclip] ..." bridge messages, are handled above as stdout).
  return type ? [{ kind: "system", ts, text: type }] : [];
}

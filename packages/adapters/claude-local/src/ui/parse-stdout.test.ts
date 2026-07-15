import { describe, expect, it } from "vitest";
import { parseClaudeStdoutLine } from "./parse-stdout.js";

const TS = "2026-07-15T20:21:29.280Z";

describe("parseClaudeStdoutLine", () => {
  it("renders assistant text blocks", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
    });
    expect(parseClaudeStdoutLine(line, TS)).toEqual([{ kind: "assistant", ts: TS, text: "hello" }]);
  });

  it("renders user tool_result blocks", () => {
    const line = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok", is_error: false }],
      },
    });
    expect(parseClaudeStdoutLine(line, TS)).toEqual([
      { kind: "tool_result", ts: TS, toolUseId: "toolu_1", content: "ok", isError: false },
    ]);
  });

  it("renders the system init frame", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      model: "claude-sonnet-5",
      session_id: "c4a56dd0",
    });
    expect(parseClaudeStdoutLine(line, TS)).toEqual([
      { kind: "init", ts: TS, model: "claude-sonnet-5", sessionId: "c4a56dd0" },
    ]);
  });

  // Regression: these control frames used to fall through to `{ kind: "stdout" }`
  // and dump raw JSON between the nicely-rendered messages in "nice" mode.
  it("suppresses rate_limit_event frames", () => {
    const line = JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        resetsAt: 1784153400,
        rateLimitType: "five_hour",
        overageStatus: "rejected",
        overageDisabledReason: "org_level_disabled",
      },
    });
    expect(parseClaudeStdoutLine(line, TS)).toEqual([]);
  });

  it("suppresses system thinking_tokens streaming deltas", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "thinking_tokens",
      estimated_tokens: 50,
      estimated_tokens_delta: 50,
      uuid: "34603adf",
      session_id: "c4a56dd0",
    });
    expect(parseClaudeStdoutLine(line, TS)).toEqual([]);
  });

  it("renders sub-task lifecycle frames as compact system notes, not raw JSON", () => {
    const started = parseClaudeStdoutLine(
      JSON.stringify({
        type: "system",
        subtype: "task_started",
        task_id: "b8luq6h49",
        tool_use_id: "toolu_2",
        description: "Provision founding engineer",
      }),
      TS,
    );
    expect(started).toEqual([
      { kind: "system", ts: TS, text: "task started: Provision founding engineer" },
    ]);

    const notified = parseClaudeStdoutLine(
      JSON.stringify({ type: "system", subtype: "task_notification", task_id: "b8luq6h49", status: "completed" }),
      TS,
    );
    expect(notified).toEqual([{ kind: "system", ts: TS, text: "task completed" }]);
  });

  it("renders other system subtypes as a compact note", () => {
    const line = JSON.stringify({ type: "system", subtype: "compact_boundary" });
    expect(parseClaudeStdoutLine(line, TS)).toEqual([{ kind: "system", ts: TS, text: "system: compact_boundary" }]);
  });

  it("keeps non-JSON bridge lines as stdout", () => {
    const line = "[paperclip] Claude ACP default unavailable; falling back to Claude CLI.";
    expect(parseClaudeStdoutLine(line, TS)).toEqual([{ kind: "stdout", ts: TS, text: line }]);
  });

  it("does not dump unrecognized JSON events as raw stdout", () => {
    const line = JSON.stringify({ type: "some_future_event", foo: 1 });
    expect(parseClaudeStdoutLine(line, TS)).toEqual([{ kind: "system", ts: TS, text: "some_future_event" }]);
  });

  it("drops typeless JSON control objects", () => {
    const line = JSON.stringify({ status: "allowed", resetsAt: 1784153400 });
    expect(parseClaudeStdoutLine(line, TS)).toEqual([]);
  });
});

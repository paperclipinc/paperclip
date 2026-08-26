import { describe, expect, it } from "vitest";

import {
  REDACTED_COMMAND_TEXT_VALUE,
  redactSensitiveText,
  redactDiagnosticText,
} from "./command-redaction.js";

describe("redactSensitiveText", () => {
  it("redacts an Authorization: Bearer header value", () => {
    const out = redactSensitiveText(
      "GET /v1 failed: Authorization: Bearer sk-ant-api03-abcdef....",
    );
    expect(out).not.toContain("sk-ant-api03-abcdefgh");
    expect(out).toContain(REDACTED_COMMAND_TEXT_VALUE);
  });

  it("redacts a bare Bearer token without an Authorization prefix", () => {
    const out = redactSensitiveText("sent header Bearer abcdEFGH12345678 ok");
    expect(out).not.toContain("abcdEFGH12345678");
    expect(out).toContain(REDACTED_COMMAND_TEXT_VALUE);
  });

  it("redacts an sk-ant- style api key", () => {
    const out = redactSensitiveText(
      "401 invalid key: sk-ant-api03-SECRETVALUE0123456789",
    );
    expect(out).not.toContain("SECRETVALUE0123456789");
    expect(out).toContain(REDACTED_COMMAND_TEXT_VALUE);
  });

  it("redacts a Google AIza api key", () => {
    const out = redactSensitiveText(
      "gemini error: key AIzaSyA1234567890abcdefghijklmnopqrstuvx rejected",
    );
    expect(out).not.toContain("AIzaSyA1234567890abcdefghijklmnopqrstuvx");
    expect(out).toContain(REDACTED_COMMAND_TEXT_VALUE);
  });

  it("redacts an api-key = value assignment", () => {
    const out = redactSensitiveText("env x-api-key=topsecretvalue123 failed");
    expect(out).not.toContain("topsecretvalue123");
    expect(out).toContain(REDACTED_COMMAND_TEXT_VALUE);
  });

  it("leaves plain diagnostic text untouched", () => {
    const text = "session/new failed: -32603 backend unavailable";
    expect(redactSensitiveText(text)).toBe(text);
  });
});

describe("redactDiagnosticText", () => {
  it("redacts a JSON secret field value", () => {
    const input = '{"token":"opaque-value","status":"error"}';
    const output = redactDiagnosticText(input);
    expect(output).not.toContain("opaque-value");
    expect(output).toContain(`"token":"${REDACTED_COMMAND_TEXT_VALUE}"`);
    // The non-secret field keeps its value.
    expect(output).toContain('"status":"error"');
  });

  it("redacts an api_key JSON field with whitespace around the colon", () => {
    const input = '{ "api_key" : "sk-secret-123" }';
    const output = redactDiagnosticText(input);
    expect(output).not.toContain("sk-secret-123");
    expect(output).toContain(REDACTED_COMMAND_TEXT_VALUE);
  });

  it("redacts an escaped-JSON secret field value", () => {
    // A diagnostic can carry a JSON string, so the double quotes appear as `\"`.
    const input = '{\\"token\\":\\"opaque-value\\"}';
    const output = redactDiagnosticText(input);
    expect(output).not.toContain("opaque-value");
    expect(output).toContain(`\\"token\\":\\"${REDACTED_COMMAND_TEXT_VALUE}\\"`);
  });

  it("still redacts a shell KEY=value secret", () => {
    const input = "ANTHROPIC_API_KEY=super-secret-value claude --print";
    const output = redactDiagnosticText(input);
    expect(output).not.toContain("super-secret-value");
    expect(output).toContain(REDACTED_COMMAND_TEXT_VALUE);
  });

  it("keeps non-secret text and non-secret JSON fields intact", () => {
    const input = '{"status":"ok","message":"probe finished"}';
    expect(redactDiagnosticText(input)).toBe(input);
  });

  it("redacts the secret but keeps a non-secret marker in the same string", () => {
    const input = 'DIAGMARKER1234 said {"authorization":"Bearer opaque"}';
    const output = redactDiagnosticText(input);
    expect(output).toContain("DIAGMARKER1234");
    expect(output).not.toContain("opaque");
  });

  it("redacts a JSON secret value that contains an escaped quote", () => {
    // The value holds an escaped quote, so a naive matcher stops at the `\"` and
    // leaves the rest of the credential. The marker sits after the escaped quote.
    const input = '{"token":"pre\\"MARKERQUOTE_A"}';
    const output = redactDiagnosticText(input);
    expect(output).not.toContain("MARKERQUOTE_A");
    expect(output).toContain(`"token":"${REDACTED_COMMAND_TEXT_VALUE}"`);
  });

  it("redacts a JSON secret value that contains an escaped backslash", () => {
    const input = '{"secret":"pre\\\\MARKERBACKSLASH_A"}';
    const output = redactDiagnosticText(input);
    expect(output).not.toContain("MARKERBACKSLASH_A");
    expect(output).toContain(`"secret":"${REDACTED_COMMAND_TEXT_VALUE}"`);
  });

  it("redacts an escaped-JSON secret value that contains an escaped quote", () => {
    // A diagnostic can carry a serialized JSON string, so the whole JSON is
    // escaped a second time. The inner value still holds an escaped quote.
    const innerJson = '{"token":"pre\\"MARKERQUOTE_B"}';
    const input = JSON.stringify(innerJson);
    const output = redactDiagnosticText(input);
    expect(output).not.toContain("MARKERQUOTE_B");
    expect(output).toContain(REDACTED_COMMAND_TEXT_VALUE);
  });

  it("redacts an escaped-JSON secret value that contains an escaped backslash", () => {
    const innerJson = '{"password":"pre\\\\MARKERBACKSLASH_B"}';
    const input = JSON.stringify(innerJson);
    const output = redactDiagnosticText(input);
    expect(output).not.toContain("MARKERBACKSLASH_B");
    expect(output).toContain(REDACTED_COMMAND_TEXT_VALUE);
  });
});

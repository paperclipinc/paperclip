import { describe, expect, it } from "vitest";
import { resolveSmtpSettingsFromEnv } from "./invite-email-smtp.js";

describe("resolveSmtpSettingsFromEnv", () => {
  it("returns null when nothing is configured", () => {
    expect(resolveSmtpSettingsFromEnv({})).toBeNull();
  });

  it("returns null when a URL is set but FROM is missing", () => {
    expect(
      resolveSmtpSettingsFromEnv({ PAPERCLIP_SMTP_URL: "smtp://mail.example.com" }),
    ).toBeNull();
  });

  it("returns null when FROM is set but neither URL nor HOST is", () => {
    expect(
      resolveSmtpSettingsFromEnv({ PAPERCLIP_SMTP_FROM: "Paperclip <no-reply@example.com>" }),
    ).toBeNull();
  });

  it("prefers the connection URL when set", () => {
    const settings = resolveSmtpSettingsFromEnv({
      PAPERCLIP_SMTP_URL: "smtps://user:pass@mail.example.com:465",
      PAPERCLIP_SMTP_HOST: "ignored.example.com",
      PAPERCLIP_SMTP_FROM: "no-reply@example.com",
    });
    expect(settings).toEqual({
      transport: "smtps://user:pass@mail.example.com:465",
      from: "no-reply@example.com",
    });
  });

  it("builds transport options from discrete host vars with defaults", () => {
    const settings = resolveSmtpSettingsFromEnv({
      PAPERCLIP_SMTP_HOST: "mail.example.com",
      PAPERCLIP_SMTP_FROM: "no-reply@example.com",
    });
    expect(settings).toEqual({
      transport: { host: "mail.example.com", port: 587, secure: false },
      from: "no-reply@example.com",
    });
  });

  it("includes auth when a user is set and infers secure for port 465", () => {
    const settings = resolveSmtpSettingsFromEnv({
      PAPERCLIP_SMTP_HOST: "mail.example.com",
      PAPERCLIP_SMTP_PORT: "465",
      PAPERCLIP_SMTP_USER: "mailer",
      PAPERCLIP_SMTP_PASSWORD: "s3cret",
      PAPERCLIP_SMTP_FROM: "no-reply@example.com",
    });
    expect(settings).toEqual({
      transport: {
        host: "mail.example.com",
        port: 465,
        secure: true,
        auth: { user: "mailer", pass: "s3cret" },
      },
      from: "no-reply@example.com",
    });
  });

  it("honors an explicit PAPERCLIP_SMTP_SECURE=true on a non-465 port", () => {
    const settings = resolveSmtpSettingsFromEnv({
      PAPERCLIP_SMTP_HOST: "mail.example.com",
      PAPERCLIP_SMTP_SECURE: "true",
      PAPERCLIP_SMTP_FROM: "no-reply@example.com",
    });
    expect(settings?.transport).toMatchObject({ port: 587, secure: true });
  });
});

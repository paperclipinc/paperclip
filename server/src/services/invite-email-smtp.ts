// SMTP transport for the invite-email hook. Activates only when SMTP env
// configuration is present; otherwise the hook keeps its no-op transport and
// invites remain copy-link only.
export interface SmtpInviteEmailSettings {
  transport:
    | string
    | {
        host: string;
        port: number;
        secure: boolean;
        auth?: { user: string; pass: string };
      };
  from: string;
}

export function resolveSmtpSettingsFromEnv(
  env: NodeJS.ProcessEnv,
): SmtpInviteEmailSettings | null {
  const from = env.PAPERCLIP_SMTP_FROM?.trim();
  const url = env.PAPERCLIP_SMTP_URL?.trim();
  const host = env.PAPERCLIP_SMTP_HOST?.trim();
  if (!from || (!url && !host)) return null;
  if (url) return { transport: url, from };

  const port = Number(env.PAPERCLIP_SMTP_PORT) || 587;
  const secure = env.PAPERCLIP_SMTP_SECURE === "true" || port === 465;
  const user = env.PAPERCLIP_SMTP_USER?.trim();
  return {
    transport: {
      host: host as string,
      port,
      secure,
      ...(user ? { auth: { user, pass: env.PAPERCLIP_SMTP_PASSWORD ?? "" } } : {}),
    },
    from,
  };
}

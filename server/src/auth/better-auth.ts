import { createSign } from "node:crypto";
import type { Request, RequestHandler } from "express";
import type { IncomingHttpHeaders } from "node:http";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { toNodeHandler } from "better-auth/node";
import type { Db } from "@paperclipai/db";
import {
  authAccounts,
  authSessions,
  authUsers,
  authVerifications,
} from "@paperclipai/db";
import type { Config } from "../config.js";
import type { EmailSender } from "./email.js";

export type BetterAuthSessionUser = {
  id: string;
  email?: string | null;
  name?: string | null;
};

export type BetterAuthSessionResult = {
  session: { id: string; userId: string } | null;
  user: BetterAuthSessionUser | null;
};

type BetterAuthInstance = ReturnType<typeof betterAuth>;

function headersFromNodeHeaders(rawHeaders: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, raw] of Object.entries(rawHeaders)) {
    if (!raw) continue;
    if (Array.isArray(raw)) {
      for (const value of raw) headers.append(key, value);
      continue;
    }
    headers.set(key, raw);
  }
  return headers;
}

function headersFromExpressRequest(req: Request): Headers {
  return headersFromNodeHeaders(req.headers);
}

export function deriveAuthTrustedOrigins(config: Config): string[] {
  const baseUrl = config.authBaseUrlMode === "explicit" ? config.authPublicBaseUrl : undefined;
  const trustedOrigins = new Set<string>();

  if (baseUrl) {
    try {
      trustedOrigins.add(new URL(baseUrl).origin);
    } catch {
      // Better Auth will surface invalid base URL separately.
    }
  }
  if (config.deploymentMode === "authenticated") {
    for (const hostname of config.allowedHostnames) {
      const trimmed = hostname.trim().toLowerCase();
      if (!trimmed) continue;
      trustedOrigins.add(`https://${trimmed}`);
      trustedOrigins.add(`http://${trimmed}`);
    }
  }

  return Array.from(trustedOrigins);
}

function generateAppleClientSecret(teamId: string, keyId: string, clientId: string, rawPrivateKey: string): string {
  // Normalize PEM: 1Password and K8s secrets often strip newlines
  const pem = rawPrivateKey.trim();
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----/, "").replace(/-----END PRIVATE KEY-----/, "").replace(/\s+/g, "");
  const privateKey = `-----BEGIN PRIVATE KEY-----\n${body.match(/.{1,64}/g)?.join("\n")}\n-----END PRIVATE KEY-----`;
  // Apple client secrets are ES256 JWTs valid for max 6 months.
  // We generate a fresh one at startup so there's nothing to rotate.
  const header = { alg: "ES256", kid: keyId, typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: teamId,
    iat: now,
    exp: now + 86400 * 180, // 6 months (Apple maximum)
    aud: "https://appleid.apple.com",
    sub: clientId,
  };
  // Use Node.js crypto to sign the JWT (no external dependencies)
  // createSign imported at top level
  const segments = [
    Buffer.from(JSON.stringify(header)).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
  ];
  const signingInput = segments.join(".");
  const sign = createSign("SHA256");
  sign.update(signingInput);
  const derSig = sign.sign({ key: privateKey, dsaEncoding: "ieee-p1363" });
  segments.push(derSig.toString("base64url"));
  return segments.join(".");
}

export function createBetterAuthInstance(
  db: Db,
  config: Config,
  trustedOrigins?: string[],
  emailSender?: EmailSender,
): BetterAuthInstance {
  const baseUrl = config.authBaseUrlMode === "explicit" ? config.authPublicBaseUrl : undefined;
  const secret = process.env.BETTER_AUTH_SECRET ?? process.env.PAPERCLIP_AGENT_JWT_SECRET;
  if (!secret) {
    throw new Error(
      "BETTER_AUTH_SECRET (or PAPERCLIP_AGENT_JWT_SECRET) must be set. " +
      "For local development, set BETTER_AUTH_SECRET=paperclip-dev-secret in your .env file.",
    );
  }
  const effectiveTrustedOrigins = trustedOrigins ?? deriveAuthTrustedOrigins(config);

  const publicUrl = process.env.PAPERCLIP_PUBLIC_URL ?? baseUrl;
  const isHttpOnly = publicUrl ? publicUrl.startsWith("http://") : false;

  const authConfig = {
    baseURL: baseUrl,
    secret,
    trustedOrigins: effectiveTrustedOrigins,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: authUsers,
        session: authSessions,
        account: authAccounts,
        verification: authVerifications,
      },
    }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: config.emailVerificationRequired,
      disableSignUp: config.authDisableSignUp,
      ...(emailSender
        ? {
            sendResetPassword: async ({ user, url }: { user: { email: string }; url: string }) => {
              const frontendUrl = url.replace("/api/auth/reset-password", "/auth/reset-password");
              await emailSender.sendPasswordResetEmail(user.email, frontendUrl);
            },
          }
        : {}),
    },
    ...(emailSender
      ? {
          emailVerification: {
            sendVerificationEmail: async ({ user, url }: { user: { email: string }; url: string }) => {
              const frontendUrl = url.replace("/api/auth/verify-email", "/auth/verify-email");
              await emailSender.sendVerificationEmail(user.email, frontendUrl);
            },
            sendOnSignUp: true,
            autoSignInAfterVerification: true,
          },
        }
      : {}),
    socialProviders: {
      ...(config.googleClientId && config.googleClientSecret
        ? {
            google: {
              clientId: config.googleClientId,
              clientSecret: config.googleClientSecret,
            },
          }
        : {}),
      ...(() => {
        // Support auto-generating Apple client secret from .p8 key
        const appleClientId = config.appleClientId;
        let appleClientSecret = config.appleClientSecret;
        if (!appleClientSecret && appleClientId && config.appleTeamId && config.appleKeyId && config.applePrivateKey) {
          appleClientSecret = generateAppleClientSecret(
            config.appleTeamId,
            config.appleKeyId,
            appleClientId,
            config.applePrivateKey,
          );
        }
        return appleClientId && appleClientSecret
          ? { apple: { clientId: appleClientId, clientSecret: appleClientSecret } }
          : {};
      })(),
    },
    user: {
      changeEmail: {
        enabled: true,
      },
    },
    ...(isHttpOnly ? { advanced: { useSecureCookies: false } } : {}),
  };

  if (!baseUrl) {
    delete (authConfig as { baseURL?: string }).baseURL;
  }

  return betterAuth(authConfig);
}

export function createBetterAuthHandler(auth: BetterAuthInstance): RequestHandler {
  const handler = toNodeHandler(auth);
  return (req, res, next) => {
    void Promise.resolve(handler(req, res)).catch(next);
  };
}

export async function resolveBetterAuthSessionFromHeaders(
  auth: BetterAuthInstance,
  headers: Headers,
): Promise<BetterAuthSessionResult | null> {
  const api = (auth as unknown as { api?: { getSession?: (input: unknown) => Promise<unknown> } }).api;
  if (!api?.getSession) return null;

  const sessionValue = await api.getSession({
    headers,
  });
  if (!sessionValue || typeof sessionValue !== "object") return null;

  const value = sessionValue as {
    session?: { id?: string; userId?: string } | null;
    user?: { id?: string; email?: string | null; name?: string | null } | null;
  };
  const session = value.session?.id && value.session.userId
    ? { id: value.session.id, userId: value.session.userId }
    : null;
  const user = value.user?.id
    ? {
        id: value.user.id,
        email: value.user.email ?? null,
        name: value.user.name ?? null,
      }
    : null;

  if (!session || !user) return null;
  return { session, user };
}

export async function resolveBetterAuthSession(
  auth: BetterAuthInstance,
  req: Request,
): Promise<BetterAuthSessionResult | null> {
  return resolveBetterAuthSessionFromHeaders(auth, headersFromExpressRequest(req));
}

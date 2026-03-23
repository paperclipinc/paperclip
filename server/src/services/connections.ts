import crypto from "node:crypto";
import { and, eq, sql, lt, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { connections, companySecrets, companySecretVersions } from "@paperclipai/db";
import type { Connection, OAuthProviderDefinition } from "@paperclipai/shared";
import { getProviderCatalog } from "@paperclipai/shared";
import { notFound, unprocessable, conflict } from "../errors.js";
import { getSecretProvider } from "../secrets/provider-registry.js";
import type { SecretProvider } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// OAuth provider client credentials — loaded from env
// ---------------------------------------------------------------------------

interface OAuthClientCredentials {
  clientId: string;
  clientSecret: string;
}

function getClientCredentials(providerId: string): OAuthClientCredentials | null {
  const upper = providerId.toUpperCase();
  const clientId = process.env[`PAPERCLIP_OAUTH_${upper}_CLIENT_ID`];
  const clientSecret = process.env[`PAPERCLIP_OAUTH_${upper}_CLIENT_SECRET`];
  if (clientId && clientSecret) return { clientId, clientSecret };
  // Try JSON config
  const json = process.env.PAPERCLIP_OAUTH_CREDENTIALS;
  if (json) {
    try {
      const parsed = JSON.parse(json) as Record<string, OAuthClientCredentials>;
      if (parsed[providerId]) return parsed[providerId];
    } catch { /* ignore */ }
  }
  return null;
}

function getPublicBaseUrl(): string {
  return (
    process.env.PAPERCLIP_PUBLIC_URL ??
    `http://localhost:${process.env.PORT ?? "3100"}`
  );
}

function getCallbackUrl(): string {
  return `${getPublicBaseUrl()}/api/connections/callback`;
}

// ---------------------------------------------------------------------------
// State token — HMAC-signed to prevent CSRF
// ---------------------------------------------------------------------------

function getStateSigningKey(): Buffer {
  const key =
    process.env.BETTER_AUTH_SECRET ??
    process.env.PAPERCLIP_SECRETS_MASTER_KEY ??
    "paperclip-dev-state-key";
  return crypto.createHash("sha256").update(key).digest();
}

interface StatePayload {
  companyId: string;
  providerId: string;
  userId: string;
  nonce: string;
  ts: number;
}

function createState(payload: StatePayload): string {
  const data = JSON.stringify(payload);
  const encoded = Buffer.from(data, "utf8").toString("base64url");
  const sig = crypto
    .createHmac("sha256", getStateSigningKey())
    .update(encoded)
    .digest("base64url");
  return `${encoded}.${sig}`;
}

function verifyState(token: string): StatePayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [encoded, sig] = parts;
  const expected = crypto
    .createHmac("sha256", getStateSigningKey())
    .update(encoded)
    .digest("base64url");
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return null;
  }
  try {
    const data = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as StatePayload;
    // Expire after 15 minutes
    if (Date.now() - data.ts > 15 * 60 * 1000) return null;
    return data;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function connectionService(db: Db) {
  const catalog = getProviderCatalog(process.env.PAPERCLIP_OAUTH_PROVIDERS);
  const catalogById = new Map<string, OAuthProviderDefinition>(
    catalog.map((p) => [p.id, p]),
  );

  function getProvider(providerId: string): OAuthProviderDefinition {
    const provider = catalogById.get(providerId);
    if (!provider) throw notFound(`Unknown OAuth provider: ${providerId}`);
    return provider;
  }

  // -- CRUD ----------------------------------------------------------------

  async function list(companyId: string): Promise<Connection[]> {
    return db
      .select()
      .from(connections)
      .where(eq(connections.companyId, companyId))
      .orderBy(connections.createdAt) as unknown as Promise<Connection[]>;
  }

  async function getById(id: string): Promise<Connection | null> {
    const rows = await db
      .select()
      .from(connections)
      .where(eq(connections.id, id));
    return (rows[0] as unknown as Connection) ?? null;
  }

  async function getByProvider(
    companyId: string,
    providerId: string,
  ): Promise<Connection | null> {
    const rows = await db
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.companyId, companyId),
          eq(connections.providerId, providerId),
        ),
      );
    return (rows[0] as unknown as Connection) ?? null;
  }

  // -- Available providers -------------------------------------------------

  function listProviders() {
    return catalog.map((p) => ({
      ...p,
      configured: getClientCredentials(p.id) !== null,
    }));
  }

  // -- OAuth flow ----------------------------------------------------------

  function getAuthorizeUrl(
    companyId: string,
    providerId: string,
    userId: string,
    opts?: { scopes?: string[] },
  ): string {
    const provider = getProvider(providerId);
    const creds = getClientCredentials(providerId);
    if (!creds) {
      throw unprocessable(
        `OAuth not configured for ${provider.displayName}. Set PAPERCLIP_OAUTH_${providerId.toUpperCase()}_CLIENT_ID and PAPERCLIP_OAUTH_${providerId.toUpperCase()}_CLIENT_SECRET.`,
      );
    }

    const state = createState({
      companyId,
      providerId,
      userId,
      nonce: crypto.randomBytes(16).toString("hex"),
      ts: Date.now(),
    });

    const scopes = opts?.scopes ?? provider.defaultScopes;
    const sep = provider.scopeSeparator ?? " ";

    const params = new URLSearchParams({
      client_id: creds.clientId,
      redirect_uri: getCallbackUrl(),
      response_type: "code",
      state,
      ...(scopes.length > 0 ? { scope: scopes.join(sep) } : {}),
      ...provider.extraAuthorizeParams,
    });

    return `${provider.authorizationUrl}?${params.toString()}`;
  }

  async function handleCallback(
    stateToken: string,
    code: string,
  ): Promise<Connection> {
    const payload = verifyState(stateToken);
    if (!payload) throw unprocessable("Invalid or expired OAuth state");

    const { companyId, providerId, userId } = payload;
    const provider = getProvider(providerId);
    const creds = getClientCredentials(providerId);
    if (!creds) throw unprocessable(`OAuth not configured for ${providerId}`);

    // Exchange code for tokens
    const tokenParams: Record<string, string> = {
      grant_type: "authorization_code",
      code,
      redirect_uri: getCallbackUrl(),
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    };

    const headers: Record<string, string> = {
      Accept: "application/json",
    };

    let body: string;
    if (provider.authMethod === "header") {
      headers.Authorization = `Basic ${Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64")}`;
      const { client_id: _cid, client_secret: _cs, ...rest } = tokenParams;
      body = new URLSearchParams(rest).toString();
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    } else {
      body = new URLSearchParams(tokenParams).toString();
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }

    const tokenRes = await fetch(provider.tokenUrl, {
      method: "POST",
      headers,
      body,
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      logger.error({ provider: providerId, status: tokenRes.status, body: errText }, "OAuth token exchange failed");
      throw unprocessable(`Token exchange failed: ${tokenRes.status}`);
    }

    const tokenData = (await tokenRes.json()) as Record<string, unknown>;
    const accessToken = tokenData.access_token as string | undefined;
    if (!accessToken) {
      throw unprocessable("OAuth provider did not return an access token");
    }

    const refreshToken = tokenData.refresh_token as string | undefined;
    const expiresIn = tokenData.expires_in as number | undefined;
    const scope = tokenData.scope as string | undefined;
    const grantedScopes = scope
      ? scope.split(provider.scopeSeparator ?? " ")
      : provider.defaultScopes;

    const expiresAt = expiresIn
      ? new Date(Date.now() + expiresIn * 1000)
      : null;

    // Fetch account label
    let accountLabel: string | null = null;
    if (provider.userInfoUrl) {
      try {
        const userRes = await fetch(provider.userInfoUrl, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (userRes.ok) {
          const userData = (await userRes.json()) as Record<string, unknown>;
          if (provider.userInfoDisplayKey) {
            // Support nested keys like "data.name"
            const keys = provider.userInfoDisplayKey.split(".");
            let val: unknown = userData;
            for (const k of keys) {
              val = (val as Record<string, unknown>)?.[k];
            }
            accountLabel = typeof val === "string" ? val : null;
          }
        }
      } catch {
        // Non-critical — just skip account label
      }
    }

    // Store tokens as a company secret
    const secretValue = JSON.stringify({
      access_token: accessToken,
      refresh_token: refreshToken ?? null,
      token_type: tokenData.token_type ?? "bearer",
      scope: scope ?? null,
    });

    const secretProvider = getSecretProvider(
      (process.env.PAPERCLIP_SECRETS_PROVIDER as SecretProvider) ?? "local_encrypted",
    );
    const prepared = await secretProvider.createVersion({
      value: secretValue,
      externalRef: null,
    });

    // Remove existing connection for this provider (reconnect)
    const existing = await getByProvider(companyId, providerId);

    return db.transaction(async (tx) => {
      // Clean up old connection + secret
      if (existing) {
        await tx.delete(connections).where(eq(connections.id, existing.id));
        if (existing.secretId) {
          await tx.delete(companySecrets).where(eq(companySecrets.id, existing.secretId));
        }
      }

      // Create new secret
      const secretName = `__connection_${providerId}`;
      // Remove any leftover secret with same name
      await tx.delete(companySecrets).where(
        and(eq(companySecrets.companyId, companyId), eq(companySecrets.name, secretName)),
      );

      const secret = await tx
        .insert(companySecrets)
        .values({
          companyId,
          name: secretName,
          provider: (process.env.PAPERCLIP_SECRETS_PROVIDER as string) ?? "local_encrypted",
          latestVersion: 1,
          description: `OAuth tokens for ${provider.displayName}`,
          createdByUserId: userId,
        })
        .returning()
        .then((rows) => rows[0]);

      await tx.insert(companySecretVersions).values({
        secretId: secret.id,
        version: 1,
        material: prepared.material,
        valueSha256: prepared.valueSha256,
        createdByUserId: userId,
      });

      // Create connection record
      const conn = await tx
        .insert(connections)
        .values({
          companyId,
          providerId,
          status: "active",
          scopes: grantedScopes,
          secretId: secret.id,
          accountLabel,
          expiresAt,
          createdByUserId: userId,
        })
        .returning()
        .then((rows) => rows[0]);

      return conn as unknown as Connection;
    });
  }

  // -- Token refresh -------------------------------------------------------

  async function refreshToken(connectionId: string): Promise<Connection> {
    const conn = await getById(connectionId);
    if (!conn) throw notFound("Connection not found");
    if (!conn.secretId) throw unprocessable("Connection has no stored tokens");

    const provider = getProvider(conn.providerId);
    if (!provider.supportsRefresh) {
      throw unprocessable(`${provider.displayName} does not support token refresh`);
    }

    const creds = getClientCredentials(conn.providerId);
    if (!creds) throw unprocessable(`OAuth not configured for ${conn.providerId}`);

    // Resolve current token data
    const secret = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.id, conn.secretId))
      .then((rows) => rows[0] ?? null);
    if (!secret) throw notFound("Secret not found");

    const secretVersion = await db
      .select()
      .from(companySecretVersions)
      .where(
        and(
          eq(companySecretVersions.secretId, secret.id),
          eq(companySecretVersions.version, secret.latestVersion),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!secretVersion) throw notFound("Secret version not found");

    const secretProvider = getSecretProvider(secret.provider as SecretProvider);
    const currentValue = await secretProvider.resolveVersion({
      material: secretVersion.material as Record<string, unknown>,
      externalRef: secret.externalRef,
    });
    const currentTokens = JSON.parse(currentValue) as Record<string, unknown>;
    const refreshTokenValue = currentTokens.refresh_token as string | undefined;
    if (!refreshTokenValue) {
      throw unprocessable("No refresh token available");
    }

    // Request new tokens
    const tokenParams: Record<string, string> = {
      grant_type: "refresh_token",
      refresh_token: refreshTokenValue,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    };

    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    };

    if (provider.authMethod === "header") {
      headers.Authorization = `Basic ${Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64")}`;
    }

    const tokenRes = await fetch(provider.tokenUrl, {
      method: "POST",
      headers,
      body: new URLSearchParams(tokenParams).toString(),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      logger.error({ provider: conn.providerId, status: tokenRes.status }, "Token refresh failed");
      // Mark connection as expired
      await db
        .update(connections)
        .set({
          status: "expired",
          lastError: `Refresh failed: ${tokenRes.status} — ${errText.slice(0, 200)}`,
          updatedAt: new Date(),
        })
        .where(eq(connections.id, conn.id));
      throw unprocessable(`Token refresh failed: ${tokenRes.status}`);
    }

    const newTokens = (await tokenRes.json()) as Record<string, unknown>;
    const newAccessToken = newTokens.access_token as string;
    const newRefreshToken = (newTokens.refresh_token as string | undefined) ?? refreshTokenValue;
    const newExpiresIn = newTokens.expires_in as number | undefined;
    const newExpiresAt = newExpiresIn ? new Date(Date.now() + newExpiresIn * 1000) : null;

    // Rotate secret
    const newSecretValue = JSON.stringify({
      access_token: newAccessToken,
      refresh_token: newRefreshToken,
      token_type: newTokens.token_type ?? "bearer",
      scope: newTokens.scope ?? currentTokens.scope ?? null,
    });

    const nextVersion = secret.latestVersion + 1;
    const prepared = await secretProvider.createVersion({
      value: newSecretValue,
      externalRef: null,
    });

    return db.transaction(async (tx) => {
      await tx.insert(companySecretVersions).values({
        secretId: secret.id,
        version: nextVersion,
        material: prepared.material,
        valueSha256: prepared.valueSha256,
      });

      await tx
        .update(companySecrets)
        .set({ latestVersion: nextVersion, updatedAt: new Date() })
        .where(eq(companySecrets.id, secret.id));

      const updated = await tx
        .update(connections)
        .set({
          status: "active",
          expiresAt: newExpiresAt,
          lastRefreshedAt: new Date(),
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(connections.id, conn.id))
        .returning()
        .then((rows) => rows[0]);

      return updated as unknown as Connection;
    });
  }

  // -- Resolve access token for runtime use --------------------------------

  async function resolveAccessToken(
    companyId: string,
    providerId: string,
  ): Promise<string> {
    const conn = await getByProvider(companyId, providerId);
    if (!conn) {
      throw notFound(`No ${providerId} connection. Connect via Settings → Connections.`);
    }
    if (!conn.secretId) {
      throw unprocessable(`${providerId} connection has no stored tokens`);
    }

    // Auto-refresh if expired
    if (conn.expiresAt && conn.expiresAt <= new Date()) {
      const provider = getProvider(providerId);
      if (provider.supportsRefresh) {
        try {
          await refreshToken(conn.id);
        } catch (err) {
          logger.warn({ providerId, err }, "Auto-refresh failed during resolve");
          throw unprocessable(`${providerId} token expired and refresh failed`);
        }
      } else {
        throw unprocessable(`${providerId} token expired — please reconnect`);
      }
    }

    // Resolve secret value
    const secret = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.id, conn.secretId))
      .then((rows) => rows[0] ?? null);
    if (!secret) throw notFound("Connection secret not found");

    const secretVersion = await db
      .select()
      .from(companySecretVersions)
      .where(
        and(
          eq(companySecretVersions.secretId, secret.id),
          eq(companySecretVersions.version, secret.latestVersion),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!secretVersion) throw notFound("Connection secret version not found");

    const secretProvider = getSecretProvider(secret.provider as SecretProvider);
    const rawValue = await secretProvider.resolveVersion({
      material: secretVersion.material as Record<string, unknown>,
      externalRef: secret.externalRef,
    });

    const tokens = JSON.parse(rawValue) as Record<string, unknown>;
    return tokens.access_token as string;
  }

  // -- Disconnect ----------------------------------------------------------

  async function disconnect(connectionId: string): Promise<Connection> {
    const conn = await getById(connectionId);
    if (!conn) throw notFound("Connection not found");

    return db.transaction(async (tx) => {
      if (conn.secretId) {
        await tx.delete(companySecrets).where(eq(companySecrets.id, conn.secretId));
      }
      const deleted = await tx
        .delete(connections)
        .where(eq(connections.id, conn.id))
        .returning()
        .then((rows) => rows[0]);
      return deleted as unknown as Connection;
    });
  }

  // -- Auth failure reporting (for inbox alerts) ----------------------------

  async function reportAuthFailure(
    companyId: string,
    providerId: string,
    errorMessage?: string,
  ): Promise<void> {
    const conn = await getByProvider(companyId, providerId);
    if (conn) {
      await db
        .update(connections)
        .set({
          status: "expired",
          lastError: errorMessage ?? "Authentication failed",
          updatedAt: new Date(),
        })
        .where(eq(connections.id, conn.id));
    }
    // If no connection exists, the inbox will show this provider as "not connected"
    // when it's referenced in an agent's env config — the UI fetches provider list
    // and compares against active connections.
  }

  // -- Expiring connections (for refresh job) ------------------------------

  async function listExpiringSoon(
    bufferMinutes: number = 10,
  ): Promise<Connection[]> {
    const cutoff = new Date(Date.now() + bufferMinutes * 60 * 1000);
    return db
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.status, "active"),
          lt(connections.expiresAt, cutoff),
        ),
      ) as unknown as Promise<Connection[]>;
  }

  // -- Expired/errored connections count (for sidebar badges) ---------------

  async function countNeedingAttention(companyId: string): Promise<number> {
    const rows = await db
      .select({ count: sql<number>`count(*)` })
      .from(connections)
      .where(
        and(
          eq(connections.companyId, companyId),
          inArray(connections.status, ["expired", "error"]),
        ),
      );
    return Number(rows[0]?.count ?? 0);
  }

  return {
    list,
    getById,
    getByProvider,
    listProviders,
    getAuthorizeUrl,
    handleCallback,
    refreshToken,
    resolveAccessToken,
    disconnect,
    reportAuthFailure,
    listExpiringSoon,
    countNeedingAttention,
    getProvider,
    verifyState,
  };
}

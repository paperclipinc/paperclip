// ---------------------------------------------------------------------------
// Third-Party OAuth Connections
// ---------------------------------------------------------------------------

export type ConnectionStatus = "active" | "expired" | "revoked" | "error";

export type OAuthProviderCategory =
  | "source_control"
  | "communication"
  | "project_management"
  | "cloud"
  | "productivity"
  | "ai"
  | "other";

/**
 * Static definition of an OAuth provider.  Shipped as a built-in catalog but
 * can be extended at runtime via env/configmap.
 */
export interface OAuthProviderDefinition {
  /** Stable identifier, e.g. "github". */
  id: string;
  /** Human-readable name, e.g. "GitHub". */
  displayName: string;
  /** Category for UI grouping / search. */
  category: OAuthProviderCategory;
  /** OAuth 2.0 authorization endpoint. */
  authorizationUrl: string;
  /** OAuth 2.0 token endpoint. */
  tokenUrl: string;
  /** Default scopes requested during authorization. */
  defaultScopes: string[];
  /** Scope separator (default " "). */
  scopeSeparator?: string;
  /** How to send client credentials to the token endpoint. */
  authMethod?: "body" | "header";
  /** Whether the provider issues refresh tokens. */
  supportsRefresh: boolean;
  /** Extra query params appended to the authorization URL. */
  extraAuthorizeParams?: Record<string, string>;
  /** URL to fetch the authenticated user's profile (for account label). */
  userInfoUrl?: string;
  /** JSONPath-like key to extract a display name from the userInfo response. */
  userInfoDisplayKey?: string;
  /** Short description shown in UI. */
  description?: string;
}

/**
 * Persisted connection record linking a company to an OAuth provider.
 * Tokens are stored in company_secrets; this record tracks metadata.
 */
export interface Connection {
  id: string;
  companyId: string;
  providerId: string;
  status: ConnectionStatus;
  scopes: string[];
  secretId: string | null;
  accountLabel: string | null;
  expiresAt: Date | null;
  lastRefreshedAt: Date | null;
  lastError: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * What the list endpoint returns — connection record enriched with provider
 * metadata so the UI can render everything in one call.
 */
export interface ConnectionWithProvider extends Connection {
  provider: OAuthProviderDefinition;
}

// EnvConnectionRefBinding is defined in secrets.ts alongside the EnvBinding union.

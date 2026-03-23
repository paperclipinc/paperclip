import type { OAuthProviderDefinition } from "./connection.js";

/**
 * Built-in OAuth provider catalog.
 *
 * Operators can extend this at runtime by setting
 *   PAPERCLIP_OAUTH_PROVIDERS='{"notion": { ... }}'
 * or via a Kubernetes ConfigMap mounted as a JSON file.
 */
export const BUILTIN_OAUTH_PROVIDERS: OAuthProviderDefinition[] = [
  // ── Source Control ────────────────────────────────────────────────────
  {
    id: "github",
    displayName: "GitHub",
    category: "source_control",
    description: "Source control, issues, pull requests, and code review.",
    authorizationUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    defaultScopes: ["repo", "read:org", "read:user"],
    authMethod: "body",
    supportsRefresh: true,
    userInfoUrl: "https://api.github.com/user",
    userInfoDisplayKey: "login",
  },
  {
    id: "gitlab",
    displayName: "GitLab",
    category: "source_control",
    description: "Git repository management, CI/CD, and DevOps.",
    authorizationUrl: "https://gitlab.com/oauth/authorize",
    tokenUrl: "https://gitlab.com/oauth/token",
    defaultScopes: ["read_user", "api"],
    supportsRefresh: true,
    userInfoUrl: "https://gitlab.com/api/v4/user",
    userInfoDisplayKey: "username",
  },
  {
    id: "bitbucket",
    displayName: "Bitbucket",
    category: "source_control",
    description: "Atlassian-hosted Git repositories and CI/CD pipelines.",
    authorizationUrl: "https://bitbucket.org/site/oauth2/authorize",
    tokenUrl: "https://bitbucket.org/site/oauth2/access_token",
    defaultScopes: ["repository", "pullrequest"],
    supportsRefresh: true,
    authMethod: "header",
    userInfoUrl: "https://api.bitbucket.org/2.0/user",
    userInfoDisplayKey: "display_name",
  },

  // ── Communication ─────────────────────────────────────────────────────
  {
    id: "slack",
    displayName: "Slack",
    category: "communication",
    description: "Team messaging, notifications, and workflow automation.",
    authorizationUrl: "https://slack.com/oauth/v2/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    defaultScopes: [
      "chat:write",
      "channels:read",
      "channels:history",
      "users:read",
    ],
    scopeSeparator: ",",
    authMethod: "body",
    supportsRefresh: false,
    userInfoUrl: "https://slack.com/api/auth.test",
    userInfoDisplayKey: "user",
  },
  {
    id: "discord",
    displayName: "Discord",
    category: "communication",
    description: "Community and team voice/text communication.",
    authorizationUrl: "https://discord.com/api/oauth2/authorize",
    tokenUrl: "https://discord.com/api/oauth2/token",
    defaultScopes: ["identify", "guilds"],
    supportsRefresh: true,
    authMethod: "body",
    userInfoUrl: "https://discord.com/api/users/@me",
    userInfoDisplayKey: "username",
  },

  // ── Project Management ────────────────────────────────────────────────
  {
    id: "linear",
    displayName: "Linear",
    category: "project_management",
    description: "Modern issue tracking and project management.",
    authorizationUrl: "https://linear.app/oauth/authorize",
    tokenUrl: "https://api.linear.app/oauth/token",
    defaultScopes: ["read", "write", "issues:create"],
    supportsRefresh: false,
    authMethod: "body",
    extraAuthorizeParams: { response_type: "code", prompt: "consent" },
  },
  {
    id: "jira",
    displayName: "Jira",
    category: "project_management",
    description: "Atlassian issue tracking and agile project management.",
    authorizationUrl: "https://auth.atlassian.com/authorize",
    tokenUrl: "https://auth.atlassian.com/oauth/token",
    defaultScopes: [
      "read:jira-work",
      "write:jira-work",
      "read:jira-user",
      "offline_access",
    ],
    supportsRefresh: true,
    authMethod: "body",
    extraAuthorizeParams: {
      audience: "api.atlassian.com",
      prompt: "consent",
    },
    userInfoUrl: "https://api.atlassian.com/me",
    userInfoDisplayKey: "displayName",
  },
  {
    id: "asana",
    displayName: "Asana",
    category: "project_management",
    description: "Work management and team collaboration.",
    authorizationUrl: "https://app.asana.com/-/oauth_authorize",
    tokenUrl: "https://app.asana.com/-/oauth_token",
    defaultScopes: [],
    supportsRefresh: true,
    authMethod: "body",
    userInfoUrl: "https://app.asana.com/api/1.0/users/me",
    userInfoDisplayKey: "data.name",
  },

  // ── Productivity ──────────────────────────────────────────────────────
  {
    id: "google",
    displayName: "Google",
    category: "productivity",
    description: "Gmail, Google Drive, Calendar, and Workspace APIs.",
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    defaultScopes: [
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
    ],
    supportsRefresh: true,
    authMethod: "body",
    extraAuthorizeParams: { access_type: "offline", prompt: "consent" },
    userInfoUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
    userInfoDisplayKey: "email",
  },
  {
    id: "notion",
    displayName: "Notion",
    category: "productivity",
    description: "Notes, docs, wikis, and knowledge management.",
    authorizationUrl: "https://api.notion.com/v1/oauth/authorize",
    tokenUrl: "https://api.notion.com/v1/oauth/token",
    defaultScopes: [],
    supportsRefresh: false,
    authMethod: "header",
    extraAuthorizeParams: { owner: "user" },
  },

  // ── Cloud ─────────────────────────────────────────────────────────────
  {
    id: "vercel",
    displayName: "Vercel",
    category: "cloud",
    description: "Frontend deployment and serverless functions.",
    authorizationUrl: "https://vercel.com/integrations/oauth/authorize",
    tokenUrl: "https://api.vercel.com/v2/oauth/access_token",
    defaultScopes: [],
    supportsRefresh: false,
    authMethod: "body",
    userInfoUrl: "https://api.vercel.com/v2/user",
    userInfoDisplayKey: "user.username",
  },
];

/**
 * Merges the built-in provider catalog with optional overrides.
 * On the server, pass `process.env.PAPERCLIP_OAUTH_PROVIDERS` as the
 * overridesJson argument. On the client, call with no arguments to get
 * the built-in catalog only.
 */
export function getProviderCatalog(overridesJson?: string): OAuthProviderDefinition[] {
  if (!overridesJson) return BUILTIN_OAUTH_PROVIDERS;
  try {
    const overrides = JSON.parse(overridesJson) as Record<string, Partial<OAuthProviderDefinition>>;
    const merged = [...BUILTIN_OAUTH_PROVIDERS];
    for (const [id, override] of Object.entries(overrides)) {
      const existing = merged.findIndex((p) => p.id === id);
      if (existing >= 0) {
        merged[existing] = { ...merged[existing], ...override, id };
      } else {
        merged.push(override as OAuthProviderDefinition);
      }
    }
    return merged;
  } catch {
    return BUILTIN_OAUTH_PROVIDERS;
  }
}

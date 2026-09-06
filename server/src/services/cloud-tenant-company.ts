import { createHash } from "node:crypto";

export type CloudStackRole = "owner" | "admin" | "member" | "support";

export interface CloudStackContext {
  stackId: string;
  stackRole: CloudStackRole;
  /**
   * The gateway URL slug for this stack (trusted x-paperclip-cloud-stack-slug
   * header). The gateway proxies /<slug>/... to this instance verbatim, so the
   * SPA must be able to resolve that slug to the stack's company; it surfaces
   * as the company's slugAliases (see withCloudStackSlugAlias). Optional: older
   * gateways do not send it.
   */
  stackSlug?: string;
}

/**
 * Deterministic company id for a cloud tenant stack. The trusted gateway
 * routes a stack's traffic to one company; deriving the id from the stack id
 * keeps that mapping stable whether or not the company row exists yet, so the
 * company can be created lazily (by onboarding) without any gateway change.
 */
export function cloudTenantCompanyId(stackId: string): string {
  const bytes = createHash("sha256").update(`paperclip-cloud-tenant-company:${stackId}`).digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Attach the stack's cloud slug as a slugAliases entry on the stack's own
 * company payload. The gateway routes /<cloud-slug>/... here verbatim, so the
 * SPA needs the slug to resolve (and then canonicalize) that URL to the
 * company's issuePrefix. Companies other than the stack company, actors
 * without a slug, and a slug that already equals the issuePrefix all pass
 * through unchanged.
 */
export function withCloudStackSlugAlias<T extends { id: string; issuePrefix: string }>(
  company: T,
  cloudStack: CloudStackContext | undefined | null,
): T {
  if (!cloudStack) return company;
  const slug = cloudStack.stackSlug?.trim();
  if (!slug) return company;
  if (company.id !== cloudTenantCompanyId(cloudStack.stackId)) return company;
  if (slug.toUpperCase() === company.issuePrefix.toUpperCase()) return company;
  return { ...company, slugAliases: [slug] };
}

/** Only a stack owner or admin may create (i.e. onboard) the stack's company. */
export function canCreateStackCompany(
  cloudStack: CloudStackContext | undefined | null,
): cloudStack is CloudStackContext {
  return cloudStack?.stackRole === "owner" || cloudStack?.stackRole === "admin";
}

/**
 * Postgres unique violation on the companies primary key — the forced stack
 * company id already exists (another owner/admin completed onboarding first).
 * Mirrors the cause-chain walk of isIssuePrefixConflict in companies.ts.
 */
export function isCompanyIdConflict(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const maybe = current as {
      code?: string;
      constraint?: string;
      constraint_name?: string;
      cause?: unknown;
    };
    const constraint = maybe.constraint ?? maybe.constraint_name;
    if (maybe.code === "23505" && constraint === "companies_pkey") return true;
    current = maybe.cause;
  }
  return false;
}

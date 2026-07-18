import { api } from "@/api/client";

export interface CompanyCreationDisclosure {
  requiresSubscription: boolean;
  trialAvailable: boolean;
  trialDays: number;
  priceCents: number;
  currency: string;
  message: string;
}

/**
 * Price disclosure from the billing plugin's scoped API route
 * (spec 2026-07-18-billing-plugin-design.md §6.3). The plugin is optional:
 * any failure (not installed, disabled, non-200) resolves to null and the
 * create-company dialog renders without a disclosure line.
 */
export async function fetchCompanyCreationDisclosure(
  activeCompanyId: string,
): Promise<CompanyCreationDisclosure | null> {
  try {
    return await api.get<CompanyCreationDisclosure>(
      `/plugins/paperclip-plugin-billing/api/creation-summary?companyId=${encodeURIComponent(activeCompanyId)}`,
    );
  } catch {
    return null;
  }
}

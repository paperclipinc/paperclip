import { api } from "./client";

// Cloud-only endpoint (Paperclip.inc hosting layer). In the EU cloud, creating an
// ADDITIONAL company must go through the hosting gateway's POST /api/cloud/companies,
// NOT the product-native POST /api/companies: the gateway provisions a control-plane
// tenant (+ mints its inference key) and tier-gates the action, then the product
// auto-creates the company on the first request to the returned slug. The native
// route is blocked in cloud, so this is the only way to create a 2nd+ company there.
//
// Plan-gating lives in the gateway (the product does not know the account plan):
//   200 -> { productSlug, url, name }      (Pro / Enterprise)
//   402 -> { error:"upgrade_required", capability:"create_company" }   (Starter)
//   409 -> { error:"company_limit_reached", limit }                    (at plan cap)
// Callers read those via the thrown ApiError (status + body) from ./client.

export type CloudCompanyCreateResult = {
  /** The product slug of the newly provisioned company. */
  productSlug: string;
  /** Where to navigate so the product auto-creates + scopes to the new company. */
  url: string;
  /** The company name as stored. */
  name: string;
};

export const cloudCompaniesApi = {
  create: (data: { name: string }) =>
    api.post<CloudCompanyCreateResult>("/cloud/companies", data),
};

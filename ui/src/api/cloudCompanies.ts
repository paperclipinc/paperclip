import { api } from "./client";

// Cloud-only endpoint (Paperclip.inc hosting layer). In the EU cloud, creating an
// ADDITIONAL company must go through the hosting gateway's POST /api/cloud/companies,
// NOT the product-native POST /api/companies: the gateway provisions a control-plane
// tenant (+ mints its inference key) and gates the action, then the product
// auto-creates the company on the first request to the returned slug. The native
// route is blocked in cloud, so this is the only way to create a 2nd+ company there.
//
// Flat plan (no Starter/Pro tiers): every subscribed account pays 10 euro per
// company per month, unlimited teammates included. The gate is the trial
// clamp, not a tier: only the first company is free-trial eligible, so
// creating a 2nd+ company while still trialing is blocked until the account
// subscribes.
//   200 -> { productSlug, url, name }      (subscribed, or first company on trial)
//   402 -> { error:"upgrade_required", capability:"create_company" }   (2nd+ company during trial)
//   402 -> { error:"billing_update_failed" }  (paying user; the per-company billing bump failed, nothing created or charged)
//   409 -> { error:"company_limit_reached", limit }                    (fair-use cap)
// Callers read those via the thrown ApiError (status + body) from ./client;
// branch on body.error, not just the status (both 402s share it).

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

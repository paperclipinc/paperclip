import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { stripeService } from "../services/stripe.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

export function billingRoutes(db: Db) {
  const router = Router();
  const stripe = stripeService(db);

  router.get("/billing/plans", async (_req, res) => {
    const plans = await stripe.listPlans();
    res.json(plans);
  });

  router.get("/companies/:companyId/subscription", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const subscription = await stripe.getSubscription(companyId);
    res.json(subscription);
  });

  router.post("/companies/:companyId/billing/checkout", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);

    const { planId } = req.body as { planId: string };
    if (!planId) {
      res.status(400).json({ error: "planId is required" });
      return;
    }

    if (!stripe.isConfigured()) {
      res.status(400).json({ error: "Stripe is not configured" });
      return;
    }

    const origin = `${req.protocol}://${req.get("host")}`;
    const successUrl = `${origin}/settings?billing=success`;
    const cancelUrl = `${origin}/settings?billing=canceled`;

    const url = await stripe.createCheckoutSession(companyId, planId, successUrl, cancelUrl);
    res.json({ url });
  });

  router.post("/companies/:companyId/billing/portal", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);

    if (!stripe.isConfigured()) {
      res.status(400).json({ error: "Stripe is not configured" });
      return;
    }

    const origin = `${req.protocol}://${req.get("host")}`;
    const returnUrl = `${origin}/settings`;

    const url = await stripe.createPortalSession(companyId, returnUrl);
    res.json({ url });
  });

  return router;
}

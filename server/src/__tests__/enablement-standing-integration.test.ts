import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  companyStanding,
  createDb,
  pluginCompanySettings,
  plugins,
} from "@paperclipai/db";
import { pluginRegistryService } from "../services/plugin-registry.js";
import { companyStandingService } from "../services/company-standing.ts";
import {
  closeDbClient,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

/**
 * Cross-branch integration coverage for the merge of feat/company-plugin-enablement
 * (PR-2, which added the PUT /plugins/{pluginId}/companies/{companyId}/enablement
 * route backed by pluginRegistryService(db).upsertCompanySettings) and
 * feat/company-standing-gate (PR-3, which taught upsertCompanySettings to clean
 * up companyStanding rows on company-disable).
 *
 * This does not go through the HTTP route layer (that's covered by
 * plugin-routes-authz.test.ts and plugin-company-enablement.test.ts). Instead it
 * exercises the exact service call the route makes, against a real embedded
 * Postgres instance, to confirm the two branches' independent changes to
 * upsertCompanySettings compose correctly on the merged base.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("enablement route path -> standing cleanup integration", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-enablement-standing-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(companyStanding);
    await db.delete(pluginCompanySettings);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await closeDbClient(db);
    await tempDb?.cleanup();
  });

  async function insertFixture() {
    const companyId = randomUUID();
    const pluginId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Enablement Standing Co",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclip.billing",
      packageName: "@paperclipai/plugin-billing",
      version: "1.0.0",
      manifestJson: {
        id: "paperclip.billing",
        name: "Billing",
        version: "1.0.0",
        capabilities: ["company.standing.write"],
      } as never,
      status: "ready",
    });
    // Seed the plugin as enabled for the company first (this is the state the
    // real PUT route pre-supposes when a subsequent toggle happens), then seed
    // a standing row for that (plugin, company) pair.
    const registry = pluginRegistryService(db);
    await registry.upsertCompanySettings(pluginId, companyId, {
      enabled: true,
      settingsJson: {},
    });
    const standings = companyStandingService(db);
    await standings.setStanding(pluginId, companyId, {
      status: "blocked",
      reason: "subscription_lapsed",
      message: "Lapsed.",
    });
    return { companyId, pluginId };
  }

  it("disabling via the enablement route's code path deletes the company's standing row", async () => {
    const { companyId, pluginId } = await insertFixture();
    const registry = pluginRegistryService(db);

    await expect(db.select().from(companyStanding)).resolves.toHaveLength(1);

    // This is the exact call PR-2's PUT /plugins/{pluginId}/companies/{companyId}/enablement
    // route makes (server/src/routes/plugins.ts).
    await registry.upsertCompanySettings(pluginId, companyId, {
      enabled: false,
      settingsJson: {},
    });

    await expect(db.select().from(companyStanding)).resolves.toHaveLength(0);
  });

  it("re-enabling via the same code path does not delete the standing row", async () => {
    const { companyId, pluginId } = await insertFixture();
    const registry = pluginRegistryService(db);

    await registry.upsertCompanySettings(pluginId, companyId, {
      enabled: true,
      settingsJson: {},
    });

    const rows = await db.select().from(companyStanding);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ companyId, pluginId });
  });
});

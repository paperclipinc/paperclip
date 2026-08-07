import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
<<<<<<< HEAD
=======
import { DEFAULT_ROLE, startCloudOnboarding } from "./onboarding-flow";
>>>>>>> origin/master

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * NUX Phase 4 — visual QA screenshot capture.
 *
 * Boots a throwaway local_trusted instance (see playwright.config.ts webServer)
<<<<<<< HEAD
 * and captures screenshots of every surface integrated by NUX Phases 1–3:
 *   - "Build a new company" step 1 (company name) + step 2 (mission)
 *   - Team-lead hire step (capsule wizard, PAP-125)
 *   - Onboarding front door (path picker)
 *   - "Add agents to your org" growth intake
=======
 * and captures screenshots of every integrated onboarding surface:
 *   - Welcome screen (path picker)
 *   - Company step (name + mission)
 *   - Create-your-first-agent step (role picker + capsule)
 *   - First-task step
 *   - "Add an agent to an existing company" entry (/:prefix/onboarding)
>>>>>>> origin/master
 *   - Conference Room (BoardChat) shell + composer + activity feed
 *   - Artifacts page
 *
 * These are structural/rendering checks — LLM-dependent streaming (CEO chat
 * responses, hiring-plan generation) is verified separately on an LLM-backed
<<<<<<< HEAD
 * instance. Screenshots land in ./nux-phase4-shots for upload as evidence.
=======
 * instance. Screenshots land in ./test-results for upload as evidence.
>>>>>>> origin/master
 */

// Write under the gitignored test-results dir so re-runs leave no untracked
// noise; screenshots are uploaded to the issue as QA evidence, not committed.
const SHOT_DIR = path.join(__dirname, "test-results", "nux-phase4-shots");

<<<<<<< HEAD
=======
const SHOTS = [
  "01-welcome.png",
  "02-company.png",
  "03-agent.png",
  "04-first-task.png",
  "05-add-agent.png",
  "06-board-chat.png",
  "07-artifacts.png",
];

>>>>>>> origin/master
function shot(name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  return path.join(SHOT_DIR, name);
}

<<<<<<< HEAD
async function openWizard(page: import("@playwright/test").Page) {
  await page.goto("/onboarding");
  const startBtn = page.getByRole("button", { name: /Start Onboarding|New Company|Add Agent/ });
  if (await startBtn.count()) {
    await startBtn.first().click();
  }
}

test.describe("NUX Phase 4 visual QA", () => {
  test("captures every integrated surface", async ({ page }) => {
    // New-NUX surfaces are flag-gated default-OFF (PAP-136/137/138): turn the
    // experimental flag on for this throwaway instance before driving them.
=======
test.describe("NUX Phase 4 visual QA", () => {
  test("captures every integrated surface", async ({ page }) => {
    // Conference Room is flag-gated default-OFF: turn the experimental flag on
    // for this throwaway instance before driving that surface (Section C).
>>>>>>> origin/master
    const flagRes = await page.request.patch("/api/instance/settings/experimental", {
      data: { enableConferenceRoomChat: true },
    });
    expect(flagRes.ok()).toBe(true);

    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => consoleErrors.push("PAGEERROR: " + err.message));

    const baseUrl =
      "http://127.0.0.1:" + (process.env.PAPERCLIP_E2E_PORT ?? "3199");

<<<<<<< HEAD
    // ── Section A: create-company path (name → mission → hire) ────────────
    await openWizard(page);
    // Front door shows when the wizard doesn't open directly on the create
    // path (e.g. another spec already created a company on this instance).
    const createCard = page.getByRole("button", { name: /Build a new company/ });
    if (await createCard.count()) {
      await createCard.first().click();
    }
    await expect(
      page.getByRole("heading", { name: "Name your company" }),
    ).toBeVisible({ timeout: 15_000 });
    await page.getByPlaceholder("Name your company").fill("QA Robotics");
    await page.screenshot({ path: shot("02-create-name.png") });

    await page.getByRole("button", { name: /^Next/ }).click();
    await expect(
      page.getByRole("heading", { name: "Define your mission" }),
    ).toBeVisible({ timeout: 10_000 });
    await page
      .getByPlaceholder("What is your team trying to achieve?")
      .fill("Build affordable home robots that handle household chores.");
    await page.screenshot({ path: shot("03-create-mission.png") });

    // Step 2 advances via "Confirm mission" (creates the company + goal);
    // step 3 is the team-lead naming step of the capsule wizard.
    await page.getByRole("button", { name: /Confirm mission/ }).click();
    await page.waitForSelector('input[placeholder="Chief of staff"]', {
      timeout: 30_000,
    });
    await page.screenshot({ path: shot("04-hire-team-lead.png") });
=======
    // ── Section A: the cloud flow, step by step ───────────────────────────
    await page.goto("/onboarding");

    await expect(
      page.getByRole("heading", { name: "Welcome to Paperclip!" }),
    ).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: shot("01-welcome.png") });

    await startCloudOnboarding(page);

    // Capture the company step populated but not yet submitted, then submit.
    await expect(
      page.getByRole("heading", { name: "What is the name of your company or team?" }),
    ).toBeVisible({ timeout: 15_000 });
    await page.locator("#onboarding-company-name").fill("QA Robotics");
    await page
      .locator("#onboarding-mission")
      .fill("Build affordable home robots that handle household chores.");
    await page.screenshot({ path: shot("02-company.png") });
    await page.getByRole("button", { name: /^Next/ }).click();

    // Agent step: pick a role so the capsule + preview render, then capture
    // before hiring.
    await expect(
      page.getByRole("heading", { name: "Create your first agent" }),
    ).toBeVisible({ timeout: 30_000 });
    await page.locator("#onboarding-agent-role").click();
    await page.getByRole("option", { name: DEFAULT_ROLE, exact: true }).click();
    await page.screenshot({ path: shot("03-agent.png") });
    await page.getByRole("button", { name: /^Create/ }).click();

    // First-task step: select a choice so the card's selected state is visible.
    await expect(
      page.getByRole("heading", { name: "Assign your agent a first task" }),
    ).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: /Create a hiring plan/ }).click();
    await page.screenshot({ path: shot("04-first-task.png") });
>>>>>>> origin/master

    // The company just created anchors the route-scoped sections below.
    const companiesRes = await page.request.get(`${baseUrl}/api/companies`);
    expect(companiesRes.ok()).toBe(true);
    const companies = await companiesRes.json();
    const qaCompany = (Array.isArray(companies) ? companies : []).find(
      (c: { name: string }) => c.name === "QA Robotics",
    );
<<<<<<< HEAD
    expect(qaCompany, "wizard should have created QA Robotics").toBeTruthy();
    const prefix: string = qaCompany.issuePrefix;

    // ── Section B: front door + growth intake ─────────────────────────────
    await page.evaluate(() => window.localStorage.clear());
    await openWizard(page);
    // Reach the full-screen front door (step 0): either it shows directly or
    // "← Back to start" returns to it from the create step.
    if (!(await page.getByRole("heading", { name: "Welcome to Paperclip" }).count())) {
      await page.getByRole("button", { name: /Back to start/ }).click();
    }
    await expect(
      page.getByRole("heading", { name: "Welcome to Paperclip" }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByRole("heading", { name: "Build a new company" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Add agents to your org" }),
    ).toBeVisible();
    await page.screenshot({ path: shot("01-front-door.png") });

    await page.getByRole("button", { name: /Add agents to your org/ }).click();
    // The grow path shares step 1 (company name) before its step-2 intake.
    await expect(
      page.getByRole("heading", { name: "Name your company" }),
    ).toBeVisible({ timeout: 10_000 });
    await page.getByPlaceholder("Name your company").fill("QA Robotics Grow");
    await page.getByRole("button", { name: /^Next/ }).click();
    await expect(
      page.getByRole("heading", { name: /Tell us about your team/ }),
    ).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: shot("05-growth-intake.png") });
=======
    expect(qaCompany, "onboarding should have created QA Robotics").toBeTruthy();
    const prefix: string = qaCompany.issuePrefix;

    // ── Section B: "add an agent to an existing company" entry ────────────
    // OnboardingWizardVariant renders outside <Routes> (App.tsx), so it never
    // sees the :companyPrefix param and the company-scoped route still opens on
    // the welcome screen. The real existing-company entry is the launcher card
    // behind it: dismiss the overlay, then "Add Agent" opens onboarding scoped
    // to this company, which skips company creation and starts at the agent step.
    await page.evaluate(() => window.localStorage.clear());
    await page.goto(`/${prefix}/onboarding`);
    await page.getByRole("button", { name: "Close onboarding" }).click();
    await page.getByRole("button", { name: "Add Agent" }).click();
    await expect(
      page.getByRole("heading", { name: "Create your first agent" }),
    ).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: shot("05-add-agent.png") });
>>>>>>> origin/master

    // ── Section C: Conference Room (BoardChat) ────────────────────────────
    // Visit the company dashboard first so CompanyContext selects the company
    // from the route before we land on the board-chat surface.
    await page.evaluate(() => window.localStorage.clear());
    await page.goto(`/${prefix}/dashboard`);
    await page.waitForLoadState("networkidle");
    await page.goto(`/${prefix}/board-chat`);
    await expect(page).toHaveURL(new RegExp(`/${prefix}/board-chat`));
    // Composer renders once a company is selected. (Regression guard for the
    // Rules-of-Hooks crash that previously blanked this page — see PAP-50.)
    await expect(
      page.getByPlaceholder("Ask anything about your company..."),
    ).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(2_000); // let welcome bubble + suggestion chips stage in
    await page.screenshot({ path: shot("06-board-chat.png") });

    // ── Section D: Artifacts ──────────────────────────────────────────────
    await page.goto(`/${prefix}/artifacts`);
    await expect(page).toHaveURL(new RegExp(`/${prefix}/artifacts`));
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1_000);
    await page.screenshot({ path: shot("07-artifacts.png") });

<<<<<<< HEAD
    for (const f of [
      "01-front-door.png",
      "02-create-name.png",
      "03-create-mission.png",
      "04-hire-team-lead.png",
      "05-growth-intake.png",
      "06-board-chat.png",
      "07-artifacts.png",
    ]) {
=======
    for (const f of SHOTS) {
>>>>>>> origin/master
      const p = shot(f);
      expect(fs.existsSync(p), `missing ${f}`).toBe(true);
      expect(fs.statSync(p).size, `empty ${f}`).toBeGreaterThan(1_000);
    }

    // No React Rules-of-Hooks / render crashes on any surface we visited.
    const hookErrors = consoleErrors.filter(
      (e) => /Rendered more hooks|change in the order of Hooks/i.test(e),
    );
    expect(hookErrors, hookErrors.join("\n")).toHaveLength(0);
  });
});

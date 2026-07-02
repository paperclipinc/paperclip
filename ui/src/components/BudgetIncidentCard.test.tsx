// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BudgetIncident } from "@paperclipai/shared";
import { BudgetIncidentCard } from "./BudgetIncidentCard";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const incident: BudgetIncident = {
  id: "incident-1",
  companyId: "company-1",
  policyId: "policy-1",
  scopeType: "company",
  scopeId: "company-1",
  scopeName: "Acme",
  metric: "billed_cents",
  windowKind: "lifetime",
  windowStart: new Date("2026-01-01T00:00:00Z"),
  windowEnd: new Date("2026-02-01T00:00:00Z"),
  thresholdType: "hard",
  amountLimit: 2000,
  amountObserved: 2100,
  status: "open",
  approvalId: null,
  approvalStatus: null,
  resolvedAt: null,
  createdAt: new Date("2026-01-15T00:00:00Z"),
  updatedAt: new Date("2026-01-15T00:00:00Z"),
};

async function renderCard(props: Partial<Parameters<typeof BudgetIncidentCard>[0]> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const onRaiseAndResume = vi.fn();
  const onKeepPaused = vi.fn();
  const onRaiseViaBilling = vi.fn();
  await act(async () => {
    root.render(
      <BudgetIncidentCard
        incident={incident}
        onRaiseAndResume={onRaiseAndResume}
        onKeepPaused={onKeepPaused}
        onRaiseViaBilling={onRaiseViaBilling}
        {...props}
      />,
    );
  });
  return { container, root, onRaiseAndResume, onKeepPaused, onRaiseViaBilling };
}

function findButton(text: string) {
  return Array.from(document.body.querySelectorAll("button")).find(
    (button) => button.textContent === text,
  );
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("BudgetIncidentCard", () => {
  it("keeps the direct raise flow byte-identical for self-hosters", async () => {
    const { root, container, onRaiseAndResume, onRaiseViaBilling } = await renderCard();

    expect(document.body.textContent).toContain("New budget (USD)");
    const raiseButton = findButton("Raise budget & resume");
    expect(raiseButton).toBeTruthy();
    await act(async () => {
      raiseButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // Default draft is max(observed + $10, limit) = 3100 cents.
    expect(onRaiseAndResume).toHaveBeenCalledWith(3100);
    expect(onRaiseViaBilling).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("routes the raise through billing (EUR) when the budget is billing-managed", async () => {
    const { root, container, onRaiseAndResume, onRaiseViaBilling } = await renderCard({
      billingManaged: true,
    });

    expect(document.body.textContent).toContain("New budget (EUR)");
    expect(document.body.textContent).not.toContain("New budget (USD)");
    expect(document.body.textContent).toContain(
      "Raise your budget through billing. Work resumes once the budget is updated.",
    );

    const billingButton = findButton("Raise budget through billing");
    expect(billingButton).toBeTruthy();
    await act(async () => {
      billingButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onRaiseViaBilling).toHaveBeenCalledWith(3100);
    expect(onRaiseAndResume).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});

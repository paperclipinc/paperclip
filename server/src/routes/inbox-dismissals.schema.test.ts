import { describe, expect, it } from "vitest";
import { inboxDismissalSchema } from "./inbox-dismissals.js";

describe("inboxDismissalSchema.itemKey", () => {
  it("accepts the upstream inbox keys (approval/join/run)", () => {
    for (const k of ["approval:abc", "join:xyz", "run:123"]) {
      expect(inboxDismissalSchema.safeParse({ itemKey: k }).success).toBe(true);
    }
  });

  it("accepts the onboarding checklist key (the Getting-started card Dismiss -> was 400 -> never dismissed)", () => {
    expect(inboxDismissalSchema.safeParse({ itemKey: "checklist:getting-started" }).success).toBe(true);
  });

  it("still rejects an unprefixed/unknown key", () => {
    expect(inboxDismissalSchema.safeParse({ itemKey: "getting-started" }).success).toBe(false);
    expect(inboxDismissalSchema.safeParse({ itemKey: "" }).success).toBe(false);
    expect(inboxDismissalSchema.safeParse({ itemKey: "bogus:x" }).success).toBe(false);
  });
});

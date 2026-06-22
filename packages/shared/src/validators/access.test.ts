import { describe, expect, it } from "vitest";
import { authSessionSchema, currentUserProfileSchema } from "./access.js";

describe("currentUserProfileSchema", () => {
  it("coerces empty-string name to null", () => {
    const result = currentUserProfileSchema.safeParse({
      id: "u1",
      email: "a@b.com",
      name: "",
      image: null,
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.name).toBe(null);
  });

  it("coerces whitespace-only name to null", () => {
    const result = currentUserProfileSchema.safeParse({
      id: "u1",
      email: "a@b.com",
      name: "   ",
      image: null,
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.name).toBe(null);
  });

  it("preserves a real name unchanged", () => {
    const result = currentUserProfileSchema.safeParse({
      id: "u1",
      email: "a@b.com",
      name: "Jane",
      image: null,
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.name).toBe("Jane");
  });

  it("preserves null name as null", () => {
    const result = currentUserProfileSchema.safeParse({
      id: "u1",
      email: "a@b.com",
      name: null,
      image: null,
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.name).toBe(null);
  });
});

describe("authSessionSchema", () => {
  it("parses a session where user name is empty string (identity provider without a name)", () => {
    const result = authSessionSchema.safeParse({
      session: { id: "s1", userId: "u1" },
      user: { id: "u1", email: "a@b.com", name: "", image: null },
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.user.name).toBe(null);
  });

  it("parses a session where user has a real name", () => {
    const result = authSessionSchema.safeParse({
      session: { id: "s1", userId: "u1" },
      user: { id: "u1", email: "a@b.com", name: "Jane", image: null },
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.user.name).toBe("Jane");
  });

  it("parses a session where user name is null", () => {
    const result = authSessionSchema.safeParse({
      session: { id: "s1", userId: "u1" },
      user: { id: "u1", email: "a@b.com", name: null, image: null },
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.user.name).toBe(null);
  });
});

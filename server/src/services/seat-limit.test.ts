import { describe, expect, it } from "vitest";
import { assertSeatAvailable } from "./seat-limit.js";

describe("assertSeatAvailable", () => {
  it("resolves (unlimited) at launch", async () => {
    await expect(assertSeatAvailable({}, "c1")).resolves.toBeUndefined();
  });
});

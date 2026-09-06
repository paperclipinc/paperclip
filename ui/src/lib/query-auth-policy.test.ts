import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import { isAuthFailure, shouldRetryQuery } from "./query-auth-policy";

describe("isAuthFailure", () => {
  it("treats a 401 ApiError as an auth failure", () => {
    expect(isAuthFailure(new ApiError("unauthorized", 401, null))).toBe(true);
  });

  it("treats a 403 ApiError as an auth failure", () => {
    expect(isAuthFailure(new ApiError("forbidden", 403, null))).toBe(true);
  });

  it("does not treat a 500 ApiError as an auth failure", () => {
    expect(isAuthFailure(new ApiError("server error", 500, null))).toBe(false);
  });

  it("does not treat a network error as an auth failure", () => {
    expect(isAuthFailure(new TypeError("Failed to fetch"))).toBe(false);
  });
});

describe("shouldRetryQuery", () => {
  it("never retries a 401 — a dead session does not recover by asking again", () => {
    expect(shouldRetryQuery(0, new ApiError("unauthorized", 401, null))).toBe(false);
  });

  it("never retries a 403", () => {
    expect(shouldRetryQuery(0, new ApiError("forbidden", 403, null))).toBe(false);
  });

  it("retries a 500 while under the attempt budget", () => {
    expect(shouldRetryQuery(0, new ApiError("server error", 500, null))).toBe(true);
    expect(shouldRetryQuery(2, new ApiError("server error", 500, null))).toBe(true);
  });

  it("stops retrying a 500 once the attempt budget is spent", () => {
    expect(shouldRetryQuery(3, new ApiError("server error", 500, null))).toBe(false);
  });

  it("retries a transient network error", () => {
    expect(shouldRetryQuery(0, new TypeError("Failed to fetch"))).toBe(true);
  });
});

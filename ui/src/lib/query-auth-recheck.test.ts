import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import { queryKeys } from "./queryKeys";
import { installAuthFailureRecheck } from "./query-auth-recheck";

function newClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
}

/** Let the cache subscriber and any refetch it triggers settle. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("installAuthFailureRecheck", () => {
  it("re-checks the session when any other query fails with 401", async () => {
    const client = newClient();
    installAuthFailureRecheck(client);

    let sessionFetches = 0;
    await client.fetchQuery({
      queryKey: queryKeys.auth.session,
      queryFn: async () => {
        sessionFetches += 1;
        return { user: { id: "u1" } };
      },
    });
    expect(sessionFetches).toBe(1);

    await client
      .fetchQuery({
        queryKey: ["companies", "list"],
        queryFn: async () => {
          throw new ApiError("unauthorized", 401, null);
        },
      })
      .catch(() => undefined);
    await settle();

    expect(sessionFetches).toBe(2);
  });

  it("does not re-check the session for a 500 — that is not a session problem", async () => {
    const client = newClient();
    installAuthFailureRecheck(client);

    let sessionFetches = 0;
    await client.fetchQuery({
      queryKey: queryKeys.auth.session,
      queryFn: async () => {
        sessionFetches += 1;
        return { user: { id: "u1" } };
      },
    });

    await client
      .fetchQuery({
        queryKey: ["companies", "list"],
        queryFn: async () => {
          throw new ApiError("server error", 500, null);
        },
      })
      .catch(() => undefined);
    await settle();

    expect(sessionFetches).toBe(1);
  });

  it("does not re-check the session in response to the session query's own failure", async () => {
    const client = newClient();
    installAuthFailureRecheck(client);

    let sessionFetches = 0;
    await client
      .fetchQuery({
        queryKey: queryKeys.auth.session,
        queryFn: async () => {
          sessionFetches += 1;
          throw new ApiError("unauthorized", 401, null);
        },
      })
      .catch(() => undefined);
    await settle();

    expect(sessionFetches).toBe(1);
  });

  it("collapses a burst of 401s from many queries into a single session re-check", async () => {
    const client = newClient();
    installAuthFailureRecheck(client);

    let sessionFetches = 0;
    await client.fetchQuery({
      queryKey: queryKeys.auth.session,
      queryFn: async () => {
        sessionFetches += 1;
        return { user: { id: "u1" } };
      },
    });
    expect(sessionFetches).toBe(1);

    await Promise.all(
      ["issues", "agents", "labels", "routines", "skills"].map((name) =>
        client
          .fetchQuery({
            queryKey: [name, "list"],
            queryFn: async () => {
              throw new ApiError("unauthorized", 401, null);
            },
          })
          .catch(() => undefined),
      ),
    );
    await settle();

    expect(sessionFetches).toBe(2);
  });
});

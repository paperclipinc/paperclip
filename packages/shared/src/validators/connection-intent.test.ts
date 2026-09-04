import { describe, expect, it } from "vitest";
import {
  connectionRequestInputSchema,
  connectionsSearchInputSchema,
  createIssueThreadInteractionSchema,
} from "../index.js";

const agentId = "11111111-1111-4111-8111-111111111111";

describe("connection intent contracts", () => {
  it("keeps generic interaction creation closed to the server-owned kind", () => {
    expect(createIssueThreadInteractionSchema.safeParse({
      kind: "connection_intent",
      payload: {
        version: 1,
        serviceSlug: "notion",
        serviceName: "Notion",
        requestingAgentId: agentId,
        requestingAgentName: "Researcher",
        phase: "requested",
      },
    }).success).toBe(false);
  });

  it("normalizes canonical search and request tool inputs", () => {
    expect(connectionsSearchInputSchema.parse({ query: "  notion  " })).toEqual({ query: "notion" });
    expect(connectionRequestInputSchema.parse({ service: " notion " })).toEqual({ service: "notion" });
  });
});

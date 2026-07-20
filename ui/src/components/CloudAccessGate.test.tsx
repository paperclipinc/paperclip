// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCurrentBoardAccess } from "@/test-utils/currentBoardAccess";
import { CloudAccessGate } from "./CloudAccessGate";

const mockHealthApi = vi.hoisted(() => ({
  get: vi.fn(),
}));
const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
}));
const mockAccessApi = vi.hoisted(() => ({
  getCurrentBoardAccess: vi.fn(),
  claimBootstrapAdmin: vi.fn(),
}));

vi.mock("@/api/health", () => ({ healthApi: mockHealthApi }));
vi.mock("@/api/auth", () => ({ authApi: mockAuthApi }));
vi.mock("@/api/access", () => ({ accessApi: mockAccessApi }));
vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/PAP/issues/PAP-1", search: "", hash: "", state: null }),
  Outlet: () => <div data-testid="gate-content">Protected content</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

// A zero-duration advance does not reliably settle react-query's own
// batched-notify scheduling under fake timers (observed empirically); a
// small positive duration does, same as the real retryDelay advances below.
async function flushReact() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10);
    });
  }
}

// Fast-forwards past a react-query retryDelay wait, then settles.
async function advancePastDelay(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await flushReact();
}

const validSession = {
  session: { id: "sess-1", userId: "user-1" },
  user: { id: "user-1", email: "user@example.com", name: "User One", image: null },
};

class FakeSessionError extends Error {
  status: number;
  constructor(status: number) {
    super(`session check failed (${status})`);
    this.status = status;
  }
}

let container: HTMLDivElement;
let root: Root | null = null;
let replaceMock: ReturnType<typeof vi.fn>;

function render() {
  root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    queryClient,
    renderPromise: act(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <CloudAccessGate />
        </QueryClientProvider>,
      );
    }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  replaceMock = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, replace: replaceMock },
  });
  mockHealthApi.get.mockResolvedValue({ status: "ok", deploymentMode: "authenticated", bootstrapStatus: "ready" });
  mockAccessApi.getCurrentBoardAccess.mockResolvedValue(buildCurrentBoardAccess());
});

afterEach(async () => {
  await act(() => root?.unmount());
  root = null;
  container.remove();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("CloudAccessGate session-check handling", () => {
  it("redirects to sign-in on a definitive unauthenticated session (null, e.g. a 401)", async () => {
    mockAuthApi.getSession.mockResolvedValue(null);

    const { renderPromise } = render();
    await renderPromise;
    await flushReact();

    expect(replaceMock).toHaveBeenCalledTimes(1);
    expect(replaceMock.mock.calls[0]?.[0]).toBe(
      "/auth/sign-in?next=%2FPAP%2Fissues%2FPAP-1",
    );
    expect(container.querySelector('[data-testid="gate-content"]')).toBeNull();
  });

  it("retries a 429 and never redirects once the session check eventually succeeds", async () => {
    mockAuthApi.getSession
      .mockRejectedValueOnce(new FakeSessionError(429))
      .mockResolvedValueOnce(validSession);

    const { renderPromise } = render();
    await renderPromise;
    await flushReact();

    // Still within the first retry's backoff window (2s) — no redirect yet,
    // and the session isn't resolved yet either.
    expect(replaceMock).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="gate-content"]')).toBeNull();

    // Advance past the first retry delay (2000ms) so the retried call fires
    // and resolves.
    await advancePastDelay(2100);

    expect(mockAuthApi.getSession).toHaveBeenCalledTimes(2);
    expect(replaceMock).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="gate-content"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Connection problem");
  });

  it("stays mounted with a non-destructive inline state (never redirects) once every retry is exhausted", async () => {
    mockAuthApi.getSession.mockRejectedValue(new FakeSessionError(429));

    const { renderPromise } = render();
    await renderPromise;
    await flushReact();

    // Advance past all three backoff delays (2s + 8s + 30s) so every retry
    // is exhausted and the query settles into its error state.
    await advancePastDelay(2_100);
    await advancePastDelay(8_100);
    await advancePastDelay(30_100);

    // 1 initial attempt + 3 retries.
    expect(mockAuthApi.getSession).toHaveBeenCalledTimes(4);
    expect(replaceMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Connection problem, retrying");
    expect(container.querySelector('[data-testid="gate-content"]')).toBeNull();
  });
});

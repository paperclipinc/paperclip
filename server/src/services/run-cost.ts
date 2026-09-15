export function parseMargin(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 1;
  return n;
}
export interface BilledInput { modelUsd: number | null; computeUsd: number; margin: number; }
export function billedCostCents(input: BilledInput): number {
  if (input.modelUsd === null) return 0;
  const wholesale = input.modelUsd + input.computeUsd;
  return Math.ceil(wholesale * input.margin * 100);
}

// PAPERCLIP_CLOUD_COMPUTE_USD_PER_HOUR: the wholesale cost of one standard
// managed sandbox pod running for an hour. A sandbox pod RESERVES known
// CPU/memory on our own Hetzner nodes for its whole lifetime, so duration x
// this rate is a cost we always pay and can always bill -- it does not depend
// on Kubecost being up, on kube-state-metrics exposing the run-id label, or on
// a run being long enough to register against the Prometheus scrape interval.
// Unset/invalid -> 0 (compute disabled -> safe degrade to today's behaviour).
export function parseComputeRatePerHour(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

// The deterministic compute floor: wall-clock pod-hours x the pod-hour rate.
export function deterministicComputeUsd(durationSec: number, ratePerHour: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0;
  if (!Number.isFinite(ratePerHour) || ratePerHour <= 0) return 0;
  return (durationSec / 3600) * ratePerHour;
}

export interface ResolveComputeInput { kubecostUsd: number; durationSec: number; ratePerHour: number; }
// Prefer a POSITIVE Kubecost measurement (real attributed node cost incl.
// amortized PV/network) when it exists; otherwise fall through to the
// deterministic floor so a managed run is NEVER metered with 0 compute. Same
// defensive shape as priceCloudTokens trusting costUsd only when > 0: a 0/NaN
// from Kubecost means "no signal", not "this run used no compute".
export function resolveComputeUsd(input: ResolveComputeInput): number {
  if (Number.isFinite(input.kubecostUsd) && input.kubecostUsd > 0) return input.kubecostUsd;
  return deterministicComputeUsd(input.durationSec, input.ratePerHour);
}

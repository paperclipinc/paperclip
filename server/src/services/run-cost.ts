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

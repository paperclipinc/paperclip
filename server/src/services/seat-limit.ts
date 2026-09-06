// Billing insertion point. Launch default: unlimited seats.
// The Billing workstream replaces this body with a real plan/seat check.
export async function assertSeatAvailable(
  _db: unknown,
  _companyId: string | null,
): Promise<void> {
  return;
}

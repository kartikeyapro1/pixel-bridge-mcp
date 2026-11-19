import type { BudgetLedger, CostEstimate } from '../core/budget.js';
import { isPixelBridgeError } from '../core/errors.js';

/**
 * Wrap a billable provider call in the reservation protocol:
 * reserve → call → settle; on failure, release only when the provider
 * certainly did not bill, otherwise keep the estimate counted as "unknown".
 */
export async function runPaid<T>(
  budget: BudgetLedger,
  estimate: CostEstimate,
  note: string,
  fn: () => Promise<{ value: T; actualCostUsd: number | null }>,
): Promise<{ value: T; ledgerId: string; costUsd: number; costIsActual: boolean }> {
  const reservation = budget.reserve(estimate, note);
  try {
    const { value, actualCostUsd } = await fn();
    budget.settle(reservation.id, actualCostUsd);
    return {
      value,
      ledgerId: reservation.id,
      costUsd: actualCostUsd ?? estimate.estimatedUsd,
      costIsActual: actualCostUsd !== null,
    };
  } catch (e) {
    const notBilled = isPixelBridgeError(e) && e.details?.billed === false;
    if (notBilled) budget.release(reservation.id, `failed: ${e.code}`);
    else budget.markUnknown(reservation.id, `outcome unknown: ${isPixelBridgeError(e) ? e.code : 'error'}`);
    throw e;
  }
}

// Event hooks called from the ledger inside the same transaction.
import type { Q } from '../db';
import { onOutgoing } from './logistics-hook';

/** After an OUT movement is written (manual, photo read, import or dispatch screen). */
export async function afterOutgoing(q: Q, movement: Record<string, unknown>, actor: string | null): Promise<void> {
  await onOutgoing(q, movement, actor);
}

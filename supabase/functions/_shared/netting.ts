import type { NetPosition, Transfer } from "./types.ts";

export function minimalTransfers(positions: NetPosition[]): Transfer[] {
  const total = positions.reduce((a, p) => a + p.cents, 0);
  if (total !== 0) throw new Error(`net positions must sum to zero, got ${total}`);

  // debtors have negative cents, creditors positive; ignore the already-settled
  const debtors = positions.filter((p) => p.cents < 0).map((p) => ({ ...p }));
  const creditors = positions.filter((p) => p.cents > 0).map((p) => ({ ...p }));
  debtors.sort((a, b) => a.cents - b.cents); // most-negative first
  creditors.sort((a, b) => b.cents - a.cents); // most-positive first

  const transfers: Transfer[] = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const debt = -debtors[i].cents;
    const credit = creditors[j].cents;
    const amount = Math.min(debt, credit);
    transfers.push({
      fromMemberId: debtors[i].memberId,
      toMemberId: creditors[j].memberId,
      amountCents: amount,
    });
    debtors[i].cents += amount;
    creditors[j].cents -= amount;
    if (debtors[i].cents === 0) i++;
    if (creditors[j].cents === 0) j++;
  }
  return transfers;
}

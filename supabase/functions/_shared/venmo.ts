export function buildVenmoPayLink(
  input: { handle: string; amountCents: number; note: string },
): string {
  const handle = input.handle.replace(/^@/, "");
  const params = new URLSearchParams({
    txn: "pay",
    amount: (input.amountCents / 100).toFixed(2),
    note: input.note,
  });
  return `https://venmo.com/${encodeURIComponent(handle)}?${params.toString()}`;
}

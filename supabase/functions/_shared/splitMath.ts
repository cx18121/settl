import type { Cents, ShareInput } from "./types.ts";

export function equalSplit(totalCents: Cents, memberIds: string[]): ShareInput[] {
  if (memberIds.length === 0) throw new Error("equalSplit needs at least one member");
  const n = memberIds.length;
  const base = Math.floor(totalCents / n);
  let remainder = totalCents - base * n; // 0..n-1 extra cents
  return memberIds.map((memberId) => {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    return { memberId, amountCents: base + extra };
  });
}

export function assertSharesSumTo(totalCents: Cents, shares: ShareInput[]): void {
  for (const s of shares) {
    if (s.amountCents < 0) throw new Error(`share for ${s.memberId} is negative`);
  }
  const sum = shares.reduce((a, s) => a + s.amountCents, 0);
  if (sum !== totalCents) {
    throw new Error(`shares must sum to total: got ${sum}, expected ${totalCents}`);
  }
}

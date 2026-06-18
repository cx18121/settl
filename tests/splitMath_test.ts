import { assertEquals, assertThrows } from "@std/assert";
import { equalSplit } from "../supabase/functions/_shared/splitMath.ts";

Deno.test("equalSplit divides evenly when divisible", () => {
  const shares = equalSplit(900, ["a", "b", "c"]);
  assertEquals(shares.map((s) => s.amountCents), [300, 300, 300]);
});

Deno.test("equalSplit gives remainder cents to first members", () => {
  const shares = equalSplit(1000, ["a", "b", "c"]);
  assertEquals(shares.map((s) => s.amountCents), [334, 333, 333]);
});

Deno.test("equalSplit always sums to total", () => {
  for (const total of [1, 7, 99, 100, 1001, 99999]) {
    for (const n of [1, 2, 3, 4, 7]) {
      const ids = Array.from({ length: n }, (_, i) => `m${i}`);
      const sum = equalSplit(total, ids).reduce((a, s) => a + s.amountCents, 0);
      assertEquals(sum, total, `total ${total} across ${n}`);
    }
  }
});

Deno.test("equalSplit rejects empty member list", () => {
  assertThrows(() => equalSplit(100, []), Error, "at least one member");
});

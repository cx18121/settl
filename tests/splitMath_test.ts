import { assertEquals, assertThrows } from "@std/assert";
import { equalSplit, assertSharesSumTo } from "../supabase/functions/_shared/splitMath.ts";

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

Deno.test("assertSharesSumTo passes when shares match total", () => {
  assertSharesSumTo(1000, [
    { memberId: "a", amountCents: 600 },
    { memberId: "b", amountCents: 400 },
  ]);
});

Deno.test("assertSharesSumTo throws when shares miss total", () => {
  assertThrows(
    () => assertSharesSumTo(1000, [{ memberId: "a", amountCents: 999 }]),
    Error,
    "must sum to total",
  );
});

Deno.test("assertSharesSumTo throws on negative share", () => {
  assertThrows(
    () =>
      assertSharesSumTo(1000, [
        { memberId: "a", amountCents: 1100 },
        { memberId: "b", amountCents: -100 },
      ]),
    Error,
    "negative",
  );
});

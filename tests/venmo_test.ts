import { assert, assertEquals } from "@std/assert";
import { buildVenmoPayLink } from "../supabase/functions/_shared/venmo.ts";

Deno.test("builds an https venmo.com pay link with the handle in the path", () => {
  const link = buildVenmoPayLink({ handle: "charlie-x", amountCents: 1450, note: "Settling up" });
  const u = new URL(link);
  assertEquals(u.protocol, "https:");
  assertEquals(u.host, "venmo.com");
  assertEquals(u.pathname, "/charlie-x");
  assertEquals(u.searchParams.get("txn"), "pay");
  assertEquals(u.searchParams.get("amount"), "14.50");
  assertEquals(u.searchParams.get("note"), "Settling up");
  assertEquals(u.searchParams.get("audience"), null);
  assertEquals(u.searchParams.get("recipients"), null);
});

Deno.test("amount renders whole dollars with two decimals", () => {
  const u = new URL(buildVenmoPayLink({ handle: "a", amountCents: 1400, note: "n" }));
  assertEquals(u.searchParams.get("amount"), "14.00");
});

Deno.test("strips a leading @ and path-encodes a hostile handle", () => {
  const link = buildVenmoPayLink({ handle: "@a/b?c#d", amountCents: 100, note: "n" });
  const u = new URL(link);
  assertEquals(u.pathname, "/a%2Fb%3Fc%23d");
  assert(!link.includes("/a/b"));
});

Deno.test("special characters in the note survive a round-trip (correct escaping)", () => {
  const note = "a b&c=d?e#f";
  const u = new URL(buildVenmoPayLink({ handle: "x", amountCents: 100, note }));
  assertEquals(u.searchParams.get("note"), note);
  assert(!u.search.includes("c=d"));
});

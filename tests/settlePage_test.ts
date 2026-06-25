import { assert } from "@std/assert";
import { renderErrorPage, renderSettlePage } from "../supabase/functions/_shared/settlePage.ts";

Deno.test("owed amount renders with a pay button", () => {
  const html = renderSettlePage({
    memberName: "Jake",
    debts: [{ creditorName: "Charlie", amountCents: 1400, payLink: "https://venmo.com/?txn=pay&amount=14.00" }],
  });
  assert(html.includes("You owe Charlie $14.00"));
  assert(html.includes('rel="noreferrer" href="https://venmo.com/?txn=pay&amp;amount=14.00"'));
  assert(html.includes("Pay with Venmo"));
});

Deno.test("the page sets a no-referrer policy so the settle token can't leak to Venmo", () => {
  const html = renderSettlePage({ memberName: "Jake", debts: [] });
  assert(html.includes('<meta name="referrer" content="no-referrer">'));
});

Deno.test("multiple creditors each render a line and a button", () => {
  const html = renderSettlePage({
    memberName: "Jake",
    debts: [
      { creditorName: "Charlie", amountCents: 1400, payLink: "https://venmo.com/?a=1" },
      { creditorName: "Dana", amountCents: 600, payLink: "https://venmo.com/?a=2" },
    ],
  });
  assert(html.includes("You owe Charlie $14.00"));
  assert(html.includes("You owe Dana $6.00"));
});

Deno.test("a settled-up member sees no pay button", () => {
  const html = renderSettlePage({ memberName: "Jake", debts: [] });
  assert(html.includes("settled up"));
  assert(!html.includes("href="));
});

Deno.test("a creditor without a handle shows a fallback, not a button", () => {
  const html = renderSettlePage({
    memberName: "Jake",
    debts: [{ creditorName: "Charlie", amountCents: 1400, payLink: null }],
  });
  assert(html.includes("hasn't added a Venmo handle"));
  assert(!html.includes("href="));
});

Deno.test("a hostile display name is HTML-escaped", () => {
  const html = renderSettlePage({
    memberName: "Jake",
    debts: [{ creditorName: "<script>alert(1)</script>", amountCents: 100, payLink: null }],
  });
  assert(!html.includes("<script>alert(1)</script>"));
  assert(html.includes("&lt;script&gt;"));
});

Deno.test("error page shows the message", () => {
  const html = renderErrorPage("This settle link isn't valid.");
  assert(html.includes("This settle link isn&#39;t valid."));
});

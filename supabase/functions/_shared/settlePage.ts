export interface SettleDebt {
  creditorName: string;
  amountCents: number;
  payLink: string | null;
}

export interface SettlePageView {
  memberName: string;
  debts: SettleDebt[];
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function dollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

const STYLE =
  "body{font-family:-apple-system,system-ui,sans-serif;max-width:30rem;margin:3rem auto;padding:0 1.25rem;color:#1a1a1a}" +
  ".debt{margin:1.5rem 0}" +
  "p{font-size:1.25rem;line-height:1.5}" +
  ".pay{display:inline-block;margin-top:.5rem;padding:.75rem 1.25rem;background:#3d95ce;color:#fff;border-radius:.5rem;text-decoration:none;font-weight:600}" +
  ".no-handle{color:#666;font-size:1rem}";

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="referrer" content="no-referrer">` +
    `<title>${esc(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;
}

export function renderSettlePage(view: SettlePageView): string {
  if (view.debts.length === 0) {
    return shell("Settl", `<p>You're all settled up 🎉</p>`);
  }
  const blocks = view.debts.map((d) => {
    const line = `<p>You owe ${esc(d.creditorName)} $${dollars(d.amountCents)}</p>`;
    const action = d.payLink
      ? `<a class="pay" rel="noreferrer" href="${esc(d.payLink)}">Pay with Venmo</a>`
      : `<p class="no-handle">${esc(d.creditorName)} hasn't added a Venmo handle yet</p>`;
    return `<div class="debt">${line}${action}</div>`;
  }).join("");
  return shell("Settl", blocks);
}

export function renderErrorPage(message: string): string {
  return shell("Settl", `<p>${esc(message)}</p>`);
}

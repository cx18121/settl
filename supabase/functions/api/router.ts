import type { SupabaseClient } from "@supabase/supabase-js";
import { authorizeGroup } from "../_shared/auth.ts";
import {
  addMembers,
  claimMember,
  confirmSettlement,
  createGroup,
  createLoan,
  createOrder,
  createPool,
  createSplit,
  getNettedTransfers,
  recordSettlement,
  voidEvent,
} from "../_shared/repo.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function statusForError(message: string): number {
  if (/unauthorized|creditor's device/i.test(message)) return 403;
  if (/already claimed|pending settlement already exists|different payment details/i.test(message)) return 409;
  if (/not found|no active event|no proposed settlement/i.test(message)) return 404;
  return 400;
}

export async function handle(req: Request, db: SupabaseClient): Promise<Response> {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const token = req.headers.get("x-settl-token");
  const device = req.headers.get("x-settl-device");
  const body = async () => (req.body ? await req.json() : {});

  try {
    if (req.method === "POST" && parts.length === 1 && parts[0] === "groups") {
      const b = await body();
      const out = await createGroup(db, { title: b.title ?? null });
      return json(out, 201);
    }

    if (parts[0] === "groups" && parts.length >= 3) {
      const groupId = parts[1];
      const sub = parts[2];

      if (req.method === "POST" && sub === "members" && parts.length === 3) {
        await authorizeGroup(db, groupId, token);
        const b = await body();
        const out = await addMembers(db, { groupId, names: b.names ?? [] });
        return json(out, 201);
      }

      if (req.method === "POST" && sub === "claim" && parts.length === 3) {
        await authorizeGroup(db, groupId, token);
        if (!device) throw new Error("missing device id");
        const b = await body();
        await claimMember(db, {
          groupId,
          memberId: b.memberId,
          deviceId: device,
          venmoHandle: b.venmoHandle ?? null,
        });
        return json({ ok: true }, 200);
      }

      if (req.method === "GET" && sub === "balances" && parts.length === 3) {
        await authorizeGroup(db, groupId, token);
        const transfers = await getNettedTransfers(db, groupId);
        return json({ transfers }, 200);
      }

      if (req.method === "POST" && sub === "splits" && parts.length === 3) {
        await authorizeGroup(db, groupId, token);
        const b = await body();
        const out = await createSplit(db, {
          groupId, title: b.title ?? null, totalCents: b.totalCents,
          payerMemberId: b.payerMemberId, shares: b.shares,
        });
        return json(out, 201);
      }

      if (req.method === "POST" && sub === "pools" && parts.length === 3) {
        await authorizeGroup(db, groupId, token);
        const b = await body();
        const out = await createPool(db, {
          groupId, title: b.title ?? null, targetCents: b.targetCents,
          organizerMemberId: b.organizerMemberId, contributorMemberIds: b.contributorMemberIds,
        });
        return json(out, 201);
      }

      if (req.method === "POST" && sub === "loans" && parts.length === 3) {
        await authorizeGroup(db, groupId, token);
        const b = await body();
        const out = await createLoan(db, {
          groupId, title: b.title ?? null, lenderMemberId: b.lenderMemberId,
          borrowerMemberId: b.borrowerMemberId, amountCents: b.amountCents,
        });
        return json(out, 201);
      }

      if (req.method === "POST" && sub === "orders" && parts.length === 3) {
        await authorizeGroup(db, groupId, token);
        const b = await body();
        const out = await createOrder(db, {
          groupId, title: b.title ?? null, payerMemberId: b.payerMemberId, items: b.items,
        });
        return json(out, 201);
      }

      if (req.method === "POST" && sub === "settlements" && parts.length === 3) {
        await authorizeGroup(db, groupId, token);
        const b = await body();
        const out = await recordSettlement(db, {
          groupId,
          fromMemberId: b.fromMemberId,
          toMemberId: b.toMemberId,
          amountCents: b.amountCents,
          method: b.method,
          idempotencyKey: b.idempotencyKey,
        });
        return json(out, 201);
      }
    }

    if (parts[0] === "groups" && parts.length === 5 && req.method === "POST") {
      const groupId = parts[1];
      await authorizeGroup(db, groupId, token);
      if (parts[2] === "settlements" && parts[4] === "confirm") {
        if (!device) throw new Error("missing device id");
        await confirmSettlement(db, { groupId, settlementId: parts[3], deviceId: device });
        return json({ ok: true }, 200);
      }
      if (parts[2] === "events" && parts[4] === "void") {
        if (!device) throw new Error("missing device id");
        await voidEvent(db, { groupId, eventId: parts[3], deviceId: device });
        return json({ ok: true }, 200);
      }
    }

    return json({ error: "not found" }, 404);
  } catch (e) {
    const message = (e as Error).message;
    return json({ error: message }, statusForError(message));
  }
}

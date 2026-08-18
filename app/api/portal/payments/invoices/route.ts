import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { corsHeaders, withCors } from "@/lib/portalCors";
import { customerFrom } from "@/lib/portalAuth";

export const runtime = "nodejs";

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}

/**
 * The customer's invoices and what they owe.
 *
 * This selected `amount_cents` and `paid_at`, neither of which exists on the
 * invoices table — the amount is `total` in dollars, and payment dates live on
 * the payments table. Postgres rejects the whole select on an unknown column,
 * so every customer's billing screen came back empty with a balance of zero,
 * including anyone who actually owed money. It read as "all paid".
 */
export async function GET(req: NextRequest) {
  const origin = req.headers.get("origin");
  const c = await customerFrom(req);
  if (!c) return withCors({ error: "not found" }, origin, 404);

  const { data, error } = await supabaseAdmin()
    .from("invoices")
    .select("id, number, total, status, due_date, created_at, line_items, payments(amount, method, paid_at)")
    .eq("customer_id", c.id)
    .order("created_at", { ascending: false })
    .limit(24);

  // A query failure must not masquerade as "you owe nothing".
  if (error) return withCors({ error: "Couldn't load your invoices — try again." }, origin, 500);

  const items = (data ?? []).map((i: any) => ({
    id: i.id,
    number: i.number,
    amount: Number(i.total ?? 0),
    status: i.status,
    due: i.due_date,
    created_at: i.created_at,
    line_items: i.line_items ?? null,
    paid_at: (i.payments ?? []).map((p: any) => p.paid_at).sort().slice(-1)[0] ?? null,
    payments: i.payments ?? [],
  }));

  // Void invoices are not owed. Counting them would show a balance for money
  // nobody is being asked for.
  const balance = items
    .filter((i) => i.status !== "paid" && i.status !== "void")
    .reduce((s, i) => s + i.amount, 0);

  return withCors({ items, balance: Math.round(balance * 100) / 100 }, origin);
}

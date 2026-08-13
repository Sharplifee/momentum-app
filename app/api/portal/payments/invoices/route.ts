import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { corsHeaders, withCors } from "@/lib/portalCors";
import { customerFrom } from "@/lib/portalAuth";
export const runtime = "nodejs";
export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}
export async function GET(req: NextRequest) {
  const origin = req.headers.get("origin");
  const c = await customerFrom(req);
  if (!c) return withCors({ error: "not found" }, origin, 404);
  const { data } = await supabaseAdmin()
    .from("invoices")
    .select("id, amount_cents, status, due_date, created_at, paid_at")
    .eq("customer_id", c.id).order("created_at", { ascending: false }).limit(24);
  const items = (data ?? []).map((i: any) => ({
    id: i.id, amount: (i.amount_cents ?? 0) / 100, status: i.status,
    due: i.due_date, paid_at: i.paid_at,
  }));
  const balance = items.filter((i) => i.status !== "paid").reduce((s, i) => s + i.amount, 0);
  return withCors({ items, balance }, origin);
}

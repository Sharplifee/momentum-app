import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { corsHeaders, withCors } from "@/lib/portalCors";
import { customerFrom } from "@/lib/portalAuth";
import { withEventLog } from "@/lib/eventLog";
export const runtime = "nodejs";
async function __OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}
/** The card on file, as Stripe knows it. Never the number — brand and last four. */
async function __GET(req: NextRequest) {
  const origin = req.headers.get("origin");
  const c = await customerFrom(req);
  if (!c) return withCors({ error: "not found" }, origin, 404);
  const { data: row } = await supabaseAdmin()
    .from("customers").select("stripe_customer_id").eq("id", c.id).maybeSingle();
  const sid = (row as any)?.stripe_customer_id;
  if (!sid || !process.env.STRIPE_SECRET_KEY) {
    return withCors({ method: null }, origin);
  }
  const res = await fetch(
    `https://api.stripe.com/v1/customers/${sid}/payment_methods?type=card&limit=1`,
    { headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` } }
  ).catch(() => null);
  if (!res?.ok) return withCors({ method: null }, origin);
  const d = await res.json();
  const card = d?.data?.[0]?.card;
  return withCors({
    method: card ? { brand: card.brand, last4: card.last4, exp: `${card.exp_month}/${card.exp_year}` } : null,
  }, origin);
}

export const GET = withEventLog("GET /api/portal/payments/method", __GET);
export const OPTIONS = withEventLog("OPTIONS /api/portal/payments/method", __OPTIONS);

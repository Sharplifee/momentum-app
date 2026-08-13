import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { corsHeaders, withCors } from "@/lib/portalCors";
import { customerFrom } from "@/lib/portalAuth";
export const runtime = "nodejs";
export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}
/**
 * Starts adding a card. Returns a Stripe client secret; the card details never
 * touch our server, which is the whole point of doing it this way.
 */
export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  const b = await req.json().catch(() => ({}));
  if (!b?.customer_id) return withCors({ error: "customer_id required" }, origin, 400);
  if (!process.env.STRIPE_SECRET_KEY) {
    return withCors({ error: "Payments aren't switched on yet." }, origin, 503);
  }
  const db = supabaseAdmin();
  const { data: c } = await db.from("customers")
    .select("id, full_name, phone, email, stripe_customer_id").eq("id", b.customer_id).maybeSingle();
  if (!c) return withCors({ error: "not found" }, origin, 404);

  let sid = (c as any).stripe_customer_id as string | null;
  const auth = { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
                 "Content-Type": "application/x-www-form-urlencoded" };

  if (!sid) {
    const body = new URLSearchParams();
    if (c.full_name) body.set("name", c.full_name);
    if (c.email) body.set("email", c.email);
    if (c.phone) body.set("phone", c.phone);
    body.set("metadata[customer_id]", c.id);
    const r = await fetch("https://api.stripe.com/v1/customers", { method: "POST", headers: auth, body });
    if (!r.ok) return withCors({ error: "We couldn't reach payments. Try again in a moment." }, origin, 502);
    sid = (await r.json()).id;
    await db.from("customers").update({ stripe_customer_id: sid }).eq("id", c.id);
  }

  const si = new URLSearchParams();
  si.set("customer", sid!);
  si.set("payment_method_types[]", "card");
  si.set("usage", "off_session");
  const r2 = await fetch("https://api.stripe.com/v1/setup_intents", { method: "POST", headers: auth, body: si });
  if (!r2.ok) return withCors({ error: "We couldn't start that. Try again in a moment." }, origin, 502);
  const intent = await r2.json();
  return withCors({ client_secret: intent.client_secret,
                    publishable_key: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? null }, origin);
}

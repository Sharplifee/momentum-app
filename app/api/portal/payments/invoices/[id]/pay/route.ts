import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { customerFrom } from "@/lib/portalAuth";
import { corsHeaders, withCors } from "@/lib/portalCors";

export const runtime = "nodejs";

/**
 * Pay one invoice.
 *
 * The billing screen has always called this and the route did not exist — the
 * Pay button answered 404, so no customer has ever been able to pay in the app.
 *
 * Returns a Stripe Checkout URL rather than charging here: card details never
 * touch our servers, which is the whole reason to use Checkout.
 */
export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: { ...corsHeaders(req.headers.get("origin")), "Access-Control-Allow-Methods": "POST,OPTIONS" },
  });
}

export async function POST(req: NextRequest, ctx: { params: { id: string } }) {
  const origin = req.headers.get("origin");
  const c = await customerFrom(req);
  if (!c) return withCors({ error: "unauthorized" }, origin, 401);

  const admin = supabaseAdmin();

  // Scoped to the caller, so an invoice id from somewhere else buys nothing.
  const { data: inv } = await admin
    .from("invoices")
    .select("id, number, total, status, customer_id")
    .eq("id", ctx.params.id)
    .eq("customer_id", c.id)
    .maybeSingle();
  if (!inv) return withCors({ error: "not found" }, origin, 404);
  if (inv.status === "paid") return withCors({ ok: true, already_paid: true }, origin);
  if (inv.status === "void") return withCors({ error: "That invoice was cancelled." }, origin, 400);

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    // Honest rather than a dead button: say it plainly and let them message us.
    return withCors({ error: "Card payments aren't switched on yet — message us and we'll sort it out." }, origin, 503);
  }

  const amount = Math.round(Number(inv.total ?? 0) * 100);
  if (amount <= 0) return withCors({ error: "Nothing to pay on that invoice." }, origin, 400);

  const site = req.nextUrl.origin;
  const form = new URLSearchParams();
  form.set("mode", "payment");
  form.set("success_url", `${site}/app?paid=1`);
  form.set("cancel_url", `${site}/app?canceled=1`);
  form.set("client_reference_id", inv.id);
  form.set("line_items[0][quantity]", "1");
  form.set("line_items[0][price_data][currency]", "usd");
  form.set("line_items[0][price_data][unit_amount]", String(amount));
  form.set("line_items[0][price_data][product_data][name]", `Momentum Landscaping — invoice #${inv.number ?? ""}`.trim());
  form.set("metadata[invoice_id]", inv.id);
  form.set("metadata[customer_id]", c.id);

  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  }).catch(() => null);

  const json = res ? await res.json().catch(() => null) : null;
  if (!res?.ok || !json?.url) {
    return withCors({ error: "Couldn't open checkout — try again in a moment." }, origin, 502);
  }

  return withCors({ ok: true, url: json.url }, origin);
}

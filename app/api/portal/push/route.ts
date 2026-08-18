import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { corsHeaders, withCors } from "@/lib/portalCors";

export const runtime = "nodejs";

/**
 * Push registration for the customer app.
 *
 * The customer app is served from momentumlandscapingut.com as a static page
 * and calls this cross-origin, the same way every other /api/portal route
 * works — so identity is the customer_id the app already holds from sign-in,
 * not a cookie session. Staff use /api/push/register instead; they have
 * profiles, customers do not.
 *
 * The device token comes from the iOS shell. In a plain browser there is no
 * token to send and nothing here ever runs.
 *
 * POST   { customer_id, token, bundle_id? }  -> registers
 * DELETE { customer_id, token }              -> retires on sign-out
 */

const CUSTOMER_BUNDLE = "com.momentumlandscapingut.customer";

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: { ...corsHeaders(req.headers.get("origin")), "Access-Control-Allow-Methods": "POST,DELETE,OPTIONS" },
  });
}

export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  const { customer_id, token, bundle_id, app_version, platform } = await req.json().catch(() => ({}));

  if (!customer_id) return withCors({ error: "customer_id required" }, origin, 400);
  if (!token) return withCors({ error: "token required" }, origin, 400);

  const db = supabaseAdmin();

  // A token that doesn't belong to a real customer is either a stale app or
  // someone poking at the endpoint; either way it should not create a row.
  const { data: customer } = await db
    .from("customers").select("id").eq("id", customer_id).maybeSingle();
  if (!customer) return withCors({ error: "not found" }, origin, 404);

  // iOS reissues the token on reinstall and phones get handed down, so the
  // upsert re-points an existing token at whoever is signed in now.
  const { error } = await db.from("push_tokens").upsert(
    {
      token,
      customer_id,
      profile_id: null,
      platform: platform ?? "ios",
      bundle_id: bundle_id ?? CUSTOMER_BUNDLE,
      app_version: app_version ?? null,
      active: true,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "token" }
  );
  if (error) return withCors({ error: error.message }, origin, 400);

  // Retire this customer's older device tokens on the same app.
  //
  // iOS issues a fresh token after a reinstall or a restore, and the old one
  // stays valid for a while — so a customer accumulates tokens and receives the
  // same notice two or three times. Only the token that just checked in is
  // known to be a phone the customer still has in their hand.
  await db
    .from("push_tokens")
    .update({ active: false })
    .eq("customer_id", customer_id)
    .eq("bundle_id", bundle_id ?? CUSTOMER_BUNDLE)
    .neq("token", token);

  return withCors({ ok: true }, origin);
}

export async function DELETE(req: NextRequest) {
  const origin = req.headers.get("origin");
  const { customer_id, token } = await req.json().catch(() => ({}));
  if (!token) return withCors({ error: "token required" }, origin, 400);

  const db = supabaseAdmin();
  const q = db.from("push_tokens").update({ active: false }).eq("token", token);
  if (customer_id) q.eq("customer_id", customer_id);
  await q;

  return withCors({ ok: true }, origin);
}

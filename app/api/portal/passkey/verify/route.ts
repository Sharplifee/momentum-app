import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { customerFrom } from "@/lib/portalAuth";
import { corsHeaders, withCors } from "@/lib/portalCors";

export const runtime = "nodejs";

/**
 * Step two of enrolling: store the public key the phone generated.
 *
 * The private half never leaves the Secure Enclave, so what lands here cannot
 * impersonate the customer even if this table were read in full.
 */
export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: { ...corsHeaders(req.headers.get("origin")), "Access-Control-Allow-Methods": "POST,OPTIONS" },
  });
}

export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  const c = await customerFrom(req);
  if (!c) return withCors({ error: "unauthorized" }, origin, 401);

  const { challenge, credential_id, public_key, device_label } = await req.json().catch(() => ({} as any));
  if (!challenge || !credential_id || !public_key) {
    return withCors({ error: "incomplete registration" }, origin, 400);
  }

  const db = supabaseAdmin();
  const { data: ch } = await db
    .from("webauthn_challenges").select("challenge, customer_id, kind, used_at")
    .eq("challenge", challenge).maybeSingle();
  // Must be ours, for this customer, and unused — otherwise a captured
  // registration could be replayed onto another account.
  if (!ch || ch.used_at || ch.kind !== "register" || ch.customer_id !== c.id) {
    return withCors({ error: "That request expired — try again." }, origin, 400);
  }
  await db.from("webauthn_challenges").update({ used_at: new Date().toISOString() }).eq("challenge", challenge);

  const { error } = await db.from("customer_passkeys").upsert({
    customer_id: c.id, credential_id, public_key,
    device_label: device_label || "iPhone",
  }, { onConflict: "credential_id" });
  if (error) return withCors({ error: "Couldn't save Face ID — try again." }, origin, 400);

  return withCors({ ok: true }, origin);
}

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { corsHeaders, withCors } from "@/lib/portalCors";
export const runtime = "nodejs";
export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}
/**
 * Set or change a password.
 *
 * Requires the customer to already be signed in — by code or by their existing
 * password — because this endpoint is how an account gets its first password
 * and must not become a way to take one over.
 */
export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  const { customer_id, password, current_password } = await req.json().catch(() => ({}));
  if (!customer_id || !password) {
    return withCors({ error: "customer_id and password required" }, origin, 400);
  }
  if (String(password).length < 8) {
    return withCors({ error: "Use at least eight characters." }, origin, 400);
  }

  const db = supabaseAdmin();
  const { data: c } = await db.from("customers")
    .select("id, email").eq("id", customer_id).maybeSingle();
  if (!c) return withCors({ error: "not found" }, origin, 404);

  // If they already have one, the old password is required to change it.
  const { data: existing } = await db.from("customer_credentials")
    .select("customer_id").eq("customer_id", c.id).maybeSingle();
  if (existing && c.email) {
    const { data: rows } = await db.rpc("momentum_check_customer_password", {
      p_email: c.email, p_password: String(current_password ?? ""),
    });
    const r = Array.isArray(rows) ? rows[0] : rows;
    if (!r?.ok) return withCors({ error: "That current password didn't match." }, origin, 401);
  }

  const { error } = await db.rpc("momentum_set_customer_password", {
    p_customer: c.id, p_password: String(password),
  });
  if (error) return withCors({ error: error.message }, origin, 400);
  return withCors({ ok: true }, origin);
}

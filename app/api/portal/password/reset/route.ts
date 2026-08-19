import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { corsHeaders, withCors } from "@/lib/portalCors";
export const runtime = "nodejs";
export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}
/**
 * Forgotten password.
 *
 * POST { email }            -> texts a reset link, and says so either way
 * POST { token, password }  -> sets the new password
 *
 * The reset goes by SMS rather than email, because the phone number is the
 * thing we actually have for every customer and the thing they have proved
 * they control.
 */
export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  const { email, token, password } = await req.json().catch(() => ({}));
  const db = supabaseAdmin();

  if (token && password) {
    if (String(password).length < 8) {
      return withCors({ error: "Use at least eight characters." }, origin, 400);
    }
    const { data: ok, error } = await db.rpc("momentum_complete_password_reset", {
      p_token: String(token), p_password: String(password),
    });
    if (error || !ok) {
      return withCors({ error: "That reset link has expired. Ask for a new one." }, origin, 400);
    }
    return withCors({ ok: true }, origin);
  }

  if (!email) return withCors({ error: "email required" }, origin, 400);

  const { data: tok } = await db.rpc("momentum_start_password_reset", {
    p_email: String(email).trim(),
  });

  if (tok) {
    const { data: c } = await db.from("customers")
      .select("phone").ilike("email", String(email).trim()).maybeSingle();
    if (c?.phone) {
      await fetch("https://api.pingram.io/send", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.PINGRAM_API_KEY}`,
                   "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "nora_reply",
          to: { id: c.phone, number: c.phone },
          sms: { message: `Reset your Momentum password: https://momentumlandscapingut.com/app#reset=${tok} — expires in an hour. Didn't ask for this? Ignore it.` },
        }),
      }).catch(() => null);
    }
  }

  // Same answer whether or not the email is on file.
  return withCors({ sent: true }, origin);
}

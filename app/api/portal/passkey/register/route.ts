import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { customerFrom } from "@/lib/portalAuth";
import { corsHeaders, withCors } from "@/lib/portalCors";

export const runtime = "nodejs";

/**
 * Step one of enrolling Face ID: hand the phone a challenge to sign.
 *
 * The customer must already be signed in — a passkey is bound to an account, so
 * enrolling one is a privileged act, not a way to create an account.
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

  const challenge = randomBytes(32).toString("base64url");
  const db = supabaseAdmin();
  await db.from("webauthn_challenges").insert({ challenge, customer_id: c.id, kind: "register" });

  const { data: existing } = await db
    .from("customer_passkeys").select("credential_id").eq("customer_id", c.id);

  return withCors({
    challenge,
    rp: { name: "Momentum Landscaping", id: req.nextUrl.hostname },
    user: {
      id: Buffer.from(c.id).toString("base64url"),
      name: c.email || c.phone || "Momentum customer",
      displayName: c.full_name || "Momentum customer",
    },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
    authenticatorSelection: {
      // Face ID lives on the device itself, and requiring verification is what
      // makes this Face ID rather than a silent key.
      authenticatorAttachment: "platform",
      userVerification: "required",
      residentKey: "preferred",
    },
    timeout: 60000,
    attestation: "none",
    excludeCredentials: (existing ?? []).map((e) => ({ type: "public-key", id: e.credential_id })),
  }, origin);
}

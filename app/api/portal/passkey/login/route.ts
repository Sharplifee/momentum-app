import { NextRequest, NextResponse } from "next/server";
import { randomBytes, createVerify, createHash } from "crypto";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { corsHeaders, withCors } from "@/lib/portalCors";

export const runtime = "nodejs";

/**
 * Face ID sign-in.
 *
 * GET  — issue a challenge for the phone to sign.
 * POST — verify the signature and return the customer.
 *
 * No customer id is required to start: the phone already knows which passkey it
 * holds, and asking who they are before proving it would let anyone enumerate
 * accounts.
 */
export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: { ...corsHeaders(req.headers.get("origin")), "Access-Control-Allow-Methods": "GET,POST,OPTIONS" },
  });
}

export async function GET(req: NextRequest) {
  const origin = req.headers.get("origin");
  const challenge = randomBytes(32).toString("base64url");
  await supabaseAdmin().from("webauthn_challenges").insert({ challenge, kind: "login" });
  return withCors({
    challenge,
    rpId: req.nextUrl.hostname,
    userVerification: "required",
    timeout: 60000,
  }, origin);
}

function b64urlToBuf(s: string) {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  const { challenge, credential_id, authenticator_data, client_data_json, signature } =
    await req.json().catch(() => ({} as any));
  if (!challenge || !credential_id || !authenticator_data || !client_data_json || !signature) {
    return withCors({ error: "incomplete assertion" }, origin, 400);
  }

  const db = supabaseAdmin();

  // Single use. Without this, a captured signature could be replayed forever.
  const { data: ch } = await db
    .from("webauthn_challenges").select("challenge, kind, used_at, created_at")
    .eq("challenge", challenge).maybeSingle();
  if (!ch || ch.used_at || ch.kind !== "login") {
    return withCors({ error: "That sign-in expired — try again." }, origin, 400);
  }
  if (Date.now() - new Date(ch.created_at).getTime() > 5 * 60 * 1000) {
    return withCors({ error: "That sign-in expired — try again." }, origin, 400);
  }
  await db.from("webauthn_challenges").update({ used_at: new Date().toISOString() }).eq("challenge", challenge);

  const { data: key } = await db
    .from("customer_passkeys")
    .select("id, customer_id, public_key, sign_count")
    .eq("credential_id", credential_id).maybeSingle();
  if (!key) return withCors({ error: "We don't recognise this device." }, origin, 401);

  // The phone signs authenticatorData || SHA256(clientDataJSON).
  const clientData = b64urlToBuf(client_data_json);
  const authData = b64urlToBuf(authenticator_data);
  const signed = Buffer.concat([authData, createHash("sha256").update(clientData).digest()]);

  // The challenge inside clientDataJSON must be the one we issued — otherwise a
  // signature obtained elsewhere would be accepted here.
  let parsed: any = null;
  try { parsed = JSON.parse(clientData.toString("utf8")); } catch { /* handled below */ }
  if (!parsed || parsed.type !== "webauthn.get" || parsed.challenge !== challenge) {
    return withCors({ error: "That sign-in couldn't be verified." }, origin, 401);
  }
  // And it must have been signed for this site.
  const expectedOrigin = `https://${req.nextUrl.hostname}`;
  if (parsed.origin && parsed.origin !== expectedOrigin) {
    return withCors({ error: "That sign-in couldn't be verified." }, origin, 401);
  }

  // Bit 2 of the flags byte is User Verified — this is what proves Face ID (or
  // the passcode) actually happened rather than a silent key use.
  const flags = authData[32];
  if (!(flags & 0x04)) {
    return withCors({ error: "Face ID didn't complete — try again." }, origin, 401);
  }

  const ok = createVerify("SHA256")
    .update(signed)
    .verify(
      { key: b64urlToBuf(key.public_key), format: "der", type: "spki" } as any,
      b64urlToBuf(signature)
    );
  if (!ok) return withCors({ error: "That sign-in couldn't be verified." }, origin, 401);

  // The counter must climb. A repeat means the key has been cloned.
  const counter = authData.readUInt32BE(33);
  if (counter !== 0 && counter <= Number(key.sign_count)) {
    return withCors({ error: "That sign-in couldn't be verified." }, origin, 401);
  }
  await db.from("customer_passkeys")
    .update({ sign_count: counter, last_used_at: new Date().toISOString() })
    .eq("id", key.id);

  const { data: cust } = await db
    .from("customers").select("id, full_name, email, status").eq("id", key.customer_id).maybeSingle();
  if (!cust) return withCors({ error: "unauthorized" }, origin, 401);

  const first = (cust.full_name ?? "").trim().split(" ")[0] || null;
  return withCors({
    ok: true, customer_id: cust.id, name: cust.full_name,
    first_name: first, email: cust.email,
    greeting: first ? `Welcome back, ${first}` : "You're in",
  }, origin);
}

import { NextRequest, NextResponse } from "next/server";
import { corsHeaders, withCors } from "@/lib/portalCors";
import crypto from "crypto";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { sendSms } from "@/lib/sms";
import { toE164 } from "@/lib/phone";
import { logAutomation } from "@/lib/automation";

export const runtime = "nodejs";

// The app is a static page on another origin; without this the browser blocks
// the request before it is ever sent.
export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: { ...corsHeaders(req.headers.get("origin")), "Access-Control-Allow-Methods": "POST,OPTIONS" },
  });
}

function hashCode(code: string, phone: string): string {
  return crypto.createHash("sha256").update(`${code}:${phone}:${process.env.CRON_SECRET}`).digest("hex");
}

export async function POST(req: NextRequest) {
  const { phone: rawPhone } = await req.json().catch(() => ({}));
  const phone = toE164(String(rawPhone ?? ""));
  if (!phone) return withCors({ error: "That doesn't look like a US phone number." }, req.headers.get("origin"), 400);

  const db = supabaseAdmin();

  // account check WITHOUT enumeration detail
  const { data: customer } = await db.from("customers").select("id").eq("phone", phone).maybeSingle();
  if (!customer) {
    await logAutomation({ trigger: "portal.otp.unknown_phone", status: "skipped", detail: { phone } });
    return withCors({
      error: "no_account",
      message: "We couldn't find an account for that number — request a quote at momentumlandscapingut.com or text us and we'll get you set up.",
    }, req.headers.get("origin"), 404);
  }

  // rate limit: max 3 sends per phone per hour
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const { count } = await db.from("otp_codes").select("id", { count: "exact", head: true }).eq("phone", phone).gte("created_at", hourAgo);
  if ((count ?? 0) >= 3) {
    await logAutomation({ trigger: "portal.otp.rate_limited", status: "skipped", detail: { phone } });
    return withCors({ error: "Too many tries just now. Give it a minute.", message: "Too many codes requested — try again in an hour." }, req.headers.get("origin"), 429);
  }

  const code = String(crypto.randomInt(100000, 1000000));
  await db.from("otp_codes").insert({
    phone,
    code_hash: hashCode(code, phone),
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  });

  // ONE-SHOT real-delivery proof: server-side config flag, never client-controlled.
  const { data: sbRow } = await db.from("system_config").select("value").eq("key", "sms_sandbox").single();
  const proveOnce = Boolean((sbRow?.value as any)?.prove_otp_once);
  if (proveOnce) {
    await db.from("system_config").update({
      value: { ...(sbRow!.value as object), prove_otp_once: false },
      updated_at: new Date().toISOString(),
    }).eq("key", "sms_sandbox");
  }

  const result = await sendSms({
    to: phone,
    message: `Your Momentum Landscaping login code is ${code}. It expires in 10 minutes. We'll never ask you for this code.`,
    sender: "system",
    bypassQuietHours: true, // user-initiated transactional message
    proveDelivery: proveOnce,
  });

  await logAutomation({ trigger: "portal.otp.sent", detail: { phone, dry_run: (result as any).dry_run ?? false, proved: proveOnce } });
  return withCors({ ok: true }, req.headers.get("origin"));
}

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { customerFrom } from "@/lib/portalAuth";
import { corsHeaders, withCors } from "@/lib/portalCors";
import { logAutomation } from "@/lib/automation";

export const runtime = "nodejs";

/**
 * Notification preferences.
 *
 * Left behind by the same move as /property: cookie auth the app never has, and
 * no GET, so the Preferences screen answered 405. These switches govern whether
 * we are allowed to text somebody, so they have to be readable — a customer
 * cannot opt out of something the screen will not show them.
 */

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: { ...corsHeaders(req.headers.get("origin")), "Access-Control-Allow-Methods": "GET,POST,OPTIONS" },
  });
}

export async function GET(req: NextRequest) {
  const origin = req.headers.get("origin");
  const customer = await customerFrom(req);
  if (!customer) return withCors({ error: "unauthorized" }, origin, 401);

  const { data } = await supabaseAdmin()
    .from("customers")
    .select("reminder_opt_out, marketing_opt_out, sms_opt_out")
    .eq("id", customer.id)
    .maybeSingle();

  // Reported as what the customer receives, not as what they have refused —
  // a screen of double negatives is how people opt out of the wrong thing.
  return withCors({
    reminders: !(data?.reminder_opt_out ?? false),
    marketing: !(data?.marketing_opt_out ?? false),
    sms: !(data?.sms_opt_out ?? false),
  }, origin);
}

export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  const customer = await customerFrom(req);
  if (!customer) return withCors({ error: "unauthorized" }, origin, 401);

  const b = await req.json().catch(() => ({} as any));
  const patch: Record<string, unknown> = {};

  // Accepts either shape: the positive one this route now returns, or the
  // opt_out flags the columns are named after.
  if (b.reminders !== undefined) patch.reminder_opt_out = !b.reminders;
  if (b.marketing !== undefined) patch.marketing_opt_out = !b.marketing;
  if (b.sms !== undefined) patch.sms_opt_out = !b.sms;
  if (b.reminder_opt_out !== undefined) patch.reminder_opt_out = Boolean(b.reminder_opt_out);
  if (b.marketing_opt_out !== undefined) patch.marketing_opt_out = Boolean(b.marketing_opt_out);
  if (b.sms_opt_out !== undefined) patch.sms_opt_out = Boolean(b.sms_opt_out);

  if (Object.keys(patch).length === 0) return withCors({ ok: true, unchanged: true }, origin);

  const { error } = await supabaseAdmin().from("customers").update(patch).eq("id", customer.id);
  if (error) return withCors({ error: "That didn't save — try again." }, origin, 400);

  await logAutomation({ trigger: "portal.preferences", ref_id: customer.id, detail: patch });
  return withCors({ ok: true }, origin);
}

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { corsHeaders, withCors } from "@/lib/portalCors";
import { customerFrom } from "@/lib/portalAuth";
export const runtime = "nodejs";
export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}
/** Connect or disconnect a calendar. Apple is a subscription, not a login. */
export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  const b = await req.json().catch(() => ({}));
  const { customer_id, provider, action } = b ?? {};
  if (!customer_id || !provider) {
    return withCors({ error: "customer_id and provider required" }, origin, 400);
  }
  if (provider !== "apple") {
    return withCors({
      error: "Google and Outlook aren't ready yet. Apple Calendar works now and updates itself.",
    }, origin, 501);
  }
  const db = supabaseAdmin();
  if (action === "disconnect") {
    await db.from("calendar_links").delete().eq("customer_id", customer_id).eq("provider", "apple");
    return withCors({ ok: true, connected: false }, origin);
  }
  await db.from("calendar_links").upsert(
    { customer_id, provider: "apple", connected_at: new Date().toISOString() },
    { onConflict: "customer_id,provider" }
  );
  return withCors({
    ok: true, connected: true,
    feed_url: `webcal://crm.momentumlandscapingut.com/api/portal/calendar/feed/${customer_id}.ics`,
  }, origin);
}

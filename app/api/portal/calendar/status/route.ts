import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { corsHeaders, withCors } from "@/lib/portalCors";
import { customerFrom } from "@/lib/portalAuth";
export const runtime = "nodejs";
export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}
/**
 * Which calendars are connected.
 *
 * Apple needs no OAuth — a webcal subscription URL is enough, and it updates
 * itself when a visit moves. Google and Outlook need consent screens that are
 * not built, so they are reported as unavailable rather than offered and then
 * failing silently, which is what the greyed-out sheet was doing.
 */
export async function GET(req: NextRequest) {
  const origin = req.headers.get("origin");
  const c = await customerFrom(req);
  if (!c) return withCors({ error: "not found" }, origin, 404);
  const { data } = await supabaseAdmin()
    .from("calendar_links").select("provider, connected_at").eq("customer_id", c.id);
  const linked = new Set((data ?? []).map((r: any) => r.provider));
  // These live here now, not on the CRM — it answers 404 for /api/portal since
  // the split, so a hardcoded crm. URL is a dead link handed to a customer.
  const base = req.nextUrl.origin;
  return withCors({
    providers: [
      { id: "apple",   name: "Apple Calendar", connected: linked.has("apple"),
        available: true,
        feed_url: `webcal://${req.nextUrl.host}/api/portal/calendar/feed/${c.id}.ics` },
      { id: "google",  name: "Google Calendar", connected: linked.has("google"),
        available: Boolean(process.env.GOOGLE_CLIENT_ID),
        start_url: `${base}/api/portal/calendar/google/start?customer_id=${c.id}`,
        reason: process.env.GOOGLE_CLIENT_ID ? undefined
          : "Coming soon — use the Apple subscription for now." },
      { id: "outlook", name: "Outlook", connected: linked.has("outlook"),
        available: false, reason: "Coming soon — use the Apple subscription for now." },
    ],
  }, origin);
}

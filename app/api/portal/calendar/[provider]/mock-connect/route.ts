import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { customerFrom } from "@/lib/portalAuth";
import { corsHeaders, withCors } from "@/lib/portalCors";

export const runtime = "nodejs";

/**
 * Mark a calendar connected without an OAuth round trip.
 *
 * The app calls this and the route did not exist, so it answered 404. It is how
 * Apple is "connected" — subscribing to a feed needs no consent screen — and how
 * Google can be recorded while its consent app is still in Google's testing mode
 * and refuses accounts that are not test users.
 */
export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: { ...corsHeaders(req.headers.get("origin")), "Access-Control-Allow-Methods": "POST,OPTIONS" },
  });
}

export async function POST(req: NextRequest, ctx: { params: { provider: string } }) {
  const origin = req.headers.get("origin");
  const c = await customerFrom(req);
  if (!c) return withCors({ error: "unauthorized" }, origin, 401);

  await req.json().catch(() => ({} as any));
  const provider = ctx.params.provider;
  if (!["apple", "google"].includes(provider)) {
    return withCors({ error: "That calendar isn't supported yet." }, origin, 400);
  }

  const { error } = await supabaseAdmin().from("calendar_links").upsert(
    // calendar_links has no email column — only customer_id, provider,
    // connected_at and the OAuth token fields.
    { customer_id: c.id, provider, connected_at: new Date().toISOString() },
    { onConflict: "customer_id,provider" }
  );
  if (error) return withCors({ error: "That didn't save — try again." }, origin, 400);

  return withCors({
    ok: true,
    provider,
    feed_url: provider === "apple"
      ? `webcal://${req.nextUrl.host}/api/portal/calendar/feed/${c.id}.ics`
      : undefined,
  }, origin);
}

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { customerFrom } from "@/lib/portalAuth";
import { corsHeaders, withCors } from "@/lib/portalCors";

export const runtime = "nodejs";

/**
 * Connect a calendar.
 *
 * The Account screen has always called /calendar/{provider}/connect, and the
 * route simply did not exist — every Connect button answered 404 and did
 * nothing. Apple and Google work differently and this is the single door for
 * both, so the screen does not have to know which is which.
 */
export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: { ...corsHeaders(req.headers.get("origin")), "Access-Control-Allow-Methods": "GET,POST,OPTIONS" },
  });
}

async function handle(req: NextRequest, provider: string) {
  const origin = req.headers.get("origin");
  const c = await customerFrom(req);
  if (!c) return withCors({ error: "unauthorized" }, origin, 401);

  if (provider === "apple") {
    // No consent screen and no tokens: subscribing to a feed is the whole
    // mechanism, and it re-reads itself whenever a visit moves.
    await supabaseAdmin().from("calendar_links").upsert(
      { customer_id: c.id, provider: "apple", connected_at: new Date().toISOString() },
      { onConflict: "customer_id,provider" }
    );
    return withCors({
      ok: true,
      kind: "subscribe",
      feed_url: `webcal://${req.nextUrl.host}/api/portal/calendar/feed/${c.id}.ics`,
    }, origin);
  }

  if (provider === "google") {
    if (!process.env.GOOGLE_CLIENT_ID) {
      return withCors({ error: "Google Calendar isn't switched on yet." }, origin, 503);
    }
    // Hands back a URL rather than redirecting — a redirect inside the app's
    // WebView traps the customer on Google's consent screen with no way back.
    return withCors({
      ok: true,
      kind: "oauth",
      start_url: `${req.nextUrl.origin}/api/portal/calendar/google/start?customer_id=${c.id}`,
    }, origin);
  }

  return withCors({ error: "That calendar isn't supported yet." }, origin, 400);
}

export async function GET(req: NextRequest, ctx: { params: { provider: string } }) {
  return handle(req, ctx.params.provider);
}
export async function POST(req: NextRequest, ctx: { params: { provider: string } }) {
  return handle(req, ctx.params.provider);
}

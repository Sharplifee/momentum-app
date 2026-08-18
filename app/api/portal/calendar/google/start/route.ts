import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { corsHeaders, withCors } from "@/lib/portalCors";

export const runtime = "nodejs";
export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}

/**
 * Begin Google Calendar consent.
 *
 * Returns a URL rather than redirecting: the app runs in a WebView, and a
 * redirect there traps the customer inside Google's consent screen with no way
 * back. The app opens this in the system browser instead.
 *
 * The state nonce is issued here and checked on the way back, which is what
 * stops someone attaching their own calendar to another customer's account.
 */
export async function GET(req: NextRequest) {
  const origin = req.headers.get("origin");
  const customerId = req.nextUrl.searchParams.get("customer_id");
  if (!customerId) return withCors({ error: "customer_id required" }, origin, 400);

  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return withCors({ error: "Google Calendar isn't switched on yet." }, origin, 503);

  const db = supabaseAdmin();
  const { data: c } = await db.from("customers").select("id").eq("id", customerId).maybeSingle();
  if (!c) return withCors({ error: "not found" }, origin, 404);

  const nonce = crypto.randomUUID();
  await db.from("oauth_states").insert({
    nonce, customer_id: c.id, provider: "google",
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  });

  const redirect = `${req.nextUrl.origin}/api/portal/calendar/google/callback`;
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirect);
  url.searchParams.set("response_type", "code");
  // Only permission to manage events we create. Not read, not delete, nothing
  // already in the customer's calendar.
  url.searchParams.set("scope", "https://www.googleapis.com/auth/calendar.events.owned");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", nonce);

  return withCors({ url: url.toString() }, origin);
}

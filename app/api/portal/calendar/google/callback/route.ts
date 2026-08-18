import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/** Where Google sends the customer back once they have agreed. */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");

  const page = (title: string, msg: string, ok = false) =>
    new NextResponse(
      `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;background:#fbfcfd;color:#1B2A3A;
display:grid;place-items:center;min-height:100dvh;margin:0;padding:24px;text-align:center}
.c{max-width:340px}h1{font-size:20px;margin:0 0 8px}p{color:#7C8A96;margin:0}</style>
<div class="c"><h1>${title}</h1><p>${msg}</p></div>`,
      { status: ok ? 200 : 400, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );

  if (!code || !state) return page("Couldn't connect", "Google didn't send everything we needed.");

  const db = supabaseAdmin();
  const { data: st } = await db
    .from("oauth_states").select("nonce, customer_id, used_at, expires_at")
    .eq("nonce", state).maybeSingle();

  if (!st || st.used_at || new Date(st.expires_at) < new Date()) {
    return page("Couldn't connect", "That link has expired. Try again from the app.");
  }
  await db.from("oauth_states").update({ used_at: new Date().toISOString() }).eq("nonce", state);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      redirect_uri: `${req.nextUrl.origin}/api/portal/calendar/google/callback`,
      grant_type: "authorization_code",
    }),
  }).catch(() => null);

  if (!res?.ok) return page("Couldn't connect", "Google wouldn't finish the connection. Try again.");
  const t = await res.json();

  await db.from("calendar_links").upsert({
    customer_id: st.customer_id, provider: "google",
    connected_at: new Date().toISOString(),
    access_token: t.access_token ?? null,
    refresh_token: t.refresh_token ?? null,
    expires_at: t.expires_in ? new Date(Date.now() + t.expires_in * 1000).toISOString() : null,
  }, { onConflict: "customer_id,provider" });

  return page("Calendar connected", "Your visits will appear in Google Calendar. You can close this.", true);
}

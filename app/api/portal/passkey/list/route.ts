import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { customerFrom } from "@/lib/portalAuth";
import { corsHeaders, withCors } from "@/lib/portalCors";
import { withEventLog } from "@/lib/eventLog";

export const runtime = "nodejs";

/** Which devices this customer has Face ID set up on, and removing one. */
async function __OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: { ...corsHeaders(req.headers.get("origin")), "Access-Control-Allow-Methods": "GET,DELETE,OPTIONS" },
  });
}

async function __GET(req: NextRequest) {
  const origin = req.headers.get("origin");
  const c = await customerFrom(req);
  if (!c) return withCors({ error: "unauthorized" }, origin, 401);
  const { data } = await supabaseAdmin()
    .from("customer_passkeys")
    .select("id, device_label, created_at, last_used_at")
    .eq("customer_id", c.id).order("created_at");
  return withCors({ passkeys: data ?? [] }, origin);
}

async function __DELETE(req: NextRequest) {
  const origin = req.headers.get("origin");
  const c = await customerFrom(req);
  if (!c) return withCors({ error: "unauthorized" }, origin, 401);
  const { id } = await req.json().catch(() => ({} as any));
  if (!id) return withCors({ error: "id required" }, origin, 400);
  // Scoped to the caller so nobody can remove another customer's device.
  await supabaseAdmin().from("customer_passkeys").delete().eq("id", id).eq("customer_id", c.id);
  return withCors({ ok: true }, origin);
}

export const GET = withEventLog("GET /api/portal/passkey/list", __GET);
export const DELETE = withEventLog("DELETE /api/portal/passkey/list", __DELETE);
export const OPTIONS = withEventLog("OPTIONS /api/portal/passkey/list", __OPTIONS);

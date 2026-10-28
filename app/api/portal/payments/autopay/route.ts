import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { corsHeaders, withCors } from "@/lib/portalCors";
import { customerFrom } from "@/lib/portalAuth";
import { withEventLog } from "@/lib/eventLog";
export const runtime = "nodejs";
async function __OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}
async function __GET(req: NextRequest) {
  const origin = req.headers.get("origin");
  const c = await customerFrom(req);
  if (!c) return withCors({ error: "not found" }, origin, 404);
  const { data } = await supabaseAdmin()
    .from("customers").select("autopay_enabled").eq("id", c.id).maybeSingle();
  return withCors({ enabled: Boolean((data as any)?.autopay_enabled) }, origin);
}
async function __POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  const b = await req.json().catch(() => ({}));
  if (!b?.customer_id) return withCors({ error: "customer_id required" }, origin, 400);
  const { error } = await supabaseAdmin()
    .from("customers").update({ autopay_enabled: Boolean(b.enabled) }).eq("id", b.customer_id);
  if (error) return withCors({ error: error.message }, origin, 400);
  return withCors({ ok: true, enabled: Boolean(b.enabled) }, origin);
}

export const GET = withEventLog("GET /api/portal/payments/autopay", __GET);
export const POST = withEventLog("POST /api/portal/payments/autopay", __POST);
export const OPTIONS = withEventLog("OPTIONS /api/portal/payments/autopay", __OPTIONS);

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { corsHeaders, withCors } from "@/lib/portalCors";
import { customerFrom, VISIT_INCLUDES } from "@/lib/portalAuth";
import { withEventLog } from "@/lib/eventLog";
export const runtime = "nodejs";
async function __OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}
/** The app pings this to decide whether it is live or falling back to mock. */
async function __GET(req: NextRequest) {
  return withCors({ ok: true, mode: "live", ts: new Date().toISOString() }, req.headers.get("origin"));
}

export const GET = withEventLog("GET /api/portal/status", __GET);
export const OPTIONS = withEventLog("OPTIONS /api/portal/status", __OPTIONS);

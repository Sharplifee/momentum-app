import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { corsHeaders, withCors } from "@/lib/portalCors";
import { customerFrom, VISIT_INCLUDES } from "@/lib/portalAuth";
export const runtime = "nodejs";
export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}
/** The app pings this to decide whether it is live or falling back to mock. */
export async function GET(req: NextRequest) {
  return withCors({ ok: true, mode: "live", ts: new Date().toISOString() }, req.headers.get("origin"));
}

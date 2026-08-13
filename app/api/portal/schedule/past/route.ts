import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { corsHeaders, withCors } from "@/lib/portalCors";
import { customerFrom, VISIT_INCLUDES } from "@/lib/portalAuth";
export const runtime = "nodejs";
export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}
export async function GET(req: NextRequest) {
  const origin = req.headers.get("origin");
  const c = await customerFrom(req);
  if (!c) return withCors({ error: "not found" }, origin, 404);
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") ?? 12), 50);
  const { data } = await supabaseAdmin()
    .from("jobs")
    .select("id, scheduled_date, status")
    .eq("customer_id", c.id)
    .lt("scheduled_date", new Date().toISOString().slice(0, 10))
    .order("scheduled_date", { ascending: false }).limit(limit);
  return withCors({
    items: (data ?? []).map((j) => ({
      id: j.id, date: j.scheduled_date, status: j.status, includes: VISIT_INCLUDES,
    })),
  }, origin);
}

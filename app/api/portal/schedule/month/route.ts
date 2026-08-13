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
  const y = Number(req.nextUrl.searchParams.get("year")) || new Date().getFullYear();
  const m = Number(req.nextUrl.searchParams.get("month")) || new Date().getMonth() + 1;
  const from = `${y}-${String(m).padStart(2, "0")}-01`;
  const to = new Date(y, m, 0).toISOString().slice(0, 10);
  const { data } = await supabaseAdmin()
    .from("jobs").select("id, scheduled_date, status")
    .eq("customer_id", c.id)
    .gte("scheduled_date", from).lte("scheduled_date", to)
    .order("scheduled_date");
  return withCors({
    year: y, month: m, count: data?.length ?? 0,
    days: (data ?? []).map((j) => ({ date: j.scheduled_date, status: j.status })),
  }, origin);
}

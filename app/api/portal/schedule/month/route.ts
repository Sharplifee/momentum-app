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
  // new Date(y, m, 0) is midnight LOCAL, and the server runs in UTC, so
  // toISOString() rolled the last day of the month back by one. A visit on the
  // 31st simply did not appear in that month's calendar. Built as a string
  // instead so no timezone is involved at all.
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const to = `${y}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
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

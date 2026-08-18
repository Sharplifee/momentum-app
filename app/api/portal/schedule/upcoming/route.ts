import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { corsHeaders, withCors } from "@/lib/portalCors";
import { customerFrom, VISIT_INCLUDES } from "@/lib/portalAuth";

/** Today where the work happens. UTC rolls over at 6pm Mountain, which moved a
 *  visit out of "upcoming" and into "past" while the crew was still on site. */
const localToday = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: "America/Denver" });

export const runtime = "nodejs";
export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}
export async function GET(req: NextRequest) {
  const origin = req.headers.get("origin");
  const c = await customerFrom(req);
  if (!c) return withCors({ error: "not found" }, origin, 404);
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") ?? 10), 40);
  const { data } = await supabaseAdmin()
    .from("jobs")
    .select("id, scheduled_date, status, crew_id")
    .eq("customer_id", c.id)
    .gte("scheduled_date", localToday())
    .order("scheduled_date").limit(limit);
  return withCors({
    items: (data ?? []).map((j) => ({
      id: j.id, date: j.scheduled_date, status: j.status,
      crew: "The Crew", includes: VISIT_INCLUDES,
    })),
  }, origin);
}

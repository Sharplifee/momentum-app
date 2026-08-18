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
  const db = supabaseAdmin();
  const today = localToday();
  const [done, upcoming] = await Promise.all([
    db.from("jobs").select("id", { count: "exact", head: true })
      .eq("customer_id", c.id).eq("status", "completed"),
    db.from("jobs").select("id", { count: "exact", head: true })
      .eq("customer_id", c.id).gte("scheduled_date", today).eq("status", "scheduled"),
  ]);
  const months = c.created_at
    ? Math.max(0, Math.round((Date.now() - new Date(c.created_at).getTime()) / 2.63e9)) : 0;
  return withCors({
    services_completed: done.count ?? 0,
    upcoming: upcoming.count ?? 0,
    member_months: months,
  }, origin);
}

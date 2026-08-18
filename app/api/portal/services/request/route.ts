import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { corsHeaders, withCors } from "@/lib/portalCors";
import { customerFrom } from "@/lib/portalAuth";

/** Today where the work happens. UTC rolls over at 6pm Mountain, which moved a
 *  visit out of "upcoming" and into "past" while the crew was still on site. */
const localToday = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: "America/Denver" });

export const runtime = "nodejs";
export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}
/**
 * A customer asking for extra work. This does not schedule anything — it
 * raises a request the office picks up, because the price is set in person.
 */
export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  const body = await req.json().catch(() => ({}));
  const { customer_id, service, note } = body ?? {};
  if (!customer_id || !service) {
    return withCors({ error: "customer_id and service required" }, origin, 400);
  }
  const db = supabaseAdmin();
  const { data: c } = await db.from("customers")
    .select("id, full_name, phone").eq("id", customer_id).maybeSingle();
  if (!c) return withCors({ error: "not found" }, origin, 404);

  await db.from("service_requests").insert({
    customer_id: c.id, service, note: note ?? null, status: "open", source: "app",
  }).then(async ({ error }) => {
    // The table may not exist yet; a request must never be lost silently, so
    // fall back to an exception the office already watches.
    if (error) {
      await db.from("exceptions").insert({
        type: "service_request", severity: "high",
        detail: `${c.full_name ?? "A customer"} asked about ${service}${note ? ` — ${note}` : ""}`,
        ref_table: "customers", ref_id: c.id, occurred_on: localToday(),
      });
    }
  });

  return withCors({ ok: true, message: "Thanks — we'll be in touch to look at it." }, origin);
}

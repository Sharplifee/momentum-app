import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * The customer's visits as a calendar subscription.
 *
 * Calendar apps re-fetch this on their own schedule, so a moved visit reaches
 * the customer's calendar without anyone pressing sync. That is why Apple needs
 * no OAuth: the URL is the connection.
 */
export async function GET(_req: NextRequest, { params }: { params: { file: string } }) {
  const id = (params.file || "").replace(/\.ics$/i, "");
  const db = supabaseAdmin();
  const { data: c } = await db.from("customers").select("id, full_name").eq("id", id).maybeSingle();
  if (!c) return new NextResponse("Not found", { status: 404 });

  const { data: jobs } = await db
    .from("jobs").select("id, scheduled_date, status")
    .eq("customer_id", c.id)
    .gte("scheduled_date", new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10))
    .order("scheduled_date");

  const stamp = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Momentum Landscaping//EN",
    "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "X-WR-CALNAME:Momentum Landscaping",
    "X-PUBLISHED-TTL:PT6H",
  ];
  for (const j of jobs ?? []) {
    const d = String(j.scheduled_date).replace(/-/g, "");
    const next = new Date(j.scheduled_date + "T00:00:00Z");
    next.setUTCDate(next.getUTCDate() + 1);
    lines.push(
      "BEGIN:VEVENT",
      `UID:${j.id}@momentumlandscapingut.com`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${d}`,
      `DTEND;VALUE=DATE:${next.toISOString().slice(0, 10).replace(/-/g, "")}`,
      "SUMMARY:Momentum — lawn service",
      "DESCRIPTION:Mow, edge, trim and blow.",
      `STATUS:${j.status === "cancelled" ? "CANCELLED" : "CONFIRMED"}`,
      "TRANSP:TRANSPARENT",
      "END:VEVENT"
    );
  }
  lines.push("END:VCALENDAR");

  return new NextResponse(lines.join("\r\n"), {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `inline; filename="momentum.ics"`,
      "Cache-Control": "public, max-age=1800",
    },
  });
}

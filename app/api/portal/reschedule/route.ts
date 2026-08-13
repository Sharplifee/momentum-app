import { NextRequest, NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { sendSms } from "@/lib/sms";
import { logAutomation } from "@/lib/automation";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const s = supabaseServer();
  const { data: { user } } = await s.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const admin = supabaseAdmin();
  const { data: customer } = await admin.from("customers").select("id, phone, full_name").eq("profile_id", user.id).maybeSingle();
  if (!customer) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { job_id, requested_date } = await req.json().catch(() => ({}));
  if (!job_id || !requested_date) return NextResponse.json({ error: "job_id and requested_date required" }, { status: 400 });

  const { data: job } = await admin.from("jobs").select("id, customer_id, crew_id, scheduled_date").eq("id", job_id).single();
  if (!job || job.customer_id !== customer.id) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const visitTime = new Date(`${job.scheduled_date}T08:00:00-06:00`).getTime();
  const inside24h = visitTime - Date.now() < 24 * 3600_000;

  if (inside24h) {
    // approval-gated: request row + staff notification, NO auto-move
    const { data: reqRow } = await admin.from("portal_requests").insert({
      customer_id: customer.id, job_id, kind: "reschedule_inside_24h",
      detail: { from: job.scheduled_date, to: requested_date },
    }).select("id").single();
    await sendSms({
      to: "+13853076535",
      message: `Portal request: ${customer.full_name} wants to move ${job.scheduled_date} → ${requested_date} (inside 24h — needs your approval in CRM).`,
      sender: "system", bypassQuietHours: true,
    });
    await logAutomation({ trigger: "portal.reschedule.approval_gated", ref_id: String(reqRow?.id), detail: { job_id, requested_date } });
    return NextResponse.json({ ok: true, message: "That visit is within 24 hours, so our team will confirm this change — you'll hear back shortly." });
  }

  // >24h: capacity-checked auto-move (same rules as Wayne's reschedule_job tool)
  const { data: crew } = await admin.from("crews").select("id, max_daily_jobs").eq("id", job.crew_id).single();
  const { count } = await admin.from("jobs").select("id", { count: "exact", head: true }).eq("crew_id", job.crew_id).eq("scheduled_date", requested_date).neq("status", "cancelled");
  if ((count ?? 0) >= (crew?.max_daily_jobs ?? 12)) {
    return NextResponse.json({ ok: false, message: "That day is full — pick another and we'll make it work." });
  }
  await admin.from("jobs").update({ scheduled_date: requested_date, weather_flag: false }).eq("id", job_id);
  await admin.from("job_events").insert({ job_id, type: "rescheduled", note: `portal: → ${requested_date}`, actor: customer.full_name ?? "customer" });

  // confirmation into the unified thread + (sandboxed/dry) SMS
  const { data: thread } = await admin.from("threads").select("id").eq("phone", customer.phone).limit(1).maybeSingle();
  const confirmation = `You're moved to ${new Date(requested_date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}. See you then! 🌱`;
  if (thread) await admin.from("messages").insert({ thread_id: thread.id, channel: "portal", direction: "outbound", sender: "wayne", body: confirmation });
  await sendSms({ to: customer.phone, message: confirmation, thread_id: thread?.id ?? null, sender: "wayne" });

  await logAutomation({ trigger: "portal.reschedule.auto", ref_id: job_id, detail: { to: requested_date } });
  return NextResponse.json({ ok: true, message: confirmation });
}

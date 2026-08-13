import { NextRequest, NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { logAutomation } from "@/lib/automation";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const s = supabaseServer();
  const { data: { user } } = await s.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const admin = supabaseAdmin();
  const { data: customer } = await admin.from("customers").select("id").eq("profile_id", user.id).maybeSingle();
  if (!customer) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { reminder_opt_out, marketing_opt_out, sms_opt_out } = await req.json().catch(() => ({}));
  const patch: Record<string, unknown> = {};
  if (reminder_opt_out !== undefined) patch.reminder_opt_out = Boolean(reminder_opt_out);
  if (marketing_opt_out !== undefined) patch.marketing_opt_out = Boolean(marketing_opt_out);
  if (sms_opt_out !== undefined) patch.sms_opt_out = Boolean(sms_opt_out);
  await admin.from("customers").update(patch).eq("id", customer.id);
  await logAutomation({ trigger: "portal.preferences", ref_id: customer.id, detail: patch });
  return NextResponse.json({ ok: true });
}

import { NextRequest, NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const s = supabaseServer();
  const { data: { user } } = await s.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const admin = supabaseAdmin();
  const { data: customer } = await admin.from("customers").select("id, full_name").eq("profile_id", user.id).maybeSingle();
  if (!customer) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { property_id, gate_code, pets, access_notes } = await req.json().catch(() => ({}));
  const { data: property } = await admin.from("properties").select("id, customer_id").eq("id", property_id).single();
  if (!property || property.customer_id !== customer.id) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const patch: Record<string, unknown> = {};
  if (gate_code !== undefined) patch.gate_code = gate_code || null;
  if (pets !== undefined) patch.pets = pets || null;
  if (access_notes !== undefined) patch.access_notes = access_notes || null;
  await admin.from("properties").update(patch).eq("id", property_id);
  await admin.from("audit_log").insert({ actor: `customer:${customer.id}`, action: "property_update", table_name: "properties", row_id: property_id, detail: patch });
  return NextResponse.json({ ok: true });
}

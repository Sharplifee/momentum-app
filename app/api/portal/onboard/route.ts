import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { corsHeaders, withCors } from "@/lib/portalCors";

export const runtime = "nodejs";

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}

/**
 * What the app collects after someone signs in and we don't know them yet.
 *
 * Name and address only. Not a form — the app can ask for one at a time, and
 * this accepts whatever it has so far, so a half-finished answer is still
 * progress rather than a lost lead.
 */
export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  const { customer_id, full_name, address, city } = await req.json().catch(() => ({}));
  if (!customer_id) return withCors({ error: "customer_id required" }, origin, 400);

  const db = supabaseAdmin();
  const patch: Record<string, unknown> = {};
  if (full_name?.trim()) patch.full_name = full_name.trim();

  if (Object.keys(patch).length) {
    await db.from("customers").update(patch).eq("id", customer_id);
  }

  if (address?.trim()) {
    const { data: existing } = await db
      .from("properties").select("id").eq("customer_id", customer_id).maybeSingle();
    if (existing) {
      await db.from("properties")
        .update({ address: address.trim(), city: city?.trim() ?? null, parcel_ring: null })
        .eq("id", existing.id);
    } else {
      await db.from("properties").insert({
        customer_id, address: address.trim(), city: city?.trim() ?? null, state: "UT",
      });
    }
  }

  const { data: c } = await db
    .from("customers").select("id, full_name").eq("id", customer_id).maybeSingle();
  const { data: p } = await db
    .from("properties").select("address").eq("customer_id", customer_id).maybeSingle();

  const done = Boolean(c?.full_name && p?.address);
  if (done) {
    await db.from("customers").update({ onboarding_complete: true }).eq("id", customer_id);
  }

  const missing: string[] = [];
  if (!c?.full_name) missing.push("name");
  if (!p?.address) missing.push("address");

  return withCors({ ok: true, complete: done, needs: missing, name: c?.full_name ?? null }, origin);
}

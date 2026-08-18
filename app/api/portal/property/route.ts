import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { customerFrom } from "@/lib/portalAuth";
import { corsHeaders, withCors } from "@/lib/portalCors";

export const runtime = "nodejs";

/**
 * The customer's property — what the crew needs to get in and do the work.
 *
 * This route was left behind when the rest of the portal API moved to
 * customer_id auth. It still authenticated from a browser session cookie, which
 * the app has never had (it is a static page on another origin), and it had no
 * GET at all — so the Property screen answered 405 and could not load, and a
 * save would have answered 401 even if it had.
 */

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: { ...corsHeaders(req.headers.get("origin")), "Access-Control-Allow-Methods": "GET,POST,OPTIONS" },
  });
}

export async function GET(req: NextRequest) {
  const origin = req.headers.get("origin");
  const customer = await customerFrom(req);
  if (!customer) return withCors({ error: "unauthorized" }, origin, 401);

  const { data: property } = await supabaseAdmin()
    .from("properties")
    .select("id, address, city, state, postal, gate_code, pets, has_dog, access_notes, lot_notes, watering_day, obstacles")
    .eq("customer_id", customer.id)
    .order("created_at")
    .limit(1)
    .maybeSingle();

  // No property on file is a normal state for a new customer, not an error.
  return withCors({ property: property ?? null }, origin);
}

export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  const customer = await customerFrom(req);
  if (!customer) return withCors({ error: "unauthorized" }, origin, 401);

  const body = await req.json().catch(() => ({} as any));
  const admin = supabaseAdmin();

  // The property is resolved from the customer rather than taken from the
  // request, so nobody can edit a property that is not theirs by guessing an id.
  const { data: property } = await admin
    .from("properties")
    .select("id")
    .eq("customer_id", customer.id)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (!property) return withCors({ error: "No property on file yet." }, origin, 404);

  const patch: Record<string, unknown> = {};
  if (body.gate_code !== undefined) patch.gate_code = body.gate_code || null;
  if (body.pets !== undefined) patch.pets = body.pets || null;
  if (body.has_dog !== undefined) patch.has_dog = Boolean(body.has_dog);
  if (body.access_notes !== undefined) patch.access_notes = body.access_notes || null;
  if (body.watering_day !== undefined) patch.watering_day = body.watering_day || null;
  if (Object.keys(patch).length === 0) return withCors({ ok: true, unchanged: true }, origin);

  const { error } = await admin.from("properties").update(patch).eq("id", property.id);
  if (error) return withCors({ error: "That didn't save — try again." }, origin, 400);

  // A gate code changing is something the crew may need to account for later.
  await admin.from("audit_log").insert({
    actor: `customer:${customer.id}`,
    action: "property_update",
    table_name: "properties",
    row_id: property.id,
    detail: patch,
  });

  return withCors({ ok: true, property_id: property.id }, origin);
}

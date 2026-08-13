import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { withCors, corsHeaders } from "@/lib/portalCors";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}

/**
 * Everything the customer home screen needs, in one call: who they are, where
 * they live, when the crew is next coming and what that visit includes.
 */
export async function GET(req: NextRequest) {
  const origin = req.headers.get("origin");
  const customerId = req.nextUrl.searchParams.get("customer_id");
  if (!customerId) return withCors({ error: "customer_id required" }, origin, 400);

  const db = supabaseAdmin();
  const [{ data: customer }, { data: property }] = await Promise.all([
    db.from("customers").select("id, full_name, phone, status").eq("id", customerId).maybeSingle(),
    db.from("properties").select("id, address, city, lat, lng").eq("customer_id", customerId).maybeSingle(),
  ]);
  if (!customer) return withCors({ error: "not found" }, origin, 404);

  const [{ data: upcoming }, { data: past }] = await Promise.all([
    db.from("jobs")
      .select("id, scheduled_date, status, kind")
      .eq("customer_id", customerId)
      .gte("scheduled_date", new Date().toISOString().slice(0, 10))
      .order("scheduled_date")
      .limit(6),
    db.from("jobs")
      .select("id, scheduled_date, status")
      .eq("customer_id", customerId)
      .lt("scheduled_date", new Date().toISOString().slice(0, 10))
      .order("scheduled_date", { ascending: false })
      .limit(8),
  ]);

  return withCors({
    customer: { id: customer.id, name: customer.full_name, status: customer.status },
    property: property ?? null,
    next_visit: upcoming?.[0] ?? null,
    upcoming: upcoming ?? [],
    past: past ?? [],
  }, origin);
}

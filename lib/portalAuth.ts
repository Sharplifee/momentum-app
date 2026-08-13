import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * Who is asking.
 *
 * The customer app is a static page calling across origins, so it identifies
 * itself with the customer id it received at sign-in. That is thin, which is
 * why every read is scoped to that id and nothing trusts an id it has not
 * looked up first.
 */
export async function customerFrom(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("customer_id") ?? req.headers.get("x-customer-id");
  if (!id) return null;
  const { data } = await supabaseAdmin()
    .from("customers")
    .select("id, full_name, phone, email, status, created_at")
    .eq("id", id).maybeSingle();
  return data ?? null;
}

/** What a weekly visit actually includes. */
export const VISIT_INCLUDES = ["Mow", "Edge", "Trim", "Blow"];

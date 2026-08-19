import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { corsHeaders, withCors } from "@/lib/portalCors";
import { customerFrom } from "@/lib/portalAuth";
export const runtime = "nodejs";
export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}
/** The quote request form. Creates a lead the CRM already knows how to handle. */
export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  const b = await req.json().catch(() => ({}));
  const { full_name, phone, address, city, requested_window } = b ?? {};
  if (!phone || !address) {
    return withCors({ error: "phone and address required" }, origin, 400);
  }
  const digits = String(phone).replace(/\D/g, "");
  const e164 = digits.length === 10 ? `+1${digits}` : digits.length === 11 ? `+${digits}` : String(phone);
  const { error } = await supabaseAdmin().from("leads").insert({
    full_name: full_name ?? null, phone: e164, address, city: city ?? null,
    requested_window: requested_window ?? null, stage: "new", source: "app",
  });
  if (error) return withCors({ error: "We couldn't send that. Try again." }, origin, 400);
  return withCors({
    ok: true,
    message: "Got it. Nora will text you shortly to arrange your quote visit.",
  }, origin);
}

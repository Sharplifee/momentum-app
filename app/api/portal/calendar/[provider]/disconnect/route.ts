import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { customerFrom } from "@/lib/portalAuth";
import { corsHeaders, withCors } from "@/lib/portalCors";

export const runtime = "nodejs";

/**
 * Disconnect a calendar. Also missing entirely — the button answered 404, so a
 * customer could connect a calendar and then had no way to undo it.
 */
export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: { ...corsHeaders(req.headers.get("origin")), "Access-Control-Allow-Methods": "POST,OPTIONS" },
  });
}

export async function POST(req: NextRequest, ctx: { params: { provider: string } }) {
  const origin = req.headers.get("origin");
  const c = await customerFrom(req);
  if (!c) return withCors({ error: "unauthorized" }, origin, 401);

  await supabaseAdmin()
    .from("calendar_links")
    .delete()
    .eq("customer_id", c.id)
    .eq("provider", ctx.params.provider);

  // Apple keeps working until the customer removes the subscription on their
  // own device — we cannot reach into their calendar, and saying so is honest.
  return withCors({
    ok: true,
    note: ctx.params.provider === "apple"
      ? "Removed here. To stop it fully, delete the Momentum calendar in your phone's Calendar settings."
      : undefined,
  }, origin);
}

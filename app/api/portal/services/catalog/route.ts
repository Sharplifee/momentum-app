import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { corsHeaders, withCors } from "@/lib/portalCors";
import { customerFrom } from "@/lib/portalAuth";
export const runtime = "nodejs";
export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}
/**
 * What can be added to a plan. No prices — every job is quoted per property,
 * in person, so a figure here would be a promise nobody made.
 */
export async function GET(req: NextRequest) {
  const origin = req.headers.get("origin");
  const { data } = await supabaseAdmin()
    .from("services").select("id, name, description, active").eq("active", true).order("name");
  const fallback = [
    { id: "weekly",  name: "Weekly lawn maintenance", description: "Mow, edge, trim and blow — same day each week." },
    { id: "aerate",  name: "Aeration",                description: "Opens compacted soil so water reaches the roots." },
    { id: "fert",    name: "Fertilization",           description: "Timed to Utah's growing calendar." },
    { id: "mulch",   name: "Mulch refresh",           description: "Premium hardwood, beds edged clean." },
    { id: "hedge",   name: "Hedge & shrub trim",      description: "Keeps beds sharp between visits." },
    { id: "leaves",  name: "Leaf cleanup",            description: "Full blow and haul away, spring and fall." },
  ];
  const items = (data?.length ? data : fallback).map((s: any) => ({
    id: s.id, name: s.name, description: s.description ?? "", quote: "Personal quote",
  }));
  return withCors({ items }, origin);
}

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { logAutomation } from "@/lib/automation";
import { customerFrom } from "@/lib/portalAuth";
import { corsHeaders, withCors } from "@/lib/portalCors";
/**
 * Nora lives in the CRM and stays there.
 *
 * She needs availability, the service area, Meta conversions and the SMS
 * pipeline — all CRM concerns. Copying her here would mean two Noras with two
 * sets of rules drifting apart, and the rules are the point: never quote a
 * price, never invent a date, always say she is an AI when asked.
 *
 * So the customer app asks the CRM for a reply instead of generating one.
 */
async function runNora(...args: any[]): Promise<string> {
  const res = await fetch("https://crm.momentumlandscapingut.com/api/nora/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.CRM_SHARED_SECRET ?? ""}`,
    },
    body: JSON.stringify({ args }),
  });
  if (!res.ok) throw new Error("nora unavailable");
  return (await res.json()).reply as string;
}


export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Messages for the customer app.
 *
 * This route identified the caller from a browser session cookie, while every
 * other portal route identifies them by the customer id the app holds from
 * sign-in. The app is a static page on another origin and has no such cookie,
 * so this always answered 401 — and since a failed call quietly falls back to
 * samples, the app showed an invented conversation rather than an error.
 *
 * The thread is resolved from the customer instead of being passed in, so no
 * one can ask for a thread that is not theirs. SMS and in-app messages share
 * one thread on purpose: the crew sees a single conversation either way.
 */

async function threadFor(customerId: string, phone: string | null) {
  const admin = supabaseAdmin();

  const { data: byCustomer } = await admin
    .from("threads")
    .select("id, phone, escalated, lead_id")
    .eq("customer_id", customerId)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (byCustomer) return byCustomer;

  // Threads opened by SMS are keyed on the phone number before anyone links
  // them to a customer record, so fall back to that and adopt it.
  if (phone) {
    const { data: byPhone } = await admin
      .from("threads")
      .select("id, phone, escalated, lead_id")
      .eq("phone", phone)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    if (byPhone) {
      await admin.from("threads").update({ customer_id: customerId }).eq("id", byPhone.id);
      return byPhone;
    }
  }

  return null;
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: {
      ...corsHeaders(req.headers.get("origin")),
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    },
  });
}

export async function GET(req: NextRequest) {
  const origin = req.headers.get("origin");
  const customer = await customerFrom(req);
  if (!customer) return withCors({ error: "unauthorized" }, origin, 401);

  const thread = await threadFor(customer.id, customer.phone);
  // No thread yet is a normal state for a new customer, not an error. An empty
  // list lets the app show the crew and an open composer instead of inventing
  // a conversation that never happened.
  if (!thread) return withCors({ messages: [], thread_id: null }, origin);

  const { data: messages } = await supabaseAdmin()
    .from("messages")
    .select("id, direction, sender, channel, body, created_at")
    .eq("thread_id", thread.id)
    .order("created_at")
    .limit(100);

  return withCors({ messages: messages ?? [], thread_id: thread.id }, origin);
}

export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  const customer = await customerFrom(req);
  if (!customer) return withCors({ error: "unauthorized" }, origin, 401);

  const { body } = await req.json().catch(() => ({} as any));
  if (!body || !String(body).trim()) return withCors({ error: "body required" }, origin, 400);

  const admin = supabaseAdmin();
  let thread = await threadFor(customer.id, customer.phone);

  // A first message from someone we have never texted still has to land
  // somewhere, so the thread is opened here rather than dropping it.
  if (!thread) {
    const { data: created, error } = await admin
      .from("threads")
      .insert({ customer_id: customer.id, phone: customer.phone, escalated: false })
      .select("id, phone, escalated, lead_id")
      .single();
    if (error || !created) return withCors({ error: "could not open a conversation" }, origin, 500);
    thread = created;
  }

  await admin.from("messages").insert({
    thread_id: thread.id,
    channel: "portal",
    direction: "inbound",
    sender: "customer",
    body: String(body),
  });
  await admin
    .from("threads")
    .update({ last_message_at: new Date().toISOString(), customer_id: customer.id })
    .eq("id", thread.id);

  // Once a human has taken the thread over, Nora stays out of it.
  if (!thread.escalated) {
    const reply = await runNora(
      { thread_id: thread.id, phone: customer.phone, lead_id: thread.lead_id, customer_id: customer.id, channel: "portal" },
      String(body)
    ).catch(async (err) => {
      console.error("nora portal reply failed", err);
      return null;
    });
    if (reply) {
      await admin.from("messages").insert({
        thread_id: thread.id, channel: "portal", direction: "outbound", sender: "nora", body: reply,
      });
    }
  }

  const { data: messages } = await admin
    .from("messages")
    .select("id, direction, sender, channel, body, created_at")
    .eq("thread_id", thread.id)
    .order("created_at")
    .limit(100);

  await logAutomation({ trigger: "portal.message", ref_id: thread.id, detail: { customer: customer.id } });
  return withCors({ ok: true, messages: messages ?? [], thread_id: thread.id }, origin);
}

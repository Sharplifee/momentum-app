import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { toE164 } from "@/lib/phone";
import { logAutomation } from "@/lib/automation";

export const runtime = "nodejs";

function hashCode(code: string, phone: string): string {
  return crypto.createHash("sha256").update(`${code}:${phone}:${process.env.CRON_SECRET}`).digest("hex");
}

export async function POST(req: NextRequest) {
  const { phone: rawPhone, code } = await req.json().catch(() => ({}));
  const phone = toE164(String(rawPhone ?? ""));
  if (!phone || !code) return NextResponse.json({ error: "phone and code required" }, { status: 400 });

  const db = supabaseAdmin();
  const { data: otp } = await db
    .from("otp_codes")
    .select("*")
    .eq("phone", phone)
    .is("consumed_at", null)
    .gte("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!otp) {
    await logAutomation({ trigger: "portal.otp.verify_fail", status: "skipped", detail: { phone, reason: "no_active_code" } });
    return NextResponse.json({ error: "That code didn't match. Try again." }, { status: 401 });
  }
  if (otp.attempts >= 5) {
    await logAutomation({ trigger: "portal.otp.verify_fail", status: "skipped", detail: { phone, reason: "Too many tries. Ask for a new code." } });
    return NextResponse.json({ error: "Too many tries. Ask for a new code." }, { status: 429 });
  }

  const expected = Buffer.from(otp.code_hash, "hex");
  const actual = Buffer.from(hashCode(String(code), phone), "hex");
  const match = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);

  if (!match) {
    await db.from("otp_codes").update({ attempts: otp.attempts + 1 }).eq("id", otp.id);
    await logAutomation({ trigger: "portal.otp.verify_fail", status: "skipped", detail: { phone, attempts: otp.attempts + 1 } });
    return NextResponse.json({ error: "That code didn't match. Try again." }, { status: 401 });
  }

  await db.from("otp_codes").update({ consumed_at: new Date().toISOString() }).eq("id", otp.id);

  // find-or-create auth user keyed to phone
  const placeholderEmail = `${phone.replace("+", "")}@phone.momentumlandscapingut.com`;
  const { data: customer } = await db.from("customers").select("id, profile_id, full_name").eq("phone", phone).single();

  let userId = customer?.profile_id as string | null;
  if (!userId) {
    const { data: created, error: cErr } = await db.auth.admin.createUser({
      email: placeholderEmail,
      email_confirm: true,
      phone_confirm: false,
      user_metadata: { full_name: customer?.full_name, phone },
    });
    if (cErr && !String(cErr.message).includes("already")) {
      return NextResponse.json({ error: cErr.message }, { status: 500 });
    }
    userId = created?.user?.id ?? null;
    if (!userId) {
      // user existed — look up by email
      const { data: list } = await db.auth.admin.listUsers({ page: 1, perPage: 200 });
      userId = list?.users.find((u) => u.email === placeholderEmail)?.id ?? null;
    }
    if (!userId) return NextResponse.json({ error: "We couldn't finish signing you in. Try again." }, { status: 500 });
    // profiles.phone is UNIQUE and may already belong to a staff profile (e.g. owner
    // testing as a customer) — the customer's phone of record lives on customers, so
    // fall back to a phone-less profile row on conflict rather than failing the login.
    let { error: profErr } = await db.from("profiles").upsert({ id: userId, role: "customer", full_name: customer?.full_name ?? "Customer", phone, email: placeholderEmail });
    if (profErr?.code === "23505") {
      ({ error: profErr } = await db.from("profiles").upsert({ id: userId, role: "customer", full_name: customer?.full_name ?? "Customer", email: placeholderEmail }));
    }
    if (profErr) {
      await logAutomation({ trigger: "portal.otp.link_error", status: "error", error: profErr.message });
      return NextResponse.json({ error: "We couldn't finish signing you in. Try again." }, { status: 500 });
    }
    const { error: linkCustErr } = await db.from("customers").update({ profile_id: userId }).eq("id", customer!.id);
    if (linkCustErr) {
      await logAutomation({ trigger: "portal.otp.link_error", status: "error", error: linkCustErr.message });
      return NextResponse.json({ error: "We couldn't finish signing you in. Try again." }, { status: 500 });
    }
  }

  // issue a session: admin magic-link generation, then exchange the token_hash client-side-free
  const { data: linkData, error: linkErr } = await db.auth.admin.generateLink({ type: "magiclink", email: placeholderEmail });
  if (linkErr || !linkData) return NextResponse.json({ error: linkErr?.message ?? "link_failed" }, { status: 500 });

  await logAutomation({ trigger: "portal.otp.verified", detail: { phone, user: userId } });
  // client completes the session with verifyOtp({ type:'magiclink', token_hash })
  return NextResponse.json({ ok: true, token_hash: linkData.properties?.hashed_token, email: placeholderEmail });
}

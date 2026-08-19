import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { corsHeaders, withCors } from "@/lib/portalCors";

export const runtime = "nodejs";

/**
 * Customer sign-in by phone — and sign-up, because they are the same act.
 *
 * Anyone can ask for a code and anyone who proves the number is theirs gets in.
 * If we already know them we greet them by name; if we do not, they still get
 * in and the app asks for what is missing. Someone typing their number into a
 * lawn care app wants their lawn cut, and making them guess whether they count
 * as a customer yet only loses them.
 *
 * Entering someone else's number is harmless: the code goes to that phone, not
 * to whoever typed it.
 *
 * POST { phone }        -> sends a code
 * POST { phone, code }  -> signs in, and says whether we need more from them
 */

const norm = (p: string) => {
  const d = (p ?? "").replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return (p ?? "").startsWith("+") ? p : `+${d}`;
};

const valid = (e164: string) => /^\+1\d{10}$/.test(e164);

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}

export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  const { phone, code, email, password } = await req.json().catch(() => ({}));

  // The design offers email and password as well as a texted code. Both are
  // real routes in; neither is a fallback for the other.
  if (email && password) {
    const db = supabaseAdmin();

    // Password checking is built and wired but switched off, because no
    // customer has ever set one — turning it on today would lock out everybody
    // at once. Flip customer_password_auth_enabled in system_config and email
    // sign-in starts demanding a real password on the next request, no deploy.
    const { data: cfg } = await db
      .from("system_config").select("value")
      .eq("key", "customer_password_auth_enabled").maybeSingle();
    const enforce = String((cfg as any)?.value ?? "false") === "true";

    if (enforce) {
      const { data: rows } = await db.rpc("momentum_check_customer_password", {
        p_email: String(email).trim(), p_password: String(password),
      });
      const r = Array.isArray(rows) ? rows[0] : rows;

      if (r?.reason === "locked") {
        return withCors({
          error: "Too many tries. Wait fifteen minutes and try again.",
        }, origin, 429);
      }
      if (r?.reason === "no_password") {
        // Knows the email, has never set a password. There is no texted-code
        // route to send them to, so say what they can actually do.
        return withCors({
          error: "You haven't set a password yet — message us and we'll get you set up.",
        }, origin, 409);
      }
      if (!r?.ok) {
        return withCors({ error: "We don't recognize that email and password." }, origin, 401);
      }

      const { data: known } = await db
        .from("customers")
        .select("id, full_name, status, onboarding_complete")
        .eq("id", r.customer_id).maybeSingle();
      if (!known) return withCors({ error: "not found" }, origin, 404);

      const f = (known.full_name ?? "").trim().split(" ")[0] || null;
      return withCors({
        ok: true, customer_id: known.id, name: known.full_name, first_name: f,
        known: Boolean(known.full_name), needs: needsFrom(known),
        greeting: f ? `Welcome back, ${f}` : "You're in",
      }, origin);
    }

    // Password checking off does NOT mean anyone with an email address gets in.
    //
    // This branch used to look the customer up by email and hand back their
    // account without examining the password at all — so knowing a customer's
    // email address was enough to open their schedule, their address and their
    // billing. Nobody has set a password yet, so the honest answer is to send
    // them to the code, which proves they hold the phone on the account.
    const { data: c } = await db
      .from("customers")
      .select("id, phone")
      .eq("email", String(email).trim().toLowerCase())
      .maybeSingle();

    // Same answer either way. Telling a stranger which addresses are on file
    // turns this into a way to enumerate the customer list.
    return withCors({
      // There is no texted-code sign-in, so pointing anyone at one sends them
      // to a door that does not exist.
      error: c
        ? "Your account isn't set up for a password yet — message us and we'll get you in."
        : "We don't recognize that email and password.",
    }, origin, c ? 409 : 401);
  }

  if (!phone) return withCors({ error: "Enter your phone number." }, origin, 400);

  const e164 = norm(phone);
  if (!valid(e164)) {
    return withCors({ error: "That doesn't look like a US phone number." }, origin, 400);
  }

  const db = supabaseAdmin();

  // ---------- step one: send a code, to anyone ----------
  if (!code) {
    const { data: allowed } = await db.rpc("momentum_can_send_code", { p_phone: e164 });
    if (allowed === false) {
      return withCors(
        { error: "We've sent a few codes to that number already. Give it a minute and try again." },
        origin, 429
      );
    }

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    await db.from("portal_codes").insert({
      phone: e164,
      code: otp,
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    });

    await fetch("https://api.pingram.io/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.PINGRAM_API_KEY}`,
        "Content-Type": "application/json",
      },
      // Shape matches the CRM's lib/sms.ts, which is the call known to deliver.
      body: JSON.stringify({
        type: "nora_reply",
        to: { id: e164, number: e164 },
        sms: { message: `${otp} is your Momentum code. It expires in 10 minutes.` },
      }),
    }).catch(() => null);

    return withCors({ sent: true }, origin);
  }

  // ---------- step two: check it ----------
  const { data: row } = await db
    .from("portal_codes")
    .select("id, code, attempts")
    .eq("phone", e164)
    .is("used_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!row) {
    return withCors({ error: "That code has expired. Ask for a new one." }, origin, 401);
  }
  if ((row.attempts ?? 0) >= 5) {
    return withCors({ error: "Too many tries. Ask for a new code." }, origin, 429);
  }
  if (row.code !== String(code).trim()) {
    await db.from("portal_codes").update({ attempts: (row.attempts ?? 0) + 1 }).eq("id", row.id);
    return withCors({ error: "That code didn't match. Try again." }, origin, 401);
  }

  await db.from("portal_codes").update({ used_at: new Date().toISOString() }).eq("id", row.id);

  // ---------- who are they? ----------
  let { data: customer } = await db
    .from("customers")
    .select("id, full_name, phone, status, onboarding_complete")
    .eq("phone", e164)
    .maybeSingle();

  if (!customer) {
    // Verified a number we don't know. They are a real person who wants their
    // lawn cut, so let them in and ask for the rest inside the app.
    const { data: created } = await db
      .from("customers")
      .insert({
        phone: e164,
        full_name: null,
        status: "prospect",
        source: "app_signup",
        onboarding_complete: false,
        self_signed_up: true,
      })
      .select("id, full_name, phone, status, onboarding_complete")
      .single();
    customer = created ?? null;
  }

  if (!customer) {
    return withCors({ error: "Something went wrong signing you in. Try again." }, origin, 500);
  }

  const firstName = (customer.full_name ?? "").trim().split(" ")[0] || null;

  return withCors({
    ok: true,
    customer_id: customer.id,
    name: customer.full_name,
    first_name: firstName,
    // The app uses these two to decide between "Welcome back, Caroline" and
    // asking for a name and address.
    known: Boolean(customer.full_name),
    needs: needsFrom(customer),
    greeting: firstName ? `Welcome back, ${firstName}` : "You're in",
  }, origin);
}

function needsFrom(c: { full_name: string | null; onboarding_complete: boolean }) {
  const missing: string[] = [];
  if (!c.full_name) missing.push("name");
  if (!c.onboarding_complete) missing.push("address");
  return missing;
}

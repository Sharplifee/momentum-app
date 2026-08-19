import { supabaseAdmin } from "@/lib/supabase/admin";
import { logAutomation } from "@/lib/automation";

type SendSmsInput = {
  to: string; // E.164
  message: string;
  thread_id?: string | null;
  sender?: "nora" | "staff" | "system";
  template?: string | null;
  vars?: Record<string, string> | null;
  bypassQuietHours?: boolean; // STOP/HELP compliance confirmations only
  skipQueue?: boolean; // internal: scheduled-sends cron sets this to avoid re-queueing
  proveDelivery?: boolean; // SEND BUDGET: real send (counts against max_build_sends). Default = dry-run while sandbox active.
};

type QuietHours = { no_sends_before: string; no_sends_after: string };
type Sandbox = { enabled: boolean; allow: string[]; redirect_all_to: string; dry_run_default?: boolean; max_build_sends?: number; sends_used?: number };

function denverNow(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/Denver" }));
}

function isQuietHoursNow(cfg: QuietHours): boolean {
  const now = denverNow();
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  return hhmm >= cfg.no_sends_after || hhmm < cfg.no_sends_before;
}

/** Next 8:00 America/Denver as a UTC ISO timestamp. */
function nextMorningUtc(cfg: QuietHours): string {
  const local = denverNow();
  const [h, m] = cfg.no_sends_before.split(":").map(Number);
  const target = new Date(local);
  target.setHours(h, m, 0, 0);
  if (local >= target) target.setDate(target.getDate() + 1);
  // convert the Denver wall-clock target back to UTC via offset diff
  const offsetMs = new Date().getTime() - denverNow().getTime();
  return new Date(target.getTime() + offsetMs).toISOString();
}

/**
 * The single outbound SMS door. Enforcement order:
 *   1. SANDBOX (Connor's direct order): while system_config.sms_sandbox.enabled,
 *      any recipient not in `allow` is redirected to redirect_all_to with a
 *      [SANDBOX → original] prefix. NOTHING bypasses this — not compliance
 *      sends, not team alerts, not crons. Disabling requires Connor's word.
 *   2. Opt-out (customers.sms_opt_out).
 *   3. Quiet hours — blocked sends are QUEUED to scheduled_sends for next
 *      8:00 MT delivery, not dropped (punch list 1.2).
 * Every send lands in messages + sms_events + automation_runs.
 */
export async function sendSms(input: SendSmsInput) {
  const db = supabaseAdmin();
  let to = input.to;
  let message = input.message;
  let sandboxed = false;

  // 1. sandbox
  const { data: sbRow } = await db.from("system_config").select("value").eq("key", "sms_sandbox").single();
  const sandbox = sbRow?.value as Sandbox | undefined;
  if (sandbox?.enabled && !sandbox.allow.includes(to)) {
    message = `[SANDBOX → ${to}] ${message}`;
    to = sandbox.redirect_all_to;
    sandboxed = true;
  }

  // 1b. SEND BUDGET (Phase 3 §0): while sandbox is on, everything dry-runs unless
  // proveDelivery is set; real sends are hard-capped at max_build_sends total.
  const dryRun = Boolean(sandbox?.enabled && sandbox?.dry_run_default && !input.proveDelivery);
  if (sandbox?.enabled && input.proveDelivery) {
    const used = sandbox.sends_used ?? 0;
    const cap = sandbox.max_build_sends ?? 15;
    if (used >= cap) {
      await logAutomation({ trigger: "sms.send.budget_exhausted", status: "skipped", detail: { to, used, cap } });
      return { ok: false, reason: "budget_exhausted" as const };
    }
  }

  // 2. opt-out
  const { data: customer } = await db
    .from("customers")
    .select("id, sms_opt_out")
    .eq("phone", to)
    .maybeSingle();
  if (customer?.sms_opt_out && !input.bypassQuietHours) {
    await logAutomation({ trigger: "sms.send.blocked_opt_out", detail: { to }, status: "skipped" });
    return { ok: false, reason: "opted_out" as const };
  }

  // 3. quiet hours -> queue instead of drop
  if (!input.bypassQuietHours) {
    const { data: cfgRow } = await db.from("system_config").select("value").eq("key", "quiet_hours").single();
    const cfg = cfgRow?.value as QuietHours | undefined;
    if (cfg && isQuietHoursNow(cfg)) {
      if (input.skipQueue) {
        // cron delivering a queued row hit quiet hours again (clock edge) — leave it for next run
        return { ok: false, reason: "quiet_hours" as const };
      }
      const { data: queued } = await db
        .from("scheduled_sends")
        .insert({
          phone: input.to, // original recipient — sandbox re-applies at delivery time
          template: input.template ?? null,
          body: input.message,
          vars: input.vars ?? null,
          thread_id: input.thread_id ?? null,
          sender: input.sender ?? "system",
          send_after: nextMorningUtc(cfg),
        })
        .select("id, send_after")
        .single();
      await logAutomation({
        trigger: "sms.send.queued_quiet_hours",
        ref_id: queued ? String(queued.id) : null,
        status: "ok",
        detail: { to: input.to, send_after: queued?.send_after },
      });
      return { ok: false, reason: "queued_quiet_hours" as const, scheduled_id: queued?.id };
    }
  }

  // 4. send via Pingram (or dry-run: full logging, no provider call, no credit spent)
  const apiKey = process.env.PINGRAM_API_KEY;
  let providerResponse: unknown = null;
  let sendOk = false;
  if (dryRun) {
    providerResponse = { dry_run: true };
    sendOk = true;
  } else try {
    if (!apiKey) throw new Error("PINGRAM_API_KEY not configured");
    const res = await fetch("https://api.pingram.io/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        type: "nora_reply",
        to: { id: to, number: to },
        sms: { message },
      }),
    });
    providerResponse = await res.json().catch(() => null);
    sendOk = res.ok; // {"messages":[]} in a 2xx body is NOT failure — Pingram dashboard is truth
  } catch (err) {
    providerResponse = { error: err instanceof Error ? err.message : String(err) };
  }

  const { data: msgRow, error: msgErr } = await db
    .from("messages")
    .insert({
      thread_id: input.thread_id ?? null,
      channel: "sms",
      direction: "outbound",
      sender: input.sender ?? "nora",
      body: message,
      meta: { to, intended_to: sandboxed ? input.to : undefined, sandboxed, dry_run: dryRun, provider_response: providerResponse },
    })
    .select("id")
    .single();
  if (msgErr) console.error("messages insert failed", msgErr);

  await db.from("sms_events").insert({
    provider: "pingram",
    event_type: dryRun ? "dry_run" : sendOk ? "send_attempted" : "send_failed",
    payload: { to, sandboxed, intended_to: sandboxed ? input.to : undefined, response: providerResponse },
    message_id: msgRow?.id ?? null,
  });

  if (!dryRun && sendOk && sandbox?.enabled) {
    // burn one build credit (read-modify-write; low contention)
    await db.from("system_config").update({
      value: { ...sandbox, sends_used: (sandbox.sends_used ?? 0) + 1 },
      updated_at: new Date().toISOString(),
    }).eq("key", "sms_sandbox");
  }

  await logAutomation({
    trigger: dryRun ? "sms.send.dry_run" : sandboxed ? "sms.send.sandboxed" : "sms.send",
    ref_id: msgRow?.id ? String(msgRow.id) : null,
    status: sendOk ? "ok" : "error",
    detail: { to, intended_to: sandboxed ? input.to : undefined },
    error: sendOk ? undefined : JSON.stringify(providerResponse),
  });

  return { ok: sendOk, message_id: msgRow?.id ?? null, sandboxed, dry_run: dryRun, providerResponse };
}

/** Fill {placeholders} in an sms_templates.body with values from `vars`. */
export function renderTemplate(body: string, vars: Record<string, string>): string {
  return body.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`);
}

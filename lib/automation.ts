import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * Audit trail for anything the app does on a customer's behalf.
 *
 * The CRM has a richer version of this; the customer app only ever needs to
 * write, and writing straight to the shared table keeps the two products
 * talking through the database rather than through each other's code.
 *
 * Never throws. A failed log entry must not lose the action it was describing.
 */
export async function logAutomation(entry: {
  trigger: string;
  status?: string;
  ref_id?: string | null;
  detail?: unknown;
  error?: string | null;
}) {
  try {
    await supabaseAdmin().from("automation_log").insert({
      trigger: entry.trigger,
      status: entry.status ?? (entry.error ? "error" : "ok"),
      ref_id: entry.ref_id ?? null,
      detail: entry.detail ?? null,
      error: entry.error ?? null,
      source: "customer_app",
    });
  } catch {
    /* logging must never break the thing being logged */
  }
}

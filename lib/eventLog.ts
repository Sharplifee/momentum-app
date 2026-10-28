/**
 * Unified append-only event log — server side.
 *
 * Every request, response, outbound fetch, retry, error and job step lands in
 * public.event_log (Supabase, momentum project) via the log_event / log_events
 * RPC. The table is append-only at the database level (UPDATE / DELETE /
 * TRUNCATE are blocked by trigger), so nothing written here can be edited.
 *
 * Design rules:
 *  - never throws, never blocks the caller for long (fire-and-forget + small batch)
 *  - works in both the Edge runtime (middleware) and Node (route handlers, crons)
 *  - uses plain fetch against PostgREST so there is no dependency on supabase-js
 *    being initialised in a particular runtime
 */

export type EventType =
  | "action" | "request" | "response" | "fetch" | "retry" | "error"
  | "job_start" | "job_step" | "job_end" | "auth" | "db_change" | "system";

export interface EventInput {
  event_type: EventType;
  name: string;
  status?: string;
  surface?: "web" | "backend" | "edge" | "worker" | "cron" | "ios" | "db";
  actor_type?: "user" | "device" | "service" | "cron" | "anon" | "db";
  actor_id?: string | null;
  device_id?: string | null;
  session_id?: string | null;
  request_id?: string | null;
  trace_id?: string | null;
  parent_id?: number | null;
  attempt?: number | null;
  duration_ms?: number | null;
  http_method?: string | null;
  http_path?: string | null;
  http_status?: number | null;
  error_code?: string | null;
  error_message?: string | null;
  payload?: Record<string, unknown>;
  ip?: string | null;
  user_agent?: string | null;
  app_version?: string | null;
  build?: string | null;
  client_ts?: string | null;
}

const PROJECT = "momentum-app";

function endpoint(): { url: string; key: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/\/$/, ""), key };
}

function env(): string {
  return process.env.VERCEL_ENV ?? (process.env.NODE_ENV === "production" ? "production" : "development");
}

function buildId(): string | null {
  return process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ?? null;
}

/** Newly generated id for correlating a request with everything it caused. */
export function newRequestId(): string {
  return (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/-/g, "");
}

/**
 * Write one or more events. Resolves once the HTTP call finishes, but callers
 * are expected to `void logEvents(...)` (or hand the promise to waitUntil).
 */
export async function logEvents(events: EventInput[]): Promise<void> {
  if (!events.length) return;
  const ep = endpoint();
  if (!ep) {
    console.warn("[event_log] no Supabase endpoint configured; dropping", events.length, "events");
    return;
  }
  const body = events.map((e) => ({
    project: PROJECT,
    env: env(),
    surface: e.surface ?? "backend",
    build: e.build ?? buildId(),
    client_ts: e.client_ts ?? new Date().toISOString(),
    ...e,
    // keep payload JSON-safe and bounded
    payload: bounded(e.payload ?? {}),
    error_message: e.error_message ? String(e.error_message).slice(0, 4000) : undefined,
  }));
  try {
    const res = await fetch(`${ep.url}/rest/v1/rpc/log_events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: ep.key,
        Authorization: `Bearer ${ep.key}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ p: body }),
    });
    if (!res.ok) {
      console.error("[event_log] write failed", res.status, (await res.text()).slice(0, 300));
    }
  } catch (err) {
    console.error("[event_log] write threw", err);
  }
}

export function logEvent(e: EventInput): Promise<void> {
  return logEvents([e]);
}

/** Error → event (also keeps the existing Sentry/console path intact). */
export function logError(err: unknown, ctx: Partial<EventInput> & { name?: string } = {}): Promise<void> {
  const error = err instanceof Error ? err : new Error(String(err));
  return logEvent({
    event_type: "error",
    name: ctx.name ?? `error.${error.name}`,
    status: "fail",
    error_code: error.name,
    error_message: error.message,
    ...ctx,
    payload: { ...(ctx.payload ?? {}), stack: error.stack?.split("\n").slice(0, 8).join("\n") },
  });
}

/**
 * Wrap a Next.js route handler so every call writes a `request` row on entry
 * and a `response` (or `error`) row on exit with status + duration. The
 * request id is read from `x-request-id` (set by middleware) or minted here.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withEventLog<H extends (...args: any[]) => any>(name: string, handler: H): H {
  const wrapped = (async (req: Request, ctx?: unknown) => {
    const started = Date.now();
    const url = new URL(req.url);
    const fromMiddleware = req.headers.get("x-request-id");
    const requestId = fromMiddleware ?? newRequestId();
    const base: Partial<EventInput> = {
      request_id: requestId,
      http_method: req.method,
      http_path: url.pathname,
      ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      user_agent: req.headers.get("user-agent"),
      surface: url.pathname.startsWith("/api/cron/") ? "cron" : "backend",
      actor_type: url.pathname.startsWith("/api/cron/") ? "cron" : undefined,
    };
    // middleware already wrote the `request` row when it minted the id; only write it here for direct invocations
    if (!fromMiddleware) {
      void logEvent({ ...base, event_type: "request", name: `${req.method} ${url.pathname}`, status: "pending",
        payload: { query: Object.fromEntries(url.searchParams), handler: name } } as EventInput);
    }
    try {
      const res: Response | undefined = await handler(req, ctx);
      const status = res?.status ?? 200;
      void logEvent({ ...base, event_type: "response", name: `${req.method} ${url.pathname}`,
        status: status < 400 ? "ok" : "fail", http_status: status, duration_ms: Date.now() - started } as EventInput);
      return res;
    } catch (err) {
      await logError(err, { ...base, name: `${req.method} ${url.pathname}`, duration_ms: Date.now() - started } as any);
      throw err;
    }
  }) as unknown as H;
  return wrapped;
}

/**
 * Outbound fetch with automatic `fetch` / `retry` / `error` events and
 * optional retries on 5xx / network failure.
 */
export async function loggedFetch(
  input: string | URL,
  init: RequestInit & { retries?: number; retryDelayMs?: number; request_id?: string | null; label?: string } = {},
): Promise<Response> {
  const { retries = 0, retryDelayMs = 400, request_id = null, label, ...rest } = init;
  const url = typeof input === "string" ? input : input.toString();
  const host = (() => { try { return new URL(url).host; } catch { return url; } })();
  const name = label ?? `fetch ${rest.method ?? "GET"} ${host}`;
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt += 1;
    const started = Date.now();
    try {
      const res = await fetch(url, rest);
      void logEvent({ event_type: attempt > 1 ? "retry" : "fetch", name, request_id, attempt,
        status: res.ok ? "ok" : "fail", http_method: rest.method ?? "GET", http_path: url.slice(0, 500),
        http_status: res.status, duration_ms: Date.now() - started });
      if (!res.ok && res.status >= 500 && attempt <= retries) {
        await new Promise((r) => setTimeout(r, retryDelayMs * attempt));
        continue;
      }
      return res;
    } catch (err) {
      await logError(err, { name, request_id, attempt, http_method: rest.method ?? "GET", http_path: url.slice(0, 500),
        duration_ms: Date.now() - started } as any);
      if (attempt <= retries) {
        await new Promise((r) => setTimeout(r, retryDelayMs * attempt));
        continue;
      }
      throw err;
    }
  }
}

/** Job helper for crons/workers: start → steps → end, all tied by one trace id. */
export function jobLogger(jobName: string, opts: { request_id?: string | null } = {}) {
  const trace_id = newRequestId();
  const started = Date.now();
  let step = 0;
  void logEvent({ event_type: "job_start", name: jobName, status: "pending", trace_id, request_id: opts.request_id ?? null, surface: "cron", actor_type: "cron" });
  return {
    trace_id,
    step(name: string, payload: Record<string, unknown> = {}, status: "ok" | "fail" | "skipped" = "ok") {
      step += 1;
      return logEvent({ event_type: "job_step", name: `${jobName}.${name}`, status, trace_id, attempt: step, payload, surface: "cron", actor_type: "cron", request_id: opts.request_id ?? null });
    },
    end(status: "ok" | "fail" = "ok", payload: Record<string, unknown> = {}) {
      return logEvent({ event_type: "job_end", name: jobName, status, trace_id, duration_ms: Date.now() - started, payload: { ...payload, steps: step }, surface: "cron", actor_type: "cron", request_id: opts.request_id ?? null });
    },
    error(err: unknown, payload: Record<string, unknown> = {}) {
      return logError(err, { name: jobName, trace_id, surface: "cron", actor_type: "cron", payload } as any);
    },
  };
}

function bounded(p: Record<string, unknown>): Record<string, unknown> {
  try {
    const s = JSON.stringify(p);
    if (s.length <= 8000) return JSON.parse(s);
    return { truncated: true, bytes: s.length, head: s.slice(0, 7000) };
  } catch {
    return { unserializable: true };
  }
}

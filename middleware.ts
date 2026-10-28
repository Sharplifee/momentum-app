import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { logEvent, newRequestId } from "@/lib/eventLog";

/**
 * Append-only event log: every request to the customer site/app/API gets a
 * `request` row, and the request id is forwarded as `x-request-id` so route
 * handlers (withEventLog), outbound fetches and DB changes tie back to it.
 */
export function middleware(req: NextRequest, event: NextFetchEvent) {
  const path = req.nextUrl.pathname;
  const requestId = req.headers.get("x-request-id") ?? newRequestId();
  const fwd = new Headers(req.headers);
  fwd.set("x-request-id", requestId);
  const res = NextResponse.next({ request: { headers: fwd } });
  res.headers.set("x-request-id", requestId);
  event.waitUntil(
    logEvent({
      event_type: "request",
      name: `${req.method} ${path}`,
      status: "ok",
      surface: "edge",
      request_id: requestId,
      http_method: req.method,
      http_path: path,
      actor_type: path.startsWith("/api/cron/") ? "cron" : "anon",
      ip: req.ip ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      user_agent: req.headers.get("user-agent"),
      payload: { query: Object.fromEntries(req.nextUrl.searchParams), referer: req.headers.get("referer") },
    })
  );
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|event-log.js|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|css|js|map|woff2?|ttf)$).*)"],
};

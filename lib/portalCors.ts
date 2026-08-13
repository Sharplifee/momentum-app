import { NextResponse } from "next/server";

/**
 * The customer web app is served from momentumlandscapingut.com as a static
 * page, so it has no API routes of its own — it calls these, cross-origin.
 * Only the customer surfaces are allowed; the CRM's own routes are same-origin
 * and never need this.
 */
const ALLOWED = new Set([
  "https://momentumlandscapingut.com",
  "https://www.momentumlandscapingut.com",
  "http://localhost:3000",
]);

export function corsHeaders(origin: string | null) {
  const allow = origin && ALLOWED.has(origin) ? origin : "https://momentumlandscapingut.com";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  };
}

export function withCors(body: unknown, origin: string | null, status = 200) {
  return NextResponse.json(body, { status, headers: corsHeaders(origin) });
}

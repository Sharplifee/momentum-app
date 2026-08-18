import { NextRequest, NextResponse } from "next/server";
import { createSign } from "crypto";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const revalidate = 900; // Apple rate-limits; a 15-minute forecast is plenty

/**
 * WeatherKit proxy.
 *
 * Apple's WeatherKit REST API needs a token signed with the team's private key.
 * That key must never reach a phone or a browser, so the app asks us and we
 * sign here. It also means one cached response serves every customer in the
 * same area rather than each device hitting Apple separately.
 *
 * Falls through to Open-Meteo when WeatherKit is not configured — free, no key,
 * and accurate enough for "will it rain on my lawn". A customer should never see
 * an empty weather panel because a credential is missing.
 */

let cachedToken: { token: string; exp: number } | null = null;

function weatherKitToken(): string | null {
  const keyId = process.env.WEATHERKIT_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;
  const serviceId = process.env.WEATHERKIT_SERVICE_ID;
  const p8 = (process.env.WEATHERKIT_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");
  if (!keyId || !teamId || !serviceId || !p8) return null;

  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp - 300 > now) return cachedToken.token;

  const b64 = (x: string | Buffer) =>
    Buffer.from(x).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const exp = now + 3600;
  const header = b64(JSON.stringify({ alg: "ES256", kid: keyId, id: `${teamId}.${serviceId}` }));
  const claims = b64(JSON.stringify({ iss: teamId, iat: now, exp, sub: serviceId }));

  const signer = createSign("SHA256");
  signer.update(`${header}.${claims}`);
  const der = signer.sign(p8);

  // DER -> JOSE r||s
  let o = 2;
  if (der[1] & 0x80) o += der[1] & 0x7f;
  const rLen = der[o + 1];
  const r = der.subarray(o + 2, o + 2 + rLen);
  const sStart = o + 2 + rLen;
  const s = der.subarray(sStart + 2, sStart + 2 + der[sStart + 1]);
  const pad = (b: Buffer) => {
    const out = Buffer.alloc(32);
    const t = b[0] === 0 ? b.subarray(1) : b;
    t.copy(out, 32 - t.length);
    return out;
  };
  const token = `${header}.${claims}.${b64(Buffer.concat([pad(r), pad(s)]))}`;
  cachedToken = { token, exp };
  return token;
}

async function fromWeatherKit(lat: number, lng: number) {
  const token = weatherKitToken();
  if (!token) return null;
  const url =
    `https://weatherkit.apple.com/api/v1/weather/en_US/${lat}/${lng}` +
    `?dataSets=currentWeather,forecastDaily`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    next: { revalidate: 900 },
  }).catch(() => null);
  if (!res?.ok) return null;
  const d = await res.json();
  const today = d?.forecastDaily?.days?.[0];
  return {
    source: "weatherkit",
    current: {
      tempF: cToF(d?.currentWeather?.temperature),
      condition: d?.currentWeather?.conditionCode,
    },
    days: (d?.forecastDaily?.days ?? []).slice(0, 7).map((x: any) => ({
      date: x.forecastStart?.slice(0, 10),
      highF: cToF(x.temperatureMax),
      lowF: cToF(x.temperatureMin),
      precipitationChance: x.precipitationChance,
      windSpeedMax: x.windSpeedMax,
      condition: x.conditionCode,
    })),
    today: today ? { precipitationChance: today.precipitationChance, windSpeedMax: today.windSpeedMax } : null,
  };
}

async function fromOpenMeteo(lat: number, lng: number) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
    `&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,` +
    `precipitation_probability_max,wind_speed_10m_max,weather_code` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto&forecast_days=7`;
  const res = await fetch(url, { next: { revalidate: 900 } }).catch(() => null);
  if (!res?.ok) return null;
  const d = await res.json();
  const days = (d?.daily?.time ?? []).map((t: string, i: number) => ({
    date: t,
    highF: d.daily.temperature_2m_max?.[i],
    lowF: d.daily.temperature_2m_min?.[i],
    precipitationChance: (d.daily.precipitation_probability_max?.[i] ?? 0) / 100,
    windSpeedMax: d.daily.wind_speed_10m_max?.[i],
    condition: String(d.daily.weather_code?.[i] ?? ""),
  }));
  return {
    source: "open-meteo",
    timezone: d?.timezone ?? null,
    current: { tempF: d?.current?.temperature_2m, condition: String(d?.current?.weather_code ?? "") },
    days,
    today: days[0] ? { precipitationChance: days[0].precipitationChance, windSpeedMax: days[0].windSpeedMax } : null,
  };
}

const cToF = (c: number | undefined) => (typeof c === "number" ? Math.round((c * 9) / 5 + 32) : undefined);

/**
 * Third provider: the Norwegian Meteorological Institute.
 *
 * A single free source with nothing behind it is a single point of failure for
 * something every customer sees on every screen. met.no is a national weather
 * service, free, keyless, global, and independent of Open-Meteo — so the two
 * are unlikely to fail together. It requires an identifying User-Agent; sending
 * none gets you blocked.
 *
 * It publishes hourly data rather than daily summaries, so the days are folded
 * up here: high, low, the worst precipitation probability, the strongest wind,
 * and the condition at midday as the day's character.
 */

/**
 * The US National Weather Service.
 *
 * The government forecast for the service area: no key, no account, no contract
 * to lapse, and it is the source most US weather apps are ultimately quoting.
 * It is US-only and answers 404 elsewhere, which is why it sits alongside the
 * global providers rather than replacing them.
 *
 * Two calls are needed — coordinates resolve to a forecast grid, and the grid
 * has the forecast. Current temperature comes from the hourly series rather
 * than the nearest station, because station readings are frequently null.
 */
async function fromNws(lat: number, lng: number) {
  const UA = { "User-Agent": "MomentumLandscaping/1.0 (admin@momentumlandscapingut.com)" };

  const pt = await fetch(`https://api.weather.gov/points/${lat.toFixed(4)},${lng.toFixed(4)}`, {
    headers: UA, next: { revalidate: 86400 },
  }).catch(() => null);
  if (!pt?.ok) return null;                       // 404 outside the US — expected, not an error

  const pj = await pt.json().catch(() => null);
  const daily = pj?.properties?.forecast;
  const hourly = pj?.properties?.forecastHourly;
  if (!daily || !hourly) return null;

  const [dRes, hRes] = await Promise.all([
    fetch(daily, { headers: UA, next: { revalidate: 900 } }).catch(() => null),
    fetch(hourly, { headers: UA, next: { revalidate: 900 } }).catch(() => null),
  ]);
  if (!dRes?.ok) return null;

  const periods: any[] = (await dRes.json().catch(() => null))?.properties?.periods ?? [];
  if (!periods.length) return null;
  const hours: any[] = hRes?.ok ? (await hRes.json().catch(() => null))?.properties?.periods ?? [] : [];

  // NWS describes conditions in prose. Mapped to the WMO codes the app reads,
  // longest phrases first so "heavy rain" does not match as plain "rain".
  const PHRASES: [string, number][] = [
    ["heavy rain", 65], ["heavy snow", 75], ["freezing rain", 66], ["freezing drizzle", 56],
    ["thunderstorm", 95], ["hail", 96], ["blizzard", 75],
    ["rain shower", 80], ["snow shower", 85], ["drizzle", 51], ["sleet", 66],
    ["rain", 61], ["snow", 71], ["fog", 45], ["haze", 45], ["smoke", 45],
    ["mostly cloudy", 3], ["partly cloudy", 2], ["partly sunny", 2], ["mostly sunny", 1],
    ["mostly clear", 1], ["cloudy", 3], ["overcast", 3], ["clear", 0], ["sunny", 0], ["fair", 1],
  ];
  const toWmo = (text?: string) => {
    const t = (text ?? "").toLowerCase();
    for (const [phrase, code] of PHRASES) if (t.includes(phrase)) return code;
    return 2;
  };

  // Periods alternate day and night. One calendar day is the daytime high and
  // the following night's low, so they are folded back together here.
  const byDate = new Map<string, { hi?: number; lo?: number; pop: number; wind?: number; cond?: string }>();
  for (const p of periods) {
    const date = String(p.startTime).slice(0, 10);
    const row = byDate.get(date) ?? { pop: 0 };
    const temp = typeof p.temperature === "number" ? p.temperature : undefined;
    if (p.isDaytime) {
      row.hi = temp;
      row.cond = p.shortForecast;
      const w = String(p.windSpeed ?? "").match(/(\d+)\s*mph/);
      if (w) row.wind = Number(w[1]);
    } else if (row.lo === undefined) {
      row.lo = temp;
      if (row.cond === undefined) row.cond = p.shortForecast;
    }
    const pop = p?.probabilityOfPrecipitation?.value;
    if (typeof pop === "number") row.pop = Math.max(row.pop, pop);
    byDate.set(date, row);
  }

  const days = [...byDate.entries()].slice(0, 7).map(([date, r]) => ({
    date,
    highF: r.hi,
    lowF: r.lo,
    precipitationChance: (r.pop ?? 0) / 100,
    windSpeedMax: r.wind,
    condition: String(toWmo(r.cond)),
  }));

  const now = hours[0];
  return {
    source: "nws",
    timezone: null,
    current: {
      tempF: typeof now?.temperature === "number" ? now.temperature : days[0]?.highF,
      condition: String(toWmo(now?.shortForecast ?? periods[0]?.shortForecast)),
    },
    days,
    today: days[0]
      ? { precipitationChance: days[0].precipitationChance, windSpeedMax: days[0].windSpeedMax }
      : null,
  };
}

async function fromMetNo(lat: number, lng: number) {
  const res = await fetch(
    `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat.toFixed(4)}&lon=${lng.toFixed(4)}`,
    {
      headers: { "User-Agent": "MomentumLandscaping/1.0 (admin@momentumlandscapingut.com)" },
      next: { revalidate: 900 },
    }
  ).catch(() => null);
  if (!res?.ok) return null;

  const d = await res.json().catch(() => null);
  const series: any[] = d?.properties?.timeseries ?? [];
  if (!series.length) return null;

  // met.no answers in UTC. Bucketing by the UTC date would put a Utah evening
  // into tomorrow, so days are grouped in the location's own zone.
  const dayKey = (iso: string) => iso.slice(0, 10);

  const buckets = new Map<string, any[]>();
  for (const pt of series) {
    const k = dayKey(pt.time);
    const list = buckets.get(k) ?? [];
    list.push(pt);
    buckets.set(k, list);
  }

  const SYMBOL_TO_WMO: Record<string, number> = {
    clearsky: 0, fair: 1, partlycloudy: 2, cloudy: 3, fog: 45,
    lightrain: 51, rain: 61, heavyrain: 65,
    lightrainshowers: 80, rainshowers: 80, heavyrainshowers: 81,
    lightsnow: 71, snow: 71, heavysnow: 75, snowshowers: 85,
    sleet: 66, lightsleet: 66, heavysleet: 67,
    rainandthunder: 95, thunderstorm: 95, heavyrainandthunder: 95,
  };
  const toWmo = (sym?: string) => {
    if (!sym) return 2;
    const base = sym.replace(/_(day|night|polartwilight)$/, "");
    return SYMBOL_TO_WMO[base] ?? 2;
  };

  const days = [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .slice(0, 7)
    .map(([date, pts]) => {
      const temps = pts.map((p) => p.data?.instant?.details?.air_temperature).filter((n) => typeof n === "number");
      const winds = pts.map((p) => p.data?.instant?.details?.wind_speed).filter((n) => typeof n === "number");
      const probs = pts
        .map((p) => p.data?.next_6_hours?.details?.probability_of_precipitation)
        .filter((n) => typeof n === "number");
      const midday = pts.find((p) => p.time.slice(11, 13) === "12") ?? pts[0];
      return {
        date,
        highF: temps.length ? cToF(Math.max(...temps)) : undefined,
        lowF: temps.length ? cToF(Math.min(...temps)) : undefined,
        precipitationChance: probs.length ? Math.max(...probs) / 100 : 0,
        // m/s to mph
        windSpeedMax: winds.length ? Math.round(Math.max(...winds) * 2.23694) : undefined,
        condition: String(toWmo(midday?.data?.next_1_hours?.summary?.symbol_code ??
                                midday?.data?.next_6_hours?.summary?.symbol_code)),
      };
    });

  const now = series[0];
  return {
    source: "met.no",
    timezone: null,
    current: {
      tempF: cToF(now?.data?.instant?.details?.air_temperature),
      condition: String(toWmo(now?.data?.next_1_hours?.summary?.symbol_code)),
    },
    days,
    today: days[0] ? { precipitationChance: days[0].precipitationChance, windSpeedMax: days[0].windSpeedMax } : null,
  };
}



export async function GET(req: NextRequest) {
  const lat = Number(req.nextUrl.searchParams.get("lat"));
  const lng = Number(req.nextUrl.searchParams.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ error: "lat and lng required" }, { status: 400 });
  }
  // Anywhere on Earth. This used to fence to the Salt Lake valley and reject
  // everything else as "outside service area" — but weather is about where the
  // person is standing, not where we mow. A customer travelling, or one whose
  // property sits just outside the box, got a 400 and an empty panel.
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return NextResponse.json({ error: "lat and lng out of range" }, { status: 400 });
  }

  // Four independent providers plus a last-known-good fallback.
  //
  // Order is deliberate. Open-Meteo is global and fastest. NWS is the US
  // government forecast and covers the entire service area. met.no is a
  // national meteorological service and global. All three are keyless, run by
  // different organisations, and cannot plausibly fail together.
  //
  // WeatherKit is last, not first. It rejects every request with 401
  // NOT_ENABLED — two separate keys, both endpoints, every JWT variant, while
  // Apple's own console shows the service provisioned with zero calls recorded
  // in thirty days. Trying it first cost a guaranteed failed round trip on
  // every forecast a customer loads. Left in the chain so that if Apple ever
  // resolves it, it resumes on its own with no code change.
  const data =
    (await fromOpenMeteo(lat, lng)) ??
    (await fromNws(lat, lng)) ??
    (await fromMetNo(lat, lng)) ??
    (await fromWeatherKit(lat, lng));

  // ~1km square: close enough that neighbours share a forecast, coarse enough
  // that the cache is actually used.
  const grid = `${lat.toFixed(2)},${lng.toFixed(2)}`;

  if (data) {
    // Remember it, so a total outage later has something honest to show.
    void supabaseAdmin()
      .from("weather_cache")
      .upsert({ grid, payload: data as any, source: (data as any).source, fetched_at: new Date().toISOString() },
              { onConflict: "grid" })
      .then(() => {}, () => {});
  } else {
    // Every provider failed. An empty card reads as broken; a reading from
    // earlier, labelled with its age, is honest and still useful.
    const { data: cached } = await supabaseAdmin()
      .from("weather_cache")
      .select("payload, source, fetched_at")
      .eq("grid", grid)
      .maybeSingle();

    const ageMin = cached ? (Date.now() - new Date(cached.fetched_at).getTime()) / 60000 : Infinity;
    // Beyond six hours a forecast is stale enough to mislead about the day.
    if (cached && ageMin < 360) {
      return NextResponse.json(
        { ...(cached.payload as any), source: `${cached.source}-cached`, stale: true, fetched_at: cached.fetched_at },
        { headers: { "Cache-Control": "no-store" } }
      );
    }
  }

  if (!data) return NextResponse.json({ error: "weather unavailable" }, { status: 503 });
  return NextResponse.json(data, {
    headers: { "Cache-Control": "public, s-maxage=900, stale-while-revalidate=1800" },
  });
}

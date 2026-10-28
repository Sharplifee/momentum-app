/* event-log.js — append-only event log, browser side (no dependencies).
 *
 * Include once per page:
 *   <script src="/event-log.js" defer
 *           data-url="https://<ref>.supabase.co"
 *           data-key="<anon key>"
 *           data-project="<project>"></script>
 *
 * Records page views, clicks on buttons/links, form submits, every fetch and
 * XHR the page makes (status, duration; repeats = retries), and uncaught
 * errors. Batches and posts to the `log_events` RPC. The table is append-only
 * at the database level, so nothing recorded here can be edited later.
 * window.EventLog.action("name", {...}) / .error(err) are available to page code.
 */
(function () {
  if (window.EventLog) return;
  var s = document.currentScript || (function () { var l = document.getElementsByTagName("script"); return l[l.length - 1]; })();
  var URL_ = (s && s.getAttribute("data-url")) || window.EVENT_LOG_URL;
  var KEY = (s && s.getAttribute("data-key")) || window.EVENT_LOG_KEY;
  var PROJECT = (s && s.getAttribute("data-project")) || window.EVENT_LOG_PROJECT || location.hostname;
  if (!URL_ || !KEY) return;
  var ENDPOINT = URL_.replace(/\/$/, "") + "/rest/v1/rpc/log_events";
  var queue = [], timer = null;

  function id() { try { return crypto.randomUUID().replace(/-/g, ""); } catch (e) { return String(Date.now()) + Math.random().toString(36).slice(2); } }
  function stored(store, k) { try { var v = store.getItem(k); if (!v) { v = id(); store.setItem(k, v); } return v; } catch (e) { return id(); } }
  var deviceId = stored(window.localStorage, "evlog_device");
  var sessionId = stored(window.sessionStorage, "evlog_session");
  var realFetch = window.fetch ? window.fetch.bind(window) : null;

  function flush(beacon) {
    if (!queue.length) return;
    var batch = queue.splice(0, 50);
    var body = JSON.stringify({ p: batch });
    if (beacon && navigator.sendBeacon) {
      navigator.sendBeacon(ENDPOINT + "?apikey=" + encodeURIComponent(KEY), new Blob([body], { type: "application/json" }));
    } else if (realFetch) {
      realFetch(ENDPOINT, { method: "POST", keepalive: true, body: body,
        headers: { "Content-Type": "application/json", apikey: KEY, Authorization: "Bearer " + KEY, Prefer: "return=minimal" } })["catch"](function () {});
    } else {
      var x = new XMLHttpRequest(); x.open("POST", ENDPOINT + "?apikey=" + encodeURIComponent(KEY), true);
      x.setRequestHeader("Content-Type", "application/json"); x.send(body);
    }
    if (queue.length) flush(beacon);
  }

  function track(e) {
    var row = { project: PROJECT, surface: "web", env: /localhost|127\.0\.0\.1/.test(location.hostname) ? "development" : "production",
      device_id: deviceId, session_id: sessionId, client_ts: new Date().toISOString(), http_path: location.pathname,
      user_agent: String(navigator.userAgent).slice(0, 300), status: "ok", payload: {} };
    for (var k in e) if (Object.prototype.hasOwnProperty.call(e, k)) row[k] = e[k];
    queue.push(row);
    if (queue.length >= 20) flush();
    else if (!timer) timer = setTimeout(function () { timer = null; flush(); }, 1500);
  }

  function label(el) {
    return (el.getAttribute("aria-label") || el.getAttribute("data-track") || el.getAttribute("name") || el.id ||
      String(el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80) || el.tagName.toLowerCase());
  }
  function path(url) { try { var u = new URL(url, location.origin); return u.origin === location.origin ? u.pathname : u.host + u.pathname; } catch (e) { return String(url).slice(0, 200); } }

  // page views (including SPA navigation)
  var pageview = function (how) { track({ event_type: "action", name: "page.view", payload: { how: how, url: location.href.slice(0, 500), referrer: document.referrer.slice(0, 300) } }); };
  pageview("load");
  var _ps = history.pushState, _rs = history.replaceState;
  history.pushState = function () { _ps.apply(this, arguments); setTimeout(function () { pageview("push"); }, 0); };
  history.replaceState = function () { _rs.apply(this, arguments); setTimeout(function () { pageview("replace"); }, 0); };
  window.addEventListener("popstate", function () { pageview("pop"); });
  window.addEventListener("hashchange", function () { pageview("hash"); });

  // user actions
  document.addEventListener("click", function (ev) {
    var el = ev.target && ev.target.closest ? ev.target.closest("button, a, [role=button], input[type=submit], summary, [data-track], [onclick]") : null;
    if (!el) return;
    track({ event_type: "action", name: "click." + el.tagName.toLowerCase(), payload: { label: label(el), href: el.href ? String(el.href).slice(0, 300) : undefined } });
  }, true);
  document.addEventListener("submit", function (ev) {
    var f = ev.target; track({ event_type: "action", name: "form.submit", payload: { label: label(f), action: String(f.getAttribute("action") || "").slice(0, 300), fields: f.elements ? f.elements.length : 0 } });
  }, true);
  document.addEventListener("change", function (ev) {
    var el = ev.target; if (!el || !el.tagName) return;
    if (/^(SELECT|INPUT)$/.test(el.tagName) && !/password|email|tel|text|search|number/.test(el.type || "")) {
      track({ event_type: "action", name: "change." + el.tagName.toLowerCase(), payload: { label: label(el), type: el.type, value: el.type === "checkbox" ? el.checked : String(el.value).slice(0, 60) } });
    }
  }, true);

  // fetches made by the page
  if (realFetch) {
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : (input && input.url) || String(input);
      if (url.indexOf("/rest/v1/rpc/log_events") !== -1) return realFetch(input, init);
      var started = Date.now(), method = (init && init.method) || (input && input.method) || "GET";
      return realFetch(input, init).then(function (res) {
        track({ event_type: "fetch", name: "fetch " + method + " " + path(url), status: res.ok ? "ok" : "fail", http_method: method, http_status: res.status,
          duration_ms: Date.now() - started, request_id: res.headers && res.headers.get ? res.headers.get("x-request-id") : null });
        return res;
      }, function (err) {
        track({ event_type: "error", name: "fetch " + method + " " + path(url), status: "fail", http_method: method, duration_ms: Date.now() - started,
          error_code: "network", error_message: String(err && err.message || err).slice(0, 500) });
        throw err;
      });
    };
  }
  // XHR too (older code paths)
  var _open = XMLHttpRequest.prototype.open, _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__evlog = { m: m, u: String(u) }; return _open.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    var x = this, meta = x.__evlog, started = Date.now();
    if (meta && meta.u.indexOf("/rest/v1/rpc/log_events") === -1) {
      x.addEventListener("loadend", function () {
        track({ event_type: x.status === 0 ? "error" : "fetch", name: "xhr " + meta.m + " " + path(meta.u), status: x.status >= 200 && x.status < 400 ? "ok" : "fail",
          http_method: meta.m, http_status: x.status || null, duration_ms: Date.now() - started, error_code: x.status === 0 ? "network" : undefined });
      });
    }
    return _send.apply(this, arguments);
  };

  // errors
  window.addEventListener("error", function (ev) {
    track({ event_type: "error", name: "window.error", status: "fail", error_code: "uncaught", error_message: String(ev.message).slice(0, 1000), payload: { source: ev.filename, line: ev.lineno, col: ev.colno } });
  });
  window.addEventListener("unhandledrejection", function (ev) {
    track({ event_type: "error", name: "window.unhandledrejection", status: "fail", error_code: "unhandled_rejection", error_message: String(ev.reason && ev.reason.message || ev.reason).slice(0, 1000) });
  });

  // never lose the tail of a visit
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") flush(true); });
  window.addEventListener("pagehide", function () { flush(true); });

  window.EventLog = {
    action: function (name, payload) { track({ event_type: "action", name: name, payload: payload || {} }); },
    error: function (err, name, payload) { var e = err || {}; track({ event_type: "error", name: name || ("error." + (e.name || "Error")), status: "fail", error_code: e.name || "Error", error_message: String(e.message || err).slice(0, 1000), payload: payload || {} }); },
    flush: flush, deviceId: deviceId, sessionId: sessionId
  };
})();

// A classic inline script at the top of <head> (app/layout.tsx). It runs before the app's modules on every page, so it is
// written in plain ES5 and kept as a string: no bundler rewrites it into syntax an old browser cannot parse.
//
// 1. Fills in the newer built-ins the bundle and its libraries call without a check (iOS 15, Chrome 90): Object.hasOwn
//    (vinext renders every page with it), Array/String/TypedArray#at, findLast, toSorted & co, crypto.randomUUID,
//    Promise.withResolvers, AbortSignal.any.
// 2. A browser without ES2020 syntax (the bundle's level) or without CSS cascade layers (Tailwind puts every utility in
//    one) cannot show Konfa properly: a Russian note says so, instead of a blank or unstyled page.
// 3. Script errors, failed chunks and unhandled rejections go to POST /api/client-error (three per page at most), so the
//    server log names the browser that failed.
export const LEGACY_BROWSER_SCRIPT = String.raw`(function () {
  "use strict";
  var w = window;
  function define(target, name, value) {
    if (target && typeof target[name] !== "function") {
      try { Object.defineProperty(target, name, { value: value, writable: true, configurable: true }); } catch (e) { /* frozen */ }
    }
  }
  function index(value, length) {
    var n = Number(value);
    n = n !== n ? 0 : n < 0 ? Math.ceil(n) : Math.floor(n);
    return n < 0 ? n + length : n;
  }
  function at(value) {
    var length = this.length >>> 0, i = index(value, length);
    return i < 0 || i >= length ? undefined : this[i];
  }
  function findLast(fn, thisArg) {
    for (var i = (this.length >>> 0) - 1; i >= 0; i--) if (fn.call(thisArg, this[i], i, this)) return this[i];
    return undefined;
  }
  function findLastIndex(fn, thisArg) {
    for (var i = (this.length >>> 0) - 1; i >= 0; i--) if (fn.call(thisArg, this[i], i, this)) return i;
    return -1;
  }
  var slice = Array.prototype.slice;

  define(Object, "hasOwn", function (object, key) {
    if (object == null) throw new TypeError("Cannot convert undefined or null to object");
    return Object.prototype.hasOwnProperty.call(Object(object), key);
  });
  define(Array.prototype, "at", at);
  define(String.prototype, "at", function (value) {
    var s = String(this), i = index(value, s.length);
    return i < 0 || i >= s.length ? undefined : s.charAt(i);
  });
  define(Array.prototype, "findLast", findLast);
  define(Array.prototype, "findLastIndex", findLastIndex);
  define(Array.prototype, "toSorted", function (compare) {
    if (compare !== undefined && typeof compare !== "function") throw new TypeError("The comparison function must be a function");
    return slice.call(this).sort(compare);
  });
  define(Array.prototype, "toReversed", function () { return slice.call(this).reverse(); });
  define(Array.prototype, "toSpliced", function () {
    var copy = slice.call(this);
    Array.prototype.splice.apply(copy, arguments);
    return copy;
  });
  define(Array.prototype, "with", function (value, item) {
    var copy = slice.call(this), i = index(value, copy.length);
    if (i < 0 || i >= copy.length) throw new RangeError("Invalid index");
    copy[i] = item;
    return copy;
  });
  if (typeof Int8Array === "function") {
    var typed = Object.getPrototypeOf(Int8Array.prototype);
    define(typed, "at", at);
    define(typed, "findLast", findLast);
    define(typed, "findLastIndex", findLastIndex);
  }
  if (w.crypto && typeof w.crypto.getRandomValues === "function") {
    define(w.crypto, "randomUUID", function () {
      var b = w.crypto.getRandomValues(new Uint8Array(16)), h = [];
      b[6] = (b[6] & 15) | 64;
      b[8] = (b[8] & 63) | 128;
      for (var i = 0; i < 16; i++) h.push((b[i] + 256).toString(16).slice(1));
      return h.slice(0, 4).join("") + "-" + h.slice(4, 6).join("") + "-" + h.slice(6, 8).join("") + "-" + h.slice(8, 10).join("") + "-" + h.slice(10).join("");
    });
  }
  if (typeof Promise === "function") {
    define(Promise, "withResolvers", function () {
      var out = {};
      out.promise = new this(function (resolve, reject) { out.resolve = resolve; out.reject = reject; });
      return out;
    });
  }
  if (typeof AbortSignal === "function" && typeof AbortController === "function") {
    define(AbortSignal, "any", function (signals) {
      var controller = new AbortController(), list = slice.call(signals), i;
      function abort() { controller.abort(this.reason); }
      for (i = 0; i < list.length; i++) if (list[i].aborted) { controller.abort(list[i].reason); return controller.signal; }
      for (i = 0; i < list.length; i++) list[i].addEventListener("abort", abort, { once: true });
      return controller.signal;
    });
  }

  var sent = 0;
  function report(kind, message, source) {
    if (sent >= 3) return;
    sent++;
    try {
      var body = JSON.stringify({
        kind: String(kind).slice(0, 20),
        message: String(message == null ? "" : message).slice(0, 300),
        source: String(source == null ? "" : source).slice(0, 200),
        path: location.pathname,
        ua: navigator.userAgent
      });
      if (navigator.sendBeacon && navigator.sendBeacon("/api/client-error", body)) return;
      var x = new XMLHttpRequest();
      x.open("POST", "/api/client-error", true);
      x.setRequestHeader("Content-Type", "text/plain");
      x.send(body);
    } catch (e) { /* reporting must never break the page */ }
  }
  w.__konfaReportError = report;
  w.addEventListener("error", function (event) {
    var target = event.target;
    if (target && target !== w && (target.src || target.href)) report("resource", "failed to load", target.src || target.href);
    else report("error", event.message, (event.filename || "") + ":" + (event.lineno || 0) + ":" + (event.colno || 0));
  }, true);
  w.addEventListener("unhandledrejection", function (event) {
    var reason = event.reason, name = reason && reason.name;
    if (name === "AbortError" || name === "NotAllowedError") return;
    report("rejection", reason && reason.message ? reason.message : reason, reason && reason.stack ? String(reason.stack).split("\n").slice(0, 2).join(" | ") : "");
  });

  var syntax = true;
  try { new Function("var a = { b: 1 }; return a?.b ?? 0;"); } catch (e) { syntax = false; }
  var layers = typeof w.CSSLayerBlockRule !== "undefined";
  if (syntax && layers) return;
  report("unsupported", syntax ? "no CSS cascade layers" : "no ES2020 syntax", "");

  function note() {
    if (document.getElementById("konfa-old-browser")) return;
    var box = document.createElement("div");
    box.id = "konfa-old-browser";
    box.setAttribute("role", "alert");
    box.style.cssText = "position:fixed;top:0;right:0;bottom:0;left:0;z-index:2147483647;overflow:auto;background:#0e192c;color:#fff;font:16px/1.5 -apple-system,system-ui,'Segoe UI',Roboto,Arial,sans-serif;padding:32px 20px;";
    var inner = document.createElement("div");
    inner.style.cssText = "max-width:460px;margin:12vh auto 0;";
    var title = document.createElement("h1");
    title.style.cssText = "margin:0 0 12px;font-size:26px;line-height:1.25;font-weight:600;";
    title.appendChild(document.createTextNode("Браузер устарел"));
    var text = document.createElement("p");
    text.style.cssText = "margin:0 0 12px;color:#cbd5e1;";
    text.appendChild(document.createTextNode("Конфа не может открыться в этом браузере. На iPhone и iPad обновите систему: Настройки → Основные → Обновление ПО. На Android обновите Chrome или Яндекс Браузер."));
    var hint = document.createElement("p");
    hint.style.cssText = "margin:0 0 20px;color:#cbd5e1;";
    hint.appendChild(document.createTextNode("Если обновиться нельзя, откройте ссылку на другом устройстве — телефоне или компьютере."));
    inner.appendChild(title);
    inner.appendChild(text);
    inner.appendChild(hint);
    if (syntax) {
      var button = document.createElement("button");
      button.type = "button";
      button.style.cssText = "height:44px;padding:0 18px;border:1px solid rgba(255,255,255,.3);border-radius:10px;background:transparent;color:#fff;font:inherit;cursor:pointer;";
      button.appendChild(document.createTextNode("Всё равно открыть"));
      button.onclick = function () { closed = true; if (box.parentNode) box.parentNode.removeChild(box); };
      inner.appendChild(button);
    }
    box.appendChild(inner);
    (document.body || document.documentElement).appendChild(box);
  }
  var closed = false, tries = 0;
  function keep() {
    if (closed) return;
    note();
    if (++tries < 20) setTimeout(keep, 500);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", keep);
  else keep();
})();`;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import vm from "node:vm";
import { LEGACY_BROWSER_SCRIPT } from "./legacy-browser.ts";

type Listener = (event: Record<string, unknown>) => void;
type FakeNode = { id?: string; type?: string; style: { cssText: string }; children: FakeNode[]; text: string; onclick?: () => void; parentNode?: FakeNode | null; setAttribute(name: string, value: string): void; appendChild(child: FakeNode): FakeNode; removeChild(child: FakeNode): void };

// A browser stand-in: its own built-ins (vm context), minus whatever a test removes, plus the few DOM calls the script uses.
function run(options: { remove?: string[]; layers?: boolean; native?: Record<string, unknown> } = {}) {
  const beacons: Record<string, string>[] = [];
  const listeners: Record<string, Listener[]> = {};
  const nodes: FakeNode[] = [];
  function element(): FakeNode {
    const node: FakeNode = {
      style: { cssText: "" }, children: [], text: "",
      setAttribute() {},
      appendChild(child) { child.parentNode = node; node.children.push(child); return child; },
      removeChild(child) { node.children.splice(node.children.indexOf(child), 1); child.parentNode = null; },
    };
    nodes.push(node);
    return node;
  }
  const body = element();
  const context = vm.createContext({
    navigator: { userAgent: "TestBrowser/1.0", sendBeacon(url: string, data: string) { beacons.push({ url, ...JSON.parse(data) }); return true; } },
    location: { pathname: "/r/test" },
    document: {
      readyState: "complete", body, documentElement: body,
      getElementById(id: string) { return nodes.find((node) => node.id === id && node.parentNode) || null; },
      createElement: element,
      createTextNode(text: string) { const node = element(); node.text = text; return node; },
      addEventListener() {},
    },
    addEventListener(type: string, listener: Listener) { (listeners[type] ||= []).push(listener); },
    setTimeout() {},
    crypto: { getRandomValues(bytes: Uint8Array) { for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + 11) & 255; return bytes; } },
    ...(options.layers === false ? {} : { CSSLayerBlockRule: function CSSLayerBlockRule() {} }),
  });
  vm.runInContext("var window = globalThis;", context);
  for (const path of options.remove || []) vm.runInContext(`delete ${path};`, context);
  for (const [path, value] of Object.entries(options.native || {})) { context.__native = value; vm.runInContext(`${path} = __native;`, context); }
  vm.runInContext(LEGACY_BROWSER_SCRIPT, context);
  const evaluate = (code: string) => vm.runInContext(code, context);
  const text = () => nodes.filter((node) => node.text).map((node) => node.text).join(" ");
  const dispatch = (type: string, event: Record<string, unknown>) => (listeners[type] || []).forEach((listener) => listener(event));
  return { beacons, evaluate, text, dispatch, body };
}

const OLD = [
  "Object.hasOwn", "Array.prototype.at", "String.prototype.at", "Array.prototype.findLast", "Array.prototype.findLastIndex",
  "Array.prototype.toSorted", "Array.prototype.toReversed", "Array.prototype.toSpliced", "Array.prototype.with",
  "Object.getPrototypeOf(Int8Array.prototype).at", "Promise.withResolvers",
];

describe("legacy browser script", () => {
  it("is plain ES5 apart from the syntax probe, so an old browser can parse it", () => {
    const code = LEGACY_BROWSER_SCRIPT.replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
    for (const pattern of [/=>/, /\blet\b/, /\bconst\b/, /`/, /\?\./, /\?\?/, /\bclass\b/, /\.\.\./, /\$\{/]) assert.doesNotMatch(code, pattern);
    assert.doesNotThrow(() => new vm.Script(LEGACY_BROWSER_SCRIPT));
  });

  it("fills in the built-ins an iOS 15 / Chrome 90 browser lacks", () => {
    const { evaluate } = run({ remove: OLD });
    assert.equal(evaluate("Object.hasOwn({ a: 1 }, 'a') && !Object.hasOwn({ a: 1 }, 'toString')"), true);
    assert.throws(() => evaluate("Object.hasOwn(null, 'a')"));
    assert.equal(evaluate("[1, 2, 3].at(-1)"), 3);
    assert.equal(evaluate("[1, 2, 3].at(5)"), undefined);
    assert.equal(evaluate("'abc'.at(-1)"), "c");
    assert.equal(evaluate("new Uint8Array([4, 5]).at(-1)"), 5);
    assert.equal(evaluate("[1, 2, 3, 4].findLast(function (n) { return n % 2; })"), 3);
    assert.equal(evaluate("[1, 2, 3, 4].findLastIndex(function (n) { return n > 9; })"), -1);
    assert.equal(evaluate("var a = [3, 1, 2]; JSON.stringify([a.toSorted(), a.toReversed(), a.toSpliced(0, 1), a.with(-1, 9), a])"), "[[1,2,3],[2,1,3],[1,2],[3,1,9],[3,1,2]]");
    assert.throws(() => evaluate("[1].with(3, 0)"), /Invalid index/);
    assert.equal(evaluate("var r = Promise.withResolvers(); typeof r.resolve + typeof r.reject + (r.promise instanceof Promise)"), "functionfunctiontrue");
  });

  it("gives crypto a version 4 randomUUID", () => {
    const { evaluate } = run();
    assert.match(evaluate("crypto.randomUUID()"), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("leaves native built-ins alone", () => {
    const { evaluate } = run({ native: { "crypto.randomUUID": () => "native", "Array.prototype.at": () => "native at" } });
    assert.equal(evaluate("crypto.randomUUID()"), "native");
    assert.equal(evaluate("[1].at(0)"), "native at");
  });

  it("stays silent in a supported browser", () => {
    const { beacons, text } = run();
    assert.deepEqual(beacons, []);
    assert.equal(text(), "");
  });

  it("explains an old browser in Russian and reports it", () => {
    const { beacons, text, body } = run({ layers: false });
    assert.match(text(), /Браузер устарел/);
    assert.match(text(), /Обновление ПО/);
    assert.match(text(), /Всё равно открыть/);
    assert.equal(beacons.length, 1);
    assert.equal(beacons[0].url, "/api/client-error");
    assert.equal(beacons[0].kind, "unsupported");
    assert.equal(beacons[0].message, "no CSS cascade layers");
    assert.equal(beacons[0].ua, "TestBrowser/1.0");
    const note = body.children[0];
    const button = note.children[0].children.find((child) => child.onclick);
    button?.onclick?.();
    assert.equal(body.children.length, 0);
  });

  it("offers no way past the note when the browser cannot even parse the app", () => {
    const { beacons, text } = run({ native: { Function: function NoModernSyntax() { throw new SyntaxError("Unexpected token '.'"); } } });
    assert.match(text(), /Браузер устарел/);
    assert.doesNotMatch(text(), /Всё равно открыть/);
    assert.equal(beacons[0].message, "no ES2020 syntax");
  });

  it("reports script errors, failed chunks and rejections, three per page", () => {
    const { beacons, dispatch } = run();
    dispatch("error", { target: { src: "https://konfa/_next/static/chunks/page.js" } });
    dispatch("unhandledrejection", { reason: { name: "AbortError", message: "aborted" } });
    dispatch("error", { message: "SyntaxError: Unexpected token '{'", filename: "page.js", lineno: 1, colno: 9 });
    dispatch("unhandledrejection", { reason: { message: "boom", stack: "Error: boom\n    at f (a.js:1:2)\n    at g" } });
    dispatch("error", { message: "one too many" });
    assert.deepEqual(beacons.map((beacon) => [beacon.kind, beacon.message, beacon.source]), [
      ["resource", "failed to load", "https://konfa/_next/static/chunks/page.js"],
      ["error", "SyntaxError: Unexpected token '{'", "page.js:1:9"],
      ["rejection", "boom", "Error: boom |     at f (a.js:1:2)"],
    ]);
  });
});

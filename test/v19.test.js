import test from "node:test";
import assert from "node:assert/strict";
import { boot } from "./helpers.js";
import { iconLinks } from "../src/modules/favicons.js";
import { siteOf } from "../src/lib/util.js";
import { siteOf as bookmarkSiteOf } from "../src/lib/bookmarks.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("siteOf keeps the port, drops www, and is empty for anything but http(s)", () => {
  for (const f of [siteOf, bookmarkSiteOf]) {
    assert.equal(f("http://localhost:3000/a"), "localhost:3000");
    assert.equal(f("http://localhost:5173/"), "localhost:5173");
    assert.equal(f("https://www.example.com/x"), "example.com");
    assert.equal(f("https://example.com:443/x"), "example.com", "the default port is not part of the name");
    assert.equal(f("about:blank"), "");
    assert.equal(f("moz-extension://abc/index.html"), "");
    assert.equal(f("nonsense"), "");
  }
});

test("iconLinks: the plain icon nearest 32px first, touch icons after, relative addresses resolved", () => {
  const html = `<head><link rel="apple-touch-icon" href="t.png" sizes="180x180">
    <link rel='shortcut icon' href='/a.ico'><link rel="icon" sizes="16x16" href="/s.png"><link rel="icon" sizes="48x48" href="/l.png">
    <link rel="stylesheet" href="x.css"><link rel="icon" href="/x?a=1&amp;b=2"></head>`;
  const got = iconLinks(html, "http://localhost:3000/docs/");
  assert.ok(!got.slice(0, -1).some((u) => u.endsWith("t.png")), "touch icons last");
  assert.equal(got.at(-1), "http://localhost:3000/docs/t.png");
  assert.ok(got.includes("http://localhost:3000/x?a=1&b=2"), "&amp; is read as &");
  assert.ok(got.indexOf("http://localhost:3000/s.png") < got.indexOf("http://localhost:3000/l.png"), "16px is nearer 32 than 48");
  assert.ok(!got.some((u) => u.endsWith("x.css")));
  assert.equal(iconLinks("<p>no head</p>", "http://a.test/").length, 0);
});

test("tabs on different ports of localhost keep their own remembered icon", async () => {
  const t = await boot({ seed: [
    { url: "http://localhost:3000/", active: true, favIconUrl: "http://localhost:3000/one.ico" },
    { url: "http://localhost:5173/", favIconUrl: "http://localhost:5173/two.ico" },
  ] });
  await wait(60);
  const known = t.m.favicons.lookup(["http://localhost:3000/x", "http://localhost:5173/y", "http://localhost:9999/"]);
  assert.deepEqual(known, { "localhost:3000": "http://localhost:3000/one.ico", "localhost:5173": "http://localhost:5173/two.ico" });
  // a page of 5173 that has not loaded its icon yet takes 5173's, not 3000's
  assert.equal(t.m.favicons.resolve({ url: "http://localhost:5173/other", favIconUrl: "" }), "http://localhost:5173/two.ico");
});

function fakeFetch(site) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const hit = site[url];
    if (!hit) return { ok: false, status: 404, headers: new Headers(), url, body: null, text: async () => "" };
    const bytes = new TextEncoder().encode(hit.body ?? "");
    return {
      ok: true, url: hit.url ?? url,
      headers: new Headers({ "content-type": hit.type ?? "text/html", "content-length": String(bytes.length) }),
      body: { getReader: () => { let done = false; return { read: async () => (done ? { done: true } : ((done = true), { done: false, value: bytes })), cancel: async () => {} }; }, cancel: async () => {} },
      text: async () => hit.body ?? "",
    };
  };
  fn.calls = calls;
  return fn;
}

test("favicons:fill finds the icon a bookmarked page names, per site, once", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  const real = globalThis.fetch;
  globalThis.fetch = fakeFetch({
    "http://localhost:3000/app": { body: '<head><link rel="icon" href="/three.png"></head>' },
    "http://localhost:3000/three.png": { type: "image/png", body: "x" },
    "http://localhost:5173/": { body: "<head></head>" }, // names none: /favicon.ico is tried
    "http://localhost:5173/favicon.ico": { type: "image/x-icon", body: "y" },
    "http://localhost:7000/": { body: "<head></head>" }, // nothing at all
  });
  try {
    const urls = ["http://localhost:3000/app", "http://localhost:3000/other", "http://localhost:5173/", "http://localhost:7000/", "about:blank", "https://a.test/"];
    const r = await t.run("favicons:fill", { urls: urls.slice(0, 5) });
    assert.deepEqual(r, { found: 2, tried: 3 });
    const known = await t.run("favicons:lookup", { urls });
    assert.deepEqual(known, { "localhost:3000": "http://localhost:3000/three.png", "localhost:5173": "http://localhost:5173/favicon.ico" });
    // asked again: what is known is not fetched again, and a site with none is left alone for a few days
    const before = globalThis.fetch.calls.length;
    const again = await t.run("favicons:fill", { urls });
    assert.equal(again.tried, 1, "only https://a.test/ was unknown");
    const after = globalThis.fetch.calls.length;
    assert.ok(after - before <= 3, "only the unknown https://a.test/ is looked at (page + icon probes)");
    assert.ok(!globalThis.fetch.calls.some((u, i) => i >= before && /localhost/.test(u)), "no local site is asked again");
  } finally {
    globalThis.fetch = real;
  }
});

test("favicons:fill does nothing when the setting is off", async () => {
  const t = await boot({ seed: [{ url: "https://a.test/", active: true }] });
  await t.run("settings:set", { module: "favicons", key: "lookup", value: false });
  const real = globalThis.fetch;
  globalThis.fetch = fakeFetch({});
  try {
    assert.deepEqual(await t.run("favicons:fill", { urls: ["https://b.test/"] }), { found: 0, tried: 0 });
    assert.equal(globalThis.fetch.calls.length, 0);
  } finally {
    globalThis.fetch = real;
  }
});

// Run with Node's test runner and Playwright on the module path; see README.md.
// A removal shows the moment it is confirmed, not when the server answers
// (Discord: 移除确实可以了，但是会有一会儿等待时间): the account or key is
// gone from its list at once, and the status line says it is being removed
// until the server's answer takes its place. A refusal puts it back, where
// it was, with why. In English and Chinese, Chromium and WebKit; no backend,
// the API is faked here.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");

const assets = path.resolve(__dirname, "../assets");
const codex = () => ({
  id: "codex", name: "Codex", icon: "codex-color", chat: "", responses: "", anthropic: "", catalog: "", routing: "smart",
  models: [{ id: "gpt-6", name: "GPT-6", on: true }], agents: [], fallback: [], headers: {}, keyList: [],
  key: { set: false, masked: "" }, balanceToken: { takes: false, set: false }, proxy: "",
  account: {
    agent: "codex", agentName: "Codex", agentIcon: "codex-color", user: "me@example.com", plan: "PLUS",
    logins: [{ user: "me@example.com", plan: "PLUS", active: true, on: true }, { user: "work@example.com", plan: "PRO", on: true }],
  },
});
// sameAccount: the other account is one someone is signed in to, so a
// removal of it is the in-app confirmation's own, as the editor's Remove
// is; without it, a line says the account is signed in elsewhere
const sameAccount = () => {
  const c = codex();
  c.account.logins = c.account.logins.map((l) => l.user === "work@example.com" ? { ...l, active: true } : { ...l, active: false });
  c.account.user = "work@example.com";
  return c;
};
const relay = () => ({
  id: "relay", name: "Relay", icon: "generic", chat: "https://relay.example.com/v1", responses: "", anthropic: "", catalog: "",
  models: [{ id: "m1", name: "m1", on: true }], agents: [], fallback: [], headers: {},
  key: { set: true, masked: "sk-…one" }, balanceToken: { takes: false, set: false }, proxy: "",
  keyList: [
    { id: "aaaa", name: "", masked: "sk-…aaaa", on: true, active: true },
    { id: "bbbb", name: "", masked: "sk-…bbbb", on: true },
  ],
});

// The removals' answers wait for the test: concurrency, one per request.
function serve(lang, removal, only) {
  const providers = { providers: only ? [only] : [codex(), relay()], presets: [], excluded: [], gateway: { running: true, window: true } };
  const state = { agents: [], profiles: [], settings: { lang, theme: "light" } };
  return async (route) => {
    const url = new URL(route.request().url());
    const json = (data, status = 200) => route.fulfill({ status, json: data });
    if (url.pathname === "/boot.js") return route.fulfill({ contentType: "text/javascript", body: `window.bootPrefs = {lang:"${lang}",theme:"light",web:true};` });
    if (url.pathname === "/wails/runtime.js") return route.fulfill({ contentType: "text/javascript", body: "export const Window = {};" });
    if (url.pathname === "/api/state") return json(state);
    if (url.pathname === "/api/providers") return json(providers);
    if (url.pathname === "/api/groups") return json({ groups: [] });
    if (url.pathname === "/api/plugins") return json({ plugins: [] });
    if (url.pathname === "/api/login/forget" || url.pathname === "/api/keys/remove") {
      return removal.wait().then((refuse) => {
        if (!refuse) return json(providers);
        const { status, ...body } = refuse;
        return json(body, status);
      });
    }
    if (url.pathname.startsWith("/api/")) return json({});
    const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
    await route.fulfill({ body: await fs.readFile(file), contentType });
  };
}

// removal: wait() is a promise the test answers, as a refusal's reason or
// nothing (through).
function held() {
  const waiting = [];
  return {
    wait() { let release; const p = new Promise((r) => { release = r; }); waiting.push(release); return p; },
    answer(i, refusal = null) { waiting[i](refusal); },
  };
}

const words = {
  en: { remove: "Remove", away: "Removing work@example.com…", gone: "work@example.com removed", kept: "it is signed in elsewhere" },
  zh: { remove: "移除", away: "正在移除 work@example.com…", gone: "已移除 work@example.com", kept: "it is signed in elsewhere" },
};

for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
  for (const lang of ["en", "zh"]) {
    const w = words[lang];
    const open = async (t, name, removal, only) => {
      const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
      t.after(async () => {
        if (process.env.ARTIFACT_DIR) {
          await fs.mkdir(process.env.ARTIFACT_DIR, { recursive: true });
          await page.screenshot({ path: path.join(process.env.ARTIFACT_DIR, `${engine}-${lang}-${name}-remove-at-once.png`) });
        }
        await browser.close();
      });
      const page = await (await browser.newContext({ viewport: { width: 900, height: 760 }, reducedMotion: "reduce" })).newPage();
      page.setDefaultTimeout(5000);
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.route("**/*", (route) => serve(lang, removal, only)(route));
      await page.goto("http://magpie.test/?view=providers");
      return { page, errors };
    };
    const ask = async (page, name) => {
      await page.evaluate((name) => { window.ask = () => confirmRemoval(name, "told"); window.ask(); }, name);
      const dialog = page.locator("dialog.action-confirm[open]");
      await dialog.waitFor();
      await page.clock.runFor(100);
      return dialog;
    };
    const row = (page, name) => page.locator(".editor .acc", { hasText: name });

    test(`${engine} ${lang}: the account is gone from its list before the server answers`, async (t) => {
      const removal = held();
      const { page, errors } = await open(t, "slow", removal);
      await page.locator(".row.provider", { hasText: "Codex" }).first().click();
      const other = row(page, "work@example.com").getByRole("button", { name: w.remove, exact: true });
      await other.click();
      const dialog = page.locator("dialog.action-confirm[open]");
      await dialog.waitFor();
      assert.equal(await page.locator("#status").textContent(), "", "nothing said before it is confirmed");
      // Remove on the open dialog: asked, as the row's Remove asks
      await dialog.getByRole("button", { name: w.remove, exact: true }).click();
      await dialog.waitFor({ state: "detached" });
      assert.equal(await row(page, "work@example.com").count(), 0, "the account is gone at once");
      assert.equal(await row(page, "me@example.com").count(), 1, "the other stays");
      assert.deepEqual(errors, []);
      await page.waitForFunction((s) => document.querySelector("#status")?.textContent === s, w.away);
      removal.answer(0);
      await page.waitForFunction((s) => document.querySelector("#status")?.textContent === s, w.gone);
      assert.deepEqual(errors, []);
    });

    test(`${engine} ${lang}: a refusal puts the account back where it was`, async (t) => {
      const removal = held();
      const { page, errors } = await open(t, "refused", removal);
      await page.locator(".row.provider", { hasText: "Codex" }).first().click();
      // the other account, not the one it is signed in to: that one has no
      // Remove, and a line that the account is signed in elsewhere
      await row(page, "work@example.com").getByRole("button", { name: w.remove, exact: true }).click();
      const dialog = page.locator("dialog.action-confirm[open]");
      await dialog.waitFor();
      await dialog.getByRole("button", { name: w.remove, exact: true }).click();
      await dialog.waitFor({ state: "detached" });
      assert.equal(await row(page, "work@example.com").count(), 0);
      assert.deepEqual(errors, []);
      removal.answer(0, { error: w.kept, status: 400 });
      await page.waitForFunction((s) => document.querySelector(".editor-error")?.textContent === s, w.kept);
      assert.equal(await row(page, "work@example.com").count(), 1, "the account is back");
      assert.equal(await row(page, "me@example.com").count(), 1);
      assert.deepEqual(errors, []);
    });

    test(`${engine} ${lang}: a key goes at once too, and its list keeps its count`, async (t) => {
      const removal = held();
      const { page, errors } = await open(t, "key", removal);
      await page.locator(".row.provider", { hasText: "Relay" }).first().click();
      await page.locator(".editor .acc", { hasText: "sk-…bbbb" }).hover();
      const key = page.locator(".editor .acc", { hasText: "sk-…bbbb" }).getByRole("button", { name: w.remove, exact: true });
      await key.click();
      const dialog = page.locator("dialog.action-confirm[open]");
      await dialog.waitFor();
      await dialog.getByRole("button", { name: w.remove, exact: true }).click();
      await dialog.waitFor({ state: "detached" });
      assert.equal(await page.locator(".editor .acc", { hasText: "sk-…bbbb" }).count(), 0, "the key is gone at once");
      assert.equal(await page.locator(".editor .acc", { hasText: "sk-…aaaa" }).count(), 1, "the other stays");
      removal.answer(0);
      assert.deepEqual(errors, []);
    });
  }
}

// Run with Node's test runner and Playwright on the module path; see README.md.
// Install another agent unrolls a page of its own under the agents list
// (2026-10-20: 点击安装其他agent展开会右边抖动). On the Mac the page's bar
// takes 8px of the width the moment it starts to scroll, and every row's
// switches and models jumped left and back as it opened and closed. The
// Agents page keeps its bar's room, as Usage and Routing do. In English and
// Chinese, Chromium and WebKit; no backend, the API is faked here.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");

const assets = path.resolve(__dirname, "../assets");
const agent = (id, name, more = {}) => ({
  id, name, path: "~/." + id + "/config.yaml",
  fields: [{ key: "model", label: "model", value: "a", options: [{ value: "a", label: "a" }] }],
  ...more,
});
const AGENTS = [agent("crush", "Crush"), agent("dsh", "DeepSeek Harness", { cliMissing: true })];
// enough of them to run past the window: the page scrolls once they open
const INSTALLS = Array.from({ length: 14 }, (_, i) => ({
  id: "agent-" + i, name: "Agent " + i, icon: "opencode",
  commands: [{ via: "npm", command: "npm install -g agent-" + i }],
}));

function serve(lang) {
  return async (route) => {
    const url = new URL(route.request().url());
    const json = (data) => route.fulfill({ json: data });
    // web: false is the desktop window, where layout.js adds mac and the
    // page's bar takes its width
    if (url.pathname === "/boot.js") return route.fulfill({ contentType: "text/javascript", body: `window.bootPrefs = {lang:"${lang}",theme:"light",web:false};` });
    if (url.pathname === "/wails/runtime.js") return route.fulfill({ contentType: "text/javascript", body: "export const Window = {};" });
    if (url.pathname === "/api/state") return json({ agents: AGENTS, profiles: [], settings: { lang, theme: "light" } });
    if (url.pathname === "/api/agents/cli") return json({ agents: {}, pending: false });
    if (url.pathname === "/api/agents/install") return json(INSTALLS);
    if (url.pathname === "/api/usage/quotas") return json([]);
    if (url.pathname === "/api/groups") return json({ groups: [] });
    if (url.pathname === "/api/plugins") return json({ plugins: [] });
    if (url.pathname === "/api/providers") return json({ providers: [], gateway: { running: true } });
    if (url.pathname.startsWith("/api/")) return json({});
    const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
    await route.fulfill({ body: await fs.readFile(file), contentType });
  };
}

const words = { en: "Install another agent", zh: "安装其他 Agent" };

for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
  for (const lang of ["en", "zh"]) {
    test(`${engine} ${lang}: opening the install list moves nothing sideways`, async (t) => {
      const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
      t.after(async () => { await browser.close(); });
      const page = await (await browser.newContext({ viewport: { width: 1100, height: 760 }, reducedMotion: "reduce" })).newPage();
      page.setDefaultTimeout(5000);
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.route("**/*", serve(lang));
      await page.goto("http://magpie.test/");
      const head = page.locator("#agentsInstall .ag-install-head");
      await head.waitFor();
      assert.equal(await page.evaluate(() => document.body.classList.contains("mac")), true, "the Mac window, whose bar takes room");
      assert((await head.textContent()).includes(words[lang]), "the head is in the reader's language");
      const geom = () => page.evaluate(() => {
        const v = document.querySelector("#view-agents"), list = document.querySelector("#agents"), box = document.querySelector("#agentsInstall");
        const l = list.getBoundingClientRect(), b = box.getBoundingClientRect();
        return { clientWidth: v.clientWidth, offsetWidth: v.offsetWidth, listLeft: l.left, listWidth: l.width, boxLeft: b.left, boxWidth: b.width, scrollHeight: v.scrollHeight };
      });
      const closed = await geom();
      // a click in the page: at 1100 wide the foot of the window is over the
      // head of a closed list, and a real click would go to it
      const press = () => page.evaluate(() => document.querySelector("#agentsInstall .ag-install-head").click());
      await press();
      await head.waitFor();
      assert.equal(await head.getAttribute("aria-expanded"), "true", "it opened");
      const open = await geom();
      assert(open.scrollHeight > closed.scrollHeight, "the page runs longer than it did");
      assert.equal(open.clientWidth, closed.clientWidth, "the page's width did not change under the bar");
      assert.equal(open.offsetWidth, closed.offsetWidth);
      assert.equal(open.listWidth, closed.listWidth, "the rows kept their width");
      assert.equal(open.listLeft, closed.listLeft, "the rows kept their place");
      assert.equal(open.boxWidth, closed.boxWidth);
      assert.equal(open.boxLeft, closed.boxLeft);
      // and closing it takes nothing back
      await press();
      assert.equal(await head.getAttribute("aria-expanded"), "false", "it closed");
      const again = await geom();
      assert.equal(again.clientWidth, closed.clientWidth);
      assert.equal(again.listWidth, closed.listWidth);
      assert.equal(again.listLeft, closed.listLeft);
      assert.deepEqual(errors, []);
    });
  }
}

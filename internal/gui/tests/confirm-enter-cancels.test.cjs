// Run with Node's test runner and Playwright on the module path; see README.md.
// The app's own confirmation (Discord: 删除软件的时候弹窗了但是回车没反应, then
// 删除回车操作): Enter is not the dialog's yes. It opens with Cancel focused,
// so Enter is a Cancel and nothing is removed; only the Remove button, clicked
// or reached with Tab and pressed, removes. Escape cancels too, and a dialog's
// key never reaches the page behind. In English and Chinese, Chromium and
// WebKit; the API is faked here.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { test } = require("node:test");
const { chromium, webkit } = require("playwright");

const assets = path.resolve(__dirname, "../assets");

function serve(lang) {
  return async (route) => {
    const url = new URL(route.request().url());
    const json = (data) => route.fulfill({ json: data });
    if (url.pathname === "/boot.js") return route.fulfill({ contentType: "text/javascript", body: `window.bootPrefs = {lang:"${lang}",theme:"light",web:true};` });
    if (url.pathname === "/wails/runtime.js") return route.fulfill({ contentType: "text/javascript", body: "export const Window = {};" });
    if (url.pathname === "/api/state") return json({ agents: [], profiles: [], settings: { lang, theme: "light" } });
    if (url.pathname === "/api/providers") return json({ providers: [], presets: [], excluded: [], gateway: { running: true, window: true } });
    if (url.pathname === "/api/groups") return json({ groups: [] });
    if (url.pathname === "/api/plugins") return json({ plugins: [] });
    if (url.pathname.startsWith("/api/")) return json({});
    const file = path.join(assets, url.pathname === "/" ? "index.html" : url.pathname);
    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" }[path.extname(file)];
    await route.fulfill({ body: await fs.readFile(file), contentType });
  };
}

const words = {
  en: { cancel: "Cancel", remove: "Remove", asks: "Remove me@example.com?", told: "This account or key will stop being used for requests. You will need to add it again to use it." },
  zh: { cancel: "取消", remove: "移除", asks: "移除 me@example.com？", told: "此账户或密钥将不再用于请求。要再次使用，需要重新添加。" },
};

for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
  for (const lang of ["en", "zh"]) {
    const w = words[lang];
    const open = async (t, name) => {
      const browser = await (engine === "webkit" ? webkit.launch() : chromium.launch({ channel: "chromium" }));
      t.after(async () => {
        if (process.env.ARTIFACT_DIR) {
          await fs.mkdir(process.env.ARTIFACT_DIR, { recursive: true });
          await page.screenshot({ path: path.join(process.env.ARTIFACT_DIR, `${engine}-${lang}-${name}-confirm-enter.png`) });
        }
        await browser.close();
      });
      const page = await (await browser.newContext({ viewport: { width: 900, height: 760 }, reducedMotion: "reduce" })).newPage();
      page.setDefaultTimeout(5000);
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.route("**/*", serve(lang));
      await page.goto("http://magpie.test/");
      await page.waitForFunction(() => typeof confirmRemoval === "function");
      // A clock of the test's own draws the dialog's showModal at once, and
      // nothing else redraws the page between the steps.
      await page.clock.install();
      // What the Remove button asks before it sends, and what it saw.
      await page.evaluate((told) => {
        window.asked = [];
        window.ask = (name) => {
          const p = confirmRemoval(name, told);
          p.then((yes) => window.asked.push(yes));
          return p;
        };
        // The editor's own Enter handlers get no key of a dialog's.
        window.editorKeys = 0;
        document.addEventListener("keydown", () => { window.editorKeys++; }, false);
      }, w.told);
      const ask = async (name = "me@example.com") => {
        await page.evaluate((name) => { window.ask(name); }, name);
        const dialog = page.locator("dialog.action-confirm[open]");
        await dialog.waitFor();
        await page.clock.runFor(100);
        return dialog;
      };
      const asked = () => page.evaluate(() => window.asked);
      return { page, errors, ask, asked };
    };

    test(`${engine} ${lang}: Enter as the dialog opens cancels, and removes nothing`, async (t) => {
      const { page, errors, ask, asked } = await open(t, "enter");
      const dialog = await ask();
      assert.equal(await dialog.locator("h2").textContent(), w.asks);
      assert.equal(await dialog.locator("p").textContent(), w.told);
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), w.cancel, "Cancel has the focus when it opens");
      await page.keyboard.press("Enter");
      await dialog.waitFor({ state: "detached" });
      assert.deepEqual(await asked(), [false], "Enter is the focused Cancel, not a yes");
      assert.equal(await page.evaluate(() => window.editorKeys), 0, "the page behind saw no key");
      assert.equal(await page.locator("dialog.action-confirm").count(), 0);
      assert.deepEqual(errors, []);
    });

    test(`${engine} ${lang}: the Remove button is what removes`, async (t) => {
      const { page, errors, ask, asked } = await open(t, "button");
      const dialog = await ask();
      await dialog.getByRole("button", { name: w.remove, exact: true }).click();
      await dialog.waitFor({ state: "detached" });
      assert.deepEqual(await asked(), [true], "a click on Remove confirmed");
      assert.deepEqual(errors, []);
    });

    test(`${engine} ${lang}: Escape declines`, async (t) => {
      const { page, errors, ask, asked } = await open(t, "escape");
      const dialog = await ask();
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
      assert.deepEqual(await asked(), [false], "Escape kept it");
      assert.equal(await page.evaluate(() => window.editorKeys), 0, "the page behind saw no key");
      assert.deepEqual(errors, []);
    });
  }
}

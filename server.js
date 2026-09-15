import express from "express";
import { chromium } from "playwright";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "20kb" }));
app.use(express.static("public", { maxAge: "1h" }));

const BOOKFINDER_URL = "https://www.arbookfind.com/advanced.aspx?client=PBQN";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map();
let browserPromise;

function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
    }).catch(err => {
      browserPromise = undefined;
      throw err;
    });
  }
  return browserPromise;
}

function normalizeISBN(value = "") {
  return String(value).replace(/[^0-9Xx]/g, "").toUpperCase();
}

function validISBN10(isbn) {
  if (!/^\d{9}[\dX]$/.test(isbn)) return false;
  const sum = [...isbn].reduce((s, c, i) => s + (c === "X" ? 10 : Number(c)) * (10 - i), 0);
  return sum % 11 === 0;
}

function validISBN13(isbn) {
  if (!/^\d{13}$/.test(isbn)) return false;
  const sum = [...isbn.slice(0, 12)].reduce((s, c, i) => s + Number(c) * (i % 2 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === Number(isbn[12]);
}

function isValidISBN(isbn) {
  return isbn.length === 10 ? validISBN10(isbn) : isbn.length === 13 ? validISBN13(isbn) : false;
}

function firstMatch(text, regexes) {
  for (const re of regexes) {
    const m = text.match(re);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

function parseResultText(text, isbn, finalUrl) {
  const normalized = text.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ");
  const quizNumber = firstMatch(normalized, [
    /AR Quiz No\.?:?\s*#?([0-9]+)/i,
    /Quiz Number:?\s*#?([0-9]+)/i
  ]);
  const atosRaw = firstMatch(normalized, [
    /ATOS Book Level:?\s*([0-9.]+)/i,
    /\bBL:?\s*([0-9.]+)/i
  ]);
  const pointsRaw = firstMatch(normalized, [
    /AR Points:?\s*([0-9.]+)/i,
    /AR Pts:?\s*([0-9.]+)/i
  ]);
  const interest = firstMatch(normalized, [
    /Interest Level:?\s*([^\n\r]+)/i,
    /\bIL:?\s*([A-Z]+\+?)/
  ]);
  const wordRaw = firstMatch(normalized, [/Word Count:?\s*([0-9,]+)/i]);

  let title = null;
  const lines = normalized.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const quizIndex = lines.findIndex(line => /AR Quiz No\./i.test(line));
  if (quizIndex > 0) {
    // Work backwards from quiz data, excluding labels/navigation and numeric-only lines.
    for (let i = quizIndex - 1; i >= Math.max(0, quizIndex - 6); i--) {
      const candidate = lines[i];
      if (!/^(ISBN|Author|Language|Interest Level|ATOS|Book Level|AR Points|Word Count|Search|Home)\b/i.test(candidate)
          && !/^\d+$/.test(candidate)
          && candidate.length > 1) {
        title = candidate;
        break;
      }
    }
  }

  return {
    isbn,
    title,
    quizNumber,
    atos: atosRaw ? Number(atosRaw) : null,
    points: pointsRaw ? Number(pointsRaw) : null,
    interestLevel: interest,
    wordCount: wordRaw ? Number(wordRaw.replace(/,/g, "")) : null,
    source: "AR Bookfinder",
    sourceUrl: finalUrl,
    lookedUpAt: new Date().toISOString()
  };
}

async function findISBNInput(page) {
  const selectors = [
    'input[aria-label*="ISBN" i]',
    'input[placeholder*="ISBN" i]',
    'input[name*="isbn" i]',
    'input[id*="isbn" i]'
  ];
  for (const selector of selectors) {
    const loc = page.locator(selector).filter({ visible: true }).first();
    if (await loc.count()) return loc;
  }

  // Label-based fallback for ASP.NET markup.
  const labelled = page.getByLabel(/ISBN/i).first();
  if (await labelled.count()) return labelled;

  const handle = await page.evaluateHandle(() => {
    const all = [...document.querySelectorAll("input[type=text],input:not([type])")];
    return all.find(input => {
      const id = input.id || "";
      const name = input.name || "";
      const nearby = input.parentElement?.innerText || "";
      return /isbn/i.test(id + " " + name + " " + nearby);
    }) || null;
  });
  const el = handle.asElement();
  if (!el) throw new Error("Could not locate the ISBN field on AR Bookfinder.");
  return el;
}

async function submitSearch(page, input) {
  // Enter often submits the correct ASP.NET form and is the least brittle route.
  try {
    await input.press("Enter");
    await page.waitForLoadState("domcontentloaded", { timeout: 12000 }).catch(() => {});
    await page.waitForTimeout(700);
    if (/AR Quiz No\.|No Results|no books|0 results/i.test(await page.locator("body").innerText())) return;
  } catch {}

  const candidates = [
    page.getByRole("button", { name: /^search$/i }).first(),
    page.locator('input[type="submit"][value*="Search" i]').first(),
    page.locator('button:has-text("Search")').first(),
    page.locator('a:has-text("Search")').first()
  ];
  for (const c of candidates) {
    try {
      if (await c.count() && await c.isVisible()) {
        await c.click();
        await page.waitForLoadState("domcontentloaded", { timeout: 12000 }).catch(() => {});
        await page.waitForTimeout(700);
        return;
      }
    } catch {}
  }
  throw new Error("Could not submit the AR Bookfinder search form.");
}

async function performLookup(isbn) {
  const hit = cache.get(isbn);
  if (hit && Date.now() - hit.time < CACHE_TTL_MS) return { ...hit.value, cached: true };

  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128 Safari/537.36"
  });
  context.setDefaultTimeout(12000);
  let page;
  try {
    page = await context.newPage();
    await page.goto(BOOKFINDER_URL, { waitUntil: "domcontentloaded", timeout: 25000 });

    const input = await findISBNInput(page);
    await input.fill(isbn);
    await submitSearch(page, input);

    let text = await page.locator("body").innerText();

    // Follow one exact result to its detail page when possible.
    const detailLinks = page.locator('a[href*="bookdetail.aspx" i]');
    const count = await detailLinks.count();
    if (count === 1) {
      await detailLinks.first().click();
      await page.waitForLoadState("domcontentloaded", { timeout: 12000 }).catch(() => {});
      await page.waitForTimeout(500);
      text = await page.locator("body").innerText();
    }

    if (!/AR Quiz No\./i.test(text)) {
      const lower = text.toLowerCase();
      if (/no results|no books|0 results|did not match/.test(lower)) {
        const e = new Error("No Accelerated Reader quiz was found for that ISBN.");
        e.code = "NOT_FOUND";
        throw e;
      }
      const e = new Error("Bookfinder returned a page, but its AR fields could not be recognized.");
      e.code = "PARSE_CHANGED";
      throw e;
    }

    const value = parseResultText(text, isbn, page.url());
    cache.set(isbn, { time: Date.now(), value });
    return { ...value, cached: false };
  } finally {
    await context.close().catch(() => {});
  }
}

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, service: "scan-ar", version: "1.5.0", time: new Date().toISOString() });
});

app.get("/api/status", async (_req, res) => {
  try {
    const b = await getBrowser();
    res.json({ ok: true, browserConnected: b.isConnected(), cacheEntries: cache.size });
  } catch (e) {
    res.status(503).json({ ok: false, browserConnected: false, error: String(e?.message || e) });
  }
});

app.get("/api/ar/:isbn", async (req, res) => {
  const isbn = normalizeISBN(req.params.isbn);
  if (!isValidISBN(isbn)) {
    return res.status(400).json({ error: "Enter a valid ISBN-10 or ISBN-13 (checksum failed)." });
  }

  try {
    const result = await performLookup(isbn);
    return res.json(result);
  } catch (e) {
    console.error(`[lookup ${isbn}]`, e);
    if (e.code === "NOT_FOUND") return res.status(404).json({ error: e.message, isbn });
    if (e.code === "PARSE_CHANGED") return res.status(502).json({ error: e.message, code: e.code });
    return res.status(502).json({ error: "AR Bookfinder lookup failed.", detail: String(e?.message || e) });
  }
});

const port = Number(process.env.PORT || 3000);
const server = app.listen(port, "0.0.0.0", () => console.log(`Scan AR v1.5.0 listening on ${port}`));

async function shutdown() {
  console.log("Shutting down…");
  server.close();
  if (browserPromise) {
    try { (await browserPromise).close(); } catch {}
  }
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

import express from "express";
import fetch, { AbortError } from "node-fetch";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import rateLimit from "express-rate-limit";

const app = express();
app.use(express.json());

const td = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

const JUNK_SELECTORS = [
  "script", "style", "noscript", "iframe",
  "nav", "header", "footer",
  ".cookie-banner", ".ad", ".advertisement",
  "#cookie", "#banner", "#nav", "#footer", "#header",
];

const ALLOWED_MODES = ["reader", "full"];
const HTML_SIZE_LIMIT = 2_000_000; 

const limiter = rateLimit({
  windowMs: 60 * 1000, 
  max: 20, 
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

const cache = new Map();
function getCache(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiry) { cache.delete(key); return null; }
  return item.data;
}
function setCache(key, data, ttl = 60000) { 
  cache.set(key, { data, expiry: Date.now() + ttl });
}

async function fetchPage(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "htmdown/1.0" },
      signal: controller.signal,
    });

    if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      throw new Error(`Not an HTML page: ${contentType}`);
    }

    const html = await res.text();

    if (html.length > HTML_SIZE_LIMIT) throw new Error("Page too large");

    return html;
  } catch (err) {
    if (err instanceof AbortError) throw new Error("Request timeout");
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function extractMarkdown(html, url) {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;

  for (const selector of JUNK_SELECTORS) doc.querySelectorAll(selector).forEach(el => el.remove());

  const reader = new Readability(doc, { keepClasses: false, disableJSONLD: false });
  const article = reader.parse();

  if (!article || !article.content) throw new Error("Could not extract content! page may require JavaScript");

  return {
    title: article.title || null,
    byline: article.byline || null,
    siteName: article.siteName || null,
    excerpt: article.excerpt || null,
    markdown: td.turndown(article.content),
    length: article.length,
  };
}

function validateURL(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error("Invalid URL"); }

  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Only http and https URLs are supported");

  const host = parsed.hostname;
  if (host === "localhost" || host.startsWith("127.") || host.startsWith("10.") ||
      host.startsWith("192.168.") || host.startsWith("172.")) {
    throw new Error("Forbidden host");
  }

  return parsed;
}

app.get("/", async (req, res) => {
  const { url, mode = "reader" } = req.query;

  if (!url) return res.json({
    name: "htmdown",
    description: "Converts webpages to clean markdown",
    usage: {
      post: "POST / with JSON body { url: 'https://...', mode: 'reader|full' }",
      get: "GET /?url=https://...&mode=reader|full",
    },
  });

  if (!ALLOWED_MODES.includes(mode)) return res.status(400).json({ error: "Invalid mode" });

  try {
    validateURL(url);

    const cacheKey = `${mode}:${url}`;
    const cached = getCache(cacheKey);
    if (cached) return res.send(cached);

    const html = await fetchPage(url);

    if (mode === "full") {
      res.set("Content-Type", "text/html; charset=utf-8");
      setCache(cacheKey, html);
      return res.send(html);
    }

    const result = extractMarkdown(html, url);
    setCache(cacheKey, result);
    return res.json(result);

  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
});

app.post("/", async (req, res) => {
  const { url, mode = "reader" } = req.body;

  if (!url || typeof url !== "string") return res.status(400).json({ error: "Missing or invalid url field" });
  if (!ALLOWED_MODES.includes(mode)) return res.status(400).json({ error: "Invalid mode" });

  try {
    validateURL(url);

    const cacheKey = `${mode}:${url}`;
    const cached = getCache(cacheKey);
    if (cached) return res.send(cached);

    const html = await fetchPage(url);

    if (mode === "full") {
      res.set("Content-Type", "text/html; charset=utf-8");
      setCache(cacheKey, html);
      return res.send(html);
    }

    const result = extractMarkdown(html, url);
    setCache(cacheKey, result);
    return res.json(result);

  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`htmdown running on port ${PORT}`));

const SELF_URL = process.env.SELF_URL || `http://localhost:${PORT}/`;

setInterval(async () => {
  try {
    console.log(`[SELF-PING] Pinging ${SELF_URL}`);
    await fetch(SELF_URL);
  } catch (err) {
    console.warn("[SELF-PING] Error:", err.message);
  }
}, 10 * 60 * 1000);

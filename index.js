import express from "express";
import fetch from "node-fetch";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";

const app = express();
app.use(express.json());

const td = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

// Remove junk elements before readability gets to them
const JUNK_SELECTORS = [
  "script", "style", "noscript", "iframe",
  "nav", "header", "footer",
  ".cookie-banner", ".ad", ".advertisement",
  "#cookie", "#banner", "#nav", "#footer", "#header",
];

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
    },
    redirect: "follow",
    timeout: 10000,
  });

  if (!res.ok) {
    throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  }

  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
    throw new Error(`Not an HTML page: ${contentType}`);
  }

  return await res.text();
}

function extractMarkdown(html, url) {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;

  // Strip junk
  for (const selector of JUNK_SELECTORS) {
    doc.querySelectorAll(selector).forEach(el => el.remove());
  }

  const reader = new Readability(doc, {
    keepClasses: false,
    disableJSONLD: false,
  });

  const article = reader.parse();

  if (!article || !article.content) {
    throw new Error("Could not extract content — page may require JavaScript");
  }

  const markdown = td.turndown(article.content);

  return {
    title: article.title || null,
    byline: article.byline || null,
    siteName: article.siteName || null,
    excerpt: article.excerpt || null,
    markdown,
    length: article.length,
  };
}

// POST { "url": "https://..." }
app.post("/", async (req, res) => {
  const { url } = req.body;

  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "Missing or invalid url field" });
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return res.status(400).json({ error: "Invalid URL" });
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    return res.status(400).json({ error: "Only http and https URLs are supported" });
  }

  try {
    const html = await fetchPage(url);
    const result = extractMarkdown(html, url);
    return res.json(result);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
});

// GET /?url=https://...  (convenient for quick testing)
app.get("/", async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.json({
      name: "htmdown",
      description: "Converts any webpage to clean markdown for LLM consumption",
      usage: {
        post: "POST / with JSON body { url: 'https://...' }",
        get: "GET /?url=https://...",
      },
    });
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return res.status(400).json({ error: "Invalid URL" });
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    return res.status(400).json({ error: "Only http and https URLs are supported" });
  }

  try {
    const html = await fetchPage(url);
    const result = extractMarkdown(html, url);
    return res.json(result);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`htmdown running on port ${PORT}`);
});
      

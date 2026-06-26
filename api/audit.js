/**
 * Free SEO Audit Tool — Backend API
 * Platform: Vercel Serverless Function   (file path in your repo: /api/audit.js)
 * Runtime:  Node.js 18+   (uses the built-in global fetch & AbortController)
 *
 * POST body:  { "url": "https://example.com", "keyword": "roofers", "email": "user@x.com" }
 * Returns:    a structured SEO report (see analyzeHtml below)
 *
 * Dependency: cheerio   (see package.json)
 */

const cheerio = require('cheerio');

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */
const FETCH_TIMEOUT_MS = 10_000;
const MAX_HTML_BYTES = 5_000_000; // 5 MB safety cap
const USER_AGENT =
  'Mozilla/5.0 (compatible; OutpostSEOAuditBot/1.0; +https://theoutpost.agency)';

/* ------------------------------------------------------------------ */
/*  CORS — strict allowlist. Only these origins may call this API.     */
/* ------------------------------------------------------------------ */
const ALLOWED_ORIGINS = [
  'https://theoutpost.agency',
  'https://theoutpost.vibepreview.com',
];

// Returns true if the request's Origin is allowed (and sets the CORS
// headers for it). Returns false if the Origin is missing or not on
// the allowlist — caller must reject the request in that case.
function setCors(req, res) {
  const origin = req.headers.origin;
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
    return false;
  }
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
  return true;
}

/* ------------------------------------------------------------------ */
/*  Text helpers                                                       */
/* ------------------------------------------------------------------ */
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Lightweight syllable heuristic — accurate enough for a Flesch estimate
// and keeps the function dependency-free at runtime (only cheerio needed).
function countSyllables(word) {
  word = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!word) return 0;
  if (word.length <= 3) return 1;
  word = word
    .replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '') // drop common silent endings
    .replace(/^y/, '');
  const groups = word.match(/[aeiouy]{1,2}/g);
  return groups ? groups.length : 1;
}

function fleschLabel(score) {
  if (score >= 90) return 'Very Easy';
  if (score >= 80) return 'Easy';
  if (score >= 70) return 'Fairly Easy';
  if (score >= 60) return 'Standard';
  if (score >= 50) return 'Fairly Difficult';
  if (score >= 30) return 'Difficult';
  return 'Very Difficult';
}

function letterGrade(score) {
  if (score >= 90) return 'A';
  if (score >= 85) return 'A-';
  if (score >= 80) return 'B+';
  if (score >= 75) return 'B';
  if (score >= 70) return 'B-';
  if (score >= 65) return 'C+';
  if (score >= 60) return 'C';
  if (score >= 55) return 'C-';
  if (score >= 50) return 'D';
  return 'F';
}

const round = (n, d = 2) => {
  const f = 10 ** d;
  return Math.round((n + Number.EPSILON) * f) / f;
};

/* ------------------------------------------------------------------ */
/*  Core analysis — a pure function so it's trivial to unit test.      */
/* ------------------------------------------------------------------ */
function analyzeHtml(html, { url = '', keyword = '' } = {}) {
  const $ = cheerio.load(html);

  // Pull metadata BEFORE stripping anything.
  const title = ($('title').first().text() || '').trim();
  const description = ($('meta[name="description"]').attr('content') || '').trim();
  const h1Elements = $('h1');
  const h1 = (h1Elements.first().text() || '').trim();
  const h1Count = h1Elements.length;
  const imageCount = $('img').length;
  const imagesWithAlt = $('img').filter(
    (_, el) => ($(el).attr('alt') || '').trim().length > 0
  ).length;
  const linkCount = $('a').length;
  const paragraphCount = $('p').length;

  // Remove non-content nodes so they don't pollute word/sentence counts.
  $('script, style, noscript, template, svg').remove();

  const bodyText = ($('body').text() || '').replace(/\s+/g, ' ').trim();
  const words = bodyText ? bodyText.split(/\s+/) : [];
  const wordCount = words.length;

  const sentences = bodyText
    .split(/[.!?]+(?:\s|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
  const sentenceCount = Math.max(sentences.length, 1);

  const totalSyllables = words.reduce((sum, w) => sum + countSyllables(w), 0);

  /* ---------- Keyword ---------- */
  const kw = keyword.trim().toLowerCase();
  let keywordBlock = null;
  if (kw) {
    const occurrences =
      (bodyText.match(new RegExp(`\\b${escapeRegExp(kw)}\\b`, 'gi')) || []).length;
    keywordBlock = {
      target: keyword.trim(),
      occurrences,
      density: wordCount ? round((occurrences / wordCount) * 100, 2) : 0,
      inTitle: title.toLowerCase().includes(kw),
      inDescription: description.toLowerCase().includes(kw),
      inH1: h1.toLowerCase().includes(kw),
    };
  }

  /* ---------- Readability (Flesch Reading Ease) ---------- */
  const avgSentenceLength = wordCount ? wordCount / sentenceCount : 0;
  const avgSyllablesPerWord = wordCount ? totalSyllables / wordCount : 0;
  const avgParagraphLength = paragraphCount ? wordCount / paragraphCount : wordCount;

  let fleschScore = 0;
  if (wordCount > 0) {
    fleschScore =
      206.835 - 1.015 * avgSentenceLength - 84.6 * avgSyllablesPerWord;
    fleschScore = Math.max(0, Math.min(100, fleschScore));
  }
  fleschScore = round(fleschScore, 1);

  /* ---------- Scores ---------- */
  const titleLength = title.length;
  const descLength = description.length;
  const altRatio = imageCount === 0 ? 1 : imagesWithAlt / imageCount;

  // Health score (0–100): on-page SEO fundamentals.
  let health = 0;
  if (title) health += titleLength >= 30 && titleLength <= 60 ? 20 : 12;
  if (description) health += descLength >= 120 && descLength <= 160 ? 18 : 10;
  if (h1Count === 1) health += 15;
  else if (h1Count > 1) health += 7;
  health += Math.round(altRatio * 15);
  if (wordCount >= 600) health += 12;
  else if (wordCount >= 300) health += 8;
  else if (wordCount >= 100) health += 4;
  if (linkCount >= 5) health += 10;
  else if (linkCount >= 1) health += 5;
  if (keywordBlock) {
    if (keywordBlock.inTitle) health += 4;
    if (keywordBlock.inDescription) health += 3;
    if (keywordBlock.inH1) health += 3;
  } else {
    health += 10; // don't penalize when no keyword was supplied
  }
  health = Math.max(0, Math.min(100, health));

  // Content quality score (0–100) → letter grade.
  let contentScore = 0;
  if (wordCount >= 1000) contentScore += 35;
  else if (wordCount >= 600) contentScore += 28;
  else if (wordCount >= 300) contentScore += 18;
  else contentScore += 8;
  if (paragraphCount >= 5) contentScore += 20;
  else if (paragraphCount >= 2) contentScore += 12;
  else contentScore += 4;
  contentScore += Math.round(altRatio * 20);
  if (fleschScore >= 50 && fleschScore <= 70) contentScore += 25;
  else if (fleschScore >= 30 && fleschScore < 50) contentScore += 15;
  else if (fleschScore > 70) contentScore += 18;
  else contentScore += 8;
  contentScore = Math.max(0, Math.min(100, contentScore));

  /* ---------- Recommendations ---------- */
  const recommendations = [];

  if (!title) {
    recommendations.push({ type: 'error', message: 'Missing <title> tag. Add a unique, descriptive page title.' });
  } else if (titleLength < 30 || titleLength > 60) {
    recommendations.push({ type: 'warning', message: `Title is ${titleLength} characters. Aim for 30–60 so it isn't truncated in search results.` });
  }

  if (!description) {
    recommendations.push({ type: 'error', message: 'Missing meta description. Add one (120–160 characters) to lift click-through from search.' });
  } else if (descLength < 120 || descLength > 160) {
    recommendations.push({ type: 'warning', message: `Meta description is ${descLength} characters. Aim for 120–160.` });
  }

  if (h1Count === 0) {
    recommendations.push({ type: 'error', message: 'No <h1> found. Add a single, keyword-relevant H1.' });
  } else if (h1Count > 1) {
    recommendations.push({ type: 'warning', message: `Found ${h1Count} <h1> tags. Use exactly one per page.` });
  }

  if (imageCount > 0 && imagesWithAlt < imageCount) {
    recommendations.push({ type: 'warning', message: `${imageCount - imagesWithAlt} of ${imageCount} images are missing alt text. Add descriptive alt attributes.` });
  }

  if (wordCount < 300) {
    recommendations.push({ type: 'warning', message: `Only ${wordCount} words on the page. Thin content struggles to rank — aim for 600+ on key pages.` });
  }

  if (keywordBlock) {
    if (!keywordBlock.inTitle) recommendations.push({ type: 'warning', message: `Target keyword "${keywordBlock.target}" is not in the title tag.` });
    if (!keywordBlock.inDescription) recommendations.push({ type: 'warning', message: `Target keyword "${keywordBlock.target}" is missing from the meta description.` });
    if (!keywordBlock.inH1) recommendations.push({ type: 'warning', message: `Target keyword "${keywordBlock.target}" is not in the H1.` });
    if (keywordBlock.density < 0.5) recommendations.push({ type: 'error', message: `Keyword density is low (${keywordBlock.density}%). Aim for ~1–2%.` });
    else if (keywordBlock.density > 3) recommendations.push({ type: 'warning', message: `Keyword density is high (${keywordBlock.density}%). Ease off to avoid keyword stuffing.` });
  }

  if (fleschScore < 50 && wordCount > 0) {
    recommendations.push({ type: 'warning', message: `Readability is "${fleschLabel(fleschScore)}" (Flesch ${fleschScore}). Shorten sentences and simplify wording.` });
  }

  if (recommendations.length === 0) {
    recommendations.push({ type: 'success', message: 'Nice work — no major on-page issues detected.' });
  }

  /* ---------- Final report ---------- */
  return {
    success: true,
    targetUrl: url,
    scores: {
      health,
      readability: fleschScore,
      content: letterGrade(contentScore),
    },
    metrics: {
      metadata: {
        title,
        titleLength,
        description,
        descriptionLength: descLength,
        h1,
        h1Count,
      },
      content: {
        wordCount,
        paragraphCount,
        sentenceCount,
        imageCount,
        imagesWithAlt,
        linkCount,
      },
      keyword: keywordBlock, // null when no keyword supplied
      readability: {
        fleschScore,
        label: fleschLabel(fleschScore),
        avgSentenceLength: round(avgSentenceLength, 1),
        avgParagraphLength: round(avgParagraphLength, 1),
        avgSyllablesPerWord: round(avgSyllablesPerWord, 2),
      },
    },
    recommendations,
  };
}

/* ------------------------------------------------------------------ */
/*  Lead-capture hook — wire to GoHighLevel (or any CRM) when ready.   */
/* ------------------------------------------------------------------ */
async function captureLead({ email, url, keyword }) {
  // Add your GHL inbound webhook URL as an env var:
  //   Vercel → Project → Settings → Environment Variables → GHL_WEBHOOK_URL
  const webhook = process.env.GHL_WEBHOOK_URL;
  if (!webhook) return; // no-op until configured

  await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      source: 'Free SEO Audit Tool',
      audited_url: url,
      target_keyword: keyword,
    }),
  });
}

/* ------------------------------------------------------------------ */
/*  HTTP handler                                                       */
/* ------------------------------------------------------------------ */
async function handler(req, res) {
  const corsOk = setCors(req, res);
  if (!corsOk) {
    return res.status(403).json({ success: false, error: 'Forbidden: origin not allowed.' });
  }

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed. Use POST.' });
  }

  // Vercel usually parses JSON bodies; guard for string/empty bodies too.
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const { url: rawUrl, keyword = '', email = '' } = body;

  if (!rawUrl || typeof rawUrl !== 'string') {
    return res.status(400).json({ success: false, error: 'A "url" is required in the request body.' });
  }

  // Normalize + validate the URL.
  let targetUrl = rawUrl.trim();
  if (!/^https?:\/\//i.test(targetUrl)) targetUrl = 'https://' + targetUrl;
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return res.status(400).json({ success: false, error: `"${rawUrl}" is not a valid URL.` });
  }

  // Fetch the HTML with a hard timeout.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let html;
  try {
    const resp = await fetch(parsed.toString(), {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
    });

    if (!resp.ok) {
      clearTimeout(timer);
      return res.status(502).json({ success: false, error: `The site responded with status ${resp.status}.` });
    }

    const contentType = resp.headers.get('content-type') || '';
    if (!contentType.includes('html')) {
      clearTimeout(timer);
      return res.status(415).json({ success: false, error: `Expected an HTML page but received "${contentType || 'unknown content type'}".` });
    }

    html = await resp.text();
    if (html.length > MAX_HTML_BYTES) html = html.slice(0, MAX_HTML_BYTES);
  } catch (err) {
    clearTimeout(timer);
    const msg =
      err.name === 'AbortError'
        ? 'The site took too long to respond (timeout).'
        : 'Could not reach the site. It may be down or blocking automated requests.';
    return res.status(502).json({ success: false, error: msg });
  }
  clearTimeout(timer);

  // Analyze.
  let report;
  try {
    report = analyzeHtml(html, { url: parsed.toString(), keyword });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to analyze the page content.' });
  }

  // Optional lead capture — fire-and-forget so it never blocks the response.
  if (email) {
    captureLead({ email, url: parsed.toString(), keyword }).catch(() => {});
  }

  return res.status(200).json(report);
}

module.exports = handler;
module.exports.analyzeHtml = analyzeHtml;

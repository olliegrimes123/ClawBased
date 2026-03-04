/**
 * ============================================================
 * ClawBased — OSINT Ingestion Module
 * ============================================================
 *
 * OpenClaw Skill: @browser
 *
 * This module is the agent's eyes. It reaches across the internet
 * and pulls in intelligence from multiple vectors:
 *
 *   - Global news (RSS feeds from BBC, Reuters, NYT, Al Jazeera)
 *   - Crypto market data (Fear & Greed Index, top coins, prices)
 *   - OSINT signal extraction (keyword-weighted relevance scoring)
 *
 * Output: A structured "Timeline Snapshot" — a single JSON object
 * representing the current state of reality as the Oracle perceives it.
 *
 * @module skills/osint_ingestion
 * @requires axios
 * @requires rss-parser
 * @requires config/defaults.json
 */

'use strict';

const axios = require('axios');
const RSSParser = require('rss-parser');
const config = require('../config/defaults.json');
const logger = require('../core/logger');

// ── Constants ──────────────────────────────────────────────
const INGESTION_CONFIG = config.ingestion;
const OSINT_KEYWORDS = INGESTION_CONFIG.osint_keywords;
const MAX_ARTICLES = INGESTION_CONFIG.max_articles_per_feed;
const DEDUP_WINDOW_MS = INGESTION_CONFIG.dedup_window_hours * 60 * 60 * 1000;

/**
 * In-memory deduplication cache.
 * Maps article URL hashes to timestamps for rolling-window dedup.
 * In production, this would be backed by a persistent store.
 * @type {Map<string, number>}
 */
const dedupCache = new Map();

// ── RSS Parser Instance ────────────────────────────────────
const rssParser = new RSSParser({
  timeout: 15000,
  headers: {
    'User-Agent': 'ClawBased/1.0 TimelineIngestion',
    Accept: 'application/rss+xml, application/xml, text/xml',
  },
  maxRedirects: 3,
});

// ============================================================
// SECTION 1: News Ingestion
// ============================================================

/**
 * Compute a simple hash for deduplication purposes.
 * Not cryptographic — just needs to be fast and collision-resistant
 * enough for URL dedup within a 24-hour window.
 *
 * @param {string} str - The string to hash
 * @returns {string} A hex-like hash string
 */
function quickHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36);
}

/**
 * Purge expired entries from the dedup cache.
 * Called before each ingestion cycle to prevent unbounded growth.
 */
function purgeExpiredDedup() {
  const cutoff = Date.now() - DEDUP_WINDOW_MS;
  let purged = 0;

  for (const [key, timestamp] of dedupCache.entries()) {
    if (timestamp < cutoff) {
      dedupCache.delete(key);
      purged++;
    }
  }

  if (purged > 0) {
    logger.debug(`[DEDUP] Purged ${purged} expired entries from timeline cache`);
  }
}

/**
 * Calculate OSINT relevance score for a given text.
 * Scans the text against the configured keyword list and returns
 * a normalized score between 0.0 and 1.0.
 *
 * @param {string} text - The text to score (title + summary)
 * @returns {number} Relevance score [0.0, 1.0]
 */
function calculateRelevanceScore(text) {
  if (!text || typeof text !== 'string') return 0;

  const normalizedText = text.toLowerCase();
  let hits = 0;

  for (const keyword of OSINT_KEYWORDS) {
    if (normalizedText.includes(keyword.toLowerCase())) {
      hits++;
    }
  }

  // Normalize against total keyword count, cap at 1.0
  return Math.min(hits / Math.max(OSINT_KEYWORDS.length * 0.3, 1), 1.0);
}

/**
 * Ingest articles from a single RSS feed.
 * Applies deduplication, relevance scoring, and article limiting.
 *
 * @param {string} feedUrl - The RSS feed URL to parse
 * @returns {Promise<Array<Object>>} Parsed and scored articles
 */
async function ingestFeed(feedUrl) {
  try {
    const feed = await rssParser.parseURL(feedUrl);
    const articles = [];

    const items = (feed.items || []).slice(0, MAX_ARTICLES);

    for (const item of items) {
      const url = item.link || item.guid || '';
      const hash = quickHash(url);

      // ── Dedup check ──
      if (dedupCache.has(hash)) {
        continue;
      }
      dedupCache.set(hash, Date.now());

      // ── Build article object ──
      const title = (item.title || '').trim();
      const summary = (item.contentSnippet || item.content || '').trim();
      const combinedText = `${title} ${summary}`;

      const article = {
        source: feed.title || feedUrl,
        title,
        summary: summary.substring(0, 500),
        url,
        published: item.pubDate || item.isoDate || new Date().toISOString(),
        relevance: calculateRelevanceScore(combinedText),
      };

      articles.push(article);
    }

    logger.debug(
      `[INGEST] ${feed.title || feedUrl}: ${articles.length} new articles ingested`
    );

    return articles;
  } catch (err) {
    logger.warn(
      `[INGEST] Failed to parse feed ${feedUrl}: ${err.message}`
    );
    return [];
  }
}

/**
 * Ingest all configured RSS feeds in parallel.
 * Returns a flat array of all articles, sorted by relevance (descending).
 *
 * @returns {Promise<Array<Object>>} All ingested articles
 */
async function ingestAllFeeds() {
  const feedUrls = INGESTION_CONFIG.news_rss_feeds;

  logger.info(
    `[INGEST] Scanning ${feedUrls.length} news feeds across the timeline...`
  );

  const feedPromises = feedUrls.map((url) => ingestFeed(url));
  const results = await Promise.allSettled(feedPromises);

  const allArticles = [];
  let failedFeeds = 0;

  for (const result of results) {
    if (result.status === 'fulfilled') {
      allArticles.push(...result.value);
    } else {
      failedFeeds++;
    }
  }

  if (failedFeeds > 0) {
    logger.warn(
      `[INGEST] ${failedFeeds}/${feedUrls.length} feeds experienced timeline distortion`
    );
  }

  // Sort by relevance score, highest first
  allArticles.sort((a, b) => b.relevance - a.relevance);

  return allArticles;
}

// ============================================================
// SECTION 2: Crypto Market Data Ingestion
// ============================================================

/**
 * Fetch the current Fear & Greed Index from Alternative.me.
 * This is a key sentiment indicator for the crypto timeline.
 *
 * @returns {Promise<Object>} Fear & Greed data
 */
async function fetchFearGreedIndex() {
  try {
    const { data } = await axios.get(
      INGESTION_CONFIG.crypto_endpoints.fear_greed,
      { timeout: 10000 }
    );

    const fng = data?.data?.[0];

    if (!fng) {
      throw new Error('Malformed Fear & Greed response');
    }

    return {
      value: parseInt(fng.value, 10),
      classification: fng.value_classification,
      timestamp: fng.timestamp,
      signal_strength: parseInt(fng.value, 10) <= 25 || parseInt(fng.value, 10) >= 75
        ? 'EXTREME'
        : 'MODERATE',
    };
  } catch (err) {
    logger.warn(`[CRYPTO] Fear & Greed Index extraction failed: ${err.message}`);
    return { value: null, classification: 'UNAVAILABLE', signal_strength: 'UNKNOWN' };
  }
}

/**
 * Fetch top cryptocurrency market data from CryptoCompare.
 *
 * @returns {Promise<Array<Object>>} Top coin snapshots
 */
async function fetchTopCoins() {
  try {
    const apiKey = process.env.CRYPTOCOMPARE_API_KEY || '';
    const url = INGESTION_CONFIG.crypto_endpoints.top_coins;

    const { data } = await axios.get(url, {
      timeout: 10000,
      headers: apiKey ? { Authorization: `Apikey ${apiKey}` } : {},
    });

    if (!data?.Data) {
      throw new Error('Malformed top coins response');
    }

    return data.Data.map((coin) => {
      const info = coin.CoinInfo || {};
      const raw = coin.RAW?.USD || {};

      return {
        symbol: info.Name,
        name: info.FullName,
        price_usd: raw.PRICE || 0,
        market_cap: raw.MKTCAP || 0,
        change_24h_pct: raw.CHANGEPCT24HOUR || 0,
        volume_24h: raw.TOTALVOLUME24HTO || 0,
      };
    });
  } catch (err) {
    logger.warn(`[CRYPTO] Top coins extraction failed: ${err.message}`);
    return [];
  }
}

/**
 * Fetch current BTC spot prices across multiple fiat pairs.
 *
 * @returns {Promise<Object>} BTC price data
 */
async function fetchBTCPrice() {
  try {
    const { data } = await axios.get(
      INGESTION_CONFIG.crypto_endpoints.btc_price,
      { timeout: 10000 }
    );

    return {
      BTC_USD: data.USD || null,
      BTC_EUR: data.EUR || null,
      fetched_at: new Date().toISOString(),
    };
  } catch (err) {
    logger.warn(`[CRYPTO] BTC price extraction failed: ${err.message}`);
    return { BTC_USD: null, BTC_EUR: null, fetched_at: null };
  }
}

// ============================================================
// SECTION 3: Timeline Snapshot Assembly
// ============================================================

/**
 * Compute aggregate signal metrics from ingested articles.
 * These metrics feed into the Nostradamus Engine's weighting system.
 *
 * @param {Array<Object>} articles - Scored articles from RSS ingestion
 * @returns {Object} Aggregate signal report
 */
function computeSignalMetrics(articles) {
  if (!articles.length) {
    return {
      total_signals: 0,
      high_relevance_count: 0,
      avg_relevance: 0,
      top_keywords: [],
      threat_level: 'UNKNOWN',
    };
  }

  const highRelevance = articles.filter((a) => a.relevance >= 0.5);
  const avgRelevance =
    articles.reduce((sum, a) => sum + a.relevance, 0) / articles.length;

  // Count keyword frequency across all articles
  const keywordFreq = {};
  for (const article of articles) {
    const text = `${article.title} ${article.summary}`.toLowerCase();
    for (const kw of OSINT_KEYWORDS) {
      if (text.includes(kw.toLowerCase())) {
        keywordFreq[kw] = (keywordFreq[kw] || 0) + 1;
      }
    }
  }

  // Sort keywords by frequency
  const topKeywords = Object.entries(keywordFreq)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([keyword, count]) => ({ keyword, count }));

  // Determine threat level based on signal density
  let threatLevel = 'LOW';
  if (highRelevance.length >= 10) threatLevel = 'CRITICAL';
  else if (highRelevance.length >= 5) threatLevel = 'ELEVATED';
  else if (highRelevance.length >= 2) threatLevel = 'MODERATE';

  return {
    total_signals: articles.length,
    high_relevance_count: highRelevance.length,
    avg_relevance: Math.round(avgRelevance * 1000) / 1000,
    top_keywords: topKeywords,
    threat_level: threatLevel,
  };
}

/**
 * Main ingestion entry point.
 * Orchestrates all data collection and assembles the Timeline Snapshot.
 *
 * This is the function invoked by the heartbeat loop.
 * It runs all ingestion tasks in parallel, then merges the results
 * into a single structured object that the Nostradamus Engine consumes.
 *
 * @returns {Promise<Object>} The complete Timeline Snapshot
 */
async function ingestTimeline() {
  logger.info('[INGEST] ══════════════════════════════════════');
  logger.info('[INGEST] Timeline ingestion cycle initiated');
  logger.info('[INGEST] The Oracle opens its eyes...');
  logger.info('[INGEST] ══════════════════════════════════════');

  // Purge stale dedup entries before fresh ingestion
  purgeExpiredDedup();

  const startTime = Date.now();

  // ── Run all ingestion tasks in parallel ──
  const [articles, fearGreed, topCoins, btcPrice] = await Promise.all([
    ingestAllFeeds(),
    fetchFearGreedIndex(),
    fetchTopCoins(),
    fetchBTCPrice(),
  ]);

  // ── Compute aggregate signals ──
  const signalMetrics = computeSignalMetrics(articles);

  // ── Assemble the Timeline Snapshot ──
  const snapshot = {
    meta: {
      agent: config.agent.name,
      version: config.agent.version,
      snapshot_id: `TS-${Date.now().toString(36).toUpperCase()}`,
      generated_at: new Date().toISOString(),
      ingestion_duration_ms: Date.now() - startTime,
    },
    signals: {
      metrics: signalMetrics,
      articles: articles.slice(0, 30), // Top 30 by relevance for LLM context window
    },
    crypto: {
      fear_greed: fearGreed,
      top_coins: topCoins,
      btc: btcPrice,
    },
  };

  logger.info(
    `[INGEST] Timeline snapshot assembled: ${snapshot.meta.snapshot_id}`
  );
  logger.info(
    `[INGEST] Signals: ${signalMetrics.total_signals} total, ` +
    `${signalMetrics.high_relevance_count} high-relevance`
  );
  logger.info(
    `[INGEST] Threat level: ${signalMetrics.threat_level}`
  );
  logger.info(
    `[INGEST] Crypto sentiment: ${fearGreed.classification} (${fearGreed.value}/100)`
  );
  logger.info(
    `[INGEST] Duration: ${snapshot.meta.ingestion_duration_ms}ms`
  );

  return snapshot;
}

// ── Module Exports ─────────────────────────────────────────
module.exports = {
  ingestTimeline,
  ingestAllFeeds,
  fetchFearGreedIndex,
  fetchTopCoins,
  fetchBTCPrice,
  calculateRelevanceScore,
  computeSignalMetrics,
};

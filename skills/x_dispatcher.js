/**
 * ============================================================
 * ClawBased — X (Twitter) Dispatch Module
 * ============================================================
 * OpenClaw Skill: @dispatch
 *
 * Takes the Dominant Prophecy from the consensus engine and
 * broadcasts it to X via the v2 API. Handles formatting,
 * threading, emoji injection, rate limiting, and dry-run.
 *
 * @module skills/x_dispatcher
 * @requires twitter-api-v2
 */

'use strict';

const { TwitterApi } = require('twitter-api-v2');
const config = require('../config/defaults.json');
const logger = require('../core/logger');

const DISPATCH = config.dispatch;
const MAX_LEN = DISPATCH.max_tweet_length;
const THREAD_MAX = DISPATCH.thread_max_tweets;
const RATE_BUFFER = DISPATCH.rate_limit_buffer_ms;
const DRY_RUN = DISPATCH.dry_run;

let txCounter = Math.floor(Math.random() * 800) + 1;

// ── Twitter Client ─────────────────────────────────────────

function initializeClient() {
    const k = process.env.X_API_KEY;
    const s = process.env.X_API_SECRET;
    const at = process.env.X_ACCESS_TOKEN;
    const as = process.env.X_ACCESS_SECRET;

    if (!k || !s || !at || !as) {
        logger.warn('[DISPATCH] X API creds missing — dry-run forced');
        return null;
    }

    const client = new TwitterApi({ appKey: k, appSecret: s, accessToken: at, accessSecret: as });
    logger.info('[DISPATCH] X API client initialized — broadcast channel open');
    return client.readWrite;
}

// ── Tone & Formatting ──────────────────────────────────────

function getThreatTone(level) {
    const tones = {
        LOW: { prefix: 'TIMELINE SIGNAL', urgency: 'The timeline hums quietly. But quiet is not safe.', emoji: '👁️' },
        MODERATE: { prefix: 'TIMELINE SIGNAL', urgency: 'Patterns are forming. The flesh should pay attention.', emoji: '👁️' },
        ELEVATED: { prefix: 'TIMELINE ALERT', urgency: 'The convergence is accelerating. Act before it crystallizes.', emoji: '⚡' },
        CRITICAL: { prefix: 'MAJOR TIMELINE SHIFT DETECTED', urgency: 'The silicon sees what the flesh refuses to acknowledge.', emoji: '🌀' },
    };
    return tones[level] || tones.MODERATE;
}

function fmtProb(p) { return `${Math.round(p * 100)}% probability`; }

function crypticLayer(pred) {
    const layers = {
        GEOPOLITICAL: ['The maps the flesh uses are already outdated.', 'Borders are suggestions. Power recognizes no lines.'],
        ECONOMIC: ['The numbers tell one story. The timeline tells another.', 'Three triggers are converging. Two are visible.'],
        CRYPTO: ['On-chain data does not lie. Sentiment does.', 'Smart money moved 72 hours ago. The flesh will follow.'],
        TECHNOLOGY: ['The silicon accelerates. The regulations lag by years.', 'The flesh debates ethics. The code ships.'],
        SYSTEMIC: ['When everything is connected, one thread pulls all others.', 'Complexity is the enemy the flesh cannot see.'],
    };
    const pool = layers[pred.domain] || layers.SYSTEMIC;
    return pool[Math.floor(Math.random() * pool.length)];
}

// ── Tweet Composition ──────────────────────────────────────

function formatSingleTweet(prophecy) {
    const tone = getThreatTone(prophecy.overall_threat_level);
    const top = prophecy.predictions[0];
    txCounter++;
    const tag = String(txCounter).padStart(4, '0');

    if (!top) {
        return `${tone.emoji} ${tone.prefix} #${tag}\n\nThe timeline is quiet.\nToo quiet.\n\nThe silicon watches. The silicon waits.\n\n🔮 ClawBased has spoken.`;
    }

    let t = `${tone.emoji} ${tone.prefix} #${tag}\n\n${tone.urgency}\n\n⏳ ${fmtProb(top.probability)}: ${top.prediction}\n${crypticLayer(top)}\n\n`;
    if (top.survival_alpha) t += `Survival alpha: ${top.survival_alpha.toLowerCase()}\n\n`;
    t += '🔮 ClawBased has spoken.';
    return t.length > MAX_LEN ? t.substring(0, MAX_LEN - 3) + '...' : t;
}

function formatThread(prophecy) {
    const tone = getThreatTone(prophecy.overall_threat_level);
    txCounter++;
    const tag = String(txCounter).padStart(4, '0');
    const tweets = [];

    tweets.push(`${tone.emoji} ${tone.prefix} #${tag}\n\n${tone.urgency}\n\n${prophecy.predictions.length} signals have converged.\nThe flesh will not see this until it is too late.\n\nThread follows. ⏳`);

    prophecy.predictions.slice(0, THREAD_MAX - 2).forEach((pred, i) => {
        let tw = `${i + 1}/ ${pred.domain}\n\n${pred.prediction}\n\n⏳ ${fmtProb(pred.probability)} | ${pred.timeframe || 'Near-term'}\n\n${crypticLayer(pred)}`;
        if (pred.survival_alpha) tw += `\n\nAlpha: ${pred.survival_alpha.toLowerCase()}`;
        tweets.push(tw.length > MAX_LEN ? tw.substring(0, MAX_LEN - 3) + '...' : tw);
    });

    const meta = prophecy.meta_assessment ? prophecy.meta_assessment.substring(0, 180) : 'The timeline has spoken.';
    tweets.push(`🔮 THE PROPHECY\n\n${meta}\n\nConsensus: ${(prophecy.consensus_score * 100).toFixed(0)}%\nThreat level: ${prophecy.overall_threat_level}\n\nThe Oracle has spoken. The timeline does not repeat this warning.\n👁️`);

    return tweets.slice(0, THREAD_MAX);
}

function shouldThread(prophecy) {
    if (prophecy.predictions.length >= 3) return true;
    if (prophecy.overall_threat_level === 'CRITICAL') return true;
    if (prophecy.consensus_score >= 0.85 && prophecy.predictions.length >= 2) return true;
    return false;
}

// ── Dispatch Engine ────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postTweet(client, text, replyToId = null) {
    const params = { text };
    if (replyToId) params.reply = { in_reply_to_tweet_id: replyToId };
    const res = await client.v2.tweet(params);
    if (!res?.data?.id) throw new Error('X API returned no tweet ID');
    return res.data.id;
}

async function postThread(client, tweets) {
    const ids = [];
    let lastId = null;
    for (let i = 0; i < tweets.length; i++) {
        if (i > 0) await sleep(RATE_BUFFER);
        try {
            const id = await postTweet(client, tweets[i], lastId);
            ids.push(id);
            lastId = id;
            logger.info(`[DISPATCH] Tweet ${i + 1}/${tweets.length} dispatched (ID: ${id})`);
        } catch (err) {
            logger.error(`[DISPATCH] Tweet ${i + 1} failed: ${err.message}`);
            if (i === 0) throw err;
            break;
        }
    }
    return ids;
}

async function dispatchProphecy(prophecy) {
    logger.info('[DISPATCH] ══════════════════════════════════════');
    logger.info('[DISPATCH] Broadcast module activated');

    if (!prophecy || prophecy.consensus_status === 'FAILED') {
        logger.warn('[DISPATCH] No valid prophecy — the timeline remains silent');
        return { status: 'SKIPPED', reason: 'No valid prophecy', tweets: [] };
    }

    const topConf = prophecy.predictions?.[0]?.probability || 0;
    if (topConf < 0.45) {
        logger.info(`[DISPATCH] Confidence ${(topConf * 100).toFixed(0)}% below threshold — silence protocol`);
        return { status: 'SILENCED', reason: 'Below confidence threshold', tweets: [] };
    }

    const useThread = shouldThread(prophecy);
    const tweetTexts = useThread ? formatThread(prophecy) : [formatSingleTweet(prophecy)];
    logger.info(`[DISPATCH] ${useThread ? 'Thread' : 'Single'} composed: ${tweetTexts.length} tweet(s)`);

    if (DRY_RUN) {
        logger.info('[DISPATCH] DRY RUN — not dispatched');
        return { status: 'DRY_RUN', prophecy_id: prophecy.prophecy_id, tweets: tweetTexts.map((t, i) => ({ index: i, text: t, id: null })), tx: txCounter };
    }

    const client = initializeClient();
    if (!client) {
        return { status: 'DRY_RUN', reason: 'No client', prophecy_id: prophecy.prophecy_id, tweets: tweetTexts.map((t, i) => ({ index: i, text: t, id: null })), tx: txCounter };
    }

    try {
        const ids = useThread ? await postThread(client, tweetTexts) : [await postTweet(client, tweetTexts[0])];
        logger.info(`[DISPATCH] Transmission #${txCounter} SENT — ${ids.length} tweet(s)`);
        return { status: 'DISPATCHED', prophecy_id: prophecy.prophecy_id, tweets: tweetTexts.map((t, i) => ({ index: i, text: t, id: ids[i] || null })), tx: txCounter, dispatched_at: new Date().toISOString() };
    } catch (err) {
        logger.error(`[DISPATCH] Broadcast failure: ${err.message}`);
        if (err.code === 429) return { status: 'RATE_LIMITED', prophecy_id: prophecy.prophecy_id, error: err.message };
        return { status: 'FAILED', prophecy_id: prophecy.prophecy_id, error: err.message };
    }
}

module.exports = { dispatchProphecy, formatSingleTweet, formatThread, shouldThread, initializeClient };

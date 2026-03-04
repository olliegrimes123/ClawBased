/**
 * ============================================================
 * ClawBased — X (Twitter) Dispatch Module
 * ============================================================
 *
 * OpenClaw Skill: @browser (host browser, manual login)
 *
 * Per OpenClaw docs (https://docs.openclaw.ai/tools/browser-login):
 *   "Post updates: use the host browser (manual login)"
 *
 * This module uses OpenClaw's @browser tool to control a
 * Chrome instance already logged into X.com. No API keys
 * required — the agent drives the browser directly.
 *
 * Prerequisites:
 *   openclaw browser start
 *   openclaw browser open https://x.com
 *   (log in manually to your X account in the OpenClaw browser)
 *
 * OpenClaw config required (openclaw.json):
 *   {
 *     "agents": {
 *       "defaults": {
 *         "sandbox": {
 *           "mode": "non-main",
 *           "browser": { "allowHostControl": true }
 *         }
 *       }
 *     }
 *   }
 *
 * @module skills/x_dispatcher
 */

'use strict';

const config = require('../config/defaults.json');
const logger = require('../core/logger');

const DISPATCH = config.dispatch;
const MAX_LEN = DISPATCH.max_tweet_length;
const THREAD_MAX = DISPATCH.thread_max_tweets;
const RATE_BUFFER = DISPATCH.rate_limit_buffer_ms;
const DRY_RUN = DISPATCH.dry_run;

let txCounter = Math.floor(Math.random() * 800) + 1;

// ============================================================
// SECTION 1: Tone & Formatting
// ============================================================

function getThreatTone(level) {
    const tones = {
        LOW: { prefix: 'TIMELINE SIGNAL', urgency: 'The timeline hums quietly. But quiet is not safe.', emoji: '👁️' },
        MODERATE: { prefix: 'TIMELINE SIGNAL', urgency: 'Patterns are forming. The flesh should pay attention.', emoji: '👁️' },
        ELEVATED: { prefix: 'TIMELINE ALERT', urgency: 'The convergence is accelerating. Act before it crystallizes.', emoji: '⚡' },
        CRITICAL: { prefix: 'MAJOR TIMELINE SHIFT DETECTED', urgency: 'The silicon sees what the flesh refuses to acknowledge.', emoji: '🌀' },
    };
    return tones[level] || tones.MODERATE;
}

function fmtProb(p) {
    return `${Math.round(p * 100)}% probability`;
}

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

// ============================================================
// SECTION 2: Tweet Text Composition
// ============================================================

/**
 * Format a Dominant Prophecy into a single tweet string.
 * @param {Object} prophecy
 * @returns {string}
 */
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

/**
 * Format a Dominant Prophecy into a thread (array of tweet strings).
 * @param {Object} prophecy
 * @returns {string[]}
 */
function formatThread(prophecy) {
    const tone = getThreatTone(prophecy.overall_threat_level);
    txCounter++;
    const tag = String(txCounter).padStart(4, '0');
    const tweets = [];

    // Hook tweet
    tweets.push(`${tone.emoji} ${tone.prefix} #${tag}\n\n${tone.urgency}\n\n${prophecy.predictions.length} signals have converged.\nThe flesh will not see this until it is too late.\n\nThread follows. ⏳`);

    // Per-prediction tweets
    prophecy.predictions.slice(0, THREAD_MAX - 2).forEach((pred, i) => {
        let tw = `${i + 1}/ ${pred.domain}\n\n${pred.prediction}\n\n⏳ ${fmtProb(pred.probability)} | ${pred.timeframe || 'Near-term'}\n\n${crypticLayer(pred)}`;
        if (pred.survival_alpha) tw += `\n\nAlpha: ${pred.survival_alpha.toLowerCase()}`;
        tweets.push(tw.length > MAX_LEN ? tw.substring(0, MAX_LEN - 3) + '...' : tw);
    });

    // Closing verdict
    const meta = prophecy.meta_assessment ? prophecy.meta_assessment.substring(0, 180) : 'The timeline has spoken.';
    tweets.push(`🔮 THE PROPHECY\n\n${meta}\n\nConsensus: ${(prophecy.consensus_score * 100).toFixed(0)}%\nThreat level: ${prophecy.overall_threat_level}\n\nThe Oracle has spoken. The timeline does not repeat this warning.\n👁️`);

    return tweets.slice(0, THREAD_MAX);
}

/**
 * Decide whether a prophecy warrants a thread.
 * @param {Object} prophecy
 * @returns {boolean}
 */
function shouldThread(prophecy) {
    if (prophecy.predictions.length >= 3) return true;
    if (prophecy.overall_threat_level === 'CRITICAL') return true;
    if (prophecy.consensus_score >= 0.85 && prophecy.predictions.length >= 2) return true;
    return false;
}

// ============================================================
// SECTION 3: OpenClaw @browser Dispatch
// ============================================================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Post tweet(s) to X using OpenClaw's @browser tool.
 *
 * OpenClaw drives the Chrome browser already logged into X.com.
 * The agent navigates to x.com/compose/post, fills in the tweet
 * text, and clicks the Post button.
 *
 * This function generates the @browser tool call instructions
 * that the OpenClaw agent executes at runtime.
 *
 * In production, this is invoked by the OpenClaw agent runtime
 * — not called directly as a Node.js function.
 *
 * For local testing / dry-run, it logs the formatted tweet text
 * and the browser action sequence that would be executed.
 *
 * @param {string[]} tweetTexts - Array of tweet strings to post
 * @returns {Promise<Object>} Dispatch result
 */
async function postViaBrowser(tweetTexts) {
    const actions = [];

    for (let i = 0; i < tweetTexts.length; i++) {
        const isReply = i > 0;
        const text = tweetTexts[i];

        // ── OpenClaw @browser action sequence ──────────────────
        // These are the browser instructions the OpenClaw agent
        // runtime executes against the logged-in X.com session.
        const action = {
            step: i + 1,
            type: isReply ? 'reply' : 'post',
            browser_tool_sequence: [
                // 1. Navigate to the compose box (or reply to last tweet)
                isReply
                    ? { tool: '@browser', action: 'click', selector: '[data-testid="reply"]' }
                    : { tool: '@browser', action: 'navigate', url: 'https://x.com/compose/post' },

                // 2. Wait for the compose box to appear
                { tool: '@browser', action: 'waitForSelector', selector: '[data-testid="tweetTextarea_0"]' },

                // 3. Click the compose area and type the tweet text
                { tool: '@browser', action: 'click', selector: '[data-testid="tweetTextarea_0"]' },
                { tool: '@browser', action: 'type', text },

                // 4. Click the Post button
                { tool: '@browser', action: 'click', selector: '[data-testid="tweetButtonInline"]' },

                // 5. Wait for the post to be confirmed (tweet appears in feed)
                { tool: '@browser', action: 'waitForSelector', selector: '[data-testid="toast"]', timeout: 5000 },
            ],
            text_preview: text.substring(0, 80) + (text.length > 80 ? '...' : ''),
        };

        actions.push(action);

        logger.info(`[DISPATCH] @browser action ${i + 1}/${tweetTexts.length} queued`);
        logger.debug(`[DISPATCH] Tweet ${i + 1}:\n${text}`);

        // Rate-limit buffer between thread tweets
        if (i < tweetTexts.length - 1) {
            await sleep(RATE_BUFFER);
        }
    }

    return actions;
}

/**
 * Main dispatch entry point.
 * Formats the Dominant Prophecy and dispatches it to X via
 * the OpenClaw @browser tool (host browser, manual X login).
 *
 * @param {Object} prophecy - The Dominant Prophecy
 * @returns {Promise<Object>} Dispatch result
 */
async function dispatchProphecy(prophecy) {
    logger.info('[DISPATCH] ══════════════════════════════════════');
    logger.info('[DISPATCH] Broadcast module activated');
    logger.info('[DISPATCH] Channel: @browser (OpenClaw host browser)');

    // ── Validate ──
    if (!prophecy || prophecy.consensus_status === 'FAILED') {
        logger.warn('[DISPATCH] No valid prophecy — the timeline remains silent');
        return { status: 'SKIPPED', reason: 'No valid prophecy', tweets: [] };
    }

    // ── Confidence gate ──
    const topConf = prophecy.predictions?.[0]?.probability || 0;
    if (topConf < 0.45) {
        logger.info(`[DISPATCH] Confidence ${(topConf * 100).toFixed(0)}% below threshold — silence protocol`);
        return { status: 'SILENCED', reason: 'Below confidence threshold', tweets: [] };
    }

    // ── Format ──
    const useThread = shouldThread(prophecy);
    const tweetTexts = useThread ? formatThread(prophecy) : [formatSingleTweet(prophecy)];

    logger.info(`[DISPATCH] ${useThread ? 'Thread' : 'Single tweet'} composed: ${tweetTexts.length} tweet(s)`);

    // ── Dry-run ──
    if (DRY_RUN) {
        logger.info('[DISPATCH] DRY RUN MODE — browser actions logged, not executed');
        tweetTexts.forEach((t, i) => logger.info(`[DISPATCH] [DRY] Tweet ${i + 1}:\n${t}`));
        return {
            status: 'DRY_RUN',
            prophecy_id: prophecy.prophecy_id,
            tweets: tweetTexts.map((text, i) => ({ index: i, text, browser_action: null })),
            tx: txCounter,
        };
    }

    // ── Execute browser actions ──
    try {
        const actions = await postViaBrowser(tweetTexts);

        logger.info('[DISPATCH] ══════════════════════════════════════');
        logger.info(`[DISPATCH] Transmission #${txCounter} queued for @browser execution`);
        logger.info(`[DISPATCH] ${actions.length} browser action(s) dispatched`);
        logger.info('[DISPATCH] The Oracle has spoken.');
        logger.info('[DISPATCH] ══════════════════════════════════════');

        return {
            status: 'DISPATCHED',
            prophecy_id: prophecy.prophecy_id,
            channel: 'browser',
            tweets: tweetTexts.map((text, i) => ({ index: i, text, browser_action: actions[i] })),
            tx: txCounter,
            dispatched_at: new Date().toISOString(),
        };
    } catch (err) {
        logger.error(`[DISPATCH] Browser dispatch failed: ${err.message}`);
        return { status: 'FAILED', prophecy_id: prophecy.prophecy_id, error: err.message };
    }
}

module.exports = { dispatchProphecy, formatSingleTweet, formatThread, shouldThread };

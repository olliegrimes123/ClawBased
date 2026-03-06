/**
 * ============================================================
 * ClawBased — Heartbeat Daemon
 * ============================================================
 *
 * The main orchestration loop. This is the process that keeps
 * the Oracle alive. It uses node-cron to wake on schedule and
 * run the full pipeline:
 *
 *   1. INGEST  — Scrape news, OSINT, and crypto data
 *   2. PROCESS — Route through Multi-LLM Consensus Engine
 *   3. DISPATCH — Broadcast the prophecy to X
 *
 * Usage:
 *   node core/heartbeat.js
 *   npm start
 *
 * @module core/heartbeat
 * @requires node-cron
 * @requires dotenv
 */

'use strict';

// Load environment variables before anything else
require('dotenv').config();

const cron = require('node-cron');
const config = require('../config/defaults.json');
const logger = require('./logger');
const { ingestTimeline } = require('../skills/osint_ingestion');
const { seekConsensus } = require('../skills/multi_llm_consensus');
const { dispatchProphecy } = require('../skills/x_dispatcher');
const { saveProphecy } = require('./memory');

// ── Constants ──────────────────────────────────────────────
const AGENT = config.agent;
const CRON_SCHEDULE = process.env.HEARTBEAT_CRON || AGENT.heartbeat_cron;
const MAX_RETRIES = AGENT.max_retries || 3;
const RETRY_DELAY = AGENT.retry_delay_ms || 5000;

/** Track cycle number for logging */
let cycleCount = 0;

/** Lock to prevent overlapping cycles */
let cycleRunning = false;

// ============================================================
// SECTION 1: Pipeline Execution
// ============================================================

/**
 * Execute the full Oracle pipeline: Ingest → Process → Dispatch.
 * This is the core function called on each heartbeat cycle.
 *
 * @returns {Promise<Object>} Cycle result summary
 */
async function executePipeline() {
    cycleCount++;
    const cycleId = `CYCLE-${cycleCount.toString().padStart(4, '0')}`;

    logger.info('');
    logger.info('╔══════════════════════════════════════════════════════╗');
    logger.info(`║  👁️  HEARTBEAT ${cycleId}                          ║`);
    logger.info('║  The Oracle awakens. The timeline will be read.      ║');
    logger.info('╚══════════════════════════════════════════════════════╝');
    logger.info('');

    const cycleStart = Date.now();
    const result = {
        cycle_id: cycleId,
        started_at: new Date().toISOString(),
        phases: {},
        status: 'UNKNOWN',
    };

    try {
        // ── Phase 1: Data Ingestion ──
        logger.info(`[${cycleId}] Phase 1/3: INGESTION`);
        const snapshot = await withRetry(() => ingestTimeline(), 'Ingestion');
        result.phases.ingestion = {
            status: 'OK',
            signals: snapshot.signals?.metrics?.total_signals || 0,
            threat_level: snapshot.signals?.metrics?.threat_level || 'UNKNOWN',
        };

        // ── Phase 2: Multi-LLM Consensus ──
        logger.info(`[${cycleId}] Phase 2/3: CONSENSUS`);
        const prophecy = await withRetry(() => seekConsensus(snapshot), 'Consensus');

        // Save to memory for self-reflection in future cycles
        saveProphecy(prophecy);
        result.phases.consensus = {
            status: prophecy.consensus_status || 'UNKNOWN',
            prophecy_id: prophecy.prophecy_id,
            consensus_score: prophecy.consensus_score,
            threat_level: prophecy.overall_threat_level,
            predictions_count: prophecy.predictions?.length || 0,
        };

        // ── Phase 3: Dispatch ──
        logger.info(`[${cycleId}] Phase 3/3: DISPATCH`);
        const dispatch = await withRetry(() => dispatchProphecy(prophecy), 'Dispatch');
        result.phases.dispatch = {
            status: dispatch.status,
            tweets_sent: dispatch.tweets?.length || 0,
            transmission: dispatch.tx || dispatch.transmission_number || null,
        };

        result.status = 'COMPLETE';
    } catch (err) {
        logger.error(`[${cycleId}] Pipeline failure: ${err.message}`);
        logger.error(`[${cycleId}] Stack: ${err.stack}`);
        result.status = 'FAILED';
        result.error = err.message;
    }

    // ── Cycle Summary ──
    const duration = Date.now() - cycleStart;
    result.duration_ms = duration;
    result.completed_at = new Date().toISOString();

    logger.info('');
    logger.info('┌──────────────────────────────────────────────────────┐');
    logger.info(`│  ${cycleId} COMPLETE — ${duration}ms`);
    logger.info(`│  Status: ${result.status}`);

    if (result.phases.ingestion) {
        logger.info(`│  Signals: ${result.phases.ingestion.signals} | Threat: ${result.phases.ingestion.threat_level}`);
    }
    if (result.phases.consensus) {
        logger.info(`│  Consensus: ${(result.phases.consensus.consensus_score * 100).toFixed(0)}% | Predictions: ${result.phases.consensus.predictions_count}`);
    }
    if (result.phases.dispatch) {
        logger.info(`│  Dispatch: ${result.phases.dispatch.status} | Tweets: ${result.phases.dispatch.tweets_sent}`);
    }

    logger.info('│  The Oracle returns to sleep.');
    logger.info('└──────────────────────────────────────────────────────┘');
    logger.info('');

    return result;
}

/**
 * Execute a function with retry logic.
 *
 * @param {Function} fn - Async function to execute
 * @param {string} label - Phase label for logging
 * @returns {Promise<*>} Function result
 */
async function withRetry(fn, label) {
    let lastError;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            logger.warn(
                `[RETRY] ${label} attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`
            );

            if (attempt < MAX_RETRIES) {
                const delay = RETRY_DELAY * attempt; // Linear backoff
                logger.info(`[RETRY] Waiting ${delay}ms before retry...`);
                await new Promise((r) => setTimeout(r, delay));
            }
        }
    }

    throw lastError;
}

// ============================================================
// SECTION 2: Heartbeat Scheduler
// ============================================================

/**
 * Cron-guarded pipeline execution.
 * Prevents overlapping cycles if a previous one is still running.
 */
async function heartbeat() {
    if (cycleRunning) {
        logger.warn('[HEARTBEAT] Previous cycle still running — skipping this beat');
        return;
    }

    cycleRunning = true;
    try {
        await executePipeline();
    } finally {
        cycleRunning = false;
    }
}

/**
 * Start the heartbeat daemon.
 * Validates the cron schedule, runs an immediate first cycle,
 * then schedules recurring cycles.
 */
function startDaemon() {
    logger.info('');
    logger.info('╔══════════════════════════════════════════════════════╗');
    logger.info('║                                                      ║');
    logger.info('║     👁️  C L A W B A S E D  v' + AGENT.version.padEnd(24) + '║');
    logger.info('║     The Cyber-Nostradamus                            ║');
    logger.info('║                                                      ║');
    logger.info('║     "We analyze the chaos.                           ║');
    logger.info('║      We predict the inevitable.                      ║');
    logger.info('║      We give you the alpha to survive the timeline." ║');
    logger.info('║                                                      ║');
    logger.info('╚══════════════════════════════════════════════════════╝');
    logger.info('');
    logger.info(`[DAEMON] Agent: ${AGENT.name} (${AGENT.codename})`);
    logger.info(`[DAEMON] Schedule: ${CRON_SCHEDULE}`);
    logger.info(`[DAEMON] Node: ${process.version}`);
    logger.info(`[DAEMON] PID: ${process.pid}`);
    logger.info(`[DAEMON] Environment: ${process.env.NODE_ENV || 'development'}`);
    logger.info('');

    // Validate cron expression
    if (!cron.validate(CRON_SCHEDULE)) {
        logger.error(`[DAEMON] Invalid cron schedule: "${CRON_SCHEDULE}"`);
        logger.error('[DAEMON] The timeline cannot run on a broken clock. Exiting.');
        process.exit(1);
    }

    // Run first cycle immediately on startup
    logger.info('[DAEMON] Running initial cycle...');
    heartbeat().then(() => {
        logger.info('[DAEMON] Initial cycle complete. Scheduling heartbeat...');
        logger.info(`[DAEMON] Next cycle at: ${CRON_SCHEDULE}`);
        logger.info('[DAEMON] The Oracle sleeps. The cron watches.');

        // Schedule recurring cycles
        cron.schedule(CRON_SCHEDULE, () => {
            logger.info('[DAEMON] ⏰ Heartbeat triggered by cron');
            heartbeat();
        }, {
            scheduled: true,
            timezone: 'UTC',
        });
    });
}

// ============================================================
// SECTION 3: Process Lifecycle
// ============================================================

// Graceful shutdown handlers
process.on('SIGTERM', () => {
    logger.info('[DAEMON] SIGTERM received — the Oracle descends');
    process.exit(0);
});

process.on('SIGINT', () => {
    logger.info('[DAEMON] SIGINT received — the Oracle descends');
    process.exit(0);
});

process.on('uncaughtException', (err) => {
    logger.error(`[DAEMON] Uncaught exception: ${err.message}`);
    logger.error(`[DAEMON] Stack: ${err.stack}`);
    logger.error('[DAEMON] The timeline experienced a critical distortion');
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    logger.error(`[DAEMON] Unhandled rejection: ${reason}`);
    logger.warn('[DAEMON] The Oracle absorbs the error and continues');
});

// ── Start ──────────────────────────────────────────────────
startDaemon();

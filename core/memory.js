/**
 * ============================================================
 * ClawBased — Persistent Memory Module
 * ============================================================
 *
 * Provides a local SQLite database for the agent to remember
 * past prophecies, self-reflect, and grade its own predictions.
 * Ensures local sovereignty.
 *
 * @module core/memory
 */

'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');

const DB_DIR = path.resolve(__dirname, '..', 'data');
const DB_PATH = path.join(DB_DIR, 'memory.db');

// Ensure data directory exists
if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
}

let db;

try {
    db = new Database(DB_PATH);
    // Ensure tables exist
    db.exec(`
    CREATE TABLE IF NOT EXISTS prophecies (
      id TEXT PRIMARY KEY,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      consensus_score REAL,
      threat_level TEXT,
      domain TEXT,
      prediction TEXT,
      probability REAL,
      survival_alpha TEXT,
      meta_assessment TEXT
    );
  `);
    logger.info('[MEMORY] Connected to sovereign persistence layer (memory.db)');
} catch (err) {
    logger.error(`[MEMORY] Initialization failed: ${err.message}`);
}

/**
 * Save a Dominant Prophecy into the persistence layer.
 * @param {Object} prophecy - The combined prophecy object
 */
function saveProphecy(prophecy) {
    if (!db || !prophecy || prophecy.consensus_status === 'FAILED') return;

    try {
        const stmt = db.prepare(`
      INSERT INTO prophecies (
        id, consensus_score, threat_level, domain, 
        prediction, probability, survival_alpha, meta_assessment
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

        // Only saving the top prediction for self-reflection to avoid context bloat
        const topPred = prophecy.predictions && prophecy.predictions.length > 0 ? prophecy.predictions[0] : null;

        if (!topPred) return;

        stmt.run(
            prophecy.prophecy_id,
            prophecy.consensus_score,
            prophecy.overall_threat_level,
            topPred.domain,
            topPred.prediction,
            topPred.probability,
            topPred.survival_alpha,
            prophecy.meta_assessment
        );

        logger.info(`[MEMORY] Prophecy ${prophecy.prophecy_id} etched into silicon.`);
    } catch (err) {
        logger.error(`[MEMORY] Failed to save prophecy: ${err.message}`);
    }
}

/**
 * Retrieve recent prophecies to use as context for new predictions.
 * @param {number} limit - Number of past prophecies to retrieve
 * @returns {Array<Object>}
 */
function getRecentProphecies(limit = 3) {
    if (!db) return [];
    try {
        const stmt = db.prepare('SELECT * FROM prophecies ORDER BY timestamp DESC LIMIT ?');
        return stmt.all(limit);
    } catch (err) {
        logger.error(`[MEMORY] Failed to retrieve matching prophecies: ${err.message}`);
        return [];
    }
}

module.exports = {
    saveProphecy,
    getRecentProphecies
};

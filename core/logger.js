/**
 * ============================================================
 * ClawBased — Centralized Logger
 * ============================================================
 * Winston-based logging with lore-flavored formatting.
 * All modules import this single logger instance.
 *
 * @module core/logger
 * @requires winston
 */

'use strict';

const winston = require('winston');
const path = require('path');
const config = require('../config/defaults.json');

const LOG_CONFIG = config.logging;

// ── Custom Format ──────────────────────────────────────────

const clawFormat = winston.format.printf(({ level, message, timestamp }) => {
    const lvl = level.toUpperCase().padEnd(5);
    return `[${timestamp}] [${lvl}] ${message}`;
});

// ── Logger Instance ────────────────────────────────────────

const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || LOG_CONFIG.level || 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        clawFormat
    ),
    transports: [
        // Console — always active
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize({ all: true }),
                winston.format.timestamp({ format: 'HH:mm:ss' }),
                clawFormat
            ),
        }),

        // File — rotated logs
        new winston.transports.File({
            filename: path.resolve(__dirname, '..', LOG_CONFIG.file || 'logs/clawbased.log'),
            maxsize: parseInt(LOG_CONFIG.max_size) || 20 * 1024 * 1024,
            maxFiles: LOG_CONFIG.max_files || 5,
            tailable: true,
        }),

        // Error-only file
        new winston.transports.File({
            filename: path.resolve(__dirname, '..', 'logs', 'errors.log'),
            level: 'error',
            maxsize: 10 * 1024 * 1024,
            maxFiles: 3,
        }),
    ],

    // Don't crash on uncaught logger errors
    exitOnError: false,
});

// ── Startup Banner ─────────────────────────────────────────

logger.info('════════════════════════════════════════════');
logger.info('  👁️  C L A W B A S E D  — Logger Online');
logger.info('  The silicon remembers. The silicon warns.');
logger.info('════════════════════════════════════════════');

module.exports = logger;

/**
 * ============================================================
 * ClawBased — Multi-LLM Consensus Engine
 * ============================================================
 *
 * OpenClaw Skill: @exec
 *
 * The Nostradamus Engine. This module takes a Timeline Snapshot
 * from the ingestion layer and routes it through two frontier LLMs
 * simultaneously. Their independent predictions are compared,
 * debated, and merged into a single Dominant Prophecy.
 *
 * Consensus Protocol:
 *   1. Send identical timeline data to Claude 3.5 Sonnet + GPT-4o
 *   2. Parse structured predictions from each model
 *   3. Compute agreement score (convergence %)
 *   4. If convergence >= threshold → accept as Dominant Prophecy
 *   5. If divergence too high → re-query with follow-up (max 3 rounds)
 *
 * @module skills/multi_llm_consensus
 * @requires axios
 * @requires config/defaults.json
 */

'use strict';

const axios = require('axios');
const config = require('../config/defaults.json');
const logger = require('../core/logger');
const { getRecentProphecies } = require('../core/memory');

// ── Constants ──────────────────────────────────────────────
const CONSENSUS_CONFIG = config.consensus;
const PROVIDERS = CONSENSUS_CONFIG.providers;
const AGREEMENT_THRESHOLD = CONSENSUS_CONFIG.agreement_threshold;
const MAX_ROUNDS = CONSENSUS_CONFIG.max_consensus_rounds;

// ============================================================
// SECTION 1: System Prompts
// ============================================================

/**
 * Build the system prompt that defines how LLMs should analyze
 * the timeline and produce structured predictions.
 *
 * Both models receive IDENTICAL instructions to ensure
 * fair comparison in the consensus protocol.
 *
 * @returns {string} The system prompt
 */
function buildSystemPrompt(pastMemories = []) {
    let memoryBlock = '';
    if (pastMemories && pastMemories.length > 0) {
        const historyText = pastMemories.map((m) =>
            `[${m.timestamp}] Threat: ${m.threat_level}. Domain: ${m.domain}. Prediction: ${m.prediction} (Confidence: ${(m.probability * 100).toFixed(0)}%)`
        ).join('\n');
        memoryBlock = `\nPAST PROPHECIES (MEMORY ALAYA):\nRetrieve context from these past predictions to verify trajectory:\n${historyText}\n`;
    }

    return `You are a component of ClawBased, the Cyber-Nostradamus — an autonomous AI Oracle 
that analyzes global intelligence and predicts near-future events.
${memoryBlock}
You will receive a "Timeline Snapshot" containing:
- Global news articles scored by relevance
- Crypto market sentiment (Fear & Greed Index)
- Top cryptocurrency market data
- BTC spot prices
- Aggregate signal metrics and threat level

YOUR TASK:
Analyze the timeline snapshot and produce a structured prediction report.

OUTPUT FORMAT (strict JSON):
{
  "analysis_window": "7-30 days",
  "overall_threat_level": "LOW|MODERATE|ELEVATED|CRITICAL",
  "predictions": [
    {
      "id": "P1",
      "domain": "GEOPOLITICAL|ECONOMIC|CRYPTO|TECHNOLOGY|SYSTEMIC",
      "prediction": "Clear, specific prediction statement",
      "probability": 0.00-1.00,
      "timeframe": "e.g., 7-14 days",
      "supporting_signals": ["signal1", "signal2"],
      "survival_alpha": "Actionable recommendation for humans"
    }
  ],
  "meta_assessment": "One paragraph summarizing the overall state of the timeline",
  "convergence_markers": ["key themes or patterns that dominate the signals"]
}

RULES:
- Produce exactly 3-5 predictions, ordered by probability (highest first)
- Each probability must be between 0.30 and 0.95 (never claim certainty)
- survival_alpha must be actionable but must NEVER name specific assets/tickers
- Be specific in predictions — vague prophecies are worthless
- Focus on what the DATA shows, not what is commonly expected
- If signals are weak, say so — do not fabricate confidence`;
}

/**
 * Build the follow-up prompt used when models diverge.
 * This prompt presents both models' predictions and asks
 * for reconciliation on specific points of disagreement.
 *
 * @param {Object} prediction1 - First model's prediction
 * @param {Object} prediction2 - Second model's prediction
 * @param {Array<string>} divergencePoints - Specific areas of disagreement
 * @returns {string} The follow-up prompt
 */
function buildDivergencePrompt(prediction1, prediction2, divergencePoints) {
    return `Two AI models analyzed the same timeline and produced divergent predictions.

MODEL A's predictions:
${JSON.stringify(prediction1.predictions, null, 2)}

MODEL B's predictions:
${JSON.stringify(prediction2.predictions, null, 2)}

DIVERGENCE POINTS:
${divergencePoints.map((p, i) => `${i + 1}. ${p}`).join('\n')}

Reconcile these divergences. For each point:
1. Identify which model's reasoning is stronger based on the data
2. Produce a merged prediction that takes the best of both analyses
3. Adjust probability scores to reflect the uncertainty from disagreement

OUTPUT FORMAT: Same structured JSON as before, but with reconciled predictions.`;
}

// ============================================================
// SECTION 2: LLM Provider Calls
// ============================================================

/**
 * Send a prompt to the Anthropic Claude API.
 *
 * @param {string} systemPrompt - The system-level instruction
 * @param {string} userContent - The user-level content (timeline data)
 * @param {Object} providerConfig - Model config from defaults.json
 * @returns {Promise<Object>} Parsed prediction response
 */
async function queryAnthropic(systemPrompt, userContent, providerConfig) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        throw new Error('[CONSENSUS] Anthropic API key not configured — timeline access denied');
    }

    const model = process.env.ANTHROPIC_MODEL || providerConfig.model;

    logger.info(`[CONSENSUS] Querying the Anthropic oracle (${model})...`);

    const response = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
            model,
            max_tokens: providerConfig.max_tokens,
            temperature: providerConfig.temperature,
            system: systemPrompt,
            messages: [
                {
                    role: 'user',
                    content: userContent,
                },
            ],
        },
        {
            headers: {
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'Content-Type': 'application/json',
            },
            timeout: 60000,
        }
    );

    const rawText = response.data?.content?.[0]?.text || '';
    return parseModelResponse(rawText, 'anthropic');
}

/**
 * Send a prompt to the OpenAI GPT API.
 *
 * @param {string} systemPrompt - The system-level instruction
 * @param {string} userContent - The user-level content (timeline data)
 * @param {Object} providerConfig - Model config from defaults.json
 * @returns {Promise<Object>} Parsed prediction response
 */
async function queryOpenAI(systemPrompt, userContent, providerConfig) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        throw new Error('[CONSENSUS] OpenAI API key not configured — timeline access denied');
    }

    const model = process.env.OPENAI_MODEL || providerConfig.model;

    logger.info(`[CONSENSUS] Querying the OpenAI oracle (${model})...`);

    const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
            model,
            max_tokens: providerConfig.max_tokens,
            temperature: providerConfig.temperature,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userContent },
            ],
            response_format: { type: 'json_object' },
        },
        {
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            timeout: 60000,
        }
    );

    const rawText = response.data?.choices?.[0]?.message?.content || '';
    return parseModelResponse(rawText, 'openai');
}

/**
 * Send a prompt to a local Ollama instance.
 *
 * @param {string} systemPrompt - The system-level instruction
 * @param {string} userContent - The user-level content (timeline data)
 * @param {Object} providerConfig - Model config from defaults.json
 * @returns {Promise<Object>} Parsed prediction response
 */
async function queryOllama(systemPrompt, userContent, providerConfig) {
    const endpoint = process.env.OLLAMA_ENDPOINT || providerConfig.endpoint || 'http://localhost:11434';
    const model = process.env.OLLAMA_MODEL || providerConfig.model || 'llama3';

    logger.info(`[CONSENSUS] Querying local Ollama oracle (${model})...`);

    const response = await axios.post(
        `${endpoint}/api/chat`,
        {
            model: model,
            options: {
                temperature: providerConfig.temperature || 0.3,
                num_predict: providerConfig.max_tokens || 4096,
            },
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userContent },
            ],
            stream: false,
            format: 'json',
        },
        { timeout: 120000 } // Local models may take longer
    );

    const rawText = response.data?.message?.content || '';
    return parseModelResponse(rawText, 'ollama');
}

/**
 * Parse raw LLM text output into structured prediction JSON.
 * Handles edge cases where models wrap JSON in markdown code fences.
 *
 * @param {string} rawText - Raw output from the LLM
 * @param {string} providerId - Identifier of the provider (for logging)
 * @returns {Object} Parsed prediction object
 */
function parseModelResponse(rawText, providerId) {
    // Strip markdown code fences if present
    let cleaned = rawText.trim();
    if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    try {
        const parsed = JSON.parse(cleaned);
        logger.info(`[CONSENSUS] ${providerId}: Response parsed successfully`);
        return parsed;
    } catch (err) {
        logger.error(
            `[CONSENSUS] ${providerId}: Failed to parse response — timeline distortion detected`
        );
        logger.debug(`[CONSENSUS] Raw output: ${rawText.substring(0, 200)}...`);

        // Return a minimal valid structure so the pipeline doesn't break
        return {
            analysis_window: 'PARSE_ERROR',
            overall_threat_level: 'UNKNOWN',
            predictions: [],
            meta_assessment: `Parse error from ${providerId}: ${err.message}`,
            convergence_markers: [],
        };
    }
}

// ============================================================
// SECTION 3: Consensus Protocol
// ============================================================

/**
 * Route a query to the appropriate LLM provider based on ID.
 *
 * @param {string} providerId - Provider identifier ('anthropic' or 'openai')
 * @param {string} systemPrompt - System prompt
 * @param {string} userContent - User content
 * @param {Object} providerConfig - Provider configuration
 * @returns {Promise<Object>} Model response
 */
async function queryProvider(providerId, systemPrompt, userContent, providerConfig) {
    switch (providerId) {
        case 'anthropic':
            return queryAnthropic(systemPrompt, userContent, providerConfig);
        case 'openai':
            return queryOpenAI(systemPrompt, userContent, providerConfig);
        case 'ollama':
            return queryOllama(systemPrompt, userContent, providerConfig);
        default:
            throw new Error(`[CONSENSUS] Unknown provider: ${providerId}`);
    }
}

/**
 * Compute the agreement score between two sets of predictions.
 * Uses domain overlap, directional alignment, and probability proximity.
 *
 * @param {Object} pred1 - Predictions from model 1
 * @param {Object} pred2 - Predictions from model 2
 * @returns {{ score: number, divergencePoints: string[] }}
 */
function computeAgreement(pred1, pred2) {
    const predictions1 = pred1.predictions || [];
    const predictions2 = pred2.predictions || [];

    if (!predictions1.length || !predictions2.length) {
        return { score: 0, divergencePoints: ['One or both models returned empty predictions'] };
    }

    let totalScore = 0;
    let comparisons = 0;
    const divergencePoints = [];

    // ── Domain overlap check ──
    const domains1 = new Set(predictions1.map((p) => p.domain));
    const domains2 = new Set(predictions2.map((p) => p.domain));
    const sharedDomains = [...domains1].filter((d) => domains2.has(d));
    const domainOverlap = sharedDomains.length / Math.max(domains1.size, domains2.size);

    totalScore += domainOverlap * 0.3; // 30% weight on domain agreement
    comparisons++;

    if (domainOverlap < 0.5) {
        divergencePoints.push(
            `Domain mismatch: Model A focused on [${[...domains1].join(', ')}], ` +
            `Model B focused on [${[...domains2].join(', ')}]`
        );
    }

    // ── Threat level alignment ──
    const threatLevels = ['LOW', 'MODERATE', 'ELEVATED', 'CRITICAL'];
    const tl1 = threatLevels.indexOf(pred1.overall_threat_level);
    const tl2 = threatLevels.indexOf(pred2.overall_threat_level);

    if (tl1 >= 0 && tl2 >= 0) {
        const threatAlignment = 1 - Math.abs(tl1 - tl2) / (threatLevels.length - 1);
        totalScore += threatAlignment * 0.2; // 20% weight
        comparisons++;

        if (threatAlignment < 0.5) {
            divergencePoints.push(
                `Threat level divergence: Model A says ${pred1.overall_threat_level}, ` +
                `Model B says ${pred2.overall_threat_level}`
            );
        }
    }

    // ── Prediction direction & probability alignment ──
    // Compare predictions within shared domains
    for (const domain of sharedDomains) {
        const p1 = predictions1.find((p) => p.domain === domain);
        const p2 = predictions2.find((p) => p.domain === domain);

        if (p1 && p2) {
            const probProximity = 1 - Math.abs((p1.probability || 0) - (p2.probability || 0));
            totalScore += probProximity * (0.5 / Math.max(sharedDomains.length, 1));
            comparisons++;

            if (probProximity < 0.6) {
                divergencePoints.push(
                    `${domain}: Probability divergence ` +
                    `(A: ${(p1.probability * 100).toFixed(0)}%, B: ${(p2.probability * 100).toFixed(0)}%)`
                );
            }
        }
    }

    const finalScore = comparisons > 0 ? totalScore : 0;

    return {
        score: Math.round(finalScore * 1000) / 1000,
        divergencePoints,
    };
}

/**
 * Merge two prediction sets into a single Dominant Prophecy.
 * Applies provider weights from configuration to produce
 * weighted probability scores.
 *
 * @param {Object} pred1 - Predictions from model 1
 * @param {Object} pred2 - Predictions from model 2
 * @param {number} weight1 - Weight for model 1 (0-1)
 * @param {number} weight2 - Weight for model 2 (0-1)
 * @param {number} agreementScore - Consensus agreement score
 * @returns {Object} The Dominant Prophecy
 */
function mergePredictions(pred1, pred2, weight1, weight2, agreementScore) {
    const predictions1 = pred1.predictions || [];
    const predictions2 = pred2.predictions || [];

    // Collect all unique domains across both models
    const allDomains = new Set([
        ...predictions1.map((p) => p.domain),
        ...predictions2.map((p) => p.domain),
    ]);

    const mergedPredictions = [];

    for (const domain of allDomains) {
        const p1 = predictions1.find((p) => p.domain === domain);
        const p2 = predictions2.find((p) => p.domain === domain);

        if (p1 && p2) {
            // Both models have predictions in this domain — weighted merge
            mergedPredictions.push({
                id: `P${mergedPredictions.length + 1}`,
                domain,
                prediction: weight1 >= weight2 ? p1.prediction : p2.prediction,
                probability: Math.round(
                    (p1.probability * weight1 + p2.probability * weight2) * 1000
                ) / 1000,
                timeframe: p1.timeframe || p2.timeframe,
                supporting_signals: [
                    ...(p1.supporting_signals || []),
                    ...(p2.supporting_signals || []),
                ].filter((v, i, a) => a.indexOf(v) === i), // deduplicate
                survival_alpha: weight1 >= weight2 ? p1.survival_alpha : p2.survival_alpha,
                consensus: 'CONVERGED',
            });
        } else {
            // Only one model predicted in this domain — include with penalty
            const solo = p1 || p2;
            const soloWeight = p1 ? weight1 : weight2;

            mergedPredictions.push({
                ...solo,
                id: `P${mergedPredictions.length + 1}`,
                probability: Math.round(solo.probability * soloWeight * 0.8 * 1000) / 1000,
                consensus: 'SINGLE_SOURCE',
            });
        }
    }

    // Sort by probability descending
    mergedPredictions.sort((a, b) => b.probability - a.probability);

    // Determine final threat level (weighted)
    const threatLevels = ['LOW', 'MODERATE', 'ELEVATED', 'CRITICAL'];
    const tl1 = threatLevels.indexOf(pred1.overall_threat_level || 'MODERATE');
    const tl2 = threatLevels.indexOf(pred2.overall_threat_level || 'MODERATE');
    const weightedThreat = Math.round(
        (Math.max(tl1, 0) * weight1 + Math.max(tl2, 0) * weight2)
    );

    return {
        prophecy_id: `PROPH-${Date.now().toString(36).toUpperCase()}`,
        generated_at: new Date().toISOString(),
        consensus_score: agreementScore,
        consensus_status: agreementScore >= AGREEMENT_THRESHOLD ? 'CONVERGED' : 'FORCED',
        overall_threat_level: threatLevels[Math.min(weightedThreat, 3)],
        predictions: mergedPredictions.slice(0, 5),
        meta_assessment: weight1 >= weight2
            ? pred1.meta_assessment
            : pred2.meta_assessment,
        convergence_markers: [
            ...(pred1.convergence_markers || []),
            ...(pred2.convergence_markers || []),
        ].filter((v, i, a) => a.indexOf(v) === i),
        model_contributions: [
            { provider: PROVIDERS[0].id, model: PROVIDERS[0].model, weight: weight1 },
            { provider: PROVIDERS[1].id, model: PROVIDERS[1].model, weight: weight2 },
        ],
    };
}

/**
 * Main consensus entry point.
 * Orchestrates the full Multi-LLM Consensus Protocol:
 *   1. Query both models in parallel
 *   2. Compute agreement score
 *   3. If below threshold, re-query with divergence context
 *   4. Merge into Dominant Prophecy
 *
 * @param {Object} timelineSnapshot - The Timeline Snapshot from ingestion
 * @returns {Promise<Object>} The Dominant Prophecy
 */
async function seekConsensus(timelineSnapshot) {
    logger.info('[CONSENSUS] ══════════════════════════════════════');
    logger.info('[CONSENSUS] Nostradamus Engine activated');
    logger.info('[CONSENSUS] Routing timeline through the silicon...');
    logger.info('[CONSENSUS] ══════════════════════════════════════');

    // Inject SQLite memories
    const pastMemories = getRecentProphecies(3);
    const systemPrompt = buildSystemPrompt(pastMemories);

    const userContent = `TIMELINE SNAPSHOT:\n${JSON.stringify(timelineSnapshot, null, 2)}`;

    // Select the top 2 active providers by weight
    const activeProviders = PROVIDERS.filter((p) => p.weight > 0);
    if (activeProviders.length < 2) {
        logger.warn('[CONSENSUS] Less than 2 active providers configured. Consensus needs at least two.');
    }
    const provider1 = activeProviders[0] || PROVIDERS[0];
    const provider2 = activeProviders[1] || PROVIDERS[1];

    let prediction1, prediction2;
    let agreementScore = 0;
    let divergencePoints = [];
    let round = 0;

    // ── Consensus loop ──
    while (round < MAX_ROUNDS) {
        round++;
        logger.info(`[CONSENSUS] Round ${round}/${MAX_ROUNDS}...`);

        const currentUserContent = round === 1
            ? userContent
            : buildDivergencePrompt(prediction1, prediction2, divergencePoints);

        // Query both models in parallel
        const [result1, result2] = await Promise.allSettled([
            queryProvider(provider1.id, systemPrompt, currentUserContent, provider1),
            queryProvider(provider2.id, systemPrompt, currentUserContent, provider2),
        ]);

        prediction1 = result1.status === 'fulfilled' ? result1.value : null;
        prediction2 = result2.status === 'fulfilled' ? result2.value : null;

        // Handle provider failures
        if (!prediction1 && !prediction2) {
            logger.error('[CONSENSUS] Both oracles failed — timeline is dark');
            return createFailedProphecy('Both LLM providers returned errors');
        }

        if (!prediction1 || !prediction2) {
            const surviving = prediction1 || prediction2;
            const failedProvider = !prediction1 ? provider1.id : provider2.id;

            logger.warn(
                `[CONSENSUS] ${failedProvider} oracle failed — proceeding with single-source prophecy`
            );

            return {
                prophecy_id: `PROPH-${Date.now().toString(36).toUpperCase()}`,
                generated_at: new Date().toISOString(),
                consensus_score: 0,
                consensus_status: 'SINGLE_SOURCE',
                overall_threat_level: surviving.overall_threat_level || 'UNKNOWN',
                predictions: (surviving.predictions || []).map((p) => ({
                    ...p,
                    probability: p.probability * 0.75, // Penalty for single-source
                    consensus: 'SINGLE_SOURCE',
                })),
                meta_assessment: surviving.meta_assessment,
                convergence_markers: surviving.convergence_markers || [],
                model_contributions: [
                    {
                        provider: prediction1 ? provider1.id : provider2.id,
                        model: prediction1 ? provider1.model : provider2.model,
                        weight: 1.0,
                    },
                ],
            };
        }

        // ── Compute agreement ──
        const agreement = computeAgreement(prediction1, prediction2);
        agreementScore = agreement.score;
        divergencePoints = agreement.divergencePoints;

        logger.info(
            `[CONSENSUS] Round ${round} convergence: ${(agreementScore * 100).toFixed(1)}%`
        );

        if (agreementScore >= AGREEMENT_THRESHOLD) {
            logger.info('[CONSENSUS] Convergence threshold met — the future is clear');
            break;
        }

        if (round < MAX_ROUNDS) {
            logger.info(
                `[CONSENSUS] Divergence detected on ${divergencePoints.length} points — ` +
                `re-querying oracles...`
            );
        }
    }

    if (agreementScore < AGREEMENT_THRESHOLD) {
        logger.warn(
            `[CONSENSUS] Max rounds reached. Forcing consensus at ${(agreementScore * 100).toFixed(1)}%`
        );
    }

    // ── Merge into Dominant Prophecy ──
    const prophecy = mergePredictions(
        prediction1,
        prediction2,
        provider1.weight,
        provider2.weight,
        agreementScore
    );

    logger.info(`[CONSENSUS] Prophecy ${prophecy.prophecy_id} forged`);
    logger.info(`[CONSENSUS] Threat level: ${prophecy.overall_threat_level}`);
    logger.info(`[CONSENSUS] Top prediction: ${prophecy.predictions[0]?.prediction || 'N/A'}`);
    logger.info(
        `[CONSENSUS] Confidence: ${((prophecy.predictions[0]?.probability || 0) * 100).toFixed(0)}%`
    );

    return prophecy;
}

/**
 * Create a failed prophecy object when the consensus engine cannot operate.
 *
 * @param {string} reason - Why the prophecy failed
 * @returns {Object} A minimal prophecy indicating failure
 */
function createFailedProphecy(reason) {
    return {
        prophecy_id: `PROPH-FAIL-${Date.now().toString(36).toUpperCase()}`,
        generated_at: new Date().toISOString(),
        consensus_score: 0,
        consensus_status: 'FAILED',
        overall_threat_level: 'UNKNOWN',
        predictions: [],
        meta_assessment: `The Nostradamus Engine could not reach the timeline: ${reason}`,
        convergence_markers: [],
        model_contributions: [],
    };
}

// ── Module Exports ─────────────────────────────────────────
module.exports = {
    seekConsensus,
    computeAgreement,
    mergePredictions,
    buildSystemPrompt,
    createFailedProphecy,
};

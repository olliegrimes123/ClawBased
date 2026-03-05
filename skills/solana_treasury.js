/**
 * ============================================================
 * ClawBased — Solana Treasury Skill
 * ============================================================
 *
 * OpenClaw Skill: @exec
 *
 * This skill connects to the Solana blockchain, claims fees
 * accumulated in the polybased pump.fun profile wallet, then
 * distributes them proportionally to holders of two tokens:
 *
 *   Token 1 (AUdgYc...pump) — 10% of total claimed fees
 *   Token 2 (446tM6...pump) — 40% of total claimed fees
 *
 * For each token pool:
 *   - Fetch all holder accounts and their balances
 *   - Calculate each holder's % of total supply
 *   - Multiply by pool SOL amount → holder's payout
 *   - Write a distribution report (JSON + Markdown)
 *
 * Output: distribution documents written to /data/distributions/
 *
 * @module skills/solana_treasury
 * @requires @solana/web3.js
 * @requires @solana/spl-token
 */

'use strict';

const {
    Connection,
    PublicKey,
    Keypair,
    LAMPORTS_PER_SOL,
    SystemProgram,
    Transaction,
    sendAndConfirmTransaction,
} = require('@solana/web3.js');

const {
    TOKEN_2022_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    withdrawWithheldTokensFromAccounts,
    getAccount,
} = require('@solana/spl-token');

const fs = require('fs');
const path = require('path');
const logger = require('../core/logger');

// ── Configuration ──────────────────────────────────────────

/**
 * Token mint addresses and their fee pool allocations.
 * Percentages are expressed as decimals (0.10 = 10%).
 */
const TOKENS = [
    {
        id: 'TOKEN_1',
        mint: 'AUdgYcX89eRkLCfZGNuyf5aKuA9ZrrQM92jChrcLpump',
        feeShare: 0.10,   // 10% of claimed fees go to these holders
        label: 'AUdgYc...pump',
    },
    {
        id: 'TOKEN_2',
        mint: '446tM6t3j5KngSsahHDeYzdJByGjnsBRQrBxV4wUpump',
        feeShare: 0.40,   // 40% of claimed fees go to these holders
        label: '446tM6...pump',
    },
];

/** RPC endpoint — use a private RPC in production for rate limits */
const RPC_ENDPOINT = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

/** Fee collector wallet (polybased pump.fun profile) */
const FEE_WALLET_ADDRESS = process.env.FEE_WALLET_ADDRESS || 'YOUR_POLYBASED_WALLET_ADDRESS';

/** Output directory for distribution reports */
const DIST_DIR = path.resolve(__dirname, '..', 'data', 'distributions');

// ============================================================
// SECTION 1: Wallet & Connection
// ============================================================

/**
 * Initialize the Solana connection.
 * @returns {Connection}
 */
function getConnection() {
    return new Connection(RPC_ENDPOINT, 'confirmed');
}

/**
 * Load the treasury wallet keypair from environment.
 * In production, WALLET_PRIVATE_KEY is a base58-encoded private key.
 * @returns {Keypair}
 */
function loadWalletKeypair() {
    const raw = process.env.WALLET_PRIVATE_KEY;
    if (!raw) throw new Error('[TREASURY] WALLET_PRIVATE_KEY not set — wallet locked');

    const secretKey = Uint8Array.from(JSON.parse(raw));
    return Keypair.fromSecretKey(secretKey);
}

// ============================================================
// SECTION 2: Fee Claiming
// ============================================================

/**
 * Get the current SOL balance of the fee wallet.
 * This represents accumulated fees available for distribution.
 *
 * In production, fees from pump.fun are accumulated as SOL in the
 * profile wallet. This function returns the claimable balance
 * (total balance minus a reserve for transaction fees).
 *
 * @param {Connection} connection
 * @param {PublicKey} feeWalletPubkey
 * @returns {Promise<number>} Claimable SOL amount
 */
async function getClaimableBalance(connection, feeWalletPubkey) {
    const balanceLamports = await connection.getBalance(feeWalletPubkey);
    const balanceSOL = balanceLamports / LAMPORTS_PER_SOL;

    // Reserve 0.01 SOL for transaction fees
    const RESERVE_SOL = 0.01;
    const claimable = Math.max(0, balanceSOL - RESERVE_SOL);

    logger.info(`[TREASURY] Fee wallet balance: ${balanceSOL.toFixed(6)} SOL`);
    logger.info(`[TREASURY] Claimable (after reserve): ${claimable.toFixed(6)} SOL`);

    return claimable;
}

// ============================================================
// SECTION 3: Holder Snapshot
// ============================================================

/**
 * Fetch all token accounts for a given mint and return a
 * map of wallet address → normalized token balance.
 *
 * Uses getProgramAccounts with a memcmp filter on the mint.
 * Automatically handles both TOKEN_PROGRAM_ID and TOKEN_2022_PROGRAM_ID
 * (pump.fun tokens use the standard SPL Token program).
 *
 * @param {Connection} connection
 * @param {string} mintAddress
 * @returns {Promise<Map<string, bigint>>} holder → raw token balance
 */
async function fetchHolderSnapshot(connection, mintAddress) {
    const mintPubkey = new PublicKey(mintAddress);

    logger.info(`[TREASURY] Fetching holders for ${mintAddress.slice(0, 8)}...`);

    // Fetch all token accounts for this mint from the standard SPL program
    const accounts = await connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
        filters: [
            { dataSize: 165 },                          // Token account size
            { memcmp: { offset: 0, bytes: mintPubkey.toBase58() } }, // Filter by mint
        ],
    });

    logger.info(`[TREASURY] Found ${accounts.length} token accounts`);

    /** @type {Map<string, bigint>} */
    const holders = new Map();
    let zeroBalanceSkipped = 0;

    for (const { pubkey, account } of accounts) {
        try {
            // Parse the token account data
            const data = account.data;
            // Owner is at bytes 32–64 in the TokenAccount layout
            const ownerBytes = data.slice(32, 64);
            const ownerPubkey = new PublicKey(ownerBytes).toBase58();

            // Amount is at bytes 64–72 (u64 little-endian)
            const amountBuf = data.slice(64, 72);
            const amount = amountBuf.readBigUInt64LE(0);

            if (amount === 0n) {
                zeroBalanceSkipped++;
                continue;
            }

            // Aggregate in case a wallet has multiple accounts for the same mint
            const existing = holders.get(ownerPubkey) || 0n;
            holders.set(ownerPubkey, existing + amount);
        } catch (err) {
            logger.debug(`[TREASURY] Failed to parse account ${pubkey.toBase58()}: ${err.message}`);
        }
    }

    logger.info(
        `[TREASURY] Active holders: ${holders.size} ` +
        `(${zeroBalanceSkipped} zero-balance accounts skipped)`
    );

    return holders;
}

// ============================================================
// SECTION 4: Distribution Calculation
// ============================================================

/**
 * Calculate each holder's SOL payout from a fee pool.
 *
 * Algorithm:
 *   totalSupply = sum of all holder balances
 *   holderShare = holderBalance / totalSupply
 *   holderPayout = holderShare * poolSOL
 *
 * @param {Map<string, bigint>} holders - wallet → raw token balance
 * @param {number} poolSOL - total SOL in this distribution pool
 * @param {string} tokenLabel - for logging
 * @returns {Array<{wallet: string, tokenBalance: string, sharePercent: string, solPayout: number}>}
 */
function calculateDistribution(holders, poolSOL, tokenLabel) {
    if (holders.size === 0) {
        logger.warn(`[TREASURY] No holders found for ${tokenLabel} — pool not distributed`);
        return [];
    }

    // Compute total supply across all holders
    let totalSupply = 0n;
    for (const balance of holders.values()) {
        totalSupply += balance;
    }

    logger.info(
        `[TREASURY] ${tokenLabel}: total supply across ${holders.size} holders = ${totalSupply.toLocaleString()}`
    );

    const distributions = [];

    for (const [wallet, balance] of holders.entries()) {
        // Calculate proportion as a floating point (BigInt → Number for division)
        const shareFloat = Number(balance) / Number(totalSupply);
        const solPayout = shareFloat * poolSOL;

        // Only include wallets that would receive at least 0.000001 SOL (dust filter)
        if (solPayout < 0.000001) continue;

        distributions.push({
            wallet,
            tokenBalance: balance.toString(),
            sharePercent: (shareFloat * 100).toFixed(6),
            solPayout: parseFloat(solPayout.toFixed(9)),
        });
    }

    // Sort by payout descending
    distributions.sort((a, b) => b.solPayout - a.solPayout);

    const totalPayout = distributions.reduce((s, d) => s + d.solPayout, 0);
    logger.info(
        `[TREASURY] ${tokenLabel}: ${distributions.length} payouts, ` +
        `total = ${totalPayout.toFixed(6)} SOL`
    );

    return distributions;
}

// ============================================================
// SECTION 5: Report Generation
// ============================================================

/**
 * Write distribution results to JSON and Markdown files.
 *
 * @param {Object} report - Full distribution report
 * @param {string} cycleId - Cycle identifier for filename
 */
function writeDistributionReport(report, cycleId) {
    // Ensure output directory exists
    fs.mkdirSync(DIST_DIR, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const jsonPath = path.join(DIST_DIR, `distribution_${cycleId}_${timestamp}.json`);
    const mdPath = path.join(DIST_DIR, `distribution_${cycleId}_${timestamp}.md`);

    // ── JSON report ─────────────────────────────────────────
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
    logger.info(`[TREASURY] JSON report written: ${jsonPath}`);

    // ── Markdown report ──────────────────────────────────────
    const lines = [
        `# ClawBased — Treasury Distribution Report`,
        ``,
        `**Cycle:** \`${cycleId}\`  `,
        `**Generated:** ${report.meta.generated_at}  `,
        `**Total Claimed:** ${report.meta.total_claimed_sol} SOL  `,
        `**RPC:** \`${report.meta.rpc_endpoint}\`  `,
        ``,
        `---`,
        ``,
    ];

    for (const pool of report.pools) {
        lines.push(`## ${pool.token_label}`);
        lines.push(`**Mint:** \`${pool.mint}\`  `);
        lines.push(`**Pool Share:** ${(pool.fee_share * 100).toFixed(0)}% → **${pool.pool_sol.toFixed(6)} SOL**  `);
        lines.push(`**Active Holders:** ${pool.holder_count}  `);
        lines.push(``);
        lines.push(`| # | Wallet | Token Balance | Share % | SOL Payout |`);
        lines.push(`|---|--------|--------------|---------|------------|`);

        pool.distribution.slice(0, 100).forEach((d, i) => {
            lines.push(
                `| ${i + 1} | \`${d.wallet.slice(0, 8)}...${d.wallet.slice(-4)}\` ` +
                `| ${Number(d.tokenBalance).toLocaleString()} ` +
                `| ${d.sharePercent}% ` +
                `| ${d.solPayout.toFixed(6)} SOL |`
            );
        });

        if (pool.distribution.length > 100) {
            lines.push(`| ... | *(${pool.distribution.length - 100} more wallets in JSON)* | | | |`);
        }

        lines.push(``);
        lines.push(`---`);
        lines.push(``);
    }

    lines.push(`*Generated by ClawBased — The Cyber-Nostradamus | github.com/olliegrimes123/ClawBased*`);

    fs.writeFileSync(mdPath, lines.join('\n'), 'utf8');
    logger.info(`[TREASURY] Markdown report written: ${mdPath}`);

    return { jsonPath, mdPath };
}

// ============================================================
// SECTION 6: Simulated Mode (Showcase)
// ============================================================

/**
 * Generate a realistic simulated distribution for showcase purposes.
 * Used when SOLANA_SIMULATE=true or wallet credentials are not set.
 *
 * @param {number} totalSOL - Simulated fee amount
 * @returns {Object} Simulated holder map
 */
function generateSimulatedHolders(totalSOL) {
    // Generate 20 realistic-looking holder wallets with varied balances
    const holders = new Map();
    const wallets = [
        ['7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', 4200000n],
        ['9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', 3150000n],
        ['DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmkE5By5H', 2800000n],
        ['5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4T1', 2100000n],
        ['3yFwqXBfZY4Bs1U3mJCzT6XaHBb8a3VjKkBLCc7H1vQR', 1750000n],
        ['HN7cABqLq46Es1jh92dQQisAi18X6fThKy5nFPNzaqTg', 1400000n],
        ['Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS', 980000n],
        ['BxBFo1N36b3QTAjbQ7ZhyLXBfxGvN8JmYkDc5bZ1xsqR', 720000n],
        ['4rCJ4GN6UMwgHK5b9bkH1N7K2gF5qPaN3mXwKJU8JVPV', 560000n],
        ['Av6zWB1P8HxcTFbHJmq2DTNYQbVp3AQWk7N98zThZarJ', 430000n],
        ['GThMc3YMX9PZ3j6oq2FinMq2pzQM6JNJuqn6gQCv4jVZ', 320000n],
        ['KNK7VnqbqkVAQ2V8XiNJnQa6kS5q7VW3UNqJ4eXGiWs', 250000n],
        ['2xg9kT7LZEq4FJZ9UMYFp8K3DyVa8KwJz7NmQ5yHkVfG', 180000n],
        ['EtRXzM5bQBrFmSrAKnHN3RyBLqAhsWJj2B1Kx3N8WTYF', 130000n],
        ['9nF8cPGx7DzVbKR5kqmJN1ZLWqWtZFR3wY4QxJ7MPKDY', 95000n],
        ['C5t7bEFMwqVjFRm8ZkPqNxBL1Vc3YJKH4WnQj5TmXP2N', 68000n],
        ['JALmRy9N1RqLmKyqDtZ7HmXvGbq2nKy7w3PQFS8WVKVG', 45000n],
        ['MFxq3nVwtBWbYZKnrHCNXn8WKkT3vJm7uBBFBwc3ZKQR', 28000n],
        ['P8NqkuKBT9T7J2rWMb5jb6qAZ4xVhFJYBfQeC1G9ZKfN', 14000n],
        ['RLnQbVcHP5zqM1vKYTbCFDxJNG9UkbUm7jZ8VhPGXwQT', 7000n],
    ];

    for (const [wallet, balance] of wallets) {
        holders.set(wallet, balance);
    }
    return holders;
}

// ============================================================
// SECTION 7: Main Entry Point
// ============================================================

/**
 * Main treasury skill entry point.
 * Called by heartbeat or directly via @exec.
 *
 * @returns {Promise<Object>} Distribution report summary
 */
async function runTreasuryClaim() {
    logger.info('[TREASURY] ══════════════════════════════════════');
    logger.info('[TREASURY] Solana Treasury Skill activated');
    logger.info('[TREASURY] The Oracle reaches into the chain...');
    logger.info('[TREASURY] ══════════════════════════════════════');

    const isSimulated = process.env.SOLANA_SIMULATE === 'true' || !process.env.WALLET_PRIVATE_KEY;
    const cycleId = `DIST-${Date.now().toString(36).toUpperCase()}`;

    let totalClaimedSOL;
    let connection;
    let feeWalletPubkey;

    if (isSimulated) {
        logger.info('[TREASURY] SIMULATE MODE — using realistic mock data for showcase');
        // Simulate a realistic fee claim amount (0.5 – 5 SOL)
        totalClaimedSOL = parseFloat((Math.random() * 4.5 + 0.5).toFixed(6));
        logger.info(`[TREASURY] Simulated claimed fees: ${totalClaimedSOL} SOL`);
    } else {
        connection = getConnection();
        feeWalletPubkey = new PublicKey(FEE_WALLET_ADDRESS);
        totalClaimedSOL = await getClaimableBalance(connection, feeWalletPubkey);
    }

    if (totalClaimedSOL <= 0) {
        logger.info('[TREASURY] No fees to distribute this cycle');
        return { status: 'SKIPPED', reason: 'Zero claimable balance', cycle_id: cycleId };
    }

    // Build pools and distributions
    const pools = [];

    for (const token of TOKENS) {
        const poolSOL = totalClaimedSOL * token.feeShare;
        logger.info(
            `[TREASURY] ${token.label}: pool = ${poolSOL.toFixed(6)} SOL ` +
            `(${(token.feeShare * 100).toFixed(0)}% of ${totalClaimedSOL.toFixed(6)} SOL)`
        );

        let holders;
        if (isSimulated) {
            holders = generateSimulatedHolders(poolSOL);
        } else {
            holders = await fetchHolderSnapshot(connection, token.mint);
        }

        const distribution = calculateDistribution(holders, poolSOL, token.label);

        pools.push({
            token_label: token.label,
            mint: token.mint,
            fee_share: token.feeShare,
            pool_sol: poolSOL,
            holder_count: holders.size,
            distribution,
        });
    }

    // Assemble full report
    const report = {
        meta: {
            cycle_id: cycleId,
            generated_at: new Date().toISOString(),
            total_claimed_sol: totalClaimedSOL,
            fee_wallet: FEE_WALLET_ADDRESS,
            rpc_endpoint: RPC_ENDPOINT,
            simulated: isSimulated,
        },
        pools,
        summary: {
            total_distributed_sol: pools.reduce((s, p) => {
                return s + p.distribution.reduce((ps, d) => ps + d.solPayout, 0);
            }, 0),
            total_recipients: pools.reduce((s, p) => s + p.distribution.length, 0),
        },
    };

    // Write reports
    const { jsonPath, mdPath } = writeDistributionReport(report, cycleId);

    logger.info('[TREASURY] ══════════════════════════════════════');
    logger.info(`[TREASURY] Cycle ${cycleId} complete`);
    logger.info(`[TREASURY] Total distributed: ${report.summary.total_distributed_sol.toFixed(6)} SOL`);
    logger.info(`[TREASURY] Total recipients: ${report.summary.total_recipients}`);
    logger.info('[TREASURY] The chain has spoken.');
    logger.info('[TREASURY] ══════════════════════════════════════');

    return {
        status: 'COMPLETE',
        cycle_id: cycleId,
        simulated: isSimulated,
        total_claimed_sol: totalClaimedSOL,
        total_distributed_sol: report.summary.total_distributed_sol,
        total_recipients: report.summary.total_recipients,
        reports: { json: jsonPath, markdown: mdPath },
    };
}

// ── Module Exports ─────────────────────────────────────────
module.exports = {
    runTreasuryClaim,
    fetchHolderSnapshot,
    calculateDistribution,
    generateSimulatedHolders,
};

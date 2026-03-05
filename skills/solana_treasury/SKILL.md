---
name: clawbased-solana-treasury
description: Claims accumulated SOL fees from the polybased pump.fun wallet, snapshots holders of two token mints, distributes 10% of fees to Token 1 holders and 40% to Token 2 holders proportionally, and writes a JSON + Markdown distribution report.
homepage: https://github.com/olliegrimes123/ClawBased
user-invocable: false
disable-model-invocation: false
---

# Solana Treasury Skill

Automates the full fee-claim and holder distribution cycle.

## Token pools

| Token | Mint | Fee Share |
|-------|------|-----------|
| Token 1 | `AUdgYcX89eRkLCfZGNuyf5aKuA9ZrrQM92jChrcLpump` | 10% |
| Token 2 | `446tM6t3j5KngSsahHDeYzdJByGjnsBRQrBxV4wUpump` | 40% |

## How it works

1. **Claim** — reads claimable SOL balance from the polybased fee wallet
2. **Split** — 10% to Token 1 pool, 40% to Token 2 pool
3. **Snapshot** — fetches every token account for each mint, aggregates balances per wallet
4. **Calculate** — each holder's payout = (their balance / total supply) × pool SOL
5. **Report** — writes a JSON + Markdown distribution document to `/data/distributions/`

## Entry point

```js
const { runTreasuryClaim } = require('{baseDir}/solana_treasury.js');
const result = await runTreasuryClaim();
```

## Simulate mode (showcase)

Set `SOLANA_SIMULATE=true` in `.env` to run with realistic mock data — no real wallet or RPC needed.

```bash
SOLANA_SIMULATE=true node -e "require('./skills/solana_treasury').runTreasuryClaim()"
```

## Environment variables required

- `SOLANA_RPC_URL` — Solana mainnet RPC endpoint
- `FEE_WALLET_ADDRESS` — polybased pump.fun wallet public key
- `WALLET_PRIVATE_KEY` — treasury keypair as JSON byte array (for signing)
- `SOLANA_SIMULATE` — set `true` to run in mock mode (optional)

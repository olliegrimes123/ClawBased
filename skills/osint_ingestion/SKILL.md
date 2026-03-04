---
name: clawbased-osint-ingestion
description: Scrapes global news (RSS), crypto sentiment, and OSINT signals to assemble a Timeline Snapshot for the Nostradamus Engine.
homepage: https://github.com/olliegrimes292/ClawBased
user-invocable: false
disable-model-invocation: false
---

# OSINT Ingestion Skill

Pulls intelligence from multiple data vectors every heartbeat cycle:

- **Global news** — BBC World, Reuters, NYT, Al Jazeera via RSS
- **Crypto sentiment** — Fear & Greed Index, top-10 market caps, BTC/ETH spot prices
- **OSINT signal scoring** — keyword-weighted relevance scoring across all ingested articles

**Output:** A structured Timeline Snapshot JSON object passed to `clawbased-multi-llm-consensus`.

## Entry point

```js
const { ingestTimeline } = require('{baseDir}/osint_ingestion.js');
const snapshot = await ingestTimeline();
```

## Environment variables required

- `NEWSAPI_KEY` — (optional) NewsAPI key for additional sources
- `CRYPTOCOMPARE_API_KEY` — CryptoCompare API key for market data

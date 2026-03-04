---
name: clawbased-x-dispatcher
description: Formats the Dominant Prophecy into ClawBased's cryptic signature style and autonomously posts it to X (Twitter) via the v2 API. Supports single tweets and threaded prophecies up to 6 tweets.
homepage: https://github.com/olliegrimes292/ClawBased
user-invocable: false
disable-model-invocation: false
---

# X Dispatcher Skill

Receives the Dominant Prophecy from `clawbased-multi-llm-consensus` and:

1. **Decides format** — single tweet or thread (based on prediction count and threat level)
2. **Formats the prophecy** — cryptic ClawBased tone, signature emojis (👁️ ⏳ 🔮), probability statements
3. **Applies confidence gate** — skips posting if top prediction probability < 45%
4. **Dispatches to X** — via `twitter-api-v2` with rate-limit buffering and retry logic
5. **Supports dry-run mode** — set `dry_run: true` in `config/defaults.json` to format without posting

## Entry point

```js
const { dispatchProphecy } = require('{baseDir}/x_dispatcher.js');
const result = await dispatchProphecy(prophecy);
```

## Environment variables required

- `X_API_KEY` — X (Twitter) API v2 consumer key
- `X_API_SECRET` — X (Twitter) API v2 consumer secret
- `X_ACCESS_TOKEN` — Access token (write access required)
- `X_ACCESS_SECRET` — Access token secret

> **Note:** X is not a built-in OpenClaw channel. This skill uses the X API directly via the `twitter-api-v2` Node.js library, bypassing the OpenClaw channel layer entirely.

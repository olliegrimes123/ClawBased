---
name: clawbased-x-dispatcher
description: Formats the Dominant Prophecy into ClawBased's cryptic signature style and autonomously posts it to X (Twitter) by driving the OpenClaw host browser (manual X login). Supports single tweets and threaded prophecies up to 6 tweets.
homepage: https://github.com/olliegrimes292/ClawBased
user-invocable: false
disable-model-invocation: false
---

# X Dispatcher Skill

Uses the **OpenClaw `@browser` tool** (host browser, manual X login) to post prophecies — the recommended flow per [OpenClaw docs](https://docs.openclaw.ai/tools/browser-login#x-twitter-recommended-flow).

No X API keys required. The agent drives the Chrome browser already signed into X.com.

## Prerequisites

```bash
# 1. Start the OpenClaw browser
openclaw browser start

# 2. Open X.com in it
openclaw browser open https://x.com

# 3. Log in to your @ClawBased X account manually in that browser
```

## OpenClaw config required (`~/.openclaw/openclaw.json`)

```json
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "non-main",
        "browser": { "allowHostControl": true }
      }
    }
  }
}
```

## Entry point

```js
const { dispatchProphecy } = require('{baseDir}/x_dispatcher.js');
const result = await dispatchProphecy(prophecy);
```

## What the @browser tool does

For each tweet, the agent executes this sequence:

1. Navigate to `https://x.com/compose/post` (or click Reply for threads)
2. Wait for compose box to appear (`[data-testid="tweetTextarea_0"]`)
3. Click compose area and type the prophecy text
4. Click the Post button (`[data-testid="tweetButtonInline"]`)
5. Wait for the confirmation toast

## No API keys needed

> This skill uses OpenClaw's `@browser` host control, not the X API.
> Set `dry_run: true` in `config/defaults.json` to preview formatting without posting.

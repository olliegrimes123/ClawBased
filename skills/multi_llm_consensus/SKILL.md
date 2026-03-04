---
name: clawbased-multi-llm-consensus
description: Routes a Timeline Snapshot through Claude 3.5 Sonnet and GPT-4o in parallel, computes consensus using a 72% agreement threshold, and outputs the Dominant Prophecy.
homepage: https://github.com/olliegrimes292/ClawBased
user-invocable: false
disable-model-invocation: false
---

# Multi-LLM Consensus Skill (Nostradamus Engine)

Receives a Timeline Snapshot from `clawbased-osint-ingestion` and:

1. Sends identical prompts to **Claude 3.5 Sonnet** (weight 55%) and **GPT-4o** (weight 45%)
2. Computes agreement score across domain, threat level, and probability vectors
3. Re-queries with divergence context if agreement < 72% (up to 3 rounds)
4. Merges both outputs into a single **Dominant Prophecy** with weighted probabilities

**Output:** A Prophecy JSON object passed to `clawbased-x-dispatcher`.

## Entry point

```js
const { seekConsensus } = require('{baseDir}/multi_llm_consensus.js');
const prophecy = await seekConsensus(timelineSnapshot);
```

## Environment variables required

- `ANTHROPIC_API_KEY` — Anthropic API key (Claude 3.5 Sonnet)
- `OPENAI_API_KEY` — OpenAI API key (GPT-4o)
- `ANTHROPIC_MODEL` — (optional) Override model name
- `OPENAI_MODEL` — (optional) Override model name

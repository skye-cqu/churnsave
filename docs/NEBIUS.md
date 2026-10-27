# Nebius Token Factory — one-step AI decision layer setup

ChurnSave's LLM decision layer calls an **OpenAI-compatible chat completions
endpoint** at runtime. The reference deployment is [Nebius Token Factory](https://nebius.ai/studio/inference-service)
running the NVIDIA open model `nvidia/llama-3.1-nemotron-70b-instruct`
(required by the Nebius × NVIDIA hackathon rules). Any other OpenAI-compatible
endpoint works too — see "Custom endpoints" below.

**Without a key nothing breaks**: the agent runs the deterministic offline
`MockProvider`, every trace step is labeled, and the closed loop stays green.

## 1. Get a key

1. Sign in at <https://studio.nebius.ai> (free tier available).
2. Enable the **Token Factory** service.
3. Create an API key under **API Keys**.

## 2. Configure env

```bash
cp .env.example .env
```

```dotenv
LLM_ENABLED=true
NEBIUS_API_KEY=napi_xxxxxxxxxxxxxxxxxxxx
NEBIUS_MODEL=nvidia/llama-3.1-nemotron-70b-instruct
# optional overrides
# NEBIUS_BASE_URL=https://api.studio.nebius.ai/v1
# NEBIUS_TIMEOUT_MS=3000
```

## 3. Verify the key with curl

```bash
curl -s https://api.studio.nebius.ai/v1/chat/completions \
  -H "Authorization: Bearer $NEBIUS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nvidia/llama-3.1-nemotron-70b-instruct",
    "max_tokens": 100,
    "response_format": {"type": "json_object"},
    "messages": [
      {"role": "system", "content": "Respond ONLY with JSON: {\"reasoning\": string, \"confidence\": number}"},
      {"role": "user", "content": "A champion buyer (12 payments, $588 LTV) cancelled. Why does 20% off for 3 months fit them?"}
    ]
  }'
```

A 200 response with a `choices[0].message.content` JSON body means the key,
model name and endpoint are all good.

## 4. Run and confirm

```bash
npm run seed && npm run dev
```

Hit **Cancel** on a subscriber. You should now see:

- Dashboard header: `AI decision layer: Nebius · nvidia/llama-3.1-nemotron-70b-instruct`
- Event stream trace: `llm:profile:nebius` and `llm:reasoning:nebius(conf:0.87)`
- Offer cards and the buyer page: the AI-generated reasoning with a
  `AI: Nebius` tag and a confidence percentage.

The agent still never waits on the LLM for more than `NEBIUS_TIMEOUT_MS`
(default 3s). On timeout, HTTP error or unparseable JSON it falls back to the
deterministic rule copy (`AI: rules` tag, `llm:reasoning:fallback(...)` in the
trace) and the offer is created regardless.

## What the LLM does (and does not do)

| Step | Role | Fallback |
| ---- | ---- | -------- |
| `summarizeBuyerHistory` | transactions → natural-language buyer portrait | locally computed portrait |
| `decideOfferReasoning` | reviews the rule-engine offer candidate, writes a one-sentence personalized rationale + confidence | rule copy, provider label `rules` |

The **rule engine keeps the decision authority** (which offer, what discount).
The LLM adds explainability and personalization on top — safe to disable at any
time via `LLM_ENABLED=false` (pure-rules mode, zero LLM calls).

## Custom endpoints

Point at any OpenAI-compatible server by setting `OPENAI_COMPAT_BASE_URL`
(takes precedence over `NEBIUS_BASE_URL`):

```dotenv
OPENAI_COMPAT_BASE_URL=https://integrations.nexus.start.nebius.cloud/v1
```

`NEBIUS_API_KEY` is used as the bearer token for whatever endpoint you choose.

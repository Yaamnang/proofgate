// agent/llm.js
// Thin OpenAI-compatible client for Vultr Serverless Inference.
// Every LLM call in ProofGate goes through here and nowhere else.

const BASE_URL = process.env.VULTR_INFERENCE_URL || 'https://api.vultrinference.com/v1';
const API_KEY = process.env.VULTR_INFERENCE_API_KEY || '';
const MODEL = process.env.VULTR_MODEL || 'llama-3.3-70b-instruct';

function available() {
  return API_KEY.length > 0;
}

// Low-level chat completion. Returns the assistant message content string.
async function chat(messages, { temperature = 0, jsonMode = true, maxTokens = 1200 } = {}) {
  if (!available()) {
    const err = new Error('VULTR_INFERENCE_API_KEY not set');
    err.code = 'NO_KEY';
    throw err;
  }
  const body = {
    model: MODEL,
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  if (jsonMode) body.response_format = { type: 'json_object' };

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // Some models reject response_format; retry once without it.
    if (jsonMode && (res.status === 400 || res.status === 422)) {
      return chat(messages, { temperature, jsonMode: false, maxTokens });
    }
    const err = new Error(`Vultr inference error ${res.status}: ${text.slice(0, 300)}`);
    err.code = 'API_ERROR';
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

// Parse the first JSON object/array found in a model response.
function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {}
  const match = text.match(/[[{][\s\S]*[\]}]/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch (_) {}
  }
  return null;
}

module.exports = { chat, parseJson, available, MODEL, BASE_URL };

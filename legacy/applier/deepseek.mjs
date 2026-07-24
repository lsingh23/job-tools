// Shared DeepSeek (OpenAI-compatible) chat helper for the applier.
//   export DEEPSEEK_API_KEY=sk-...   before starting the server.
// Used by both /tailor (résumé tailoring) and /answer (form-question answering).

const URL   = process.env.DEEPSEEK_URL   ?? "https://api.deepseek.com/chat/completions";
const MODEL = process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash";
const KEY   = process.env.DEEPSEEK_API_KEY ?? "";

export const DEEPSEEK_MODEL = MODEL;
export const hasDeepSeekKey = () => !!KEY;

/**
 * Returns the assistant message content string. `json:true` requests a JSON object.
 * Pass `onDelta(text)` to stream: the request switches to SSE and onDelta fires for
 * each token chunk as it arrives (the full string is still returned at the end).
 */
export async function deepseekChat({ system, user, temperature = 0.3, json = false, onDelta = null }) {
  if (!KEY) throw new Error("DEEPSEEK_API_KEY is not set (export it before starting the server)");
  const streaming = typeof onDelta === "function";
  const body = {
    model: MODEL, stream: streaming, temperature,
    thinking: { type: "disabled" },
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
  };
  if (json) body.response_format = { type: "json_object" };
  const res = await fetch(URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${(await res.text()).slice(0, 300)}`);
  if (!streaming) {
    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? "";
  }

  // SSE stream: lines are "data: {...}" chunks, terminated by "data: [DONE]".
  let full = "", buf = "";
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.replace(/^data:\s*/, "").trim();
      if (!line || line === "[DONE]") continue;
      try {
        const delta = JSON.parse(line).choices?.[0]?.delta?.content ?? "";
        if (delta) { full += delta; onDelta(delta); }
      } catch { /* ignore keep-alive/partial lines */ }
    }
  }
  return full;
}

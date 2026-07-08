// Streaming BYOK API clients for the three providers Slash supports.
// Each function streams assistant text back through an onDelta callback,
// using the user's own API key. No keys, endpoints, or models are baked
// in beyond public, editable defaults.

// Read a fetch Response body as Server-Sent Events, calling onData with
// each "data:" payload string.
async function readSSE(res, onData) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (line.startsWith('data:')) onData(line.slice(5).trim());
    }
  }
  // Flush a final event that ended the stream without a trailing newline,
  // otherwise the last token / stop-reason event is silently dropped.
  buffer += decoder.decode();
  const last = buffer.replace(/\r$/, '');
  if (last.startsWith('data:')) onData(last.slice(5).trim());
}

// A provider's stream can carry an error event mid-flight (rate limit, overload,
// safety stop). Detect it so we surface the failure instead of silently handing
// the user a truncated answer. Returns a message string, or null if not an error.
function sseError(evt) {
  if (!evt || typeof evt !== 'object') return null;
  if (evt.type === 'error') return (evt.error && evt.error.message) || 'stream error';
  if (evt.error) return evt.error.message || (evt.error.code ? 'error ' + evt.error.code : 'stream error');
  return null;
}

// --- Anthropic agent loop (tool use) ---
// One streaming turn. Accumulates text + tool_use content blocks and the
// stop reason. Text is streamed live through onDelta.
async function anthropicTurn({ apiKey, model, system, messages, tools, onDelta, signal }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens: 2048, stream: true, system, messages, tools }),
    signal,
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const blocks = [];
  let cur = null;
  let jsonBuf = '';
  let stopReason = null;
  await readSSE(res, (data) => {
    if (data === '[DONE]') return;
    let evt;
    try {
      evt = JSON.parse(data);
    } catch {
      return;
    }
    const err = sseError(evt);
    if (err) throw new Error('Anthropic stream error: ' + err);
    if (evt.type === 'content_block_start') {
      cur = { ...evt.content_block };
      if (cur.type === 'text') cur.text = '';
      if (cur.type === 'tool_use') jsonBuf = '';
    } else if (evt.type === 'content_block_delta') {
      if (evt.delta?.type === 'text_delta') {
        cur.text += evt.delta.text;
        onDelta(evt.delta.text);
      } else if (evt.delta?.type === 'input_json_delta') {
        jsonBuf += evt.delta.partial_json || '';
      }
    } else if (evt.type === 'content_block_stop') {
      if (cur) {
        if (cur.type === 'tool_use') {
          try {
            cur.input = jsonBuf ? JSON.parse(jsonBuf) : {};
          } catch {
            cur.input = {};
          }
        }
        blocks.push(cur);
        cur = null;
      }
    } else if (evt.type === 'message_delta') {
      if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
    }
  });
  return { blocks, stopReason };
}

// Run a full tool-use conversation: stream a turn, execute any tools the model
// asked for, feed the results back, and repeat until it stops calling tools.
async function runAnthropicAgent({ apiKey, model, system, messages, tools, onDelta, onTool, executeTool, signal }) {
  const convo = messages.slice();
  for (let turn = 0; turn < 8; turn++) {
    const { blocks, stopReason } = await anthropicTurn({ apiKey, model, system, messages: convo, tools, onDelta, signal });
    const content = blocks.map((b) =>
      b.type === 'text'
        ? { type: 'text', text: b.text }
        : { type: 'tool_use', id: b.id, name: b.name, input: b.input },
    );
    convo.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '' }] });
    if (stopReason !== 'tool_use') break;

    const results = [];
    for (const b of blocks) {
      if (b.type !== 'tool_use') continue;
      if (onTool) onTool({ phase: 'start', name: b.name, input: b.input });
      let result;
      try {
        result = await executeTool(b.name, b.input);
      } catch (e) {
        result = 'Tool error: ' + (e && e.message ? e.message : String(e));
      }
      if (onTool) onTool({ phase: 'end', name: b.name, result });
      results.push({ type: 'tool_result', tool_use_id: b.id, content: String(result).slice(0, 12000) });
    }
    convo.push({ role: 'user', content: results });
  }
}

// --- OpenAI agent loop (function calling) ---
// One streaming turn. Streams assistant text through onDelta and accumulates
// any tool calls (their arguments arrive as fragments, keyed by index).
async function openaiTurn({ apiKey, model, messages, tools, onDelta, signal }) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey },
    body: JSON.stringify({ model, stream: true, messages, tools }),
    signal,
  });
  if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  let text = '';
  const calls = []; // accumulated by tool_call index
  await readSSE(res, (data) => {
    if (data === '[DONE]') return;
    let evt;
    try {
      evt = JSON.parse(data);
    } catch {
      return;
    }
    const err = sseError(evt);
    if (err) throw new Error('OpenAI stream error: ' + err);
    const d = evt.choices?.[0]?.delta;
    if (!d) return;
    if (d.content) {
      text += d.content;
      onDelta(d.content);
    }
    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        const i = tc.index ?? 0;
        if (!calls[i]) calls[i] = { id: '', name: '', args: '' };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) calls[i].name = tc.function.name;
        if (tc.function?.arguments) calls[i].args += tc.function.arguments;
      }
    }
  });
  return { text, calls: calls.filter(Boolean) };
}

// Run a full tool-use conversation against the OpenAI chat completions API.
async function runOpenAiAgent({ apiKey, model, system, messages, tools, onDelta, onTool, executeTool, signal }) {
  const oaTools = tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
  const convo = [{ role: 'system', content: system }, ...messages];
  for (let turn = 0; turn < 8; turn++) {
    const { text, calls } = await openaiTurn({ apiKey, model, messages: convo, tools: oaTools, onDelta, signal });
    const assistant = { role: 'assistant', content: text || null };
    if (calls.length) {
      assistant.tool_calls = calls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.args || '{}' },
      }));
    }
    convo.push(assistant);
    if (!calls.length) break;
    for (const c of calls) {
      let input = {};
      try {
        input = c.args ? JSON.parse(c.args) : {};
      } catch {
        input = {};
      }
      if (onTool) onTool({ phase: 'start', name: c.name, input });
      let result;
      try {
        result = await executeTool(c.name, input);
      } catch (e) {
        result = 'Tool error: ' + (e && e.message ? e.message : String(e));
      }
      if (onTool) onTool({ phase: 'end', name: c.name, result });
      convo.push({ role: 'tool', tool_call_id: c.id, content: String(result).slice(0, 12000) });
    }
  }
}

// --- Google Gemini agent loop (function calling) ---
// Gemini's function declarations use an OpenAPI-subset schema whose types are
// upper-cased. Translate our Anthropic-style input_schema into it.
function toGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  if (schema.type) out.type = String(schema.type).toUpperCase();
  if (schema.description) out.description = schema.description;
  if (schema.properties) {
    out.properties = {};
    for (const k of Object.keys(schema.properties)) out.properties[k] = toGeminiSchema(schema.properties[k]);
  }
  if (Array.isArray(schema.required)) out.required = schema.required;
  if (schema.items) out.items = toGeminiSchema(schema.items);
  return out;
}

async function geminiTurn({ apiKey, model, system, contents, decls, onDelta, signal }) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}` +
    `:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents,
    tools: [{ function_declarations: decls }],
    system_instruction: { parts: [{ text: system }] },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`Google API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  let text = '';
  const fcalls = []; // { name, args }
  await readSSE(res, (data) => {
    let evt;
    try {
      evt = JSON.parse(data);
    } catch {
      return;
    }
    const err = sseError(evt);
    if (err) throw new Error('Google stream error: ' + err);
    const parts = evt.candidates?.[0]?.content?.parts;
    if (!parts) return;
    for (const p of parts) {
      if (typeof p.text === 'string') {
        text += p.text;
        onDelta(p.text);
      } else if (p.functionCall) {
        fcalls.push(p.functionCall);
      }
    }
  });
  return { text, fcalls };
}

async function runGoogleAgent({ apiKey, model, system, messages, tools, onDelta, onTool, executeTool, signal }) {
  const decls = tools.map((t) => {
    const fn = { name: t.name, description: t.description };
    // Gemini rejects an empty parameters object, so omit it for no-arg tools.
    if (t.input_schema?.properties && Object.keys(t.input_schema.properties).length) {
      fn.parameters = toGeminiSchema(t.input_schema);
    }
    return fn;
  });
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  for (let turn = 0; turn < 8; turn++) {
    const { text, fcalls } = await geminiTurn({ apiKey, model, system, contents, decls, onDelta, signal });
    const modelParts = [];
    if (text) modelParts.push({ text });
    for (const fc of fcalls) modelParts.push({ functionCall: fc });
    contents.push({ role: 'model', parts: modelParts.length ? modelParts : [{ text: '' }] });
    if (!fcalls.length) break;
    // Function results go back as a user turn of functionResponse parts.
    const respParts = [];
    for (const fc of fcalls) {
      const input = fc.args || {};
      if (onTool) onTool({ phase: 'start', name: fc.name, input });
      let result;
      try {
        result = await executeTool(fc.name, input);
      } catch (e) {
        result = 'Tool error: ' + (e && e.message ? e.message : String(e));
      }
      if (onTool) onTool({ phase: 'end', name: fc.name, result });
      respParts.push({
        functionResponse: { name: fc.name, response: { result: String(result).slice(0, 12000) } },
      });
    }
    contents.push({ role: 'user', parts: respParts });
  }
}

module.exports = { runAnthropicAgent, runOpenAiAgent, runGoogleAgent, sseError };

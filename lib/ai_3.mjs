// Проксі до Claude API з web search (спільний код для Node-сервера та Netlify Functions)
// ---------- Claude proxy ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);

// POST до Claude API з перепробою. Якщо заголовки відповіді не прийшли за AI_HEADERS_TIMEOUT_MS (за замовч. 60 с) —
// зависле зʼєднання обривається й запит повторюється (без цього Node чекає 5 хв: UND_ERR_HEADERS_TIMEOUT).
// Повторюємо також мережеві збої та тимчасові відповіді API (429 / 5xx / 529 overloaded). Усього AI_MAX_ATTEMPTS спроб (за замовч. 3).
async function postMessages(url, headers, body) {
  const headersMs = +process.env.AI_HEADERS_TIMEOUT_MS || 60e3;
  const attempts = Math.max(1, +process.env.AI_MAX_ATTEMPTS || 3);
  let lastErr;
  for (let a = 1; a <= attempts; a++) {
    const ac = new AbortController();
    const total = AbortSignal.timeout(600e3);
    total.addEventListener('abort', () => ac.abort(total.reason), { once: true });
    const hdrTimer = setTimeout(() => ac.abort(new Error('немає відповіді від Claude API за ' + Math.round(headersMs / 1000) + ' с')), headersMs);
    try {
      const r = await fetch(url, { method: 'POST', headers, body, signal: ac.signal });
      clearTimeout(hdrTimer);
      if (RETRY_STATUS.has(r.status) && a < attempts) {
        const wait = Math.min(20e3, (+r.headers.get('retry-after') || 0) * 1000) || 1500 * a;
        await r.body?.cancel().catch(() => {});
        await sleep(wait);
        continue;
      }
      return r;
    } catch (e) {
      clearTimeout(hdrTimer); lastErr = e;
      if (a < attempts) await sleep(1500 * a);
    }
  }
  const c = lastErr && lastErr.cause;
  throw new Error('Мережа до Claude API (спроб: ' + attempts + '): ' + ((lastErr && lastErr.message) || lastErr) + (c ? ' (' + (c.code || '') + ' ' + (c.message || c) + ')' : '') + '. Якщо повторюється — перевірте ANTHROPIC_API_KEY (без пробілів/переносів) та ANTHROPIC_BASE_URL (має бути порожнім або https://api.anthropic.com)');
}

export async function callClaude({ system, prompt, messages, web, maxTokens, model }) {
  if (!(process.env.ANTHROPIC_API_KEY || '').trim()) throw new Error('На сервері не задано ANTHROPIC_API_KEY');
  const msgs = messages || [{ role: 'user', content: prompt }];
  const citations = new Map();
  let text = '';
  let usage = { input_tokens: 0, output_tokens: 0 };
  let convo = msgs.slice();
  for (let turn = 0; turn < 5; turn++) {
    const body = { model: model || (process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5'), max_tokens: Math.min(maxTokens || 8000, 32000), system, messages: convo, stream: true };
    if (web) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }];
    const r = await postMessages(
      (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').trim().replace(/\/$/, '') + '/v1/messages',
      { 'content-type': 'application/json', 'x-api-key': (process.env.ANTHROPIC_API_KEY || '').trim(), 'anthropic-version': '2023-06-01' },
      JSON.stringify(body));
    if (!r.ok) { const j0 = await r.json().catch(() => ({})); throw new Error('Claude API ' + r.status + ': ' + (j0.error && j0.error.message || JSON.stringify(j0).slice(0, 300))); }
    const j = /event-stream/.test(r.headers.get('content-type') || '') ? await readStream(r) : await r.json();
    usage.input_tokens += j.usage?.input_tokens || 0; usage.output_tokens += j.usage?.output_tokens || 0;
    let turnText = '';
    for (const b of j.content || []) {
      if (b.type === 'text') {
        turnText += b.text;
        for (const c of b.citations || []) if (c.url && !citations.has(c.url)) citations.set(c.url, { url: c.url, title: c.title || '', cited_text: (c.cited_text || '').slice(0, 300) });
      } else if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
        for (const c of b.content) if (c.url && !citations.has(c.url)) citations.set(c.url, { url: c.url, title: c.title || '', cited_text: '', page_age: c.page_age || '' });
      }
    }
    text += turnText;
    if (j.stop_reason === 'pause_turn') { convo = convo.concat([{ role: 'assistant', content: j.content }]); continue; }
    return { text, citations: [...citations.values()], usage, stop_reason: j.stop_reason, model: j.model || (process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5') };
  }
  return { text, citations: [...citations.values()], usage, stop_reason: 'max_turns', model: (process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5') };
}


// Читає SSE-потік Messages API й збирає повну відповідь (щоб заголовки приходили одразу, без таймауту на довгих запитах із web search)
async function readStream(r) {
  const msg = { content: [], usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: null, model: '' };
  const partial = new Map();
  const dec = new TextDecoder(); let buf = '';
  const handle = ev => {
    if (ev.type === 'message_start') { msg.model = ev.message.model; msg.usage.input_tokens = ev.message.usage?.input_tokens || 0; msg.usage.output_tokens = ev.message.usage?.output_tokens || 0; }
    else if (ev.type === 'content_block_start') { msg.content[ev.index] = { ...ev.content_block }; if (ev.content_block.type === 'text') { msg.content[ev.index].text = ev.content_block.text || ''; msg.content[ev.index].citations = ev.content_block.citations ? ev.content_block.citations.slice() : []; } }
    else if (ev.type === 'content_block_delta') {
      const b = msg.content[ev.index]; const d = ev.delta; if (!b) return;
      if (d.type === 'text_delta') b.text += d.text;
      else if (d.type === 'citations_delta') (b.citations = b.citations || []).push(d.citation);
      else if (d.type === 'input_json_delta') partial.set(ev.index, (partial.get(ev.index) || '') + d.partial_json);
    }
    else if (ev.type === 'content_block_stop') { const p = partial.get(ev.index); if (p != null) { try { msg.content[ev.index].input = p ? JSON.parse(p) : {}; } catch { msg.content[ev.index].input = {}; } partial.delete(ev.index); } }
    else if (ev.type === 'message_delta') { if (ev.delta?.stop_reason) msg.stop_reason = ev.delta.stop_reason; if (ev.usage) { if (ev.usage.output_tokens != null) msg.usage.output_tokens = ev.usage.output_tokens; if (ev.usage.input_tokens != null) msg.usage.input_tokens = ev.usage.input_tokens; } }
    else if (ev.type === 'error') throw new Error('Claude API stream: ' + (ev.error?.message || JSON.stringify(ev.error)));
  };
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let i; while ((i = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, i); buf = buf.slice(i + 2);
      const line = raw.split('\n').find(l => l.startsWith('data:')); if (!line) continue;
      const data = line.slice(5).trim(); if (!data) continue;
      let ev; try { ev = JSON.parse(data); } catch { continue; }
      handle(ev);
    }
  }
  msg.content = msg.content.filter(Boolean);
  return msg;
}

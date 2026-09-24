// Проксі до Claude API з web search (спільний код для Node-сервера та Netlify Functions)
// ---------- Claude proxy ----------
export async function callClaude({ system, prompt, messages, web, maxTokens, model }) {
  if (!(process.env.ANTHROPIC_API_KEY || '')) throw new Error('На сервері не задано ANTHROPIC_API_KEY');
  const msgs = messages || [{ role: 'user', content: prompt }];
  const citations = new Map();
  let text = '';
  let usage = { input_tokens: 0, output_tokens: 0 };
  let convo = msgs.slice();
  for (let turn = 0; turn < 5; turn++) {
    const body = { model: model || (process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5'), max_tokens: Math.min(maxTokens || 8000, 32000), system, messages: convo };
    if (web) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }];
    const r = await fetch((process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '') + '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': (process.env.ANTHROPIC_API_KEY || ''), 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(600e3),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('Claude API ' + r.status + ': ' + (j.error && j.error.message || JSON.stringify(j).slice(0, 300)));
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


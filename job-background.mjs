// Background Function (до 15 хв): виконує AI-запит або парсинг і кладе результат у Blobs.
import { store } from '../../lib/store.mjs';
import { callClaude } from '../../lib/ai.mjs';
import { parseSocial } from '../../lib/parse.mjs';

export default async (req) => {
  let id; try { ({ id } = await req.json()); } catch { return new Response('bad request', { status: 400 }); }
  const jobs = store('jobs'); const job = await jobs.get(String(id), { type: 'json' });
  if (!job || job.status !== 'queued') return new Response('ignored', { status: 202 });
  const { payload, ...base } = job;
  await jobs.setJSON(id, { ...job, status: 'running' });
  try {
    const result = job.type === 'ai' ? await callClaude(payload) : await parseSocial(payload);
    await jobs.setJSON(id, { ...base, status: 'done', result, finishedAt: new Date().toISOString() });
  } catch (e) {
    await jobs.setJSON(id, { ...base, status: 'error', error: String((e && e.message) || e), finishedAt: new Date().toISOString() });
  }
  return new Response('ok', { status: 202 });
};

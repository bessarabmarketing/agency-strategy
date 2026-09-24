// Agency Strategy OS — API на Netlify Functions (Netlify Blobs як БД).
// Маршрути ті самі, що й у server.js, тому фронтенд не змінюється.
import { store } from '../../lib/store.mjs';

export const config = { path: '/api/*' };

const nowIso = () => new Date().toISOString();
const J = (code, obj) => new Response(JSON.stringify(obj), { status: code, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const env = k => (globalThis.process && process.env[k]) || (globalThis.Netlify && Netlify.env.get(k)) || '';
const rd = async req => { try { const t = await req.text(); return t ? JSON.parse(t) : {}; } catch { throw new Error('Некоректний JSON'); } };
const getJ = (st, key) => st.get(key, { type: 'json' });

export default async (req) => {
  try {
    const url = new URL(req.url);
    const p = url.pathname.replace(/^\/\.netlify\/functions\/api/, '').replace(/\/+$/, '') || '/';
    const m0 = req.method;
    if (p === '/api/status') return J(200, { ai: !!env('ANTHROPIC_API_KEY'), parser: !!env('APIFY_TOKEN'), model: env('ANTHROPIC_MODEL') || 'claude-sonnet-4-5', teamKeyRequired: !!env('TEAM_KEY'), version: '1.0.0-netlify' });
    const TEAM_KEY = env('TEAM_KEY');
    if (TEAM_KEY && req.headers.get('x-team-key') !== TEAM_KEY) return J(401, { error: 'Невірний командний ключ' });
    let by = 'невідомо'; try { by = decodeURIComponent(req.headers.get('x-user') || '') || by; } catch { }
    const projects = store('projects'), revs = store('revs'), kv = store('kv'), jobs = store('jobs');
    let m;

    if (p === '/api/projects' && m0 === 'GET') {
      const { blobs } = await projects.list({ prefix: 'meta/' });
      const rows = (await Promise.all(blobs.map(b => getJ(projects, b.key)))).filter(Boolean);
      rows.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
      return J(200, rows);
    }
    if (p === '/api/projects' && m0 === 'POST') {
      const b = await rd(req);
      if (!b.id || !b.data || !/^[\w-]+$/.test(b.id)) return J(400, { error: 'id і data обовʼязкові' });
      if (await getJ(projects, 'data/' + b.id)) return J(409, { error: 'Проєкт уже існує' });
      const at = nowIso();
      const meta = { id: b.id, name: b.name || 'Без назви', rev: 1, updated_at: at, updated_by: by, meta: b.meta || {} };
      await projects.setJSON('data/' + b.id, { ...meta, data: b.data });
      await projects.setJSON('meta/' + b.id, meta);
      await addRev(revs, b.id, 1, at, by, 'Проєкт створено', b.data);
      return J(200, { id: b.id, rev: 1 });
    }
    if ((m = p.match(/^\/api\/projects\/([\w-]+)$/))) {
      const id = m[1]; const cur = await getJ(projects, 'data/' + id);
      if (m0 === 'GET') return cur ? J(200, cur) : J(404, { error: 'Не знайдено' });
      if (m0 === 'PUT') {
        const b = await rd(req); if (!cur) return J(404, { error: 'Не знайдено' });
        if (!b.force && b.rev !== cur.rev) return J(409, { error: 'Конфлікт версій', rev: cur.rev, updated_by: cur.updated_by, updated_at: cur.updated_at });
        const at = nowIso(); const rev = cur.rev + 1;
        const meta = { id, name: b.name || cur.name, rev, updated_at: at, updated_by: by, meta: b.meta || {} };
        await projects.setJSON('data/' + id, { ...meta, data: b.data });
        await projects.setJSON('meta/' + id, meta);
        if (b.snap) await addRev(revs, id, rev, at, by, String(b.snap).slice(0, 200), b.data);
        return J(200, { rev });
      }
      if (m0 === 'DELETE') {
        await projects.delete('data/' + id); await projects.delete('meta/' + id);
        const { blobs } = await revs.list({ prefix: id + '/' }); await Promise.all(blobs.map(x => revs.delete(x.key)));
        return J(200, { ok: true });
      }
    }
    if ((m = p.match(/^\/api\/projects\/([\w-]+)\/revisions(?:\/(\d+))?$/)) && m0 === 'GET') {
      if (!m[2]) return J(200, (await getJ(revs, m[1] + '/idx')) || []);
      const idx = (await getJ(revs, m[1] + '/idx')) || []; const it = idx.find(x => x.id === +m[2]);
      const snap = it && await getJ(revs, m[1] + '/' + m[2]);
      return snap ? J(200, { ...it, snapshot: snap }) : J(404, { error: 'Не знайдено' });
    }
    if ((m = p.match(/^\/api\/kv\/([\w.-]+)$/))) {
      if (m0 === 'GET') { const r = await getJ(kv, m[1]); return J(200, r ? { value: r.value, rev: r.rev } : { value: null, rev: 0 }); }
      if (m0 === 'PUT') { const b = await rd(req); const r = await getJ(kv, m[1]); await kv.setJSON(m[1], { value: b.value, rev: ((r && r.rev) || 0) + 1, updated_at: nowIso(), updated_by: by }); return J(200, { ok: true }); }
    }
    if (p === '/api/jobs' && m0 === 'POST') {
      const b = await rd(req);
      if (b.type !== 'ai' && b.type !== 'parse') return J(400, { error: 'Невідомий тип задачі' });
      const id = crypto.randomUUID(); const job = { id, type: b.type, status: 'queued', startedAt: nowIso(), payload: b.payload || {} };
      await jobs.setJSON(id, job);
      // Запускаємо Background Function (до 15 хв). Вона читає payload із Blobs за id.
      try {
        const r = await fetch(url.origin + '/.netlify/functions/job-background', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) });
        if (r.status >= 400) throw new Error('background HTTP ' + r.status);
      } catch (e) { await jobs.setJSON(id, { id, type: b.type, status: 'error', startedAt: job.startedAt, finishedAt: nowIso(), error: 'Не вдалося запустити фонову задачу: ' + e.message }); }
      return J(200, { id });
    }
    if ((m = p.match(/^\/api\/jobs\/([\w-]+)$/)) && m0 === 'GET') {
      const j = await getJ(jobs, m[1]); if (!j) return J(404, { error: 'Задачу не знайдено' });
      if ((j.status === 'queued' || j.status === 'running') && Date.now() - Date.parse(j.startedAt) > 16 * 60e3) return J(200, { id: j.id, type: j.type, status: 'error', error: 'Задачу перервано: перевищено ліміт часу 15 хвилин' });
      const { payload, ...pub } = j; return J(200, pub);
    }
    return J(404, { error: 'Невідомий маршрут' });
  } catch (e) { return J(500, { error: String((e && e.message) || e) }); }
};

async function addRev(revs, id, rev, at, by, summary, data) {
  await revs.setJSON(id + '/' + rev, data);
  const idx = ((await getJ(revs, id + '/idx')) || []); idx.unshift({ id: rev, rev, at, by, summary });
  const drop = idx.splice(60); await revs.setJSON(id + '/idx', idx);
  await Promise.all(drop.map(x => revs.delete(id + '/' + x.id)));
}

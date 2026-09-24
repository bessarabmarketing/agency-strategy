// Парсинг соцмереж через Apify (спільний код)
const nowIso = () => new Date().toISOString();
// ---------- Parsing (Apify) ----------
const num = v => (v == null || isNaN(+v)) ? null : +v;
const pick = (o, ...ks) => { for (const k of ks) { const v = k.split('.').reduce((a, x) => a == null ? a : a[x], o); if (v != null && v !== '') return v; } return null; };
function stats(posts) {
  const n = posts.length;
  const avg = k => { const a = posts.map(p => p[k]).filter(v => v != null); return a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null; };
  const times = posts.map(p => Date.parse(p.date)).filter(t => t > 0).sort((a, b) => a - b);
  let perWeek = null;
  if (times.length > 2) { const days = Math.max(1, (times[times.length - 1] - times[0]) / 864e5); perWeek = +(times.length / days * 7).toFixed(1); }
  const formats = {}; posts.forEach(p => { if (p.type) formats[p.type] = (formats[p.type] || 0) + 1; });
  const tags = {}; posts.forEach(p => (p.hashtags || []).forEach(t => { t = String(t).toLowerCase(); tags[t] = (tags[t] || 0) + 1; }));
  const topTags = Object.entries(tags).sort((a, b) => b[1] - a[1]).slice(0, 10).map(x => x[0]);
  const top = posts.slice().sort((a, b) => ((b.likes || 0) + (b.comments || 0) * 3 + (b.views || 0) / 50) - ((a.likes || 0) + (a.comments || 0) * 3 + (a.views || 0) / 50)).slice(0, 8);
  return { count: n, avgLikes: avg('likes'), avgComments: avg('comments'), avgViews: avg('views'), avgShares: avg('shares'), postsPerWeek: perWeek, formats, topHashtags: topTags, top };
}
const trim = (s, n = 260) => s ? String(s).replace(/\s+/g, ' ').slice(0, n) : '';
function normalize(platform, items) {
  if (platform === 'instagram') {
    const profile = items.find(i => i.followersCount != null || i.biography != null) || null;
    const posts = items.filter(i => i.caption != null || i.shortCode || i.url).map(i => ({
      url: pick(i, 'url') || (i.shortCode ? 'https://www.instagram.com/p/' + i.shortCode + '/' : null),
      type: pick(i, 'type', 'productType') || null, date: pick(i, 'timestamp', 'takenAtTimestamp'),
      caption: trim(i.caption), likes: num(i.likesCount), comments: num(i.commentsCount), views: num(pick(i, 'videoViewCount', 'videoPlayCount')),
      hashtags: i.hashtags || [], music: pick(i, 'musicInfo.song_name'),
    }));
    return { profile: profile ? { name: profile.fullName, bio: trim(profile.biography, 400), followers: num(profile.followersCount), following: num(profile.followsCount), posts: num(profile.postsCount), url: profile.url } : null, posts, stats: stats(posts) };
  }
  if (platform === 'tiktok') {
    const posts = items.map(i => ({
      url: pick(i, 'webVideoUrl'), type: 'video', date: pick(i, 'createTimeISO') || (i.createTime ? new Date(i.createTime * 1000).toISOString() : null),
      caption: trim(pick(i, 'text')), likes: num(i.diggCount), comments: num(i.commentCount), views: num(i.playCount), shares: num(i.shareCount),
      hashtags: (i.hashtags || []).map(h => h.name || h), music: pick(i, 'musicMeta.musicName'),
    }));
    const a = items[0]?.authorMeta;
    return { profile: a ? { name: a.nickName || a.name, bio: trim(a.signature, 400), followers: num(a.fans), following: num(a.following), posts: num(a.video), url: a.profileUrl } : null, posts, stats: stats(posts) };
  }
  if (platform === 'facebook') {
    const posts = items.map(i => ({
      url: pick(i, 'url', 'postUrl'), type: pick(i, 'type') || 'post', date: pick(i, 'time', 'timestamp'), caption: trim(pick(i, 'text', 'message')),
      likes: num(pick(i, 'likes', 'reactionsCount')), comments: num(i.comments), shares: num(i.shares), views: num(i.viewsCount), hashtags: [],
    }));
    return { profile: items[0]?.pageName ? { name: items[0].pageName } : null, posts, stats: stats(posts) };
  }
  if (platform === 'meta_ads') {
    const ads = items.map(i => ({
      id: pick(i, 'adArchiveID', 'ad_archive_id'), page: pick(i, 'pageName', 'snapshot.page_name'),
      text: trim(pick(i, 'snapshot.body.text', 'snapshot.body', 'adCreativeBody'), 400), title: trim(pick(i, 'snapshot.title')), cta: pick(i, 'snapshot.cta_text', 'snapshot.ctaText'),
      link: pick(i, 'snapshot.link_url', 'snapshot.linkUrl'), format: pick(i, 'snapshot.display_format', 'snapshot.displayFormat'),
      start: pick(i, 'startDateFormatted', 'startDate', 'start_date'), end: pick(i, 'endDateFormatted', 'endDate', 'end_date'), active: pick(i, 'isActive', 'is_active'),
      platforms: pick(i, 'publisherPlatform', 'publisher_platform') || [],
    }));
    const fm = {}; ads.forEach(a => { if (a.format) fm[a.format] = (fm[a.format] || 0) + 1; });
    const cta = {}; ads.forEach(a => { if (a.cta) cta[a.cta] = (cta[a.cta] || 0) + 1; });
    return { profile: null, ads, stats: { count: ads.length, active: ads.filter(a => a.active).length, formats: fm, ctas: cta } };
  }
  return { posts: [], stats: {} };
}
function igHandle(s) { s = String(s || '').trim(); const m = s.match(/instagram\.com\/([^/?#]+)/i); return (m ? m[1] : s).replace(/^@/, ''); }
function ttHandle(s) { s = String(s || '').trim(); const m = s.match(/tiktok\.com\/@([^/?#]+)/i); return (m ? m[1] : s).replace(/^@/, ''); }
function buildActorInput(platform, p) {
  const limit = Math.min(+p.limit || 20, 60);
  if (platform === 'instagram') return { input: { directUrls: ['https://www.instagram.com/' + igHandle(p.handle) + '/'], resultsType: 'posts', resultsLimit: limit, addParentData: true }, handle: igHandle(p.handle) };
  if (platform === 'tiktok') return { input: { profiles: [ttHandle(p.handle)], resultsPerPage: limit, profileScrapeSections: ['videos'], shouldDownloadVideos: false, shouldDownloadCovers: false }, handle: ttHandle(p.handle) };
  if (platform === 'facebook') return { input: { startUrls: [{ url: /^https?:/.test(p.handle) ? p.handle : 'https://www.facebook.com/' + p.handle }], resultsLimit: limit }, handle: p.handle };
  if (platform === 'meta_ads') {
    const url = 'https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=' + encodeURIComponent(p.country || 'UA') + '&q=' + encodeURIComponent(p.handle) + '&search_type=keyword_unordered&media_type=all';
    return { input: { startUrls: [{ url }], resultsLimit: limit, count: limit }, handle: p.handle };
  }
  throw new Error('Невідома платформа: ' + platform);
}
export async function parseSocial(p) {
  if (!(process.env.APIFY_TOKEN || '')) throw new Error('На сервері не задано APIFY_TOKEN — парсинг недоступний');
  const platform = p.platform;
  const ACTORS = { instagram: process.env.APIFY_ACTOR_INSTAGRAM || 'apify~instagram-scraper', tiktok: process.env.APIFY_ACTOR_TIKTOK || 'clockworks~tiktok-scraper', facebook: process.env.APIFY_ACTOR_FACEBOOK || 'apify~facebook-posts-scraper', meta_ads: process.env.APIFY_ACTOR_META_ADS || 'apify~facebook-ads-scraper' };
  const actor = ACTORS[platform]; if (!actor) throw new Error('Невідома платформа: ' + platform);
  const { input, handle } = buildActorInput(platform, p);
  const r = await fetch(`${(process.env.APIFY_BASE_URL || 'https://api.apify.com').replace(/\/$/, '')}/v2/acts/${actor}/run-sync-get-dataset-items?token=${encodeURIComponent((process.env.APIFY_TOKEN || ''))}&timeout=240&format=json&clean=true`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(280e3),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error('Apify ' + r.status + ': ' + txt.slice(0, 300));
  let items; try { items = JSON.parse(txt); } catch { throw new Error('Apify повернув не JSON'); }
  if (!Array.isArray(items)) throw new Error('Apify: неочікувана відповідь');
  if (!items.length) throw new Error('Парсер не повернув даних (акаунт закритий, не існує або заблокований)');
  return { platform, handle, fetchedAt: nowIso(), actor, ...normalize(platform, items) };
}


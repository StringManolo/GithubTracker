// ─────────────────────────────────────────────────────────────────────────────
// VISIT TRACKER WORKER — Cloudflare Workers
// ─────────────────────────────────────────────────────────────────────────────
// ENV vars expected in your Cloudflare dashboard (or .env for local dev):
//   API_KEY          — secret string required on sensitive /stats/* endpoints
//   VISITS_KV        — KV namespace binding
//
// KV key schema:
//   meta:{user}:{ts}              → JSON { referer, ip, date, userAgent, headers, country, browser, version }
//   meta:index:{user}             → JSON [ts, ts, ...] last 5000 timestamps (for recent queries)
//   total:{user}                  → "N"
//   daily:{user}:{YYYY-MM-DD}     → "N"
//   weekly:{user}:{YYYY-W##}      → "N"
//   monthly:{user}:{YYYY-MM}      → "N"
//   yearly:{user}:{YYYY}          → "N"
//   repo:total:{user}:{repo}      → "N"
//   repo:daily:{user}:{repo}:{D}  → "N"
//   repo:weekly:{user}:{repo}:{W} → "N"
//   repo:monthly:{user}:{repo}:{M}→ "N"
//   repo:yearly:{user}:{repo}:{Y} → "N"
//   repo:index:{user}             → JSON ["repo1","repo2",…]
//   ref:{user}:{referrer}         → "N"
//   ref:index:{user}              → JSON ["ref1","ref2",…]
//   country:{user}:{code}         → "N"
//   country:index:{user}          → JSON ["US","ES",…]
//   browser:{user}:{name}:{ver}   → "N"
//   browser:index:{user}          → JSON ["Chrome:120","Firefox:121",…]
//   ip:{user}:{ip}                → "N"
//   ip:index:{user}               → JSON ["1.2.3.4",…]
//   ua:{user}:{hash}              → JSON { ua, count }
//   ua:index:{user}               → JSON [hash, hash,…]
// ─────────────────────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function now() { return new Date(); }
function dateStr(d = now()) { return d.toISOString().slice(0, 10); }
function monthStr(d = now()) { return d.toISOString().slice(0, 7); }
function yearStr(d = now()) { return d.toISOString().slice(0, 4); }

function weekStr(d = now()) {
  const jan1 = new Date(d.getUTCFullYear(), 0, 1);
  const days = Math.floor((d - jan1) / 86400000);
  const week = String(Math.ceil((days + jan1.getUTCDay() + 1) / 7)).padStart(2, '0');
  return `${d.getUTCFullYear()}-W${week}`;
}

// Simple hash for user-agent strings (no crypto needed)
function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

async function kvGet(env, key, parse = false) {
  const val = await env.VISITS_KV.get(key);
  if (val === null) return parse ? null : '0';
  return parse ? JSON.parse(val) : val;
}

async function kvInc(env, key) {
  const cur = parseInt(await env.VISITS_KV.get(key) || '0');
  await env.VISITS_KV.put(key, String(cur + 1));
  return cur + 1;
}

async function kvPushUnique(env, key, value) {
  let arr = (await kvGet(env, key, true)) || [];
  if (!arr.includes(value)) {
    arr.push(value);
    await env.VISITS_KV.put(key, JSON.stringify(arr));
  }
}

async function kvPushCapped(env, key, value, cap = 5000) {
  let arr = (await kvGet(env, key, true)) || [];
  arr.push(value);
  if (arr.length > cap) arr = arr.slice(arr.length - cap);
  await env.VISITS_KV.put(key, JSON.stringify(arr));
}

// ═══════════════════════════════════════════════════════════════════════════════
// BROWSER DETECTION (from UserAgent string)
// ═══════════════════════════════════════════════════════════════════════════════

function parseBrowser(ua) {
  if (!ua) return { name: 'Unknown', version: '0' };
  const patterns = [
    { name: 'Googlebot',  re: /Googlebot\/([\d.]+)/ },
    { name: 'Bingbot',    re: /bingbot\/([\d.]+)/ },
    { name: 'Slurp',      re: /Slurp\/([\d.]+)/ },
    { name: 'DuckDuckBot',re: /DuckDuckBot\/([\d.]+)/ },
    { name: 'Curl',       re: /curl\/([\d.]+)/ },
    { name: 'Wget',       re: /Wget\/([\d.]+)/ },
    { name: 'Edge',       re: /Edg(?:e|A|iOS)?\/([\d.]+)/ },
    { name: 'Opera',      re: /(?:OPR|Opera)\/([\d.]+)/ },
    { name: 'Samsung',    re: /SamsungBrowser\/([\d.]+)/ },
    { name: 'UC',         re: /UCBrowser\/([\d.]+)/ },
    { name: 'Firefox',    re: /Firefox\/([\d.]+)/ },
    { name: 'Chromium',   re: /Chromium\/([\d.]+)/ },
    { name: 'Chrome',     re: /Chrome\/([\d.]+)/ },
    { name: 'Safari',     re: /Version\/([\d.]+).*Safari/ },
    { name: 'Brave',      re: /Brave/ },
    { name: 'Vivaldi',    re: /Vivaldi\/([\d.]+)/ },
    { name: 'Lynx',       re: /Lynx\/([\d.]+)/ },
    { name: 'w3m',        re: /w3m\/([\d.]+)/ },
    { name: 'Links',      re: /links?\/([\d.]+)/i },
  ];
  for (const p of patterns) {
    const m = ua.match(p.re);
    if (m) return { name: p.name, version: m[1] || '0' };
  }
  // Fallback: try to pull something
  if (/Mobile/i.test(ua)) return { name: 'Mobile Browser', version: '0' };
  return { name: 'Unknown', version: '0' };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRACK A VISIT
// ═══════════════════════════════════════════════════════════════════════════════

async function trackVisit(request, env, user, repo) {
  const d = now();
  const ts = d.getTime();
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarding-For') || '0.0.0.0';
  const country = request.headers.get('CF-IPCountry') || 'XX';
  const referer = request.headers.get('Referer') || 'direct';
  const userAgent = request.headers.get('User-Agent') || 'unknown';
  const browser = parseBrowser(userAgent);

  // Collect raw headers (filter out sensitive CF internals, keep useful ones)
  const rawHeaders = {};
  const keepHeaders = [
    'user-agent','referer','accept','accept-language','accept-encoding',
    'connection','host','origin','sec-fetch-site','sec-fetch-mode',
    'sec-fetch-dest','sec-ch-ua','sec-ch-ua-platform','sec-ch-ua-mobile',
    'cf-ipcountry','cf-ray','cf-connecting-ip','x-forwarding-for',
    'authorization' // included so admins can see if someone sends it
  ];
  for (const h of keepHeaders) {
    const v = request.headers.get(h);
    if (v) rawHeaders[h] = v;
  }

  const meta = {
    referer,
    ip,
    date: d.toISOString(),
    userAgent,
    headers: rawHeaders,
    country,
    browser: browser.name,
    browserVersion: browser.version,
    repo: repo || null
  };

  // ── Write meta (TTL 90 days for storage efficiency)
  await env.VISITS_KV.put(`meta:${user}:${ts}`, JSON.stringify(meta), { expirationTtl: 7776000 });
  await kvPushCapped(env, `meta:index:${user}`, ts);

  // ── Increment counters (user-level)
  await kvInc(env, `total:${user}`);
  await kvInc(env, `daily:${user}:${dateStr(d)}`);
  await kvInc(env, `weekly:${user}:${weekStr(d)}`);
  await kvInc(env, `monthly:${user}:${monthStr(d)}`);
  await kvInc(env, `yearly:${user}:${yearStr(d)}`);

  // ── Repo counters
  if (repo) {
    await kvPushUnique(env, `repo:index:${user}`, repo);
    await kvInc(env, `repo:total:${user}:${repo}`);
    await kvInc(env, `repo:daily:${user}:${repo}:${dateStr(d)}`);
    await kvInc(env, `repo:weekly:${user}:${repo}:${weekStr(d)}`);
    await kvInc(env, `repo:monthly:${user}:${repo}:${monthStr(d)}`);
    await kvInc(env, `repo:yearly:${user}:${repo}:${yearStr(d)}`);
  }

  // ── Referrer
  const refKey = referer.replace(/https?:\/\//, '').split('/')[0] || 'direct';
  await kvPushUnique(env, `ref:index:${user}`, refKey);
  await kvInc(env, `ref:${user}:${refKey}`);

  // ── Country
  await kvPushUnique(env, `country:index:${user}`, country);
  await kvInc(env, `country:${user}:${country}`);

  // ── Browser
  const browserKey = `${browser.name}:${browser.version}`;
  await kvPushUnique(env, `browser:index:${user}`, browserKey);
  await kvInc(env, `browser:${user}:${browserKey}`);

  // ── IP
  await kvPushUnique(env, `ip:index:${user}`, ip);
  await kvInc(env, `ip:${user}:${ip}`);

  // ── User-Agent (hashed key, full UA stored in value)
  const uaHash = simpleHash(userAgent);
  await kvPushUnique(env, `ua:index:${user}`, uaHash);
  const uaData = (await kvGet(env, `ua:${user}:${uaHash}`, true)) || { ua: userAgent, count: 0 };
  uaData.count++;
  await env.VISITS_KV.put(`ua:${user}:${uaHash}`, JSON.stringify(uaData));

  return await kvGet(env, `total:${user}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SVG BADGE GENERATOR
// ═══════════════════════════════════════════════════════════════════════════════

function makeBadge({ label = 'views', value = '0', color = '#4c1', textcolor = '#fff', labelColor = '#555' }) {
  // Measure approximate text widths
  const labelW = Math.max(label.length * 6.5 + 20, 50);
  const valueStr = String(value);
  const valueW = Math.max(valueStr.length * 7.5 + 16, 38);
  const totalW = labelW + valueW;
  const labelX = Math.round(labelW / 2);
  const valueX = Math.round(labelW + valueW / 2);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="20">
  <linearGradient id="a" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="c"><rect rx="3" width="${totalW}" height="20"/></clipPath>
  <g clip-path="url(#c)">
    <rect width="${labelW}" height="20" fill="${labelColor}"/>
    <rect x="${labelW}" width="${valueW}" height="20" fill="${color}"/>
    <rect width="${totalW}" height="20" fill="url(#a)"/>
  </g>
  <g fill="${textcolor}" text-anchor="middle" font-family="Verdana,Geneva,sans-serif" font-size="11">
    <text x="${labelX}" y="14" fill="#010101" fill-opacity=".3">${escapeXml(label)}</text>
    <text x="${labelX}" y="13">${escapeXml(label)}</text>
    <text x="${valueX}" y="14" fill="#010101" fill-opacity=".3">${escapeXml(valueStr)}</text>
    <text x="${valueX}" y="13">${escapeXml(valueStr)}</text>
  </g>
</svg>`;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SVG GRAPH GENERATOR (horizontal bar chart)
// ═══════════════════════════════════════════════════════════════════════════════

function makeGraph({ title = '', data = [], color = '#4c1', textcolor = '#ccc', bgcolor = '#1a1a2e', barcolor = null, maxBars = 15 }) {
  // data: [{ label, value }, ...]
  if (data.length === 0) data = [{ label: 'no data', value: 0 }];
  if (data.length > maxBars) data = data.slice(0, maxBars);

  const barH = 18;
  const gap = 4;
  const padL = 140; // left padding for labels
  const padR = 50;  // right for value text
  const padT = title ? 30 : 12;
  const padB = 12;
  const maxVal = Math.max(...data.map(d => d.value), 1);
  const availW = 460;
  const chartH = data.length * (barH + gap);
  const totalH = padT + chartH + padB;
  const totalW = padL + availW + padR;
  const bc = barcolor || color;

  let bars = '';
  data.forEach((item, i) => {
    const y = padT + i * (barH + gap);
    const barW = Math.max((item.value / maxVal) * availW, 2);
    const labelX = padL - 8;
    const valX = padL + barW + 8;

    bars += `
  <text x="${labelX}" y="${y + 12}" text-anchor="end" fill="${textcolor}" font-family="'SF Mono',Consolas,monospace" font-size="11" opacity=".85">${escapeXml(String(item.label).slice(0, 18))}</text>
  <rect x="${padL}" y="${y}" width="${barW}" height="${barH}" rx="3" fill="${bc}" opacity=".85"/>
  <text x="${valX}" y="${y + 12}" fill="${textcolor}" font-family="'SF Mono',Consolas,monospace" font-size="11" font-weight="600">${escapeXml(String(item.value))}</text>`;
  });

  const titleSvg = title
    ? `<text x="${padL}" y="18" fill="${textcolor}" font-family="'SF Mono',Consolas,monospace" font-size="13" font-weight="600" opacity=".9">${escapeXml(title)}</text>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${totalH}">
  <rect width="${totalW}" height="${totalH}" rx="6" fill="${bgcolor}"/>
  ${titleSvg}
${bars}
</svg>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// RESPONSE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Origin, Content-Type',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS }
  });
}

function svgResponse(svg) {
  return new Response(svg, {
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      ...CORS
    }
  });
}

function errorResponse(msg, status = 400) {
  return jsonResponse({ error: msg }, status);
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH CHECK
// ═══════════════════════════════════════════════════════════════════════════════

function checkAuth(url, env) {
  const key = url.searchParams.get('apikey');
  if (!env.API_KEY) return false; // if no key configured, deny by default
  return key === env.API_KEY;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATS ENDPOINT HANDLERS
// Each returns { data, graphTitle } so the router can apply svg/graph rendering
// ═══════════════════════════════════════════════════════════════════════════════

async function statsTotal(env, user) {
  const total = parseInt(await kvGet(env, `total:${user}`));
  return { data: { user, total }, graphData: null };
}

async function statsDaily(env, user) {
  const d = dateStr();
  const count = parseInt(await kvGet(env, `daily:${user}:${d}`));
  return {
    data: { user, date: d, visits: count },
    graphData: { title: `Daily — ${user}`, items: [{ label: d, value: count }] }
  };
}

async function statsWeekly(env, user) {
  const w = weekStr();
  const count = parseInt(await kvGet(env, `weekly:${user}:${w}`));
  return {
    data: { user, week: w, visits: count },
    graphData: { title: `Weekly — ${user}`, items: [{ label: w, value: count }] }
  };
}

async function statsMonthly(env, user) {
  const m = monthStr();
  const count = parseInt(await kvGet(env, `monthly:${user}:${m}`));
  return {
    data: { user, month: m, visits: count },
    graphData: { title: `Monthly — ${user}`, items: [{ label: m, value: count }] }
  };
}

async function statsYearly(env, user) {
  const y = yearStr();
  const count = parseInt(await kvGet(env, `yearly:${user}:${y}`));
  return {
    data: { user, year: y, visits: count },
    graphData: { title: `Yearly — ${user}`, items: [{ label: y, value: count }] }
  };
}

// ── Repo stats

async function statsRepoTotal(env, user, repo) {
  if (!repo) return { data: { error: 'repo param required' }, graphData: null };
  const total = parseInt(await kvGet(env, `repo:total:${user}:${repo}`));
  return { data: { user, repo, total }, graphData: null };
}

async function statsRepoDaily(env, user, repo) {
  if (!repo) return { data: { error: 'repo param required' }, graphData: null };
  const d = dateStr();
  const count = parseInt(await kvGet(env, `repo:daily:${user}:${repo}:${d}`));
  return {
    data: { user, repo, date: d, visits: count },
    graphData: { title: `Daily — ${user}/${repo}`, items: [{ label: d, value: count }] }
  };
}

async function statsRepoWeekly(env, user, repo) {
  if (!repo) return { data: { error: 'repo param required' }, graphData: null };
  const w = weekStr();
  const count = parseInt(await kvGet(env, `repo:weekly:${user}:${repo}:${w}`));
  return {
    data: { user, repo, week: w, visits: count },
    graphData: { title: `Weekly — ${user}/${repo}`, items: [{ label: w, value: count }] }
  };
}

async function statsRepoMonthly(env, user, repo) {
  if (!repo) return { data: { error: 'repo param required' }, graphData: null };
  const m = monthStr();
  const count = parseInt(await kvGet(env, `repo:monthly:${user}:${repo}:${m}`));
  return {
    data: { user, repo, month: m, visits: count },
    graphData: { title: `Monthly — ${user}/${repo}`, items: [{ label: m, value: count }] }
  };
}

async function statsRepoYearly(env, user, repo) {
  if (!repo) return { data: { error: 'repo param required' }, graphData: null };
  const y = yearStr();
  const count = parseInt(await kvGet(env, `repo:yearly:${user}:${repo}:${y}`));
  return {
    data: { user, repo, year: y, visits: count },
    graphData: { title: `Yearly — ${user}/${repo}`, items: [{ label: y, value: count }] }
  };
}

async function statsAllRepos(env, user) {
  const repos = (await kvGet(env, `repo:index:${user}`, true)) || [];
  const items = [];
  for (const repo of repos) {
    const total = parseInt(await kvGet(env, `repo:total:${user}:${repo}`));
    items.push({ repo, total });
  }
  items.sort((a, b) => b.total - a.total);
  return {
    data: { user, repos: items },
    graphData: { title: `Repos — ${user}`, items: items.map(i => ({ label: i.repo, value: i.total })) }
  };
}

// ── Referrer stats

async function statsReferrer(env, user, ref) {
  if (!ref) return statsAllReferrers(env, user);
  const count = parseInt(await kvGet(env, `ref:${user}:${ref}`));
  return {
    data: { user, referrer: ref, visits: count },
    graphData: { title: `Referrer — ${ref}`, items: [{ label: ref, value: count }] }
  };
}

async function statsAllReferrers(env, user) {
  const refs = (await kvGet(env, `ref:index:${user}`, true)) || [];
  const items = [];
  for (const ref of refs) {
    const count = parseInt(await kvGet(env, `ref:${user}:${ref}`));
    items.push({ referrer: ref, visits: count });
  }
  items.sort((a, b) => b.visits - a.visits);
  return {
    data: { user, referrers: items },
    graphData: { title: `Referrers — ${user}`, items: items.map(i => ({ label: i.referrer, value: i.visits })) }
  };
}

// ── Country stats

async function statsCountry(env, user) {
  const countries = (await kvGet(env, `country:index:${user}`, true)) || [];
  const items = [];
  for (const code of countries) {
    const count = parseInt(await kvGet(env, `country:${user}:${code}`));
    items.push({ country: code, visits: count });
  }
  items.sort((a, b) => b.visits - a.visits);
  return {
    data: { user, countries: items },
    graphData: { title: `Countries — ${user}`, items: items.map(i => ({ label: i.country, value: i.visits })) }
  };
}

// ── Browser stats

async function statsBrowser(env, user) {
  const browsers = (await kvGet(env, `browser:index:${user}`, true)) || [];
  const items = [];
  for (const bk of browsers) {
    const [name, ...vParts] = bk.split(':');
    const version = vParts.join(':');
    const count = parseInt(await kvGet(env, `browser:${user}:${bk}`));
    items.push({ browser: name, version, visits: count });
  }
  items.sort((a, b) => b.visits - a.visits);
  return {
    data: { user, browsers: items },
    graphData: { title: `Browsers — ${user}`, items: items.map(i => ({ label: `${i.browser} ${i.version}`, value: i.visits })) }
  };
}

// ── IP stats (SENSITIVE)

async function statsIP(env, user) {
  const ips = (await kvGet(env, `ip:index:${user}`, true)) || [];
  const items = [];
  for (const ip of ips) {
    const count = parseInt(await kvGet(env, `ip:${user}:${ip}`));
    items.push({ ip, visits: count });
  }
  items.sort((a, b) => b.visits - a.visits);
  return {
    data: { user, ips: items },
    graphData: { title: `IPs — ${user}`, items: items.map(i => ({ label: i.ip, value: i.visits })) }
  };
}

// ── User-Agent stats (SENSITIVE)

async function statsUserAgent(env, user) {
  const hashes = (await kvGet(env, `ua:index:${user}`, true)) || [];
  const items = [];
  for (const h of hashes) {
    const uaData = (await kvGet(env, `ua:${user}:${h}`, true)) || { ua: 'unknown', count: 0 };
    items.push({ userAgent: uaData.ua, visits: uaData.count });
  }
  items.sort((a, b) => b.visits - a.visits);
  return {
    data: { user, userAgents: items },
    graphData: { title: `User Agents — ${user}`, items: items.map(i => ({ label: i.userAgent.slice(0, 40), value: i.visits })) }
  };
}

// ── Recent visits (SENSITIVE)

async function statsRecent(env, user, limit = 20) {
  const index = (await kvGet(env, `meta:index:${user}`, true)) || [];
  const recent = index.slice(-limit).reverse();
  const visits = [];
  for (const ts of recent) {
    const meta = await kvGet(env, `meta:${user}:${ts}`, true);
    if (meta) visits.push({ timestamp: ts, ...meta });
  }
  return { data: { user, visits }, graphData: null };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTER
// ═══════════════════════════════════════════════════════════════════════════════

// Endpoints that expose sensitive data require API key
const SENSITIVE_ROUTES = [
  '/stats/ip',
  '/stats/useragent',
  '/stats/recent',
  '/stats/referrer',
  '/stats/referrers',
];

// All /stats/* routes require auth
const AUTH_ROUTES_PREFIX = '/stats/';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ── CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // ── GET only
    if (request.method !== 'GET') {
      return errorResponse('Method not allowed', 405);
    }

    const user = url.searchParams.get('user') || 'anonymous';
    const repo = url.searchParams.get('repo');

    // ── Common render params
    const wantSvg = url.searchParams.has('svg');
    const wantGraph = url.searchParams.has('graph');
    const label = url.searchParams.get('label');
    const color = url.searchParams.get('color') || '#4c1';
    const textcolor = url.searchParams.get('textcolor') || '#fff';
    const labelcolor = url.searchParams.get('labelcolor') || '#555';
    const bgcolor = url.searchParams.get('bgcolor') || '#1a1a2e';
    const barcolor = url.searchParams.get('barcolor');

    // ══════════════════════════════════════════════════════════════════════════
    // PUBLIC: / — Track visit & return badge
    // ══════════════════════════════════════════════════════════════════════════
    if (path === '/' || path === '') {
      const total = await trackVisit(request, env, user, repo);
      const badgeLabel = label || (repo ? `${user}/${repo}` : `${user} views`);
      const svg = makeBadge({ label: badgeLabel, value: total, color, textcolor, labelColor: labelcolor });
      return svgResponse(svg);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // AUTHENTICATED STATS ROUTES
    // ══════════════════════════════════════════════════════════════════════════
    if (path.startsWith(AUTH_ROUTES_PREFIX)) {
      if (!checkAuth(url, env)) {
        return errorResponse('Unauthorized — pass ?apikey=<your key>', 401);
      }

      // Helper: apply svg/graph rendering to a stats result
      async function renderStats(statsFn, ...args) {
        const { data, graphData } = await statsFn(env, ...args);

        if (wantGraph && graphData && graphData.items && graphData.items.length > 0) {
          const svg = makeGraph({
            title: graphData.title,
            data: graphData.items,
            color,
            textcolor: textcolor === '#fff' ? '#ccc' : textcolor,
            bgcolor,
            barcolor
          });
          return svgResponse(svg);
        }

        if (wantSvg) {
          // For badge mode: pick the most relevant single number
          let value = '0';
          const d = data;
          if (d.total !== undefined) value = d.total;
          else if (d.visits !== undefined) value = d.visits;
          else if (d.repos) value = d.repos.length;
          else if (d.referrers) value = d.referrers.length;
          else if (d.countries) value = d.countries.length;
          else if (d.browsers) value = d.browsers.length;
          else if (d.ips) value = d.ips.length;
          else if (d.userAgents) value = d.userAgents.length;

          const badgeLabel = label || path.replace('/stats/', '').replace(/\//g, ' ');
          const svg = makeBadge({ label: badgeLabel, value, color, textcolor, labelColor: labelcolor });
          return svgResponse(svg);
        }

        return jsonResponse(data);
      }

      // ── Route dispatch
      switch (path) {
        case '/stats/total':
          return renderStats(statsTotal, user);

        case '/stats/daily':
          return renderStats(statsDaily, user);

        case '/stats/weekly':
          return renderStats(statsWeekly, user);

        case '/stats/monthly':
          return renderStats(statsMonthly, user);

        case '/stats/yearly':
          return renderStats(statsYearly, user);

        // Repo routes
        case '/stats/repo':
          return renderStats(statsRepoTotal, user, repo);

        case '/stats/repo/daily':
          return renderStats(statsRepoDaily, user, repo);

        case '/stats/repo/weekly':
          return renderStats(statsRepoWeekly, user, repo);

        case '/stats/repo/monthly':
          return renderStats(statsRepoMonthly, user, repo);

        case '/stats/repo/yearly':
          return renderStats(statsRepoYearly, user, repo);

        case '/stats/repos':
          return renderStats(statsAllRepos, user);

        // Referrer routes
        case '/stats/referrer':
          return renderStats(statsReferrer, user, url.searchParams.get('ref'));

        case '/stats/referrers':
          return renderStats(statsAllReferrers, user);

        // Breakdown routes
        case '/stats/country':
          return renderStats(statsCountry, user);

        case '/stats/browser':
          return renderStats(statsBrowser, user);

        // Sensitive routes
        case '/stats/ip':
          return renderStats(statsIP, user);

        case '/stats/useragent':
          return renderStats(statsUserAgent, user);

        case '/stats/recent':
          const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 100);
          return renderStats(statsRecent, user, limit);

        default:
          return errorResponse('Unknown stats endpoint', 404);
      }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // PUBLIC: /health — Liveness check
    // ══════════════════════════════════════════════════════════════════════════
    if (path === '/health') {
      return jsonResponse({ status: 'ok', timestamp: now().toISOString() });
    }

    // ══════════════════════════════════════════════════════════════════════════
    // PUBLIC: /docs — API documentation
    // ══════════════════════════════════════════════════════════════════════════
    if (path === '/docs') {
      return jsonResponse(API_DOCS);
    }

    return errorResponse('Not found', 404);
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// INLINE API DOCS
// ═══════════════════════════════════════════════════════════════════════════════
const API_DOCS = {
  description: "Visit Tracker — Cloudflare Workers",
  env: {
    API_KEY: "Secret key for authenticated endpoints (set as env var or secret)",
    VISITS_KV: "KV namespace binding"
  },
  public_endpoints: {
    "GET /": {
      description: "Track a visit and return an SVG badge",
      params: {
        user: "GitHub username or identifier (default: anonymous)",
        repo: "Optional: repository name to also track repo-level stats",
        label: "Custom badge label text",
        color: "Badge value-area color (hex, e.g. #4c1)",
        textcolor: "Badge text color (hex)",
        labelcolor: "Badge label-area color (hex)"
      }
    },
    "GET /health": { description: "Health check — returns status and timestamp" },
    "GET /docs": { description: "This documentation" }
  },
  authenticated_endpoints: {
    note: "All endpoints below require ?apikey=<your API_KEY>",
    profile_stats: {
      "GET /stats/total?user=X": "Total visits for user X",
      "GET /stats/daily?user=X": "Visits today",
      "GET /stats/weekly?user=X": "Visits this week",
      "GET /stats/monthly?user=X": "Visits this month",
      "GET /stats/yearly?user=X": "Visits this year"
    },
    repo_stats: {
      "GET /stats/repo?user=X&repo=Y": "Total visits to repo Y",
      "GET /stats/repo/daily?user=X&repo=Y": "Today's visits to repo Y",
      "GET /stats/repo/weekly?user=X&repo=Y": "This week's visits to repo Y",
      "GET /stats/repo/monthly?user=X&repo=Y": "This month's visits to repo Y",
      "GET /stats/repo/yearly?user=X&repo=Y": "This year's visits to repo Y",
      "GET /stats/repos?user=X": "All repos and their total visits"
    },
    referrer_stats: {
      "GET /stats/referrer?user=X&ref=Z": "Visits from referrer Z (omit ref for all)",
      "GET /stats/referrers?user=X": "All referrers with visit counts"
    },
    breakdown_stats: {
      "GET /stats/country?user=X": "Visits grouped by country (via CF-IPCountry)",
      "GET /stats/browser?user=X": "Visits grouped by browser and version"
    },
    sensitive_stats: {
      note: "These expose raw IPs / user agents — use with care",
      "GET /stats/ip?user=X": "Visits grouped by IP address",
      "GET /stats/useragent?user=X": "Visits grouped by full User-Agent string",
      "GET /stats/recent?user=X&limit=N": "Last N visits with full metadata (max 100)"
    },
    rendering_params: {
      note: "Append to any stats endpoint",
      svg: "?svg=1 → returns an SVG badge instead of JSON",
      graph: "?graph=1 → returns an SVG bar-chart graph instead of JSON",
      label: "?label=Text → custom label for badge mode",
      color: "?color=#hex → badge/bar color",
      textcolor: "?textcolor=#hex → text color",
      labelcolor: "?labelcolor=#hex → badge label background",
      bgcolor: "?bgcolor=#hex → graph background color",
      barcolor: "?barcolor=#hex → graph bar color (overrides color)"
    }
  }
};
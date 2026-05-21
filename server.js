const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

const PORT       = process.env.PORT || 3000;
const DATA_DIR   = path.join(__dirname, 'data');
const CACHE_FILE = path.join(DATA_DIR, 'cache.json');
const HIST_FILE  = path.join(DATA_DIR, 'history.json');

const BOI_BASE     = 'https://edge.boi.gov.il/FusionEdgeServer/sdmx/v2/data/dataflow/BOI.STATISTICS';
const BOI_RATE_URL = `${BOI_BASE}/BR/1.0/MNT_RIB_BOI_D?lastNObservations=1&format=csv`;
const CBS_CPI_URL  = 'https://api.cbs.gov.il/index/time-series/data/format/json?id=120010&startPeriod=2020-01';

// BOI yield series candidates (will probe server-side)
const MATURITIES = ['1Y','3Y','5Y','10Y','30Y'];
const YIELD_SERIES = {
  shachar: MATURITIES.map(m => ({ mat: m, url: `${BOI_BASE}/BR/1.0/MNT_YLD_GVT_ILS_${m}_D?lastNObservations=10&format=csv` })),
  galil:   MATURITIES.map(m => ({ mat: m, url: `${BOI_BASE}/BR/1.0/MNT_YLD_GVT_CPI_${m}_D?lastNObservations=10&format=csv` }))
};
// NSS fallback candidates
const NSS_SERIES = {
  shachar: ['B0','B1','B2','B3','T1','T2'].map(p => `${BOI_BASE}/BR/1.0/MNT_NSS_GVT_ILS_${p}_D?lastNObservations=10&format=csv`),
  galil:   ['B0','B1','B2','B3','T1','T2'].map(p => `${BOI_BASE}/BR/1.0/MNT_NSS_GVT_CPI_${p}_D?lastNObservations=10&format=csv`)
};

// In-memory state
let cache = { boiRate: null, prime: null, cpi: null, yields: { shachar:{}, galil:{} }, workingSeries: {}, lastUpdate: null };
let history = {}; // { 'YYYY-MM-DD': { boiRate, cpi, yields } }

// ── helpers ──────────────────────────────────────────────
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
function loadFromFiles() {
  try {
    if (fs.existsSync(CACHE_FILE)) cache = { ...cache, ...JSON.parse(fs.readFileSync(CACHE_FILE,'utf8')) };
    if (fs.existsSync(HIST_FILE))  history = JSON.parse(fs.readFileSync(HIST_FILE,'utf8'));
    console.log('[init] cache loaded, lastUpdate:', cache.lastUpdate, '| history days:', Object.keys(history).length);
  } catch(e) { console.error('[init] load error:', e.message); }
}
function saveToFiles() {
  try {
    ensureDataDir();
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache,null,2));
    fs.writeFileSync(HIST_FILE,  JSON.stringify(history,null,2));
  } catch(e) { console.error('[save] error:', e.message); }
}
function httpsGet(rawUrl) {
  return new Promise((resolve, reject) => {
    https.get(rawUrl, { headers:{ 'User-Agent':'ps-mortgage-portal/2.0' } }, r => {
      let d=''; r.on('data',c=>d+=c); r.on('end',()=>resolve({status:r.statusCode,body:d}));
    }).on('error', reject);
  });
}
// Parse SDMX CSV → [{ date, value }]
function parseBOIcsv(csv) {
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return [];
  const h = lines[0].split(',');
  const ti = h.indexOf('TIME_PERIOD'), vi = h.indexOf('OBS_VALUE');
  if (ti<0||vi<0) return [];
  return lines.slice(1)
    .map(l => { const p=l.split(','); return { date:p[ti], value:parseFloat(p[vi]) }; })
    .filter(r => !isNaN(r.value));
}
// NSS formula: compute par yield at t years
function nssYield(params, t) {
  const [b0,b1,b2,b3,t1,t2] = params;
  const e1 = Math.exp(-t/t1), e2 = Math.exp(-t/t2);
  const f1 = t1/t*(1-e1), f2 = t1/t*(1-e1)-e1, f3 = t2/t*(1-e2)-e2;
  return b0 + b1*f1 + b2*f2 + b3*f3;
}

// ── data fetchers ─────────────────────────────────────────
async function fetchBOIRate() {
  try {
    const {status,body} = await httpsGet(BOI_RATE_URL);
    if (status!==200) return null;
    const rows = parseBOIcsv(body);
    return rows.length ? rows[rows.length-1].value : null;
  } catch(e) { console.error('[BOI rate]',e.message); return null; }
}

async function fetchCPI() {
  try {
    const {status,body} = await httpsGet(CBS_CPI_URL);
    if (status!==200) { console.warn('[CPI] CBS HTTP',status); return null; }
    const data = JSON.parse(body);
    // CBS response: { "result": { "record": [ {"period":"YYYY-MM","indexNumber":"NNN",...} ] } }
    //           or: { "data": { "dataValues": [...] } }
    let records = data?.result?.record || data?.data?.dataValues || [];
    if (!records.length) { console.warn('[CPI] no records in CBS response'); return null; }
    // Normalise field names
    records = records.map(r => ({
      period: r.period || r.refPeriod || '',
      val: parseFloat(r.indexNumber || r.value || r.indexValue || 0)
    })).filter(r=>r.period && !isNaN(r.val)).sort((a,b)=>a.period.localeCompare(b.period));
    const last = records[records.length-1];
    const [yr,mo] = last.period.split('-');
    const lyp = `${+yr-1}-${mo}`;
    const ly  = records.find(r=>r.period===lyp);
    const yoy = ly ? +((last.val-ly.val)/ly.val*100).toFixed(2) : null;
    console.log('[CPI] period:', last.period, 'yoy:', yoy);
    return { period: last.period, value: last.val, yoy };
  } catch(e) { console.error('[CPI]',e.message); return null; }
}

async function fetchYieldSeries(urlStr) {
  try {
    const {status,body} = await httpsGet(urlStr);
    if (status!==200) return null;
    const rows = parseBOIcsv(body);
    if (!rows.length) return null;
    // Return last 10 data points (for history)
    return rows.slice(-10);
  } catch(e) { return null; }
}

async function fetchAllYields() {
  const yields = { shachar:{}, galil:{} };
  const working = {};
  for (const [type, series] of Object.entries(YIELD_SERIES)) {
    for (const {mat, url} of series) {
      const rows = await fetchYieldSeries(url);
      if (rows) {
        const last = rows[rows.length-1];
        yields[type][mat] = { value: last.value, date: last.date, history: rows };
        working[`${type}_${mat}`] = url;
        console.log(`[yield] ${type} ${mat}: ${last.value}% (${last.date})`);
      }
    }
  }
  cache.workingSeries = working;
  if (!Object.keys(working).length) {
    console.warn('[yield] No direct yield series found, trying NSS params...');
    await fetchYieldsViaNSS(yields);
  }
  return yields;
}

async function fetchYieldsViaNSS(yields) {
  for (const [type, urls] of Object.entries(NSS_SERIES)) {
    const params = [];
    for (const u of urls) {
      const rows = await fetchYieldSeries(u);
      params.push(rows ? rows[rows.length-1].value : null);
    }
    if (params.filter(Boolean).length === 6) {
      const date = new Date().toISOString().split('T')[0];
      for (const m of MATURITIES) {
        const t = parseInt(m);
        try {
          const y = nssYield(params, t);
          yields[type][m] = { value: +y.toFixed(3), date, source:'nss' };
          console.log(`[NSS] ${type} ${m}Y: ${y.toFixed(3)}%`);
        } catch(e) {}
      }
    }
  }
}

// ── snapshot / history ────────────────────────────────────
function saveSnapshot() {
  const today = new Date().toISOString().split('T')[0];
  const snap = { boiRate: cache.boiRate, cpi: cache.cpi?.yoy, ts: new Date().toISOString(), yields: {} };
  for (const type of ['shachar','galil']) {
    snap.yields[type] = {};
    for (const [mat, d] of Object.entries(cache.yields[type]||{})) {
      snap.yields[type][mat] = d.value;
    }
  }
  history[today] = snap;
  // Keep 90 days
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate()-90);
  const cutStr = cutoff.toISOString().split('T')[0];
  for (const d of Object.keys(history)) { if (d<cutStr) delete history[d]; }
}

function getSnapshotNDaysAgo(n) {
  for (let i=n; i<=n+5; i++) {
    const d = new Date(); d.setDate(d.getDate()-i);
    const k = d.toISOString().split('T')[0];
    if (history[k]) return { date:k, data:history[k] };
  }
  return null;
}

// ── full refresh ──────────────────────────────────────────
async function refreshAllData() {
  console.log('[refresh] Starting full data refresh...');
  const [rate, cpi, yields] = await Promise.all([ fetchBOIRate(), fetchCPI(), fetchAllYields() ]);
  if (rate!==null) { cache.boiRate=rate; cache.prime=+(rate+1.5).toFixed(2); }
  if (cpi) cache.cpi=cpi;
  if (yields) cache.yields=yields;
  cache.lastUpdate = new Date().toISOString();
  saveSnapshot();
  saveToFiles();
  console.log(`[refresh] Done — BOI rate:${cache.boiRate} prime:${cache.prime} CPI YoY:${cache.cpi?.yoy}`);
}

// ── scheduler (15:00 UTC = 18:00 Israel) ─────────────────
function scheduleRefresh() {
  const now  = new Date();
  const next = new Date(); next.setUTCHours(15,0,0,0);
  if (next<=now) next.setDate(next.getDate()+1);
  const ms = next-now;
  console.log(`[scheduler] Next refresh at 15:00 UTC (~${Math.round(ms/60000)}min)`);
  setTimeout(async()=>{ await refreshAllData(); scheduleRefresh(); }, ms);
}

// ── HTTP server ───────────────────────────────────────────
const htmlPath = path.join(__dirname,'public','index.html');
let HTML = fs.readFileSync(htmlPath);

function sendJSON(res,data,status=200) {
  const j=JSON.stringify(data);
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Access-Control-Allow-Origin':'*','Cache-Control':'no-cache'});
  res.end(j);
}

http.createServer((req,res)=>{
  const {pathname,query} = url.parse(req.url,true);

  if (pathname==='/api/boi-rate') {
    https.get(BOI_RATE_URL,{headers:{'User-Agent':'ps-mortgage-portal/2.0'}},(r)=>{
      let d=''; r.on('data',c=>d+=c); r.on('end',()=>{
        res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Access-Control-Allow-Origin':'*','Cache-Control':'no-cache'});
        res.end(d);
      });
    }).on('error',e=>{ res.writeHead(502); res.end('BOI error:'+e.message); });

  } else if (pathname==='/api/live-data') {
    const week = getSnapshotNDaysAgo(7);
    const resp = {
      boiRate: cache.boiRate,
      prime:   cache.prime,
      cpi:     cache.cpi,
      yields:  cache.yields,
      weekAgo: week ? week.data : null,
      weekAgoDate: week ? week.date : null,
      lastUpdate: cache.lastUpdate,
      workingSeries: cache.workingSeries
    };
    sendJSON(res, resp);

  } else if (pathname==='/api/yield-history') {
    sendJSON(res, { history, days: Object.keys(history).length });

  } else if (pathname==='/api/refresh') {
    refreshAllData()
      .then(()=>sendJSON(res,{ok:true,lastUpdate:cache.lastUpdate}))
      .catch(e=>sendJSON(res,{ok:false,error:e.message},500));

  } else if (pathname==='/api/debug') {
    sendJSON(res,{ cache, historyDays:Object.keys(history), workingSeries:cache.workingSeries });

  } else {
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
    res.end(HTML);
  }
}).listen(PORT,'0.0.0.0',()=>{
  console.log(`PS Mortgage Portal v2 running on port ${PORT}`);
});

// ── init ──────────────────────────────────────────────────
ensureDataDir();
loadFromFiles();
const age = cache.lastUpdate ? (Date.now()-new Date(cache.lastUpdate)) : Infinity;
const stale = age > 4*60*60*1000;
if (stale || !cache.boiRate) {
  console.log('[init] Cache stale or empty — refreshing now');
  refreshAllData().catch(console.error);
} else {
  console.log('[init] Cache fresh, skipping initial refresh');
}
scheduleRefresh();

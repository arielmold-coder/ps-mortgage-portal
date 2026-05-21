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
const BOI_CPI_URL  = `${BOI_BASE}/PRI/1.0/CP_PCHYTY?lastNObservations=3&format=csv`;
// ZCM = inflation expectations & zero-coupon yield curve (monthly)
// Fetch last 2 months so we have current + prev month for comparison
const BOI_ZCM_URL  = `${BOI_BASE}/ZCM/1.0?lastNObservations=2&format=csv`;

// Available maturities (30Y not published; 20Y is the max)
const MATURITIES = ['1Y','3Y','5Y','10Y','15Y'];

// Correct ZCM series codes (confirmed via API exploration)
const ZCM_SERIES = {
  shachar: {
    '1Y':  'ZC_TSB_ZND_01Y_MA',
    '3Y':  'ZC_TSB_ZND_03Y_MA',
    '5Y':  'ZC_TSB_ZND_05Y_MA',
    '10Y': 'ZC_TSB_ZND_10Y_MA',
    '15Y': 'ZC_TSB_ZND_15Y_MA'
  },
  galil: {
    '1Y':  'ZC_TSB_ZRD_01Y_MA',
    '3Y':  'ZC_TSB_ZRD_03Y_MA',
    '5Y':  'ZC_TSB_ZRD_05Y_MA',
    '10Y': 'ZC_TSB_ZRD_10Y_MA',
    '15Y': 'ZC_TSB_ZRD_15Y_MA'
  }
};

// In-memory state
let cache = {
  boiRate: null, prime: null, cpi: null,
  yields: { shachar:{}, galil:{} },
  lastUpdate: null
};
let history = {}; // { 'YYYY-MM': { boiRate, cpi, yields:{shachar:{},galil:{}} } }

// ── helpers ──────────────────────────────────────────────
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
function loadFromFiles() {
  try {
    if (fs.existsSync(CACHE_FILE)) cache = { ...cache, ...JSON.parse(fs.readFileSync(CACHE_FILE,'utf8')) };
    if (fs.existsSync(HIST_FILE))  history = JSON.parse(fs.readFileSync(HIST_FILE,'utf8'));
    console.log('[init] cache loaded, lastUpdate:', cache.lastUpdate, '| history months:', Object.keys(history).length);
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
// Parse SDMX CSV → array of row objects
function parseBOIcsv(csv) {
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return [];
  const h = lines[0].split(',');
  return lines.slice(1).map(l => {
    const p = l.split(',');
    const obj = {};
    h.forEach((k,i) => obj[k.trim()] = (p[i]||'').trim());
    return obj;
  });
}

// ── data fetchers ─────────────────────────────────────────
async function fetchBOIRate() {
  try {
    const {status,body} = await httpsGet(BOI_RATE_URL);
    if (status!==200) return null;
    const rows = parseBOIcsv(body);
    const last = rows.filter(r=>r.OBS_VALUE).pop();
    const val = last ? parseFloat(last.OBS_VALUE) : null;
    console.log('[BOI rate]', val, last?.TIME_PERIOD);
    return val;
  } catch(e) { console.error('[BOI rate]',e.message); return null; }
}

async function fetchCPI() {
  try {
    const {status,body} = await httpsGet(BOI_CPI_URL);
    if (status!==200) { console.warn('[CPI] HTTP',status); return null; }
    const rows = parseBOIcsv(body).filter(r=>r.OBS_VALUE);
    if (!rows.length) { console.warn('[CPI] no rows'); return null; }
    // Rows sorted by TIME_PERIOD ascending; last = most recent
    rows.sort((a,b)=>a.TIME_PERIOD.localeCompare(b.TIME_PERIOD));
    const last = rows[rows.length-1];
    const yoy  = parseFloat(last.OBS_VALUE);
    console.log('[CPI] period:', last.TIME_PERIOD, 'yoy:', yoy);
    return { period: last.TIME_PERIOD, yoy: +yoy.toFixed(2) };
  } catch(e) { console.error('[CPI]',e.message); return null; }
}

async function fetchAllYields() {
  try {
    const {status,body} = await httpsGet(BOI_ZCM_URL);
    if (status!==200) { console.warn('[ZCM] HTTP',status); return null; }
    const rows = parseBOIcsv(body).filter(r=>r.OBS_VALUE&&r.SERIES_CODE);

    // Build lookup: series_code -> sorted rows
    const byCode = {};
    for (const row of rows) {
      if (!byCode[row.SERIES_CODE]) byCode[row.SERIES_CODE] = [];
      byCode[row.SERIES_CODE].push({ period: row.TIME_PERIOD, value: parseFloat(row.OBS_VALUE) });
    }

    const yields = { shachar:{}, galil:{} };
    for (const [type, matMap] of Object.entries(ZCM_SERIES)) {
      for (const [mat, code] of Object.entries(matMap)) {
        const entries = byCode[code];
        if (!entries || !entries.length) { console.warn(`[ZCM] missing ${code}`); continue; }
        entries.sort((a,b)=>a.period.localeCompare(b.period));
        const last = entries[entries.length-1];
        const prev = entries.length>1 ? entries[entries.length-2] : null;
        yields[type][mat] = {
          value:    +last.value.toFixed(4),
          period:   last.period,
          prevValue: prev ? +prev.value.toFixed(4) : null,
          prevPeriod: prev ? prev.period : null
        };
        console.log(`[ZCM] ${type} ${mat}: ${last.value.toFixed(3)}% (${last.period})`);
      }
    }
    return yields;
  } catch(e) { console.error('[ZCM]',e.message); return null; }
}

// ── snapshot / history ────────────────────────────────────
function saveSnapshot() {
  // Key by month (YYYY-MM) since ZCM data is monthly
  const month = new Date().toISOString().substring(0,7);
  const snap = {
    boiRate: cache.boiRate,
    cpiYoy:  cache.cpi?.yoy,
    ts:      new Date().toISOString(),
    yields:  {}
  };
  for (const type of ['shachar','galil']) {
    snap.yields[type] = {};
    for (const [mat, d] of Object.entries(cache.yields[type]||{})) {
      snap.yields[type][mat] = d.value;
    }
  }
  history[month] = snap;
  // Keep 24 months
  const months = Object.keys(history).sort();
  if (months.length > 24) {
    for (const old of months.slice(0, months.length-24)) delete history[old];
  }
}

function getPrevMonthSnapshot() {
  const months = Object.keys(history).sort();
  if (months.length < 2) return null;
  const prev = months[months.length-2];
  return { month: prev, data: history[prev] };
}

// ── full refresh ──────────────────────────────────────────
async function refreshAllData() {
  console.log('[refresh] Starting full data refresh...');
  const [rate, cpi, yields] = await Promise.all([ fetchBOIRate(), fetchCPI(), fetchAllYields() ]);
  if (rate!==null) { cache.boiRate=rate; cache.prime=+(rate+1.5).toFixed(2); }
  if (cpi)    cache.cpi    = cpi;
  if (yields) cache.yields = yields;
  cache.lastUpdate = new Date().toISOString();
  saveSnapshot();
  saveToFiles();
  console.log(`[refresh] Done — BOI:${cache.boiRate} prime:${cache.prime} CPI YoY:${cache.cpi?.yoy}%`);
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
  const {pathname} = url.parse(req.url,true);

  if (pathname==='/api/boi-rate') {
    // Raw proxy (backward compat)
    https.get(BOI_RATE_URL,{headers:{'User-Agent':'ps-mortgage-portal/2.0'}},(r)=>{
      let d=''; r.on('data',c=>d+=c); r.on('end',()=>{
        res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Access-Control-Allow-Origin':'*','Cache-Control':'no-cache'});
        res.end(d);
      });
    }).on('error',e=>{ res.writeHead(502); res.end('BOI error:'+e.message); });

  } else if (pathname==='/api/live-data') {
    const prev = getPrevMonthSnapshot();
    const resp = {
      boiRate:    cache.boiRate,
      prime:      cache.prime,
      cpi:        cache.cpi,
      yields:     cache.yields,
      prevMonth:  prev ? prev.data : null,
      prevMonthKey: prev ? prev.month : null,
      lastUpdate: cache.lastUpdate
    };
    sendJSON(res, resp);

  } else if (pathname==='/api/yield-history') {
    sendJSON(res, { history, months: Object.keys(history).length });

  } else if (pathname==='/api/refresh') {
    refreshAllData()
      .then(()=>sendJSON(res,{ok:true,lastUpdate:cache.lastUpdate,boiRate:cache.boiRate,cpi:cache.cpi}))
      .catch(e=>sendJSON(res,{ok:false,error:e.message},500));

  } else if (pathname==='/api/debug') {
    sendJSON(res,{ cache, historyMonths:Object.keys(history), maturities: MATURITIES });

  } else {
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
    res.end(HTML);
  }
}).listen(PORT,'0.0.0.0',()=>{
  console.log(`PS Mortgage Portal v3 running on port ${PORT}`);
  console.log(`Maturities: ${MATURITIES.join(', ')} (note: 30Y not published by BOI; 20Y is max)`);
});

// ── init ──────────────────────────────────────────────────
ensureDataDir();
loadFromFiles();
const age   = cache.lastUpdate ? (Date.now()-new Date(cache.lastUpdate)) : Infinity;
const stale = age > 4*60*60*1000;
if (stale || !cache.boiRate) {
  console.log('[init] Cache stale or empty — refreshing now');
  refreshAllData().catch(console.error);
} else {
  console.log('[init] Cache fresh, skipping initial refresh');
}
scheduleRefresh();

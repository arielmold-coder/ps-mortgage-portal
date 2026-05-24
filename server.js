const http  = require('http');
let XLSX; try { XLSX = require('xlsx'); } catch(e) { console.warn('[xlsx] not available, XLS parsing disabled'); }
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
const USER_BONDS_FILE = path.join(DATA_DIR, 'user-bonds.json');

const BANK_RATES_FILE = path.join(DATA_DIR, 'bank-rates.json');
const BOI_XLS_URL = 'https://www.boi.org.il/boi_files/Pikuah/TamInt010.xls';

// BIR SDMX series for per-bank mortgage rates
// REP_ENTITY codes: 11=הפועלים 12=לאומי 17=מזרחי 18=בינלאומי 20=דיסקונט 31=מרכנתיל 10=ירושלים
const BANK_META = {
  '11': 'הפועלים',
  '12': 'לאומי',
  '17': 'מזרחי טפחות',
  '18': 'בינלאומי',
  '20': 'דיסקונט',
  '31': 'מרכנתיל',
  '10': 'ירושלים'
};
// Series suffix → track description
// _2155 = prime-linked (פריים), _4122 = fixed nominal Q1, _2151 = CPI-linked
const BIR_TRACKS = {
  prime:    { suffix: '2155', label: 'משתנה – פריים',      type: 'NI' },
  fixedNI:  { suffix: '4122', label: 'קבוע לא צמוד',      type: 'NI' },
  fixedCI:  { suffix: '2151', label: 'צמוד מדד',           type: 'CI' }
};
// Aggregate series
const BIR_AVG_SERIES = 'BNK_99010_LR_BIR_1893'; // all-banks avg mortgage rate


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
  bankRates: null,
  lastUpdate: null
};
let history = {}; // { 'YYYY-MM': { boiRate, cpi, yields:{shachar:{},galil:{}} } }
let userBonds = null; // uploaded bond data { bonds:[], filename, uploadedAt }

// ── helpers ──────────────────────────────────────────────
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
function loadFromFiles() {
  try {
    if (fs.existsSync(CACHE_FILE)) cache = { ...cache, ...JSON.parse(fs.readFileSync(CACHE_FILE,'utf8')) };
    if (fs.existsSync(HIST_FILE))  history = JSON.parse(fs.readFileSync(HIST_FILE,'utf8'));
    if (fs.existsSync(USER_BONDS_FILE)) userBonds = JSON.parse(fs.readFileSync(USER_BONDS_FILE,'utf8'));
    if (cache.bankRates) console.log('[init] bankRates loaded, period:', cache.bankRates.period);
    console.log('[init] cache loaded, lastUpdate:', cache.lastUpdate, '| history months:', Object.keys(history).length);
  } catch(e) { console.error('[init] load error:', e.message); }
}
function saveToFiles() {
  try {
    ensureDataDir();
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache,null,2));
    fs.writeFileSync(HIST_FILE,  JSON.stringify(history,null,2));
    if (userBonds) fs.writeFileSync(USER_BONDS_FILE, JSON.stringify(userBonds,null,2));
  } catch(e) { console.error('[save] error:', e.message); }
}
function httpsGet(rawUrl) {
  return new Promise((resolve, reject) => {
    https.get(rawUrl, { headers:{ 'User-Agent':'ps-mortgage-portal/2.0' } }, r => {
      let d=''; r.on('data',c=>d+=c); r.on('end',()=>resolve({status:r.statusCode,body:d}));
    }).on('error', reject);
  });
}
// Parse SDMX CSV → array of row objects (handles quoted fields with commas)
function parseCsvLine(line) {
  const result = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' ) { inQ = !inQ; }
    else if (c === ',' && !inQ) { result.push(cur.trim()); cur = ''; }
    else { cur += c; }
  }
  result.push(cur.trim());
  return result;
}
function parseBOIcsv(csv) {
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return [];
  const h = parseCsvLine(lines[0]);
  return lines.slice(1).map(l => {
    const p = parseCsvLine(l);
    const obj = {};
    h.forEach((k,i) => obj[k] = (p[i]||'').trim());
    return obj;
  });
}

// ── user-uploaded bond yields → same shape as fetchAllYields output ─────
function yieldsFromUserBonds() {
  if (!userBonds || !userBonds.bonds || !userBonds.bonds.length) return null;
  const yields = { shachar:{}, galil:{} };
  for (const b of userBonds.bonds) {
    const type = b.type; // 'shachar' | 'galil'
    const mat  = b.maturity;
    if (!yields[type]) continue;
    // Build same shape as ZCM: value + period, no prevValue (user upload has no prev)
    yields[type][mat] = {
      value:  +parseFloat(b.yield_pct).toFixed(4),
      period: b.date || userBonds.uploadedAt?.substring(0,10) || 'user',
      prevValue:  cache.yields?.[type]?.[mat]?.value ?? null,   // keep last known as "prev"
      prevPeriod: cache.yields?.[type]?.[mat]?.period ?? null,
      source: 'user'
    };
  }
  return yields;
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


// ── bank rates: download XLS from BOI ────────────────────
function httpsGetBinary(rawUrl) {
  return new Promise((resolve, reject) => {
    const doRequest = (u, depth=0) => {
      const mod = u.startsWith('https') ? https : require('http');
      mod.get(u, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; ps-mortgage-portal/2.0)',
          'Accept': 'application/vnd.ms-excel,*/*'
        }
      }, r => {
        if ((r.statusCode === 301 || r.statusCode === 302) && r.headers.location && depth < 3) {
          return doRequest(r.headers.location, depth+1);
        }
        const chunks = [];
        r.on('data', c => chunks.push(c));
        r.on('end', () => resolve({ status: r.statusCode, buffer: Buffer.concat(chunks) }));
      }).on('error', reject);
    };
    doRequest(rawUrl);
  });
}

async function fetchBankRatesXLS() {
  if (!XLSX) { console.warn('[bank-rates] xlsx not available'); return null; }
  // Hebrew month names for display
  const HE_MONTHS = {
    '01':'ינואר','02':'פברואר','03':'מרץ','04':'אפריל',
    '05':'מאי','06':'יוני','07':'יולי','08':'אוגוסט',
    '09':'ספטמבר','10':'אוקטובר','11':'נובמבר','12':'דצמבר'
  };
  function periodHe(iso) {
    // "2026-04" -> "אפריל 2026"
    const m = iso && iso.match(/^(\d{4})-(\d{2})$/);
    return m ? `${HE_MONTHS[m[2]]||m[2]} ${m[1]}` : iso;
  }

  try {
    console.log('[bank-rates] Downloading TamInt010.xls...');
    const { status, buffer } = await httpsGetBinary(BOI_XLS_URL);
    if (status !== 200) { console.warn('[bank-rates] XLS HTTP', status); return null; }
    console.log('[bank-rates] XLS downloaded,', buffer.length, 'bytes');

    const wb = XLSX.read(buffer, { type: 'buffer' });
    console.log('[bank-rates] Sheets:', wb.SheetNames);

    // TamInt010.xls structure (L01 sheet):
    // Row 0: Excel serial date (file update date)
    // Rows 1-8: Titles
    // Row 9: Bank names at fixed columns: פועלים@1, לאומי@7, דיסקונט@13,
    //         מזרחי@19, בינלאומי@25, מרכנתיל@31, ירושלים@37, סך מערכת@43
    // Row 11: Track names (offsets from bank col):
    //         +0=IRR(3IRR), +1=קבועה לא צמודה, +2=פריים, +3=משתנה לא צמודה, +4=משתנה צמוד, +5=קבועה צמוד
    // Row 12+: Data rows — col 0 = "YYYY-MM" string, values at bank+track cols
    //          Most recent period is row 12 (newest first)

    const BANK_KEYS = {
      'פועלים':'הפועלים', 'לאומי':'לאומי', 'דיסקונט':'דיסקונט',
      'מזרחי':'מזרחי טפחות', 'בינלאומי':'בינלאומי',
      'מרכנתיל':'מרכנתיל', 'ירושלים':'ירושלים',
      'מערכת':'ממוצע מערכת', 'סך':'ממוצע מערכת', 'כלל':'ממוצע מערכת'
    };
    // Track offsets from bank base column
    const TRACK_OFF = { irr: 0, fixedNI: 1, prime: 2, varNI: 3, varCI: 4, fixedCI: 5 };

    for (const sheetName of wb.SheetNames) {
      const ws = wb.Sheets[sheetName];
      const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
      if (!data || data.length < 13) continue;

      // 1. Find bank columns by scanning rows 5-15
      const bankCols = {}; // bankCanonName -> base column index
      for (let ri = 5; ri < Math.min(15, data.length); ri++) {
        const row = data[ri] || [];
        for (let ci = 0; ci < row.length; ci++) {
          const cell = row[ci];
          if (!cell || typeof cell !== 'string') continue;
          for (const [key, name] of Object.entries(BANK_KEYS)) {
            if (cell.includes(key) && !bankCols[name]) {
              bankCols[name] = ci;
              break;
            }
          }
        }
        if (Object.keys(bankCols).length >= 5) break;
      }
      if (Object.keys(bankCols).length < 3) {
        console.log('[bank-rates] Sheet', sheetName, '— not enough banks found, skipping');
        continue;
      }

      // 2. Find most recent data row — col 0 has "YYYY-MM" format
      let latestPeriod = null, latestRow = null;
      for (let ri = 10; ri < data.length; ri++) {
        const row = data[ri];
        if (!row) continue;
        const cell = row[0];
        if (cell && typeof cell === 'string' && /^\d{4}-\d{2}$/.test(cell.trim())) {
          const period = cell.trim();
          if (!latestPeriod || period > latestPeriod) {
            latestPeriod = period;
            latestRow = row;
          }
        }
      }
      if (!latestPeriod || !latestRow) {
        console.log('[bank-rates] Sheet', sheetName, '— no date rows found, skipping');
        continue;
      }

      // 3. Extract IRR and track values per bank
      const banks = {};
      const tracks = {}; // bankName -> { irr, fixedNI, prime, varCI, fixedCI }
      for (const [bankName, baseCol] of Object.entries(bankCols)) {
        const irr = parseFloat(latestRow[baseCol + TRACK_OFF.irr]);
        if (isNaN(irr) || irr < 1 || irr > 20) continue;
        banks[bankName] = +irr.toFixed(4);
        tracks[bankName] = {};
        for (const [track, off] of Object.entries(TRACK_OFF)) {
          const v = parseFloat(latestRow[baseCol + off]);
          if (!isNaN(v) && v > 0 && v < 20) tracks[bankName][track] = +v.toFixed(4);
        }
      }

      if (Object.keys(banks).length >= 3) {
        const displayPeriod = periodHe(latestPeriod);
        console.log('[bank-rates] XLS parsed sheet:', sheetName,
          '| period:', latestPeriod, '(', displayPeriod, ')',
          '| banks:', Object.keys(banks).join(', '));
        return { period: latestPeriod, periodHe: displayPeriod, banks, tracks, source: 'xls', sheet: sheetName };
      }
    }

    console.warn('[bank-rates] XLS: no usable sheet found');
    return null;
  } catch(e) {
    console.error('[bank-rates] XLS error:', e.message);
    return null;
  }
}


// SDMX BIR fallback — per track, per bank
async function fetchBankRatesSDMX() {
  try {
    console.log('[bank-rates] Fetching SDMX BIR...');
    // Fetch all BIR with 1 obs
    const {status, body} = await httpsGet(
      `${BOI_BASE}/BIR/1.0?lastNObservations=2&format=csv`
    );
    if (status !== 200) { console.warn('[BIR] HTTP', status); return null; }
    const rows = parseBOIcsv(body).filter(r => r.OBS_VALUE && r.SERIES_CODE);

    // Index by series code → last value
    const byCode = {};
    for (const row of rows) {
      const code = row.SERIES_CODE;
      if (!byCode[code] || row.TIME_PERIOD > byCode[code].period) {
        byCode[code] = { value: parseFloat(row.OBS_VALUE), period: row.TIME_PERIOD };
      }
    }

    // Aggregate
    const avgEntry = byCode[BIR_AVG_SERIES];
    const period = avgEntry?.period || 'n/a';

    // Per bank per track
    const banks = {};
    for (const [bankId, bankName] of Object.entries(BANK_META)) {
      const padded = bankId.padStart(2,'0');
      const entry = {};
      for (const [track, meta] of Object.entries(BIR_TRACKS)) {
        const code = `BNK_${padded}001_LR_BIR_${meta.suffix}`;
        const d = byCode[code];
        if (d) entry[track] = { value: +d.value.toFixed(4), period: d.period };
      }
      if (Object.keys(entry).length) banks[bankName] = entry;
    }

    console.log('[bank-rates] SDMX BIR fetched, period:', period, '| banks:', Object.keys(banks).join(', '));
    return {
      period,
      avg: avgEntry ? +avgEntry.value.toFixed(4) : null,
      perBank: banks,
      source: 'sdmx'
    };
  } catch(e) {
    console.error('[bank-rates] SDMX error:', e.message);
    return null;
  }
}

async function fetchBankRates() {
  // Try XLS first (most current), fall back to SDMX
  const xls = await fetchBankRatesXLS();
  if (xls) {
    return { ...xls, fallback: false };
  }
  console.log('[bank-rates] XLS failed, trying SDMX fallback...');
  const sdmx = await fetchBankRatesSDMX();
  if (sdmx) return { ...sdmx, fallback: true };
  return null;
}

// ── full refresh ──────────────────────────────────────────
async function refreshAllData() {
  console.log('[refresh] Starting full data refresh...');
  const [rate, cpi, zcmYields, bankRates] = await Promise.all([ fetchBOIRate(), fetchCPI(), fetchAllYields(), fetchBankRates() ]);
  if (rate!==null) { cache.boiRate=rate; cache.prime=+(rate+1.5).toFixed(2); }
  if (cpi) cache.cpi = cpi;
  // Yields: prefer user-uploaded data; fall back to ZCM
  const yields = yieldsFromUserBonds() || zcmYields;
  if (yields) cache.yields = yields;
  if (bankRates) { cache.bankRates = bankRates; }
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
    sendJSON(res,{ cache, historyMonths:Object.keys(history), maturities: MATURITIES, hasUserBonds: !!userBonds });

  } else if (pathname==='/api/user-bonds') {
    sendJSON(res, { data: userBonds, source: userBonds ? 'user' : 'boi-zcm' });

  } else if (pathname==='/api/upload-bonds' && req.method==='POST') {
    let body='';
    req.on('data',c=>body+=c);
    req.on('end',()=>{
      try {
        const payload = JSON.parse(body);
        if (!payload.bonds || !Array.isArray(payload.bonds)) {
          return sendJSON(res,{ok:false,error:'invalid payload — need bonds array'},400);
        }
        // Validate rows
        const valid = payload.bonds.filter(b=>
          b.type && (b.type==='shachar'||b.type==='galil') &&
          b.maturity && !isNaN(parseFloat(b.yield_pct))
        );
        if (!valid.length) return sendJSON(res,{ok:false,error:'no valid rows'},400);
        userBonds = { bonds: valid, filename: payload.filename||'upload.csv', uploadedAt: payload.uploadedAt||new Date().toISOString() };
        // Immediately rebuild yields from user data
        const uy = yieldsFromUserBonds();
        if (uy) { cache.yields = uy; cache.lastUpdate = new Date().toISOString(); }
        ensureDataDir();
        fs.writeFileSync(USER_BONDS_FILE, JSON.stringify(userBonds,null,2));
        console.log('[user-bonds] Loaded', valid.length, 'entries from', userBonds.filename);
        sendJSON(res, { ok:true, count: valid.length, data: userBonds });
      } catch(e) { sendJSON(res,{ok:false,error:e.message},500); }
    });

  } else if (pathname==='/api/upload-bonds' && req.method==='DELETE') {
    userBonds = null;
    try { if(fs.existsSync(USER_BONDS_FILE)) fs.unlinkSync(USER_BONDS_FILE); } catch(e){}
    // Restore ZCM yields
    fetchAllYields().then(y=>{ if(y){cache.yields=y;cache.lastUpdate=new Date().toISOString();} });
    sendJSON(res, { ok:true, message:'user bonds cleared; reverting to BOI ZCM' });

  } else if (pathname==='/api/bank-rates') {
    sendJSON(res, { data: cache.bankRates, lastUpdate: cache.lastUpdate });

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

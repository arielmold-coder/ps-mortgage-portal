const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

const PORT    = process.env.PORT || 3000;
const htmlPath = path.join(__dirname, 'public', 'index.html');
const HTML    = fs.readFileSync(htmlPath);

const BOI_URL = 'https://edge.boi.gov.il/FusionEdgeServer/sdmx/v2/data/dataflow/BOI.STATISTICS/BR/1.0/MNT_RIB_BOI_D?lastNObservations=1&format=csv';

function fetchBOI(res) {
  https.get(BOI_URL, { headers: { 'User-Agent': 'ps-mortgage-portal/1.0' } }, (r) => {
    let data = '';
    r.on('data', chunk => data += chunk);
    r.on('end', () => {
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache'
      });
      res.end(data);
    });
  }).on('error', (e) => {
    res.writeHead(502);
    res.end('BOI fetch error: ' + e.message);
  });
}

http.createServer((req, res) => {
  const pathname = url.parse(req.url).pathname;

  if (pathname === '/api/boi-rate') {
    fetchBOI(res);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
  }
}).listen(PORT, '0.0.0.0', () => {
  console.log('PS Mortgage Portal running on port ' + PORT);
});

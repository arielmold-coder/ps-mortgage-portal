const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const htmlPath = path.join(__dirname, 'public', 'index.html');
const HTML = fs.readFileSync(htmlPath);

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(HTML);
}).listen(PORT, '0.0.0.0', () => {
  console.log('PS Mortgage Portal running on port ' + PORT);
});

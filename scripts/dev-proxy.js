#!/usr/bin/env node
/**
 * Server di sviluppo locale — Campagna AI
 * ------------------------------------------------------------------
 * Fa due cose:
 *   1. serve i file statici del progetto;
 *   2. inoltra le richieste `/catasto/*` al WMS della cartografia catastale
 *      dell'Agenzia delle Entrate, replicando *esattamente* il rewrite
 *      definito in `vercel.json`.
 *
 * Perché serve: il servizio WMS dell'Agenzia delle Entrate non invia gli
 * header CORS. Inoltrando la richiesta dal nostro dominio la richiesta diventa
 * "same-origin" per il browser, quindi:
 *   - non serve alcun header CORS;
 *   - il canvas della mappa non viene "sporcato" e le linee catastali
 *     finiscono correttamente nell'immagine PNG esportata.
 *
 * Uso:
 *   node scripts/dev-proxy.js        (oppure: npm run dev)
 *   PORT=8080 node scripts/dev-proxy.js
 */
'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 5173);
const ROOT = path.resolve(__dirname, '..');

const UPSTREAM = 'https://wms.cartografia.agenziaentrate.gov.it/inspire/wms/';
const PREFIX = '/catasto/';

/**
 * WFS dell'Agenzia delle Entrate: serve il contorno esatto di una particella
 * trovata con la ricerca. Anche questo servizio non invia header CORS, quindi
 * passa dallo stesso inoltro (in produzione: rewrite di Vercel su /wfs/*).
 */
const UPSTREAM_WFS = 'https://wfs.cartografia.agenziaentrate.gov.it/inspire/wfs/';
const PREFIX_WFS = '/wfs/';

const TIMEOUT_MS = 30000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8'
};

/** Inoltra la richiesta al WMS (o al WFS) catastale. */
function proxyCatasto(req, res, upstream, prefix) {
  const target = upstream + req.url.slice(prefix.length);

  const upstreamReq = https.get(
    target,
    {
      headers: {
        'User-Agent': 'campagna-ai-dev-proxy/0.1 (+https://localhost)',
        Accept: prefix === PREFIX_WFS
          ? 'application/xml,text/xml,*/*;q=0.8'
          : 'image/png,image/*;q=0.9,*/*;q=0.8'
      }
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, {
        'Content-Type': upstreamRes.headers['content-type'] || 'application/octet-stream',
        // In sviluppo è già same-origin, l'header è qui solo per trasparenza.
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store'
      });
      upstreamRes.pipe(res);
    }
  );

  upstreamReq.setTimeout(TIMEOUT_MS, () => {
    upstreamReq.destroy(new Error('timeout del servizio catastale'));
  });

  upstreamReq.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    res.end('Proxy catasto: ' + err.message);
  });
}

/** Serve i file statici del progetto. */
function serveStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('400 - richiesta non valida');
    return;
  }

  if (pathname.endsWith('/')) pathname += 'index.html';

  const filePath = path.normalize(path.join(ROOT, pathname));

  // Protezione contro il path traversal: il file deve restare dentro ROOT.
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 - accesso negato');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 - ' + pathname);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith(PREFIX)) {
    proxyCatasto(req, res, UPSTREAM, PREFIX);
  } else if (req.url.startsWith(PREFIX_WFS)) {
    proxyCatasto(req, res, UPSTREAM_WFS, PREFIX_WFS);
  } else {
    serveStatic(req, res);
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Porta ${PORT} già occupata. Prova: PORT=8080 node scripts/dev-proxy.js\n`);
  } else {
    console.error('\n  Errore server:', err.message, '\n');
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log('\n  Campagna AI — server di sviluppo attivo\n');
  console.log(`  App:      http://localhost:${PORT}/`);
  console.log(`  Catasto:  http://localhost:${PORT}${PREFIX}ows01.php`);
  console.log(`            -> ${UPSTREAM}`);
  console.log(`  WFS:      http://localhost:${PORT}${PREFIX_WFS}owfs01.php`);
  console.log(`            -> ${UPSTREAM_WFS}\n`);
  console.log('  (in produzione Vercel applica lo stesso inoltro via vercel.json)\n');
});

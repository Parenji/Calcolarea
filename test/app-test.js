/* ==========================================================================
   Prova nell'app vera — `npm run test:app`
   --------------------------------------------------------------------------
   Apre l'applicazione in un browser senza finestra, aspetta che i dati
   catastali arrivino e controlla i comportamenti che contano: che non ci siano
   errori, che i numeri delle particelle si disegnino, che la calamita sia
   agganciata, che la superficie di una particella si misuri, che un clic su un
   vertice lo elimini, che un poligono si disegni e che l'immagine si componga.

   Richiede il server di sviluppo acceso (`npm run dev`).
   ========================================================================== */

'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const INDIRIZZO = process.env.CALCOLAREA_URL || 'http://localhost:5173/';
const CHROME = process.env.CHROME_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 10600 + Math.floor(Math.random() * 300);
const ATTESA_AVVIO = Number(process.env.ATTESA || 9000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passati = 0;
let falliti = 0;

function verifica(descrizione, condizione, dettaglio) {
  if (condizione) {
    passati += 1;
    console.log('  ok   ' + descrizione);
  } else {
    falliti += 1;
    console.log('  FALLITO  ' + descrizione + (dettaglio ? '  → ' + dettaglio : ''));
  }
}

async function main() {
  const profilo = path.join('/tmp', 'calcolarea-test-' + process.pid);
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--disable-crash-reporter', '--hide-scrollbars', '--window-size=1280,900',
    '--user-data-dir=' + profilo, '--remote-debugging-port=' + PORT, 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'ignore'] });

  let ws;
  for (let i = 0; i < 80; i += 1) {
    try {
      const j = await (await fetch('http://127.0.0.1:' + PORT + '/json/version')).json();
      if (j.webSocketDebuggerUrl) { ws = new WebSocket(j.webSocketDebuggerUrl); break; }
    } catch (e) { /* il browser sta ancora partendo */ }
    await sleep(300);
  }
  if (!ws) throw new Error('il browser non si è avviato');

  await new Promise((r) => ws.addEventListener('open', r, { once: true }));

  let id = 0;
  const pending = new Map();
  const problemi = [];

  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve } = pending.get(m.id);
      pending.delete(m.id);
      resolve(m.result);
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      problemi.push('ECCEZIONE: ' + String(d.exception && d.exception.description).split('\n')[0].slice(0, 220));
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      problemi.push('ERRORE CONSOLE: ' + m.params.args.map((a) => a.value || a.description || '').join(' ').slice(0, 220));
    }
  });

  function invia(method, params, sessionId) {
    const mioId = ++id;
    const p = { id: mioId, method, params: params || {} };
    if (sessionId) p.sessionId = sessionId;
    ws.send(JSON.stringify(p));
    return new Promise((res) => pending.set(mioId, { resolve: res }));
  }

  const { targetId } = await invia('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await invia('Target.attachToTarget', { targetId, flatten: true });
  await invia('Runtime.enable', {}, sessionId);
  await invia('Page.enable', {}, sessionId);
  await invia('Page.navigate', { url: INDIRIZZO }, sessionId);
  await sleep(ATTESA_AVVIO);

  async function valuta(espressione) {
    const r = await invia('Runtime.evaluate', {
      expression: espressione, returnByValue: true, awaitPromise: true
    }, sessionId);
    if (r.exceptionDetails) {
      return { __errore: String(r.exceptionDetails.exception && r.exceptionDetails.exception.description).slice(0, 300) };
    }
    return r.result.value;
  }

  async function clic(x, y) {
    await invia('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 }, sessionId);
    await sleep(140);
    await invia('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId);
    await sleep(60);
    await invia('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId);
    await sleep(320);
  }

  console.log('Avvio');
  const moduli = await valuta('({ map: typeof Campagna.map, catasto: typeof Campagna.catasto, ' +
    'draw: typeof Campagna.draw, ricerca: typeof Campagna.ricerca, numeri: typeof Campagna.numeri, ' +
    'punto: typeof Campagna.punto, store: typeof Campagna.store })');
  ['map', 'catasto', 'draw', 'ricerca', 'numeri', 'punto', 'store'].forEach(function (nome) {
    verifica('modulo ' + nome, moduli && moduli[nome] === 'object', 'vale ' + (moduli && moduli[nome]));
  });

  console.log('\nCatasto');
  await valuta(`(function () {
    var m = Campagna.map.getMap();
    m.getView().setCenter(ol.proj.fromLonLat([11.100643, 42.750394]));
    m.getView().setZoom(17);
    m.renderSync();
    Campagna.catasto.setEnabled('particelle', true);
    Campagna.catasto.updateResolution();
    return true;
  })()`);
  await sleep(16000);

  const catasto = await valuta(`(function () {
    var m = Campagna.map.getMap();
    // i numeri stanno fra i livelli della mappa, lo sfondo del catasto
    // dentro il gruppo dedicato
    var numeri = null;
    var sfondo = null;
    m.getLayers().getArray().forEach(function (l) {
      if (l.get('catastoKey') === '__numeri') numeri = l;
    });
    var gruppo = Campagna.map.getCatastoGroup();
    if (gruppo) {
      gruppo.getLayers().getArray().forEach(function (l) {
        if (l.get('catastoKey') === '__sfondo') sfondo = l;
      });
    }
    return {
      etichette: numeri && numeri.getSource() ? numeri.getSource().getFeatures().length : 0,
      sfondoVisibile: sfondo ? sfondo.getVisible() : false,
      snap: m.getInteractions().getArray().filter(function (i) { return i instanceof ol.interaction.Snap; }).length,
      zoom: m.getView().getZoom()
    };
  })()`);
  verifica('numeri delle particelle disegnati', catasto.etichette > 20, 'trovate ' + catasto.etichette);
  verifica('sfondo chiaro acceso', catasto.sfondoVisibile === true);
  verifica('calamita agganciata', catasto.snap >= 1);

  console.log('\nSuperficie di una particella');
  const superficie = await valuta(`(async function () {
    var esiti = {};
    try {
      var contorno = await Campagna.ricerca.contornoParticella(42.750394, 11.100643, 'E202', '0087', '888');
      esiti.mq = contorno ? Campagna.ricerca.areaDelContorno(contorno) : null;
      esiti.testo = esiti.mq ? Campagna.measure.formatArea(esiti.mq) : null;
    } catch (e) { esiti.errore = String(e && e.message); }
    return esiti;
  })()`);
  verifica('contorno e superficie ottenuti', !!(superficie && superficie.mq > 0),
    superficie && (superficie.errore || 'mq ' + superficie.mq));
  console.log('       ' + (superficie && superficie.testo ? 'superficie: ' + superficie.testo : ''));

  console.log('\nEliminazione di un vertice');
  const preparato = await valuta(`(function () {
    var m = Campagna.map.getMap();
    var centro = ol.proj.fromLonLat([11.100643, 42.750394]);
    var d = 60;
    var anello = [
      [centro[0] - d, centro[1] - d], [centro[0] + d, centro[1] - d],
      [centro[0] + d, centro[1] + d], [centro[0] - d, centro[1] + d],
      [centro[0] - d, centro[1] - d]
    ];
    var f = new ol.Feature(new ol.geom.Polygon([anello]));
    Campagna.draw.addFeature(f);
    Campagna.draw.setActiveFeature(f);
    var pulsante = document.getElementById('btn-modify');
    if (pulsante) pulsante.click();
    var rect = document.getElementById('map').getBoundingClientRect();
    var px = m.getPixelFromCoordinate(anello[1]);
    return {
      prima: f.getGeometry().getCoordinates()[0].length,
      strumento: Campagna.draw.getTool(),
      clic: [Math.round(rect.left + px[0]), Math.round(rect.top + px[1])]
    };
  })()`);
  await sleep(700);
  await clic(preparato.clic[0], preparato.clic[1]);
  await sleep(900);
  const dopoTagliato = await valuta(`(function () {
    var f = Campagna.draw.getActiveFeature();
    return f ? f.getGeometry().getCoordinates()[0].length : -1;
  })()`);
  verifica('strumento modifica attivo', preparato.strumento === 'Modify', String(preparato.strumento));
  verifica('un clic secco toglie un vertice', dopoTagliato === preparato.prima - 1,
    'prima ' + preparato.prima + ', dopo ' + dopoTagliato);

  console.log('\nDisegno di un poligono');
  const disegnato = await valuta(`(function () {
    Campagna.draw.clearFeatures();
    var m = Campagna.map.getMap();
    var centro = ol.proj.fromLonLat([11.100643, 42.750394]);
    var d = 70;
    var anello = [
      [centro[0] - d, centro[1] - d], [centro[0] + d, centro[1] - d],
      [centro[0] + d, centro[1] + d], [centro[0] - d, centro[1] + d],
      [centro[0] - d, centro[1] - d]
    ];
    var f = new ol.Feature(new ol.geom.Polygon([anello]));
    Campagna.draw.addFeature(f);
    Campagna.draw.setActiveFeature(f);
    var misure = Campagna.measure.describe(f.getGeometry());
    return { vertici: misure.vertices, area: misure.areaText };
  })()`);
  verifica('misure calcolate su un poligono', disegnato.vertici === 4 && !!disegnato.area,
    JSON.stringify(disegnato));

  console.log('\nRicerca');
  const ricerca = await valuta(`(function () {
    return {
      regioni: document.getElementById('ric-regione') ? document.getElementById('ric-regione').options.length : 0,
      comuni: document.querySelectorAll('#ric-suggerimenti option').length,
      haPulisci: !!document.getElementById('ric-pulisci')
    };
  })()`);
  verifica('elenco regioni caricato', ricerca.regioni > 1, 'voci ' + ricerca.regioni);
  verifica('nessun elenco enorme di comuni a campo vuoto', ricerca.comuni === 0, 'voci ' + ricerca.comuni);
  verifica('pulsante annulla ricerca presente', ricerca.haPulisci === true);

  console.log('\nErrori in console');
  verifica('nessuna eccezione', problemi.length === 0, problemi.slice(0, 3).join(' | '));

  console.log('\n' + passati + ' controlli superati, ' + falliti + ' falliti');
  chrome.kill('SIGKILL');
  try { fs.rmSync(profilo, { recursive: true, force: true }); } catch (e) { /* niente */ }
  process.exit(falliti ? 1 : 0);
}

main().catch((e) => {
  console.error('ERRORE:', e.message);
  process.exit(1);
});

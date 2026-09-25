/* ==========================================================================
   Controllo dei sorgenti — `npm run test:api`
   --------------------------------------------------------------------------
   Serve a intercettare le cancellazioni silenziose: una modifica fatta "per
   intervallo" può portare via una funzione senza che la sintassi se ne accorga,
   e il guasto si vede solo usando l'app.

   Qui si verifica che ogni funzione importante ci sia ancora, che i file
   siano citati dalla pagina e che le graffe siano in pari. Costa millisecondi
   e va lanciato dopo ogni modifica.
   ========================================================================== */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const RADICE = path.resolve(__dirname, '..');
let falliti = 0;
let passati = 0;

function leggi(percorso) {
  return fs.readFileSync(path.join(RADICE, percorso), 'utf8');
}

function verifica(descrizione, condizione, dettaglio) {
  if (condizione) {
    passati += 1;
    console.log('  ok   ' + descrizione);
  } else {
    falliti += 1;
    console.log('  FALLITO  ' + descrizione + (dettaglio ? '  → ' + dettaglio : ''));
  }
}

/**
 * Funzioni e proprietà senza le quali una funzione dell'app smette di
 * funzionare. Se una sparisce, il test lo dice subito.
 */
const ATTESE = {
  'js/catasto.js': [
    'createImageSource',
    'caricaPezzi',
    'caricaPezziOra',
    'togliFondo',
    'createSfondo',
    'aggiornaSfondo',
    'aggiornaNumeri',
    'aggiornaSoglie',
    'zoomMinimoEffettivo',
    'inScala',
    'probeProxy',
    'buildUI'
  ],
  'js/ricerca.js': [
    'cerca',
    'caricaElenco',
    'nomeComune',
    'puntiDelComune',
    'leggiPunti',
    'correggiNumeri',
    'caricaContorno',
    'particelleDaGml',
    'particelleNellArea',
    'contorniParticelle',
    'siSovrappongono',
    'anelliDi',
    'areaDelContorno',
    'pulisciEvidenza',
    'wfsRiquadro'
  ],
  'js/draw.js': [
    'init',
    'setTool',
    'setModify',
    'startDraw',
    'verticeSottoIlClic',
    'eliminaVertice',
    'preparaAggancio',
    'caricaContorniAggancio',
    'ripassaAllaCalamita',
    'aggancioCatasto',
    'refreshFeature'
  ],
  'js/numeri.js': ['init', 'aggiorna', 'infoArea', 'riepilogoCatasto', 'disegna', 'ordinaPerDimensione'],
  'js/punto.js': ['init', 'descrivi', 'descriviCatasto', 'descriviArea', 'areeCheContengono', 'mostra', 'chiudiScheda'],
  'js/map.js': ['init', 'setBase', 'setLabelsVisible', 'buildStyles', 'createBaseControl', 'labelStyle'],
  'js/main.js': ['init', 'renderSavedList', 'renderMeasure', 'saveActive', 'chiediNomeEGruppo', 'saveActive', 'inquadraAppezzamentiSalvati'],
  'js/store.js': ['all', 'add', 'update', 'remove', 'gruppi', 'creaGruppo', 'rinominaGruppo', 'eliminaGruppo', 'sposta']
};

console.log('Sorgenti');

Object.keys(ATTESE).forEach(function (file) {
  const testo = leggi(file);

  ATTESE[file].forEach(function (nome) {
    const cè = new RegExp('function\\s+' + nome + '\\s*\\(').test(testo) ||
      new RegExp('\\b' + nome + '\\s*:').test(testo);
    verifica(file + ' → ' + nome, cè, 'funzione mancante');
  });

  const graffe = (testo.match(/\{/g) || []).length - (testo.match(/\}/g) || []).length;
  verifica(file + ' → graffe in pari', graffe === 0, 'differenza ' + graffe);
});

console.log('\nPagina');
const html = leggi('index.html');

['js/config.js', 'js/measure.js', 'js/store.js', 'js/catasto.js', 'js/map.js',
 'js/draw.js', 'js/export.js', 'js/ricerca.js', 'js/numeri.js', 'js/punto.js',
 'js/main.js'].forEach(function (file) {
  verifica('index.html carica ' + file, html.indexOf(file) !== -1, 'script non citato');
});

verifica('index.html ha il titolo CALCOLAREA', html.indexOf('CALCOLAREA') !== -1);
verifica('index.html ha la maniglia del pannello', html.indexOf('maniglia-pannello') !== -1);
verifica('index.html ha la barra delle misure', html.indexOf('barra-misure') !== -1);
verifica('index.html ha i comandi rapidi', html.indexOf('comandi-rapidi') !== -1);

console.log('\nConfigurazione');
const vercel = JSON.parse(leggi('vercel.json'));
const inoltri = (vercel.rewrites || []).map(function (r) { return r.source; });
verifica('vercel.json inoltra /catasto', inoltri.indexOf('/catasto/:resource') !== -1);
verifica('vercel.json inoltra /wfs', inoltri.indexOf('/wfs/:resource') !== -1);

const pkg = JSON.parse(leggi('package.json'));
verifica('package.json ha lo script dev', !!pkg.scripts.dev);
verifica('package.json ha lo script test', !!pkg.scripts.test);

console.log('\n' + passati + ' controlli superati, ' + falliti + ' falliti');
process.exit(falliti ? 1 : 0);

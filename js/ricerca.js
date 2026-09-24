/* ==========================================================================
   Campagna AI — ricerca di una particella catastale
   --------------------------------------------------------------------------
   Da (comune, foglio, particella) a un punto sulla mappa.

   Perché non si può chiedere al servizio dell'Agenzia delle Entrate:
   il WMS non accetta il parametro `FILTER` (ServiceException) e il WFS, che
   pure esiste (wfs.cartografia.agenziaentrate.gov.it/inspire/wfs/owfs01.php),
   ignora `CQL_FILTER` e rifiuta i filtri FES: entrambi sanno disegnare solo
   per area, non cercare per attributo. Verificato sul servizio reale.

   Si usano quindi i dati aperti di OnData (github.com/ondata/dati_catastali,
   licenza CC BY 4.0), che contengono il punto interno di ogni particella
   d'Italia con le chiavi comune/foglio/particella.

   I file regionali pesano 6-72 MB e non si scaricano certo interi: si legge
   solo la parte necessaria con richieste HTTP Range, saltando i blocchi
   (row group) che per le loro statistiche non possono contenere il comune
   cercato. Misurato: ~1,5 MB e 0,3-3,5 secondi per ricerca.

   Trovato il punto, il contorno esatto della particella si chiede al WFS
   (che non invia header CORS, quindi passa dall'inoltro /wfs/*) e viene
   evidenziato sulla mappa.

   Limiti noti dei dati: il Trentino-Alto Adige non è coperto, e la fotografia
   è quella dell'ultimo aggiornamento del dataset (maggio 2025).
   ========================================================================== */

Campagna.ricerca = (function () {
  'use strict';

  var ARCHIVIO =
    'https://raw.githubusercontent.com/ondata/dati_catastali/main/S_0000_ITALIA/anagrafica/';
  var INDICE = ARCHIVIO + 'index.parquet';
  var ELENCO = 'data/comuni.json';
  var PROXY_WFS = '/wfs/owfs01.php';
  var LIBRERIE = [
    'https://cdn.jsdelivr.net/npm/hyparquet@1.31.0/+esm',
    'https://cdn.jsdelivr.net/npm/hyparquet-compressors@1.1.1/+esm'
  ];

  /** Raggio (in gradi) del riquadro con cui si chiede il contorno al WFS. */
  var RAGGIO_CONTORNO = 0.0004; // ~40 m

  var NS_WFS = 'http://www.opengis.net/wfs/2.0';
  var NS_GML = 'http://www.opengis.net/gml/3.2';
  var NS_CP = 'http://mapserver.gis.umn.edu/mapserver';

  var map = null;
  var els = {};

  var elenco = null; // Promise dei dati dell'elenco comuni
  var datiElenco = null; // {regioni, province, comuni} una volta caricati
  var indice = null; // Promise<{codice: fileRegione}>
  var librerie = null; // Promise<{pq, compressori}>
  var livello = null; // layer vettoriale dell'evidenziazione
  var sorgente = null;

  // --------------------------------------------------------------- interfaccia

  function stato(testo, tipo) {
    if (!els.stato) return;
    els.stato.textContent = testo || '';
    els.stato.className = 'hint small' + (tipo ? ' ' + tipo : '');
  }

  function occupato(attivo) {
    if (els.cerca) {
      els.cerca.disabled = !!attivo;
      els.cerca.textContent = attivo ? 'Cerco…' : 'Cerca sulla mappa';
    }
  }

  function normalizza(testo) {
    return String(testo || '').trim().toUpperCase();
  }

  /** Comuni della regione scelta, per il suggerimento del campo comune. */
  function aggiornaSuggerimenti() {
    if (!els.comune || !els.suggerimenti || !datiElenco) return;

    var scelta = els.regione && els.regione.value !== '' ? Number(els.regione.value) : null;

    // L'elenco dei comuni non si mostra mai tutto: senza questo comparivano
    // migliaia di voci appena si toccava il campo.
    var scritto = String(els.comune.value || '').trim().toLowerCase();
    els.suggerimenti.innerHTML = '';
    if (scritto.length < 2) return;

    var quanti = 0;
    datiElenco.comuni.forEach(function (riga) {
      if (quanti >= 40) return;
      if (riga[0].toLowerCase().indexOf(scritto) === -1) return;
      if (scelta != null && riga[2] !== scelta) return;
      var opzione = document.createElement('option');
      opzione.value = riga[0];
      opzione.label = riga[0] + ' (' + riga[3] + ') — ' + riga[1];
      els.suggerimenti.appendChild(opzione);
      quanti += 1;
    });
  }

  function popolaRegioni() {
    if (!els.regione) return;
    els.regione.innerHTML = '';
    var tutte = document.createElement('option');
    tutte.value = '';
    tutte.textContent = 'Tutte le regioni';
    els.regione.appendChild(tutte);

    datiElenco.regioni.forEach(function (nome, indice) {
      var opzione = document.createElement('option');
      opzione.value = String(indice);
      opzione.textContent = nome;
      els.regione.appendChild(opzione);
    });
  }

  /** Trova il comune digitato: restituisce la riga [nome, codice, regione, provincia]. */
  function trovaComune(testo, regione) {
    var cercato = normalizza(testo);
    if (!cercato) return null;

    var candidati = datiElenco.comuni.filter(function (riga) {
      return regione == null || riga[2] === regione;
    });

    // prima l'uguaglianza esatta, poi un nome che inizia con il testo
    var esatto = candidati.filter(function (riga) {
      return normalizza(riga[0]) === cercato;
    });
    if (esatto.length) return esatto[0];

    var parziale = candidati.filter(function (riga) {
      return normalizza(riga[0]).indexOf(cercato) === 0;
    });
    return parziale.length === 1 ? parziale[0] : null;
  }

  // ------------------------------------------------------------------ librerie

  function caricaLibrerie() {
    if (!librerie) {
      librerie = Promise.all(LIBRERIE.map(function (url) {
        return import(/* @vite-ignore */ url);
      })).then(function (moduli) {
        return { pq: moduli[0], compressori: moduli[1].compressors };
      });
    }
    return librerie;
  }

  function caricaElenco() {
    if (!elenco) {
      elenco = fetch(ELENCO)
        .then(function (risposta) {
          if (!risposta.ok) throw new Error('elenco comuni non disponibile (' + risposta.status + ')');
          return risposta.json();
        })
        .then(function (dati) {
          datiElenco = dati;
          return dati;
        });
    }
    return elenco;
  }

  /** Legge una volta sola l'indice: codice catastale -> file regionale. */
  function apriIndice() {
    if (!indice) {
      indice = caricaLibrerie().then(function (lib) {
        return lib.pq
          .asyncBufferFromUrl({ url: INDICE })
          .then(function (file) {
            return lib.pq.parquetReadObjects({
              file: file,
              compressors: lib.compressori,
              columns: ['comune', 'file']
            });
          })
          .then(function (righe) {
            var mappa = {};
            righe.forEach(function (riga) {
              mappa[riga.comune] = riga.file;
            });
            return mappa;
          });
      });
    }
    return indice;
  }

  // -------------------------------------------------------------------- ricerca

  /** Particelle di un comune già lette, e in che ordine sono state usate. */
  var puntiPerComune = {};
  var ordineComuni = [];
  var MAX_COMUNI = 4;

  /**
   * Legge dal file regionale tutte le particelle di un comune, con numero e
   * punto interno. Si leggono solo i blocchi (row group) che possono contenere
   * il comune, come per la ricerca.
   */
  function leggiPunti(lib, url, codice) {
    return lib.pq.asyncBufferFromUrl({ url: url }).then(function (file) {
      return lib.pq.parquetMetadataAsync(file).then(function (meta) {
        var chiavi = meta.row_groups[0].columns.map(function (colonna) {
          return colonna.meta_data.path_in_schema.join('.');
        });
        var iComune = chiavi.indexOf('comune');
        if (iComune < 0) throw new Error('formato del file regionale inatteso');

        var blocchi = [];
        var riga = 0;
        meta.row_groups.forEach(function (gruppo) {
          var statistiche = gruppo.columns[iComune].meta_data.statistics;
          if (
            statistiche &&
            String(statistiche.min_value) <= codice &&
            String(statistiche.max_value) >= codice
          ) {
            blocchi.push({ da: riga, a: riga + Number(gruppo.num_rows) });
          }
          riga += Number(gruppo.num_rows);
        });

        var punti = [];
        var catena = Promise.resolve();

        blocchi.forEach(function (blocco) {
          catena = catena.then(function () {
            return lib.pq
              .parquetReadObjects({
                file: file,
                compressors: lib.compressori,
                rowStart: blocco.da,
                rowEnd: blocco.a,
                columns: ['comune', 'foglio', 'particella', 'x', 'y']
              })
              .then(function (righe) {
                righe.forEach(function (r) {
                  if (r.comune !== codice) return;
                  punti.push({
                    lon: Number(r.x) / 1e6,
                    lat: Number(r.y) / 1e6,
                    numero: String(r.particella),
                    foglio: String(r.foglio)
                  });
                });
              });
          });
        });

        return catena.then(function () {
          return punti;
        });
      });
    });
  }

  /**
   * Legge le particelle di un comune dal file parquet della sua regione.
   *
   * `filtro` può contenere `foglio` e/o `particella`, entrambi facoltativi:
   * senza filtro si prendono tutte le particelle del comune, con il solo foglio
   * quelle del foglio, e così via. Restituisce sempre il numero di particelle
   * trovate e il riquadro che le contiene, più qualche esempio.
   *
   * Il file è ordinato per comune e ogni blocco (row group) ha le statistiche
   * min/max della colonna `comune`: si leggono solo i blocchi che possono
   * contenere il comune cercato, invece dei 6-72 MB dell'intero file.
   */
  function cercaNelFile(lib, url, codice, filtro) {
    return lib.pq.asyncBufferFromUrl({ url: url }).then(function (file) {
      return lib.pq.parquetMetadataAsync(file).then(function (meta) {
        var chiavi = meta.row_groups[0].columns.map(function (colonna) {
          return colonna.meta_data.path_in_schema.join('.');
        });
        var iComune = chiavi.indexOf('comune');
        if (iComune < 0) throw new Error('formato del file regionale inatteso');

        var blocchi = [];
        var riga = 0;
        meta.row_groups.forEach(function (gruppo) {
          var statistiche = gruppo.columns[iComune].meta_data.statistics;
          var puoContenere =
            statistiche &&
            String(statistiche.min_value) <= codice &&
            String(statistiche.max_value) >= codice;
          if (puoContenere) {
            blocchi.push({ da: riga, a: riga + Number(gruppo.num_rows) });
          }
          riga += Number(gruppo.num_rows);
        });

        if (!blocchi.length) return null;

        var esito = {
          quante: 0,
          bbox: [Infinity, Infinity, -Infinity, -Infinity],
          esempi: []
        };

        var catena = Promise.resolve();
        blocchi.forEach(function (blocco) {
          catena = catena.then(function () {
            return lib.pq
              .parquetReadObjects({
                file: file,
                compressors: lib.compressori,
                rowStart: blocco.da,
                rowEnd: blocco.a,
                columns: ['comune', 'foglio', 'particella', 'x', 'y']
              })
              .then(function (righe) {
                for (var i = 0; i < righe.length; i += 1) {
                  var r = righe[i];
                  if (r.comune !== codice) continue;
                  esito.quante += 1;

                  if (filtro.foglio && String(r.foglio) !== filtro.foglio) continue;
                  if (filtro.particella && String(r.particella) !== filtro.particella) continue;

                  var lat = Number(r.y) / 1e6;
                  var lon = Number(r.x) / 1e6;
                  esito.bbox[0] = Math.min(esito.bbox[0], lon);
                  esito.bbox[1] = Math.min(esito.bbox[1], lat);
                  esito.bbox[2] = Math.max(esito.bbox[2], lon);
                  esito.bbox[3] = Math.max(esito.bbox[3], lat);

                  if (esito.esempi.length < 40) {
                    esito.esempi.push({
                      lat: lat,
                      lon: lon,
                      foglio: String(r.foglio),
                      particella: String(r.particella)
                    });
                  }
                }
              });
          });
        });

        return catena.then(function () {
          return esito;
        });
      });
    });
  }

  // ---------------------------------------------------------------- evidenza

  /**
   * Anelli del contorno di un membro GML.
   *
   * Il servizio restituisce le coordinate in EPSG:6706 con l'ordine degli assi
   * lat,lon (`srsName="urn:ogc:def:crs:EPSG::6706"`), quindi ogni coppia va
   * letta come latitudine, longitudine.
   */
  function anelliDelMembro(membro) {
    var posList = membro.getElementsByTagNameNS(NS_GML, 'posList');
    var anelli = [];

    for (var i = 0; i < posList.length; i += 1) {
      var numeri = (posList[i].textContent || '').trim().split(/\s+/).map(Number);
      var anello = [];
      for (var j = 0; j + 1 < numeri.length; j += 2) {
        if (isFinite(numeri[j]) && isFinite(numeri[j + 1])) {
          anello.push(ol.proj.fromLonLat([numeri[j + 1], numeri[j]]));
        }
      }
      if (anello.length > 2) {
        // l'anello deve essere chiuso
        var primo = anello[0];
        var ultimo = anello[anello.length - 1];
        if (primo[0] !== ultimo[0] || primo[1] !== ultimo[1]) anello.push([primo[0], primo[1]]);
        anelli.push(anello);
      }
    }

    return anelli;
  }

  function preparaEvidenza() {
    if (livello) return;

    sorgente = new ol.source.Vector();
    livello = new ol.layer.Vector({
      source: sorgente,
      zIndex: 900,
      style: function (feature) {
        if (feature.get('tipo') === 'punto') {
          return new ol.style.Style({
            image: new ol.style.Circle({
              radius: 7,
              fill: new ol.style.Fill({ color: 'rgba(214, 48, 49, 0.9)' }),
              stroke: new ol.style.Stroke({ color: '#ffffff', width: 2 })
            })
          });
        }
        return new ol.style.Style({
          fill: new ol.style.Fill({ color: 'rgba(214, 48, 49, 0.18)' }),
          stroke: new ol.style.Stroke({ color: '#d63031', width: 3 })
        });
      }
    });
    map.addLayer(livello);
  }

  function mostraPunto(lat, lon, etichetta) {
    preparaEvidenza();
    sorgente.clear();

    var punto = new ol.Feature({
      geometry: new ol.geom.Point(ol.proj.fromLonLat([lon, lat])),
      tipo: 'punto'
    });
    punto.set('descrizione', etichetta);
    sorgente.addFeature(punto);

    map.getView().animate({
      center: ol.proj.fromLonLat([lon, lat]),
      zoom: 18,
      duration: 700
    });
  }

  /**
   * Chiede al WFS il contorno esatto della particella e lo evidenzia.
   *
   * Il WFS non invia header CORS: la richiesta passa dall'inoltro /wfs/*, come
   * per il WMS. Gli assi del BBOX sono lat,lon e gli errori arrivano come
   * HTTP 200 con dentro una ServiceException: vanno controllati nel corpo.
   *
   * Il GML si legge a mano invece di usare `ol.format.WFS`: MapServer incapsula
   * la geometria in un elemento non standard (`CP:msGeometry`) che OpenLayers
   * non riconosce — provato, restituisce zero feature.
   */
  function caricaContorno(lat, lon, codice, foglio, particella) {
    var bbox = [
      lat - RAGGIO_CONTORNO,
      lon - RAGGIO_CONTORNO,
      lat + RAGGIO_CONTORNO,
      lon + RAGGIO_CONTORNO
    ].join(',');

    var url =
      PROXY_WFS +
      '?language=ita&SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature' +
      '&TYPENAMES=CP:CadastralParcel&SRSNAME=urn:ogc:def:crs:EPSG::6706' +
      '&COUNT=99&BBOX=' +
      encodeURIComponent(bbox);

    // Il servizio a volte rifiuta una richiesta che, ripetuta, riesce: si
    // ritenta una volta prima di rinunciare.
    function chiedi() {
      return fetch(url).then(function (risposta) {
        if (!risposta.ok) throw new Error('contorno non disponibile (' + risposta.status + ')');
        return risposta.text();
      }).then(function (testo) {
        if (testo.indexOf('ServiceException') !== -1) {
          throw new Error('richiesta rifiutata');
        }
        return testo;
      });
    }

    return chiedi()
      .catch(function () {
        return chiedi();
      })
      .catch(function () {
        throw new Error('il servizio ha rifiutato la richiesta del contorno');
      })
      .then(function (testo) {

        var doc = new DOMParser().parseFromString(testo, 'application/xml');
        var membri = doc.getElementsByTagNameNS(NS_WFS, 'member');
        var riferimento = codice + '_' + foglio.padStart(4, '0');
        var scelto = null;

        for (var i = 0; i < membri.length && !scelto; i += 1) {
          var nodo = membri[i].getElementsByTagNameNS(NS_CP, 'NATIONALCADASTRALREFERENCE')[0];
          var ref = nodo ? nodo.textContent.trim() : '';
          if (
            ref.indexOf(riferimento) === 0 &&
            ref.slice(-(particella.length + 1)) === '.' + particella
          ) {
            scelto = membri[i];
          }
        }
        // ripiego: se il bbox contiene una sola particella è quella
        if (!scelto && membri.length === 1) scelto = membri[0];
        if (!scelto) return null;

        var anelli = anelliDelMembro(scelto);
        if (!anelli.length) return null;

        var contorno = new ol.Feature({
          geometry: new ol.geom.Polygon(anelli),
          tipo: 'contorno'
        });
        sorgente.addFeature(contorno);
        return contorno;
      });
  }

  // -------------------------------------------------------------------- azione

  function cerca() {
    var regione = els.regione && els.regione.value !== '' ? Number(els.regione.value) : null;
    var comune = trovaComune(els.comune ? els.comune.value : '', regione);
    var foglio = normalizza(els.foglio ? els.foglio.value : '');
    var particella = normalizza(els.particella ? els.particella.value : '');

    if (!comune) {
      stato(
        'Comune non riconosciuto' + (regione != null ? ' in questa regione' : '') +
          ': scegli un nome dall\'elenco dei suggerimenti.',
        'warn'
      );
      return;
    }

    occupato(true);
    stato('Preparo l\'archivio delle particelle…');

    var codice = comune[1];
    var filtro = {
      foglio: foglio ? foglio.padStart(4, '0') : null,
      particella: particella || null
    };

    Promise.all([caricaLibrerie(), apriIndice()])
      .then(function (esiti) {
        var lib = esiti[0];
        var mappa = esiti[1];
        var file = mappa[codice];

        if (!file) {
          throw new Error(
            'Per ' + comune[0] + ' non ci sono dati nell\'archivio aperto usato dalla ricerca ' +
              '(il Trentino-Alto Adige non è coperto).'
          );
        }

        stato(
          'Cerco ' + comune[0] +
            (foglio ? ' foglio ' + foglio : '') +
            (particella ? ' particella ' + particella : '') +
            '…'
        );

        return cercaNelFile(lib, ARCHIVIO + file, codice, filtro).then(function (trovato) {
          return { comune: comune, trovato: trovato };
        });
      })
      .then(function (esito) {
        var comune = esito.comune;
        var trovato = esito.trovato;

        if (!trovato || !trovato.quante) {
          stato(
            'Nessuna particella per ' + comune[0] +
              (foglio ? ' al foglio ' + foglio : '') + '.',
            'warn'
          );
          return null;
        }

        if (!trovato.esempi.length) {
          stato(
            'Il comune di ' + comune[0] + ' ha ' + numero(trovato.quante) + ' particelle, ma nessuna ' +
              (particella ? 'con il numero ' + particella + ' ' : '') +
              (foglio ? 'al foglio ' + foglio : '') +
              '. Controlla i numeri: il foglio va senza zeri iniziali.',
            'warn'
          );
          return null;
        }

        if (Campagna.catasto) Campagna.catasto.setEnabled('particelle', true);

        // Foglio e particella indicati, oppure particella trovata in un foglio
        // solo: si va sul punto esatto e si chiede il contorno.
        var preciso =
          (filtro.foglio && filtro.particella) ||
          (filtro.particella && trovato.esempi.length === 1);

        if (!preciso) {
          return inquadra(comune, trovato, filtro);
        }

        var esempio = trovato.esempi[0];
        mostraPunto(
          esempio.lat,
          esempio.lon,
          comune[0] + ' · foglio ' + Number(esempio.foglio) + ' · particella ' + esempio.particella
        );

        stato(
          'Trovata: ' + comune[0] + ' foglio ' + Number(esempio.foglio) + ' particella ' +
            esempio.particella + '. Carico il contorno…'
        );

        if (els.pulisci) els.pulisci.hidden = false;

        return caricaContorno(esempio.lat, esempio.lon, comune[1], esempio.foglio, esempio.particella)
          .then(function (contorno) {
            var mq = areaDelContorno(contorno);
            if (els.esito) {
              els.esito.textContent =
                comune[0] + ' (' + comune[3] + ')\nfoglio ' + Number(esempio.foglio) +
                ' · particella ' + esempio.particella +
                (mq
                  ? '\nsuperficie ' + Campagna.measure.formatArea(mq) +
                    '  (' + Math.round(mq).toLocaleString('it-IT') + ' m²)'
                  : '') +
                '\n' + esempio.lat.toFixed(6) + '°, ' + esempio.lon.toFixed(6) + '°' +
                (contorno ? '\ncontorno caricato dal WFS' : '\ncontorno non disponibile');
            }
            stato(
              'Particella evidenziata sulla mappa.' +
                (contorno ? '' : ' (contorno non disponibile, mostrato solo il punto)')
            );
          })
          .catch(function (err) {
            stato('Particella trovata e centrata, ma contorno non caricato: ' + err.message, 'warn');
          });
      })
      .catch(function (err) {
        stato('Ricerca non riuscita: ' + err.message, 'warn');
      })
      .then(function () {
        occupato(false);
      });
  }

  /**
   * Inquadra quello che si è trovato senza arrivare alla singola particella:
   * l'intero comune, un foglio, o tutte le particelle con quel numero.
   */
  function inquadra(comune, trovato, filtro) {
    if (sorgente) sorgente.clear();
    if (els.pulisci) els.pulisci.hidden = false;

    var bbox = trovato.bbox;
    if (isFinite(bbox[0]) && isFinite(bbox[1])) {
      map.getView().fit(ol.proj.transformExtent(bbox, 'EPSG:4326', 'EPSG:3857'), {
        padding: [70, 70, 70, 70],
        maxZoom: 18,
        duration: 700
      });
    }

    var fogli = [];
    trovato.esempi.forEach(function (esempio) {
      if (fogli.indexOf(esempio.foglio) === -1) fogli.push(esempio.foglio);
    });

    var descrizione = comune[0] + ' (' + comune[3] + ')';
    var messaggio;

    if (filtro.particella) {
      descrizione += '\nparticella ' + filtro.particella + ' — trovata in ' + fogli.length +
        ' fogl' + (fogli.length === 1 ? 'io' : 'i') + ': ' +
        fogli.slice(0, 8).map(Number).join(', ') + (fogli.length > 8 ? '…' : '');
      messaggio = 'Particella ' + filtro.particella + ' presente in più fogli: inquadrati tutti. ' +
        'Aggiungi il foglio per andare su quella giusta.';
    } else if (filtro.foglio) {
      descrizione += '\nfoglio ' + Number(filtro.foglio) + ' — ' + numero(trovato.esempi.length) +
        ' particelle inquadrate';
      messaggio = 'Foglio inquadrato. Aggiungi il numero di particella per evidenziarla.';
    } else {
      descrizione += '\n' + numero(trovato.quante) + ' particelle inquadrate';
      messaggio = 'Comune inquadrato. Aggiungi foglio e particella per arrivare alla singola.';
    }

    if (els.esito) els.esito.textContent = descrizione;
    stato(messaggio);
  }

  function numero(valore) {
    return Number(valore).toLocaleString('it-IT');
  }

  // --------------------------------------------------------------------- avvio

  /**
   * Superficie di un contorno, in metri quadri. Si misura sulla sfera, così
   * il numero non dipende dalla proiezione con cui è disegnato.
   */
  function areaDelContorno(contorno) {
    if (!contorno) return null;

    var geometria = contorno.getGeometry ? contorno.getGeometry() : contorno;
    if (!geometria) return null;

    try {
      var mq = ol.sphere.getArea(geometria, { projection: 'EPSG:3857' });
      return isFinite(mq) && mq > 0 ? mq : null;
    } catch (err) {
      return null;
    }
  }

  /** Toglie l'evidenziazione dalla mappa: ricerca annullata. */
  function pulisciEvidenza() {
    if (sorgente) sorgente.clear();
    if (els.esito) els.esito.textContent = '';
    if (els.pulisci) els.pulisci.hidden = true;
    stato('Ricerca annullata.');
  }

  function init(olMap) {
    map = olMap;

    els = {
      regione: document.getElementById('ric-regione'),
      comune: document.getElementById('ric-comune'),
      suggerimenti: document.getElementById('ric-suggerimenti'),
      foglio: document.getElementById('ric-foglio'),
      particella: document.getElementById('ric-particella'),
      cerca: document.getElementById('ric-cerca'),
      stato: document.getElementById('ric-stato'),
      esito: document.getElementById('ric-esito'),

      pulisci: document.getElementById('ric-pulisci')
    };

    if (!els.cerca) return;

    els.cerca.addEventListener('click', cerca);
    if (els.regione) {
      els.regione.addEventListener('change', function () {
        aggiornaSuggerimenti();
        if (els.comune) els.comune.value = '';
        stato('');
      });
    }
    [els.comune, els.foglio, els.particella].forEach(function (campo) {
      if (!campo) return;
      campo.addEventListener('keydown', function (evento) {
        if (evento.key === 'Enter') {
          evento.preventDefault();
          cerca();
        }
      });
    });

    // L'elenco serve solo quando si apre la ricerca: si carica in sottofondo.
    caricaElenco()
      .then(function () {
        popolaRegioni();
        aggiornaSuggerimenti();
      })
      .catch(function (err) {
        stato('Elenco comuni non caricato: ' + err.message, 'warn');
      });
  }

  // ------------------------------------------- particelle dentro un'area

  /**
   * Estrae, da una risposta GML del WFS, le particelle con contorno e numero.
   */
  function particelleDaGml(testo) {
    var doc = new DOMParser().parseFromString(testo, 'application/xml');
    var membri = doc.getElementsByTagNameNS(NS_WFS, 'member');
    var elenco = [];

    for (var i = 0; i < membri.length; i += 1) {
      var nodo = membri[i].getElementsByTagNameNS(NS_CP, 'NATIONALCADASTRALREFERENCE')[0];
      if (!nodo) continue;

      var anelli = anelliDelMembro(membri[i]);
      if (!anelli.length) continue;

      var riferimento = nodo.textContent.trim();
      var pezzi = riferimento.split('_');
      var coda = (pezzi[1] || '').split('.');
      var foglio = coda[0] || '';

      elenco.push({
        comune: pezzi[0] || '',
        // Il riferimento e' <comune>_<foglio a 4 cifre><2 caratteri>.<particella>:
        // `E467_001500.40` e' il foglio 15, `E202_0087D0.888` e' il foglio 87.
        // Il foglio sono quindi le prime quattro cifre, senza zeri iniziali.
        foglio: foglio.slice(0, -2).replace(/^0+/, '') || foglio,
        particella: coda[1] || '',
        // MultiPolygon vuole un poligono per anello: `[[anello1], [anello2]]`.
        // Con un livello di annidamento in piu' OpenLayers costruisce una
        // geometria dall'extent **vuoto**, e il confronto la scarta in
        // silenzio: e' il motivo per cui le particelle con piu' di un anello
        // (tante, in campagna) non comparivano nell'elenco.
        geometria: anelli.length > 1
          ? new ol.geom.MultiPolygon(anelli.map(function (a) { return [a]; }))
          : new ol.geom.Polygon([anelli[0]])
      });
    }

    return elenco;
  }

  /** Anelli (contorni) di una geometria, siano essi poligoni o multipoligoni. */
  function anelliDi(geometria) {
    if (geometria.getType() === 'MultiPolygon') {
      return geometria.getPolygons().reduce(function (tutti, poligono) {
        return tutti.concat(poligono.getLinearRings());
      }, []);
    }
    return geometria.getLinearRings();
  }

  /** Vero se i due segmenti si incontrano. */
  function segmentiSiIncontrano(p1, p2, p3, p4) {
    function orient(a, b, c) {
      var valore = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (Math.abs(valore) < 1e-9) return 0;
      return valore > 0 ? 1 : 2;
    }
    function suSegmento(a, b, c) {
      return (
        Math.min(a[0], b[0]) - 1e-9 <= c[0] && c[0] <= Math.max(a[0], b[0]) + 1e-9 &&
        Math.min(a[1], b[1]) - 1e-9 <= c[1] && c[1] <= Math.max(a[1], b[1]) + 1e-9
      );
    }

    var o1 = orient(p1, p2, p3);
    var o2 = orient(p1, p2, p4);
    var o3 = orient(p3, p4, p1);
    var o4 = orient(p3, p4, p2);

    if (o1 !== o2 && o3 !== o4) return true;
    if (o1 === 0 && suSegmento(p1, p2, p3)) return true;
    if (o2 === 0 && suSegmento(p1, p2, p4)) return true;
    if (o3 === 0 && suSegmento(p3, p4, p1)) return true;
    if (o4 === 0 && suSegmento(p3, p4, p2)) return true;
    return false;
  }

  /**
   * Vero se le due geometrie si **sovrappongono** con una superficie vera.
   *
   * Toccarsi non basta: disegnando l'area esattamente lungo un confine
   * catastale, la particella confinante ha in comune quel tratto di linea ma
   * non ci sta dentro, e non va contata. Quindi:
   *   1. un vertice di una dentro l'altra, ma ad almeno 5 cm dal confine;
   *   2. oppure due lati che si incrociano davvero (non paralleli e sovrapposti).
   */
  function siSovrappongono(a, b) {
    if (!ol.extent.intersects(a.getExtent(), b.getExtent())) return false;

    /** Vero se il punto sta dentro, ma non appoggiato al confine. */
    function dentroConMargine(poligono, punto) {
      if (!poligono.intersectsCoordinate(punto)) return false;
      var vicino = poligono.getClosestPoint(punto);
      if (!vicino) return true;
      var dx = vicino[0] - punto[0];
      var dy = vicino[1] - punto[1];
      return Math.sqrt(dx * dx + dy * dy) > 0.05; // 5 cm
    }

    function orient(a1, b1, c1) {
      var valore = (b1[0] - a1[0]) * (c1[1] - a1[1]) - (b1[1] - a1[1]) * (c1[0] - a1[0]);
      if (Math.abs(valore) < 1e-9) return 0;
      return valore > 0 ? 1 : 2;
    }

    /** Incrocio vero: i lati si attraversano, non si limitano a combaciare. */
    function incrocioVero(p1, p2, p3, p4) {
      var o1 = orient(p1, p2, p3);
      var o2 = orient(p1, p2, p4);
      var o3 = orient(p3, p4, p1);
      var o4 = orient(p3, p4, p2);
      if (o1 === 0 || o2 === 0 || o3 === 0 || o4 === 0) return false;
      return o1 !== o2 && o3 !== o4;
    }

    var anelliA = anelliDi(a);
    var anelliB = anelliDi(b);
    var i;
    var j;

    for (i = 0; i < anelliA.length; i += 1) {
      var verticiA = anelliA[i].getCoordinates();
      for (j = 0; j < verticiA.length; j += 1) {
        if (dentroConMargine(b, verticiA[j])) return true;
      }
    }

    for (i = 0; i < anelliB.length; i += 1) {
      var verticiB = anelliB[i].getCoordinates();
      for (j = 0; j < verticiB.length; j += 1) {
        if (dentroConMargine(a, verticiB[j])) return true;
      }
    }

    for (i = 0; i < anelliA.length; i += 1) {
      var primoA = anelliA[i].getCoordinates();
      for (j = 0; j < anelliB.length; j += 1) {
        var primoB = anelliB[j].getCoordinates();
        for (var x = 0; x + 1 < primoA.length; x += 1) {
          for (var y = 0; y + 1 < primoB.length; y += 1) {
            if (incrocioVero(primoA[x], primoA[x + 1], primoB[y], primoB[y + 1])) return true;
          }
        }
      }
    }

    return false;
  }

  /**
   * I contorni delle particelle che coprono un'area, senza numeri né conteggi:
   * servono alla calamita che aggancia i vertici alle linee catastali.
   *
   * Si leggono i riquadri che il servizio accetta, con la stessa insistenza
   * usata per l'elenco dell'area: se il servizio rifiuta, si ritenta spostando
   * il riquadro di qualche metro.
   */
  function contorniParticelle(geometria3857) {
    var areaGradi = geometria3857.clone().transform('EPSG:3857', 'EPSG:4326');
    var extent = areaGradi.getExtent();

    var passoLat = 900 / 110574;
    var passoLon = 3000 / 81752;
    var riquadri = [];

    for (var lat = extent[1]; lat < extent[3]; lat += passoLat) {
      for (var lon = extent[0]; lon < extent[2]; lon += passoLon) {
        var lat1 = Math.min(lat + passoLat, extent[3]);
        var lon1 = Math.min(lon + passoLon, extent[2]);
        riquadri.push([lat, lon, lat1, lon1]);
      }
    }

    if (!riquadri.length) return Promise.resolve([]);

    return Promise.all(
      riquadri.map(function (r) {
        return wfsRiquadro(r[0], r[1], r[2], r[3]).catch(function () {
          var scarto = 0.00003;
          return wfsRiquadro(r[0] - scarto, r[1] - scarto, r[2] + scarto, r[3] + scarto);
        });
      })
    )
      .then(function (risposte) {
        var poligoni = [];
        risposte.forEach(function (testo) {
          particelleDaGml(testo).forEach(function (particella) {
            if (particella.geometria) poligoni.push(particella.geometria);
          });
        });
        return poligoni;
      })
      .catch(function () {
        // senza contorni si disegna come prima: nessun aggancio, nessun errore
        return [];
      });
  }

  /** Chiede al WFS le particelle di un riquadro (assi lat,lon). */
  function wfsRiquadro(sud, ovest, nord, est) {
    var url =
      '/wfs/owfs01.php?language=ita&SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature' +
      '&TYPENAMES=CP:CadastralParcel&SRSNAME=urn:ogc:def:crs:EPSG::6706&BBOX=' +
      encodeURIComponent([sud, ovest, nord, est].join(','));

    return fetch(url).then(function (risposta) {
      if (!risposta.ok) throw new Error('servizio non raggiungibile (' + risposta.status + ')');
      return risposta.text();
    }).then(function (testo) {
      if (testo.indexOf('ServiceException') !== -1) {
        throw new Error('il servizio ha rifiutato la richiesta');
      }
      return testo;
    });
  }

  /**
   * Le particelle che intersecano un appezzamento, con i contorni esatti.
   *
   * I punti interni delle particelle non bastano: una particella tagliata dal
   * bordo dell'area ha il punto fuori e verrebbe persa, pur essendo visibile.
   * Qui si chiedono al WFS i **contorni** delle particelle del riquadro e si
   * verifica l'intersezione vera con il poligono disegnato.
   *
   * Il servizio accetta riquadri di circa 2 km di lato, quindi aree piu' grandi
   * vengono divise in piu' richieste; una richiesta che fallisce viene ritentata
   * una volta con lo stesso riquadro.
   */
  function particelleNellArea(geometria3857) {
    // il riquadro va espresso in gradi per il servizio, mentre il confronto fra
    // contorni si fa in metri: servono due versioni della stessa geometria
    var areaGradi = geometria3857.clone().transform('EPSG:3857', 'EPSG:4326');
    var extent = areaGradi.getExtent();

    // Il servizio non restituisce tutte le particelle che intersecano il
    // riquadro: filtra per il **punto** interno della particella. Una
    // particella che tocca l'area ma ha il punto fuori verrebbe persa (provato:
    // `E202_0087D0.STRADA004` spariva con il riquadro esatto). Si chiede quindi
    // un riquadro allargato di ~400 m e poi si filtra sul contorno vero.
    var passoLat = 900 / 110574; // ~0,9 km di striscia
    var passoLon = 3000 / 81752; // ~3 km di striscia
    var margineLat = 400 / 110574;
    var margineLon = 400 / 81752;
    var riquadri = [];

    for (var lat = extent[1]; lat < extent[3]; lat += passoLat) {
      for (var lon = extent[0]; lon < extent[2]; lon += passoLon) {
        var lat1 = Math.min(lat + passoLat, extent[3]);
        var lon1 = Math.min(lon + passoLon, extent[2]);

        // Si chiedono due riquadri, quello esatto e quello allargato: il
        // servizio restituisce le particelle il cui **punto** interno cade nel
        // riquadro, quindi una particella lunga e stretta (una strada) che
        // attraversa l'area può avere il punto lontano e comparire solo nella
        // richiesta allargata. Provato: `STRADA001` compare solo col riquadro
        // esatto, `STRADA005` solo con quello allargato, ed entrambe toccano
        // l'area. L'unione delle due è quello che serve.
        riquadri.push([lat, lon, lat1, lon1]);
        riquadri.push([
          lat - margineLat,
          lon - margineLon,
          lat1 + margineLat,
          lon1 + margineLon
        ]);
      }
    }

    // Il servizio rifiuta alcuni riquadri in modo **deterministico**: per
    // esempio `42.7483,11.0983,42.7507,11.1007` fallisce sempre, mentre lo
    // stesso riquadro spostato di un millesimo di grado (circa un metro)
    // risponde. Si ritenta quindi allargando il riquadro di pochi metri ogni
    // volta: qualche metro di margine non cambia nulla, perché le particelle
    // vere si decidono poi sul contorno.
    function conRitentativi(r, quanti, tentativo) {
      var scarto = (tentativo - 1) * 0.00003;
      return wfsRiquadro(r[0] - scarto, r[1] - scarto, r[2] + scarto, r[3] + scarto).catch(
        function (errore) {
          if (quanti <= 1) throw errore;
          return new Promise(function (risolvi) {
            setTimeout(risolvi, 300);
          }).then(function () {
            return conRitentativi(r, quanti - 1, tentativo + 1);
          });
        }
      );
    }

    var richieste = riquadri.map(function (r) {
      return conRitentativi(r, 4, 1);
    });

    return Promise.all(richieste).then(function (risposte) {
      var comuni = [];
      var fogli = [];
      var particelle = [];
      var viste = [];
      var gruppi = [];
      var conContorno = [];

      risposte.forEach(function (testo) {
        particelleDaGml(testo).forEach(function (particella) {
          if (!siSovrappongono(geometria3857, particella.geometria)) return;

          // Si conta per riferimento completo: lo stesso numero può esistere in
          // fogli diversi, e sono due particelle distinte.
          var riferimento = particella.comune + '_' + particella.foglio + '.' + particella.particella;
          if (viste.indexOf(riferimento) !== -1) return;
          viste.push(riferimento);

          if (particella.comune && comuni.indexOf(particella.comune) === -1) {
            comuni.push(particella.comune);
          }
          if (fogli.indexOf(particella.foglio) === -1) fogli.push(particella.foglio);
          particelle.push(particella.particella);

          // le stesse particelle, tenute divise per comune e foglio: serve
          // quando l'area tocca piu' fogli o piu' comuni
          var gruppo = null;
          for (var g = 0; g < gruppi.length; g += 1) {
            if (gruppi[g].comune === particella.comune && gruppi[g].foglio === particella.foglio) {
              gruppo = gruppi[g];
            }
          }
          if (!gruppo) {
            gruppo = { comune: particella.comune, foglio: particella.foglio, particelle: [] };
            gruppi.push(gruppo);
          }
          gruppo.particelle.push(particella.particella);
          conContorno.push(particella);
        });
      });

      // Il riferimento del servizio per le **strade** non è il numero
      // catastale: negli stessi posti il servizio scrive `STRADA001…007` mentre
      // i dati aperti dicono `STRADA064, 082, 085, 086`. Per le particelle
      // normali i due coincidono. Si preferisce quindi il numero dei dati
      // aperti — quello che si legge sulla mappa — cercando il loro punto
      // interno dentro il contorno arrivato dal servizio.
      return correggiNumeri(conContorno, comuni).then(function (sostituiti) {
        if (sostituiti) {
          particelle = [];
          gruppi.forEach(function (gruppo) { gruppo.particelle = []; });

          conContorno.forEach(function (particella) {
            if (particelle.indexOf(particella.particella) === -1) {
              particelle.push(particella.particella);
            }
            var gruppo = null;
            for (var g = 0; g < gruppi.length; g += 1) {
              if (gruppi[g].comune === particella.comune && gruppi[g].foglio === particella.foglio) {
                gruppo = gruppi[g];
              }
            }
            // Dopo la sostituzione più tratti di strada possono portare lo
            // stesso numero: si tiene una voce sola.
            if (gruppo && gruppo.particelle.indexOf(particella.particella) === -1) {
              gruppo.particelle.push(particella.particella);
            }
          });
        }

        return {
          comuni: comuni,
          fogli: fogli.sort(function (a, b) {
            var differenza = parseInt(a, 10) - parseInt(b, 10);
            return differenza || String(a).localeCompare(String(b));
          }),
          particelle: particelle,
          gruppi: gruppi
        };
      });
    });
  }

  /** Indice codice catastale -> riga del comune, costruito una volta sola. */
  var indicePerCodice = null;

  /**
   * Nome del comune a partire dal codice catastale, con la regione fra
   * parentesi: «Grosseto (Toscana)». È il modo in cui il comune va scritto
   * nell'immagine esportata: il codice dice poco a chi legge.
   */
  function nomeComune(codice) {
    if (!codice) return Promise.resolve(String(codice || ''));

    var promessa = indicePerCodice
      ? Promise.resolve(indicePerCodice)
      : caricaElenco().then(function (dati) {
          indicePerCodice = {};
          dati.comuni.forEach(function (riga) {
            indicePerCodice[riga[1]] = riga;
          });
          return indicePerCodice;
        });

    return promessa
      .then(function (indice) {
        var riga = indice[codice];
        if (!riga) return codice;
        var regione = datiElenco ? datiElenco.regioni[riga[2]] : '';
        return regione ? riga[0] + ' (' + regione + ')' : riga[0];
      })
      .catch(function () {
        return codice;
      });
  }

  /**
   * Sostituisce il numero di ogni particella con quello dei dati aperti,
   * cercando il punto interno della particella dentro il contorno del servizio.
   * Se per una particella non si trova nulla, resta il numero del servizio.
   */
  function correggiNumeri(particelle, comuni) {
    if (!particelle.length || !comuni.length) return Promise.resolve(false);

    return Promise.all(
      comuni.map(function (codice) {
        return puntiDelComune(codice).catch(function () {
          return [];
        });
      })
    ).then(function (elenchi) {
      var punti = elenchi.reduce(function (tutti, elenco) {
        return tutti.concat(elenco);
      }, []);

      if (!punti.length) return false;

      // Le strade sono lunghe e strette: dentro il loro contorno può cadere il
      // punto di un campo. Si accetta solo un punto dello stesso genere.
      function strada(numero) {
        return String(numero).indexOf('STRADA') === 0;
      }

      particelle.forEach(function (particella) {
        if (!particella.geometria) return;
        var genere = strada(particella.particella);
        var trovato = null;

        for (var i = 0; i < punti.length && !trovato; i += 1) {
          if (strada(punti[i].numero) !== genere) continue;
          var coord = ol.proj.fromLonLat([punti[i].lon, punti[i].lat]);
          if (particella.geometria.intersectsCoordinate(coord)) trovato = punti[i];
        }

        if (trovato) particella.particella = trovato.numero;
      });

      return true;
    }).catch(function () {
      return false;
    });
  }

  /**
   * Tutte le particelle di un comune, con numero e punto interno. Si legge una
   * volta per comune e resta in memoria.
   */
  function puntiDelComune(codice) {
    if (puntiPerComune[codice]) return Promise.resolve(puntiPerComune[codice]);

    return Promise.all([caricaLibrerie(), apriIndice()])
      .then(function (esiti) {
        var lib = esiti[0];
        var file = esiti[1][codice];
        if (!file) throw new Error('comune non presente nell\'archivio: ' + codice);
        return leggiPunti(lib, ARCHIVIO + file, codice);
      })
      .then(function (punti) {
        // si tengono in memoria gli ultimi comuni letti: le particelle di un
        // comune sono decine di migliaia, non si possono accumulare tutti
        ordineComuni.push(codice);
        while (ordineComuni.length > MAX_COMUNI) {
          var vecchio = ordineComuni.shift();
          if (vecchio !== codice) delete puntiPerComune[vecchio];
        }
        puntiPerComune[codice] = punti;
        return punti;
      });
  }

  return {
    init: init,
    cerca: cerca,
    pulisci: pulisciEvidenza,
    areaDelContorno: areaDelContorno,
    contorniParticelle: contorniParticelle,

    /**
     * Contorno di una particella, chiesto al WFS a partire da un punto che le
     * sta dentro. Serve al popup per misurarne la superficie.
     */
    contornoParticella: function (lat, lon, codice, foglio, particella) {
      return caricaContorno(lat, lon, codice, foglio, particella);
    },
    nomeComune: nomeComune,
    particelleNellArea: particelleNellArea,

    puntiComune: puntiDelComune,

    /**
     * Codice catastale del comune che contiene un punto, chiesto al servizio
     * con una GetFeatureInfo sul layer dei fogli (che riporta il riferimento
     * del comune, es. `E202_0087D0`).
     */
    comuneDaPunto: function (lon, lat) {
      var passo = 0.0006;
      var bbox = [lon - passo, lat - passo, lon + passo, lat + passo].join(',');

      var url =
        Campagna.config.catasto.url +
        '?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetFeatureInfo&LAYERS=CP.CadastralZoning' +
        '&QUERY_LAYERS=CP.CadastralZoning&STYLES=&FORMAT=image/png&INFO_FORMAT=text/html' +
        '&WIDTH=101&HEIGHT=101&SRS=EPSG:4258&X=50&Y=50&BBOX=' +
        encodeURIComponent(bbox);

      return fetch(url)
        .then(function (risposta) {
          return risposta.ok ? risposta.text() : '';
        })
        .then(function (testo) {
          var riferimento = /NationalCadastralZoningReference<\/th><td>([^<]+)</.exec(testo);
          if (!riferimento) return null;
          return riferimento[1].trim().split('_')[0] || null;
        })
        .catch(function () {
          return null;
        });
    },

    /**
     * Usata dai test: ricerca senza passare dall'interfaccia. Restituisce la
     * prima particella trovata (con foglio e particella normalizzati), oppure
     * `null`.
     */
    risolvi: function (codice, foglio, particella) {
      var filtro = {
        foglio: foglio ? String(foglio).padStart(4, '0') : null,
        particella: particella ? String(particella) : null
      };

      return Promise.all([caricaLibrerie(), apriIndice()]).then(function (esiti) {
        var mappa = esiti[1];
        var file = mappa[codice];
        if (!file) throw new Error('comune non presente nell\'archivio: ' + codice);
        return cercaNelFile(esiti[0], ARCHIVIO + file, codice, filtro);
      }).then(function (trovato) {
        return trovato && trovato.esempi.length ? trovato.esempi[0] : null;
      });
    }
  };
})();

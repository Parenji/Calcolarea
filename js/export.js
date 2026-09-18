/* ==========================================================================
   Campagna AI — esportazione dell'appezzamento come immagine PNG
   --------------------------------------------------------------------------
   L'immagine si compone di due parti:
     1. lo sfondo della mappa così com'è sullo schermo (sfondo stradale o
        satellitare, appezzamento evidenziato, eventuali linee catastali);
     2. una fascia inferiore con i dati: superficie, perimetro, centro,
        vertici e le attribuzioni dei dati.

   Tecnica: si attendono il caricamento di tutti i tile (`rendercomplete`),
   poi si ricompongono i canvas dei singoli layer di OpenLayers in un unico
   canvas (esattamente come nell'esempio "export map" della documentazione
   ufficiale), e infine si aggiunge la fascia dati.

   Requisito: i tile server devono inviare header CORS. Verificato: sia
   OpenStreetMap sia Esri lo fanno. Le immagini catastali sono già same-origin
   perché passano dal nostro dominio (rewrite di Vercel / dev-proxy).
   ========================================================================== */

Campagna.exporter = (function () {
  'use strict';

  var FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  var CAPTION_HEIGHT = 236;

  /**
   * Renderizza l'intera mappa in un canvas dedicato e lo restituisce.
   *
   * È il metodo ufficiale di OpenLayers per esportare una mappa: la
   * documentazione di `ol/Map` indica esplicitamente di usare un
   * `HTMLCanvasElement` (o un `OffscreenCanvas`) come `target`
   * «when exporting a map». Il canvas diventa il bersaglio di rendering, quindi
   * contiene già tutti i layer composti, riproiettati e con le opacità applicate.
   *
   * Il metodo alternativo — ricomporre a mano i canvas dei singoli layer
   * leggendo le matrici CSS da `.ol-layer` — è un retaggio delle versioni
   * precedenti e in OpenLayers 10 restituisce un'immagine mal posizionata
   * (contenuto piccolo nell'angolo e grande spazio vuoto), perché le matrici
   * interne non sono più quelle su cui quel codice contava.
   */
  function renderToCanvas(map, timeoutMs) {
    var size = map.getSize();
    var canvas = document.createElement('canvas');
    canvas.width = Math.round(size[0]);
    canvas.height = Math.round(size[1]);

    var previousTarget = map.getTarget();

    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = null;

      function finish() {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);

        // Si copia il risultato prima di riportare la mappa al suo contenitore,
        // perché il cambio di target azzera il canvas.
        var result = document.createElement('canvas');
        result.width = canvas.width;
        result.height = canvas.height;
        result.getContext('2d').drawImage(canvas, 0, 0);

        map.setTarget(previousTarget);

        if (!result.width || !result.height) {
          reject(new Error("Impossibile renderizzare la mappa per l'esportazione."));
          return;
        }
        resolve(result);
      }

      try {
        map.setTarget(canvas);
      } catch (err) {
        map.setTarget(previousTarget);
        reject(err);
        return;
      }

      // `rendercomplete` viene emesso solo quando tutti i layer hanno finito di
      // caricare i propri dati (tile e immagini WMS): è l'attesa che ci serve.
      map.once('rendercomplete', finish);
      timer = setTimeout(finish, timeoutMs || 20000);
      map.renderSync();
    });
  }

  /** Tronca una stringa perché stia nella larghezza indicata. */
  function fitText(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    var result = text;
    while (result.length > 4 && ctx.measureText(result + '…').width > maxWidth) {
      result = result.slice(0, -1);
    }
    return result + '…';
  }

  /** Nome file sicuro a partire dal nome dell'appezzamento. */
  function slugify(text) {
    var base = String(text || 'appezzamento')
      .toLowerCase()
      .replace(/[àáâä]/g, 'a')
      .replace(/[èéêë]/g, 'e')
      .replace(/[ìíîï]/g, 'i')
      .replace(/[òóôö]/g, 'o')
      .replace(/[ùúûü]/g, 'u')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
    return base || 'appezzamento';
  }

  /** Compone l'immagine finale: mappa + fascia con i dati. */
  function composeWithCaption(mapCanvas, data) {
    var widthCss = mapCanvas.width;

    var out = document.createElement('canvas');
    out.width = mapCanvas.width;
    out.height = mapCanvas.height + CAPTION_HEIGHT;

    var ctx = out.getContext('2d');
    ctx.drawImage(mapCanvas, 0, 0);

    // L'origine viene spostata appena sotto l'immagine della mappa:
    // y = 0 corrisponde ora all'inizio della fascia.
    ctx.translate(0, mapCanvas.height);

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, widthCss, CAPTION_HEIGHT);

    ctx.fillStyle = '#2f7d4f';
    ctx.fillRect(0, 0, widthCss, 3);

    var left = 22;
    var right = widthCss - 22;
    var usable = right - left;

    // Titolo: nome dell'appezzamento
    ctx.fillStyle = '#16241b';
    ctx.font = '700 19px ' + FONT;
    ctx.fillText(fitText(ctx, data.title, usable), left, 32);

    // Superficie e perimetro, in evidenza
    ctx.font = '700 17px ' + FONT;
    ctx.fillStyle = '#256940';
    var areaLine = 'Superficie: ' + data.area;
    ctx.fillText(areaLine, left, 64);

    ctx.fillStyle = '#16241b';
    ctx.fillText('Perimetro: ' + data.perimeter, left + ctx.measureText(areaLine).width + 28, 64);

    // Riga di dettaglio
    ctx.font = '400 13px ' + FONT;
    ctx.fillStyle = '#5d6b62';
    ctx.fillText(
      fitText(
        ctx,
        'Acri: ' + data.acres + '   ·   Vertici: ' + data.vertices + '   ·   Sfondo: ' + data.base,
        usable
      ),
      left,
      92
    );

    ctx.fillText(fitText(ctx, 'Centro: ' + data.centroid, usable), left, 114);

    var catastoLine =
      data.catasto && data.catasto.length
        ? 'Catasto attivo: ' + data.catasto.join(', ')
        : 'Catasto: non attivo';
    ctx.fillText(fitText(ctx, catastoLine, usable), left, 136);

    // Cosa c'è dentro l'area: comuni, fogli e numeri delle particelle
    if (data.catastoDentro) {
      var dentro = data.catastoDentro;
      ctx.font = '400 12.5px ' + FONT;
      ctx.fillStyle = '#16241b';

      var righe = [];

      if (dentro.errore) {
        righe.push('Dati catastali dell\u2019area non disponibili (' + dentro.errore + ')');
      } else if (Campagna.numeri && Campagna.numeri.riepilogoCatasto) {
        var riepilogo = Campagna.numeri.riepilogoCatasto(dentro);
        if (riepilogo) {
          riepilogo.righe.forEach(function (voce) {
            var valore = voce[1];
            // l'elenco può essere lunghissimo: la fascia ha altezza fissa
            if (voce[0].indexOf('Particelle') === 0 && valore.length > 160) {
              valore = valore.slice(0, 157).replace(/[\s\u00b7,]+$/, '') + ' \u2026';
            }
            righe.push(voce[0] + ': ' + valore);
          });
        }
      }

      righe.slice(0, 3).forEach(function (riga, indice) {
        ctx.fillText(fitText(ctx, riga, usable), left, 158 + indice * 18);
      });
    }

    ctx.font = '400 12px ' + FONT;
    ctx.fillStyle = '#16241b';
    ctx.fillText('Data: ' + data.date, left, 222);

    // Attribuzioni
    ctx.font = '400 11px ' + FONT;
    ctx.fillStyle = '#8b978f';
    var attrText = fitText(ctx, data.attribution, usable * 0.62);
    ctx.fillText(attrText, right - ctx.measureText(attrText).width, 222);

    return out;
  }

  /** Converte il canvas in file e avvia il download. */
  function downloadCanvas(canvas, filename) {
    return new Promise(function (resolve, reject) {
      try {
        canvas.toBlob(function (result) {
          if (!result) {
            reject(
              new Error(
                "Impossibile generare l'immagine: i tile della mappa potrebbero non essere accessibili."
              )
            );
            return;
          }

          var url = URL.createObjectURL(result);
          var link = document.createElement('a');
          link.href = url;
          link.download = filename;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          setTimeout(function () {
            URL.revokeObjectURL(url);
          }, 1000);

          resolve(result.size);
        }, 'image/png');
      } catch (err) {
        reject(
          new Error(
            'Immagine non esportabile, i dati di sfondo non sono accessibili da questo dominio (' +
              err.name +
              ').'
          )
        );
      }
    });
  }

  /**
   * Genera e scarica l'immagine PNG dell'appezzamento.
   *
   * @param {Object} options
   *   map           istanza ol.Map
   *   feature       feature da inquadrare ed evidenziare
   *   misure        risultato di Campagna.measure.describe()
   *   name          nome dell'appezzamento
   *   baseName      etichetta dello sfondo ("Mappa" / "Satellite")
   *   catastoLabels elenco dei layer catastali attivi
   * @returns {Promise<number>} dimensione in byte dell'immagine prodotta
   */
  function download(options) {
    var map = options.map;
    var feature = options.feature;

    if (!map || !feature) {
      return Promise.reject(new Error('Nessun appezzamento da esportare.'));
    }

    var view = map.getView();
    var previous = {
      center: view.getCenter(),
      resolution: view.getResolution(),
      rotation: view.getRotation()
    };

    if (typeof view.cancelAnimations === 'function') view.cancelAnimations();

    function restoreView() {
      view.setCenter(previous.center);
      view.setResolution(previous.resolution);
      view.setRotation(previous.rotation);
    }

    // 1. Inquadra l'appezzamento con un margine
    var geometry = feature.getGeometry();
    var extent = geometry.getExtent();
    if (extent && isFinite(extent[0]) && extent[0] !== extent[2]) {
      view.fit(extent, { padding: [90, 90, 90, 90], maxZoom: 19, duration: 0 });
    }
    map.renderSync();

    // 1b. Le immagini del catasto arrivano a pezzi, chiesti dopo il cambio di
    //     vista: qui si chiedono subito e si aspetta che arrivino, altrimenti
    //     l'immagine può uscire senza le linee delle particelle.
    var pronti = Campagna.catasto && Campagna.catasto.caricaPezziOra
      ? Campagna.catasto.caricaPezziOra()
      : Promise.resolve();

    // 2. Renderizza la mappa in un canvas dedicato: è il metodo ufficiale di
    //    OpenLayers per l'esportazione e attende da sé il caricamento dei tile
    //    e delle immagini WMS prima di restituire il risultato.
    return pronti
      .then(function () {
        map.renderSync();
        return renderToCanvas(map, 20000);
      })
      .then(function (mapCanvas) {
        // 3. Compone mappa + fascia dati
        var misure = options.misure || Campagna.measure.describe(geometry);

        var finalCanvas = composeWithCaption(mapCanvas, {
          // nome dell'appezzamento e, se c'è, il gruppo
          title: options.group
            ? (options.name || 'Appezzamento') + ' \u00b7 ' + options.group
            : (options.name || 'Appezzamento'),
          area: misure.areaText,
          perimeter: misure.perimeterText,
          acres: misure.acresText,
          vertices: misure.vertices == null ? '—' : String(misure.vertices),
          centroid: misure.centroidText,
          base: options.baseName || '—',
          catasto: options.catastoLabels || [],
          catastoDentro: options.catastoDentro || null,
          date: new Date().toLocaleString('it-IT'),
          attribution:
            'Fonte dati: Agenzia delle Entrate (CC BY 4.0) · OpenStreetMap contributors · Imagery Esri'
        });

        var filename =
          'appezzamento-' +
          slugify(options.name) +
          '-' +
          new Date().toISOString().slice(0, 10) +
          '.png';

        return downloadCanvas(finalCanvas, filename);
      })
      .then(function (size) {
        restoreView();
        return size;
      })
      .catch(function (err) {
        restoreView();
        throw err;
      });
  }

  return {
    download: download,
    slugify: slugify
  };
})();

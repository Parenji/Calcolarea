/* ==========================================================================
   Campagna AI — numeri delle particelle, disegnati dall'app
   --------------------------------------------------------------------------
   Perché non si chiedono al servizio dell'Agenzia: il layer `codice_plla`
   disegna i numeri solo a scala molto più fine di quella della vista (6·10⁻⁶
   gradi/px contro 1,6·10⁻⁵ dei contorni). Chiesto a quella scala e poi
   rimpicciolito alla vista, il testo diventa alto poco più di un pixel:
   illeggibile. A zoom 15, per giunta, servirebbero sedici immagini da 2048 px
   solo per i numeri.

   I numeri si disegnano quindi qui, come testo vettoriale: resta leggibile a
   qualunque zoom e costa una lettura per comune (i dati aperti OnData, già usati
   dalla ricerca), non un'immagine per vista.

   Il comune si scopre chiedendo al servizio, per qualche punto della vista, il
   foglio che lo contiene: la risposta riporta il riferimento del comune
   (es. `E202_0087D0`).
   ========================================================================== */

Campagna.numeri = (function () {
  'use strict';

  /** Da quale zoom si disegnano i numeri (lo stesso delle particelle). */
  var ZOOM_MINIMO = 15;
  /** Quanti punti della vista interrogare per scoprire i comuni. */
  var PUNTI_SONDAGGIO = 5;
  /** Oltre questo numero di particelle visibili i numeri non si disegnano. */
  var MAX_ETICHETTE = 6000;

  var map = null;
  var livello = null;
  var sorgente = null;
  var attesa = null;
  var comuniCaricati = {};

  /**
   * Corpo del testo in base allo zoom: a zoom 15 le particelle sono poche
   * decine di pixel, quindi il numero deve essere piccolo per stare dentro il
   * contorno; ingrandendo cresce fino a diventare comodamente leggibile.
   */
  function corpoTesto() {
    var zoom = map ? map.getView().getZoom() : 18;
    if (zoom == null) return 11;
    return Math.max(8.5, Math.min(11.5, 8.5 + (zoom - 15) * 0.75));
  }

  function stile(feature) {
    var corpo = corpoTesto();
    return new ol.style.Style({
      text: new ol.style.Text({
        text: feature.get('numero'),
        font: '600 ' + corpo.toFixed(1) + 'px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fill: new ol.style.Fill({ color: '#3a2f14' }),
        stroke: new ol.style.Stroke({ color: 'rgba(255,255,255,0.92)', width: 2.5 }),
        // Spazio attorno all'etichetta: a zoom basso le particelle sono
        // piccole, e senza questo i numeri si affollerebbero fino a formare
        // una parete di cifre illeggibile.
        padding: [4, 5, 4, 5],
        overflow: true
      })
    });
  }

  /**
   * Stima la dimensione di ogni particella dalla distanza dalla particella
   * piu vicina: i numeri si disegnano solo dove c'e spazio per leggerli, e si
   * parte dalle particelle piu grandi (OpenLayers nasconde le etichette che
   * si sovrappongono, nell'ordine in cui arrivano).
   */
  function ordinaPerDimensione(punti) {
    if (!punti.length) return punti;

    var lato = 0.0006; // circa 50 m: cella della griglia di ricerca
    var celle = {};
    punti.forEach(function (punto, indice) {
      var chiave = Math.floor(punto.lon / lato) + ':' + Math.floor(punto.lat / lato);
      (celle[chiave] = celle[chiave] || []).push(indice);
    });

    function distanza(a, b) {
      var dx = (a.lon - b.lon) * 0.73;
      var dy = a.lat - b.lat;
      return dx * dx + dy * dy;
    }

    punti.forEach(function (punto, indice) {
      var cx = Math.floor(punto.lon / lato);
      var cy = Math.floor(punto.lat / lato);
      var minima = Infinity;
      for (var i = -1; i <= 1 && minima > 0; i += 1) {
        for (var j = -1; j <= 1; j += 1) {
          var vicini = celle[(cx + i) + ':' + (cy + j)];
          if (!vicini) continue;
          for (var k = 0; k < vicini.length; k += 1) {
            if (vicini[k] === indice) continue;
            var d = distanza(punto, punti[vicini[k]]);
            if (d < minima) minima = d;
          }
        }
      }
      punto.dimensione = isFinite(minima) ? minima : 1;
    });

    return punti.slice().sort(function (a, b) {
      return b.dimensione - a.dimensione;
    });
  }

  function creaLivello() {
    if (livello || !map) return;

    sorgente = new ol.source.Vector();
    livello = new ol.layer.Vector({
      source: sorgente,
      zIndex: 210,
      style: stile,
      // OpenLayers nasconde da solo le etichette che si sovrappongono: a zoom
      // 15 le particelle sono piccole e i numeri di tutte non ci starebbero,
      // quindi restano quelli che hanno spazio — come fa una carta vera.
      declutter: true
    });
    livello.set('catastoKey', '__numeri');
    map.addLayer(livello);
  }

  /** I punti della vista su cui chiedere al servizio in che comune siamo. */
  function puntiSondaggio(extent) {
    var cx = (extent[0] + extent[2]) / 2;
    var cy = (extent[1] + extent[3]) / 2;
    var dx = (extent[2] - extent[0]) * 0.42;
    var dy = (extent[3] - extent[1]) * 0.42;

    return [
      [cx, cy],
      [cx - dx, cy - dy],
      [cx + dx, cy - dy],
      [cx - dx, cy + dy],
      [cx + dx, cy + dy]
    ].slice(0, PUNTI_SONDAGGIO);
  }

  function comuneDaPunto(lon, lat) {
    var passo = 0.0008;
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
        var trovato = /NationalCadastralZoningReference<\/th><td>\s*([A-Za-z][0-9]{3})_/.exec(testo);
        return trovato ? trovato[1] : null;
      })
      .catch(function () {
        return null;
      });
  }

  /** Disegna i numeri delle particelle visibili nel riquadro indicato. */
  function disegna(extent) {
    if (!sorgente) return;

    var comuni = puntiSondaggio(extent);
    Promise.all(
      comuni.map(function (punto) {
        return comuneDaPunto(punto[0], punto[1]);
      })
    )
      .then(function (codici) {
        var distinti = [];
        codici.forEach(function (codice) {
          if (codice && distinti.indexOf(codice) === -1) distinti.push(codice);
        });
        if (!distinti.length) return null;

        return Promise.all(
          distinti.map(function (codice) {
            return Campagna.ricerca.puntiComune(codice).catch(function () {
              return [];
            });
          })
        ).then(function (elenchi) {
          return elenchi.reduce(function (tutti, elenco) {
            return tutti.concat(elenco);
          }, []);
        });
      })
      .then(function (punti) {
        if (!punti) return;

        // margine del 10%: le particelle a cavallo del bordo restano visibili
        var dx = (extent[2] - extent[0]) * 0.05;
        var dy = (extent[3] - extent[1]) * 0.05;
        var visibili = punti.filter(function (punto) {
          return (
            punto.lon >= extent[0] - dx &&
            punto.lon <= extent[2] + dx &&
            punto.lat >= extent[1] - dy &&
            punto.lat <= extent[3] + dy
          );
        });

        if (visibili.length > MAX_ETICHETTE) {
          visibili = visibili.slice(0, MAX_ETICHETTE);
        }

        sorgente.clear();
        sorgente.addFeatures(
          ordinaPerDimensione(visibili).map(function (punto) {
            var feature = new ol.Feature({
              geometry: new ol.geom.Point(ol.proj.fromLonLat([punto.lon, punto.lat]))
            });
            feature.set('numero', punto.numero);
            return feature;
          })
        );
      })
      .catch(function () {
        // senza dati i numeri semplicemente non compaiono
      });
  }

  /**
   * Aggiorna i numeri per la vista corrente. Va chiamata a ogni cambio di vista
   * e quando si accende o spegne il layer delle particelle.
   */
  function aggiorna(attivo, opacity) {
    if (!map) return;

    clearTimeout(attesa);
    attesa = setTimeout(function () {
      var zoom = map.getView().getZoom();
      var visibile = attivo && zoom != null && zoom >= ZOOM_MINIMO;

      if (livello) {
        livello.setVisible(visibile);
        livello.setOpacity(opacity == null ? 1 : opacity);
      }
      if (!visibile) {
        if (sorgente) sorgente.clear();
        return;
      }

      creaLivello();
      var extent = ol.proj.transformExtent(
        map.getView().calculateExtent(map.getSize()),
        'EPSG:3857',
        'EPSG:4326'
      );
      disegna(extent);
    }, 350);
  }

  /**
   * Comuni, fogli e numeri di particella che interessano un appezzamento.
   * Serve alla fascia dati dell'immagine esportata.
   *
   * I contorni vengono dal WFS e l'intersezione e' verificata davvero, quindi
   * l'elenco e' completo: comprende anche le particelle tagliate dal bordo
   * dell'area, che con i soli punti interni andrebbero perse.
   */
  function infoArea(geometry) {
    if (!geometry) return Promise.resolve(null);

    return Campagna.ricerca
      .particelleNellArea(geometry)
      .then(function (trovate) {
        return Promise.all(
          trovate.comuni.map(function (codice) {
            return Campagna.ricerca.nomeComune(codice);
          })
        ).then(function (nomi) {
          // i gruppi arrivano con il codice del comune: qui si sostituisce il
          // nome, perché è quello che si legge
          var perCodice = {};
          trovate.comuni.forEach(function (codice, indice) {
            perCodice[codice] = nomi[indice];
          });

          return {
            comuni: nomi,
            fogli: trovate.fogli,
            particelle: trovate.particelle,
            gruppi: (trovate.gruppi || []).map(function (gruppo) {
              return {
                comune: perCodice[gruppo.comune] || gruppo.comune,
                foglio: gruppo.foglio,
                particelle: gruppo.particelle
              };
            })
          };
        });
      })
      .catch(function (errore) {
        // nessun elenco parziale: o e' completo, o si dice che non c'e'
        return { comuni: [], fogli: [], particelle: [], errore: errore.message };
      });
  }

  /**
   * Come scrivere comuni, fogli e particelle nella scheda e nella fascia
   * dell'immagine: forma compatta se l'area sta in un foglio solo, altrimenti
   * una voce per foglio (col comune, se i comuni sono più d'uno), così si
   * capisce quali particelle appartengono a quale foglio.
   */
  function riepilogoCatasto(info) {
    if (!info) return null;

    var gruppi = info.gruppi || [];
    var comuni = info.comuni || [];
    var fogli = info.fogli || [];
    var particelle = info.particelle || [];
    var multiComune = comuni.length > 1;

    var righe = [];
    if (comuni.length) righe.push(['Comuni', comuni.join(', ')]);
    if (fogli.length) righe.push(['Fogli', fogli.join(', ')]);

    var etichetta = 'Particelle (' + particelle.length + ')';
    var valore;

    if (gruppi.length <= 1) {
      valore = particelle.join(', ');
    } else {
      valore = gruppi
        .map(function (gruppo) {
          var testa =
            (multiComune && gruppo.comune ? gruppo.comune + ' \u00b7 ' : '') +
            'foglio ' + gruppo.foglio + ': ';
          return testa + gruppo.particelle.join(', ');
        })
        .join('  \u00b7  ');
    }

    righe.push([etichetta, valore]);
    return { righe: righe, valoreParticelle: valore, perFoglio: gruppi.length > 1 };
  }

  function init(olMap) {
    map = olMap;
    creaLivello();
  }

  return {
    init: init,
    aggiorna: aggiorna,
    infoArea: infoArea,
    riepilogoCatasto: riepilogoCatasto,
    /** Usata dai test. */
    comuneDaPunto: comuneDaPunto
  };
})();

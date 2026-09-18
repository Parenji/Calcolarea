/* ==========================================================================
   Campagna AI — informazioni di un punto della mappa
   --------------------------------------------------------------------------
   Un clic sulla mappa (quando non si sta disegnando e c'è almeno un layer
   catastale acceso) apre una scheda con:
     · regione e comune
     · foglio e numero di particella
     · coordinate del punto
     · l'appezzamento salvato che contiene il punto, con il suo gruppo

   Comune, foglio e particella si chiedono al servizio con una GetFeatureInfo:
   è il dato corrente, non una copia. Il riferimento che torna
   (`E202_0087D0.888`) contiene tutte e tre le informazioni in una volta.
   ========================================================================== */

Campagna.punto = (function () {
  'use strict';

  var map = null;
  var overlay = null;
  var scheda = null;
  /** Vero quando la scheda è aperta: il clic successivo la chiude. */
  var aperta = false;
  /** Il segnalino sul punto cliccato, come nelle mappe che si usano tutti i giorni. */
  var segnalino = null;

  /** Il riferimento catastale si legge come in ricerca.js. */
  function leggiRiferimento(testo, chiave) {
    var espressione = new RegExp(chiave + '<\\/th><td>([^<]+)<');
    var trovato = espressione.exec(testo);
    return trovato ? trovato[1].trim() : null;
  }

  /** Chiede al servizio gli attributi di un punto su un layer. */
  function getFeatureInfo(layer, lon, lat) {
    var passo = 0.0002;
    var bbox = [lon - passo, lat - passo, lon + passo, lat + passo].join(',');
    var url =
      Campagna.config.catasto.url +
      '?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetFeatureInfo&LAYERS=' + layer +
      '&QUERY_LAYERS=' + layer + '&STYLES=&FORMAT=image/png&INFO_FORMAT=text/html' +
      '&WIDTH=101&HEIGHT=101&SRS=EPSG:4258&X=50&Y=50&BBOX=' + encodeURIComponent(bbox);

    return fetch(url)
      .then(function (risposta) {
        return risposta.ok ? risposta.text() : '';
      })
      .catch(function () {
        return '';
      });
  }

  /** Appezzamenti salvati che contengono il punto indicato. */
  function areeCheContengono(coord) {
    var trovate = [];

    Campagna.store.all().forEach(function (record) {
      var feature;
      try {
        feature = Campagna.store.toFeature(record);
      } catch (err) {
        return;
      }
      var geometria = feature.getGeometry();
      if (geometria && geometria.intersectsCoordinate(coord)) {
        trovate.push({
          nome: record.name,
          gruppo: record.group || '',
          area: record.areaText || Campagna.measure.formatArea(record.areaM2),
          perimetro: record.perimeterText || Campagna.measure.formatLength(record.perimeterM),
          geometria: geometria
        });
      }
    });

    return trovate;
  }

  function riga(etichetta, valore, evidenzia) {
    var div = document.createElement('div');
    div.className = 'punto-riga';

    var eti = document.createElement('span');
    eti.className = 'punto-eti';
    eti.textContent = etichetta;

    var val = document.createElement('span');
    val.className = 'punto-val';

    var forti = evidenzia ? [].concat(evidenzia) : [];
    if (!forti.length || !valore) {
      val.textContent = valore;
    } else {
      // si spezza il testo e si mette in grassetto solo ciò che va evidenziato
      String(valore).split(/(\s*[\u00b7,]\s*)/).forEach(function (pezzo) {
        if (forti.indexOf(pezzo.trim()) !== -1) {
          var forte = document.createElement('strong');
          forte.textContent = pezzo;
          val.appendChild(forte);
        } else {
          val.appendChild(document.createTextNode(pezzo));
        }
      });
    }

    div.appendChild(eti);
    div.appendChild(val);
    return div;
  }

  function mostra(coord, contenuto) {
    scheda.innerHTML = '';

    var testa = document.createElement('div');
    testa.className = 'punto-testa';

    var chiudi = document.createElement('button');
    chiudi.type = 'button';
    chiudi.className = 'punto-chiudi';
    chiudi.setAttribute('aria-label', 'Chiudi');
    chiudi.textContent = '\u00d7';
    chiudi.addEventListener('click', function () {
      chiudiScheda();
    });

    // il titolo c'è solo quando serve: senza, non deve restare spazio vuoto
    if (contenuto.titolo) {
      var titolo = document.createElement('strong');
      titolo.textContent = contenuto.titolo;
      testa.appendChild(titolo);
    }

    testa.appendChild(chiudi);
    testa.classList.toggle('solo-chiudi', !contenuto.titolo);
    scheda.appendChild(testa);

    (contenuto.righe || []).forEach(function (voce) {
      scheda.appendChild(riga(voce[0], voce[1]));
    });

    if (contenuto.aree && contenuto.aree.length) {
      contenuto.aree.forEach(function (area) {
        // il gruppo su una riga sua, prima dell'appezzamento
        if (area.gruppo) scheda.appendChild(riga('Gruppo', area.gruppo));
        scheda.appendChild(riga('Appezzamento', area.nome));
        if (area.area) scheda.appendChild(riga('Superficie', area.area));
        if (area.perimetro) scheda.appendChild(riga('Perimetro', area.perimetro));
      });
    }

    if (contenuto.azione) {
      var pulsante = document.createElement('button');
      pulsante.type = 'button';
      pulsante.className = 'punto-azione';
      pulsante.textContent = contenuto.azione.testo;
      pulsante.addEventListener('click', contenuto.azione.fai);
      scheda.appendChild(pulsante);
    }

    // La scheda si apre dal lato dove c'è spazio: cliccando vicino al bordo
    // destro si apre verso sinistra, e viceversa. Su schermo stretto era il
    // motivo per cui le schede uscivano dallo schermo.
    var pixel = map ? map.getPixelFromCoordinate(coord) : null;
    var larghezza = map ? map.getSize()[0] : 0;
    var verso = pixel && larghezza && pixel[0] > larghezza * 0.55 ? 'bottom-right' : 'bottom-left';

    overlay.setPositioning(verso);
    overlay.setOffset(verso === 'bottom-right' ? [-12, -12] : [12, -12]);
    overlay.setPosition(coord);
    if (segnalino) segnalino.setPosition(coord);
    aperta = true;

    // rete di sicurezza per il bordo in alto e in basso
    if (overlay.panIntoView) {
      overlay.panIntoView({ margin: 20, animation: { duration: 250 } });
    }
  }

  /** Chiude la scheda e toglie il segnalino. */
  function chiudiScheda() {
    overlay.setPosition(undefined);
    if (segnalino) segnalino.setPosition(undefined);
    aperta = false;
  }

  function inCorso(coord) {
    mostra(coord, { titolo: 'Lettura del catasto\u2026', righe: [] });
  }

  /** Coordinate del punto, riga comune a tutte le schede. */
  function rigaCoordinate(lon, lat) {
    return ['Coordinate', lat.toFixed(6) + '\u00b0 N, ' + lon.toFixed(6) + '\u00b0 E'];
  }

  /**
   * Dentro un appezzamento salvato si mostra **prima l'appezzamento**: chi
   * clicca lì vuole sapere di che area si tratta, non i dati catastali della
   * particella. Il rimando alla particella resta a un clic di distanza.
   */
  function descriviArea(coord, area) {
    var lonlat = ol.proj.toLonLat(coord);
    var righe = [];
    righe.push(['Nome', area.nome]);
    if (area.gruppo) righe.push(['Gruppo', area.gruppo]);
    if (area.area) righe.push(['Superficie', area.area]);
    if (area.perimetro) righe.push(['Perimetro', area.perimetro]);
    righe.push(rigaCoordinate(lonlat[0], lonlat[1]));

    mostra(coord, { titolo: '', righe: righe });

    // I dati catastali dell'area (comuni, fogli, particelle) arrivano dal WFS:
    // qualche secondo, quindi si scrivono quando sono pronti.
    if (!area.geometria || !Campagna.numeri) return;

    var attesa = document.createElement('div');
    attesa.className = 'punto-riga punto-attesa';
    attesa.textContent = 'Dati catastali dell\u2019area: lettura\u2026';
    scheda.appendChild(attesa);

    // Si chiede anche in che particella si è cliccato: serve a metterla in
    // grassetto nell'elenco.
    var cliccata = getFeatureInfo('CP.CadastralParcel', lonlat[0], lonlat[1]).then(function (testo) {
      var riferimento = leggiRiferimento(testo, 'NationalCadastralReference');
      return riferimento ? (riferimento.split('.')[1] || null) : null;
    }).catch(function () {
      return null;
    });

    Promise.all([Campagna.numeri.infoArea(area.geometria), cliccata]).then(function (esiti) {
      var info = esiti[0];
      var particellaCliccata = esiti[1];

      // se nel frattempo si è cliccato altrove, non si tocca più questa scheda
      if (overlay.getPosition() !== coord || !scheda.contains(attesa)) return;
      scheda.removeChild(attesa);

      if (!info || info.errore) {
        scheda.appendChild(riga('Catasto', 'dati non disponibili'));
        return;
      }

      var riepilogo = Campagna.numeri.riepilogoCatasto
        ? Campagna.numeri.riepilogoCatasto(info)
        : null;

      if (!riepilogo) return;

      riepilogo.righe.forEach(function (voce) {
        var evidenzia = voce[0].indexOf('Particelle') === 0 && particellaCliccata
          ? [particellaCliccata]
          : null;
        scheda.appendChild(riga(voce[0], voce[1], evidenzia));
      });

      if (particellaCliccata) {
        var nota = document.createElement('p');
        nota.className = 'punto-nota';
        nota.textContent =
          'In grassetto la particella ' + particellaCliccata + ', quella su cui hai cliccato.';
        scheda.appendChild(nota);
      }
    }).catch(function () {
      if (scheda.contains(attesa)) {
        scheda.removeChild(attesa);
        scheda.appendChild(riga('Catasto', 'dati non disponibili'));
      }
    });
  }

  function descrivi(coord) {
    var aree = areeCheContengono(coord);

    if (aree.length) {
      descriviArea(coord, aree[0]);
      return Promise.resolve();
    }

    return descriviCatasto(coord);
  }

  function descriviCatasto(coord) {
    var lonlat = ol.proj.toLonLat(coord);
    var lon = lonlat[0];
    var lat = lonlat[1];

    // la particella: dal riferimento si ricavano comune, foglio e numero
    return getFeatureInfo('CP.CadastralParcel', lon, lat).then(function (testo) {
      var riferimento = leggiRiferimento(testo, 'NationalCadastralReference');
      var foglio = null;
      var particella = null;
      var codice = null;

      if (riferimento) {
        var pezzi = riferimento.split('_');
        var coda = (pezzi[1] || '').split('.');
        codice = pezzi[0] || null;
        // due caratteri di suffisso dopo le quattro cifre del foglio
        foglio = (coda[0] || '').slice(0, -2).replace(/^0+/, '') || null;
        particella = coda[1] || null;
      }

      // 2. senza particella si prova almeno il foglio (zone censuarie)
      var ripiego = riferimento
        ? Promise.resolve(null)
        : getFeatureInfo('CP.CadastralZoning', lon, lat);

      return ripiego.then(function (testoZone) {
        if (!riferimento && testoZone) {
          var rifZona = leggiRiferimento(testoZone, 'NationalCadastralZoningReference');
          var etichetta = leggiRiferimento(testoZone, 'Label');
          if (rifZona) codice = rifZona.split('_')[0] || null;
          if (etichetta) foglio = etichetta.replace(/^0+/, '');
        }

        var nomeComune = codice
          ? Campagna.ricerca.nomeComune(codice)
          : Promise.resolve(null);

        return nomeComune.then(function (nome) {
          var righe = [];
          if (nome) righe.push(['Comune', nome]);
          if (foglio) righe.push(['Foglio', foglio]);
          if (particella) righe.push(['Particella', particella]);
          if (!foglio && !particella) {
            righe.push(['Catasto', 'nessun dato in questo punto']);
          }
          righe.push(rigaCoordinate(lon, lat));

          mostra(coord, { titolo: '', righe: righe });
        });
      });
    });
  }

  function init(olMap) {
    map = olMap;

    scheda = document.createElement('div');
    scheda.className = 'punto-scheda';

    // segnalino nel punto cliccato
    var puntino = document.createElement('div');
    puntino.className = 'punto-segnalino';
    puntino.setAttribute('aria-hidden', 'true');

    segnalino = new ol.Overlay({
      element: puntino,
      positioning: 'center-center',
      stopEvent: false,
      insertFirst: true
    });
    map.addOverlay(segnalino);

    overlay = new ol.Overlay({
      element: scheda,
      positioning: 'bottom-left',
      offset: [12, -12],
      stopEvent: true,
      // se la scheda uscirebbe dallo schermo, la mappa si sposta quel tanto
      // che basta a farla stare tutta: su mobile era il difetto più evidente
      autoPan: true,
      autoPanMargin: 24,
      autoPanAnimation: { duration: 250 }
    });
    map.addOverlay(overlay);

    map.on('singleclick', function (evento) {
      // durante un disegno il clic serve allo strumento, non alla lettura
      if (Campagna.draw && Campagna.draw.getTool && Campagna.draw.getTool()) return;

      // nemmeno il clic che chiude un disegno (vertice iniziale del poligono,
      // ultimo clic del rettangolo o del cerchio): lo strumento è già stato
      // messo via, ma il clic è ancora suo
      if (
        Campagna.draw &&
        Campagna.draw.ultimaFineDisegno &&
        Date.now() - Campagna.draw.ultimaFineDisegno() < 500
      ) {
        return;
      }

      // e senza layer catastali accesi non c'è niente da leggere
      if (!Campagna.catasto || !Campagna.catasto.activeLabels().length) return;

      // se una scheda è già aperta, il clic altrove la chiude e basta
      if (aperta) {
        chiudiScheda();
        return;
      }

      inCorso(evento.coordinate);
      descrivi(evento.coordinate).catch(function () {
        chiudiScheda();
      });
    });
  }

  return {
    init: init,
    descrivi: descrivi
  };
})();

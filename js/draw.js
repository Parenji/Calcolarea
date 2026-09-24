/* ==========================================================================
   Campagna AI — disegno, modifica e selezione degli appezzamenti
   --------------------------------------------------------------------------
   Strumenti: poligono (click sui vertici), rettangolo (trascina) e cerchio
   (centro + raggio). La modifica dei vertici usa `ol.interaction.Modify`,
   lo snap a `ol.interaction.Snap` (comodo per appezzamenti confinanti).
   ========================================================================== */

Campagna.draw = (function () {
  'use strict';

  var map = null;
  var source = null;
  var styles = null;
  var hooks = {};

  var drawInteraction = null;
  var modifyInteraction = null;
  var snapInteraction = null;

  var activeTool = null;
  var activeFeature = null;

  var liveGeometry = null;
  var liveHandler = null;

  // ------------------------------------------------------------- misure live

  function attachLive(geometry) {
    detachLive();
    if (!geometry) return;
    liveGeometry = geometry;
    liveHandler = function () {
      refreshFeature(activeFeature);
    };
    liveGeometry.on('change', liveHandler);
  }

  function detachLive() {
    if (liveGeometry && liveHandler) {
      liveGeometry.un('change', liveHandler);
    }
    liveGeometry = null;
    liveHandler = null;
  }

  /** Ricalcola le misure di una feature e aggiorna etichetta + interfaccia. */
  function refreshFeature(feature) {
    if (!feature) return null;
    var misure = Campagna.measure.describe(feature.getGeometry());
    Campagna.map.setMeasureLabel(feature, misure.labelText);
    if (hooks.onChange && feature === activeFeature) hooks.onChange(feature, misure);
    return misure;
  }

  // -------------------------------------------------------------- selezione

  function setActiveFeature(feature) {
    if (activeFeature && activeFeature !== feature) {
      activeFeature.set('selected', false);
    }
    activeFeature = feature || null;

    if (activeFeature) {
      activeFeature.set('selected', true);
    }

    if (hooks.onChange) {
      hooks.onChange(
        activeFeature,
        activeFeature ? Campagna.measure.describe(activeFeature.getGeometry()) : null
      );
    }
  }

  // ------------------------------------------------------------------ disegno

  function removeDrawInteraction() {
    if (drawInteraction) {
      map.removeInteraction(drawInteraction);
      drawInteraction = null;
    }
    detachLive();
    activeTool = null;
  }

  function startDraw(tool) {
    removeDrawInteraction();

    var options = {
      source: source,
      type: tool === 'Polygon' ? 'Polygon' : 'Circle',
      style: [styles.sketch, styles.vertex],
      snapTolerance: 12
    };

    if (tool === 'Box') {
      options.geometryFunction = ol.interaction.Draw.createBox();
    }

    drawInteraction = new ol.interaction.Draw(options);

    drawInteraction.on('drawstart', function (event) {
      var feature = event.feature;
      feature.set('kind', 'draft');
      activeFeature = feature;
      feature.set('selected', true);
      attachLive(feature.getGeometry());
      refreshFeature(feature);
    });

    drawInteraction.on('drawend', function (event) {
      // il clic che chiude il disegno arriva anche alla mappa: qui si segna il
      // momento, così la scheda del punto non si apre proprio mentre si chiude
      ultimaFineDisegno = Date.now();
      detachLive();
      var feature = event.feature;
      feature.set('kind', 'draft');
      feature.set('selected', true);
      activeFeature = feature;

      // il lato dritto diventa il tratto di confine vero, se il modo è acceso
      try {
        aderisciAiConfini(feature);
      } catch (err) {
        console.error('[disegno] aderenza ai confini non riuscita', err);
      }

      removeDrawInteraction();
      refreshFeature(feature);
      if (hooks.onToolChange) hooks.onToolChange(null);
    });

    map.addInteraction(drawInteraction);

    // lo strumento appena creato sta in fondo: la calamita va rimessa dopo
    aggancioCatasto(true);
    activeTool = tool;
    if (hooks.onToolChange) hooks.onToolChange(tool);
  }

  // ----------------------------------------------------------------- modifica

  /** Forma del poligono all'inizio di un trascinamento di vertici. */
  var formaAllInizio = null;

  /** Contorni delle particelle, usati come calamita per i vertici. */
  var sorgenteCatasto = null;
  var snapCatasto = null;
  var zonaAggancio = null;

  /**
   * Accende la calamita sulle linee catastali.
   *
   * I contorni arrivano dal WFS: si chiedono per la zona inquadrata, in
   * sottofondo, e restano finché non ci si sposta. Con la calamita accesa un
   * vertice posato a pochi pixel da una linea catastale — o da un suo vertice —
   * ci si appoggia esattamente, invece di restare fuori di un pezzetto.
   */
  function preparaAggancio() {
    if (!sorgenteCatasto) {
      sorgenteCatasto = new ol.source.Vector();
      snapCatasto = new ol.interaction.Snap({
        source: sorgenteCatasto,
        pixelTolerance: 12,
        // anche lungo i lati, non solo sui vertici: è quello che serve per
        // seguire un confine catastale
        edge: true
      });
    }
    return snapCatasto;
  }

  function caricaContorniAggancio(adesso) {
    if (!map || !Campagna.ricerca || !Campagna.ricerca.contorniParticelle) return;

    var vista = map.getView();
    var zoom = vista.getZoom();
    if (zoom == null || zoom < 15) {
      if (sorgenteCatasto) sorgenteCatasto.clear();
      zonaAggancio = null;
      return;
    }

    var extent = vista.calculateExtent(map.getSize());
    var chiave = extent
      .map(function (valore) {
        return Math.round(valore / 40);
      })
      .join(',');

    if (!adesso && chiave === zonaAggancio) return;
    zonaAggancio = chiave;

    Campagna.ricerca
      .contorniParticelle(ol.geom.Polygon.fromExtent(extent))
      .then(function (poligoni) {
        if (!sorgenteCatasto) return;
        sorgenteCatasto.clear();
        poligoni.forEach(function (geometria) {
          sorgenteCatasto.addFeature(new ol.Feature(geometria));
        });
      })
      .catch(function () {
        /* niente contorni: si disegna senza calamita */
      });
  }

  /** Vero quando i lati devono seguire i confini catastali invece di tagliarli. */
  var seguiConfini = true;

  function impostaSeguiConfini(attivo) {
    seguiConfini = !!attivo;
  }

  function segueConfini() {
    return seguiConfini;
  }

  /**
   * Fa aderire i lati del poligono appena disegnato ai confini catastali.
   *
   * Il vertice posato con la calamita sta già sulla linea, ma il lato che lo
   * unisce al successivo taglia la curva: qui, per ogni coppia di vertici che
   * stanno sullo stesso confine, si inseriscono i vertici intermedi della
   * linea catastale. Un lato dritto diventa così il tratto di confine vero,
   * anche se è irregolare.
   *
   * Si tiene la strada più breve fra le due, che è quella che si intendeva
   * seguire; se la strada più breve allunga il lato di oltre tre volte, non si
   * tocca niente: vuol dire che il confine non era quello.
   */
  function aderisciAiConfini(feature) {
    if (!seguiConfini || !feature || !sorgenteCatasto) return false;

    var geometria = feature.getGeometry();
    if (!geometria || geometria.getType() !== 'Polygon') return false;

    var poligoni = sorgenteCatasto.getFeatures();
    if (!poligoni.length) return false;

    var anelli = geometria.getCoordinates();
    var anello = anelli[0];
    var vertici = anello.slice(0, anello.length - 1);
    if (vertici.length < 3) return false;

    var tolleranza = 0.6; // metri: quanto si considera "sopra la linea"
    var aggiunti = 0;
    var risultato = [];

    for (var i = 0; i < vertici.length; i += 1) {
      var A = vertici[i];
      var B = vertici[(i + 1) % vertici.length];
      risultato.push(A);

      if (Math.abs(A[0] - B[0]) < 0.01 && Math.abs(A[1] - B[1]) < 0.01) continue;

      var percorso = trattoLungoIlConfine(poligoni, A, B, tolleranza);
      if (percorso && percorso.length > 2) {
        for (var k = 1; k < percorso.length - 1; k += 1) {
          risultato.push(percorso[k]);
          aggiunti += 1;
        }
      }
    }

    if (!aggiunti) return false;

    risultato.push(risultato[0].slice());
    anelli[0] = risultato;
    geometria.setCoordinates(anelli);
    return true;
  }

  function distanza(p, q) {
    return Math.sqrt(Math.pow(p[0] - q[0], 2) + Math.pow(p[1] - q[1], 2));
  }

  function lunghezza(tratto) {
    var totale = 0;
    for (var i = 1; i < tratto.length; i += 1) totale += distanza(tratto[i - 1], tratto[i]);
    return totale;
  }

  /**
   * Il tratto di confine catastale che unisce due punti, se esiste.
   *
   * I due punti non stanno necessariamente su un vertice del confine: la
   * calamita li appoggia **in mezzo a un segmento**. Si cerca quindi la
   * posizione lungo l'anello proiettando il punto sui segmenti, e da lì si
   * percorre l'anello in un verso o nell'altro.
   */
  function trattoLungoIlConfine(poligoni, A, B, tolleranza) {
    var migliore = null;
    var migliorePunteggio = Infinity;

    poligoni.forEach(function (feature) {
      var geometria = feature.getGeometry();
      if (!geometria) return;

      var anelli = geometria.getType() === 'MultiPolygon'
        ? geometria.getPolygons().reduce(function (tutti, poligono) {
            return tutti.concat(poligono.getLinearRings());
          }, [])
        : geometria.getLinearRings();

      anelli.forEach(function (anello) {
        var punti = anello.getCoordinates();
        var n = punti.length - 1;
        if (n < 3) return;

        var da = proiettaSullAnello(punti, A);
        var a = proiettaSullAnello(punti, B);
        if (!da || !a) return;
        if (da.distanza > tolleranza || a.distanza > tolleranza) return;

        var dritto = distanza(A, B);
        var versi = [percorsoAnello(punti, n, da, a), percorsoAnello(punti, n, a, da)];

        versi.forEach(function (tratto) {
          if (!tratto || tratto.length < 2) return;

          var lungo = lunghezza(tratto);
          if (dritto > 0.5 && lungo > dritto * 3) return; // non è quel confine

          var punteggio = lungo - dritto;
          if (punteggio < migliorePunteggio) {
            migliorePunteggio = punteggio;
            migliore = tratto;
          }
        });
      });
    });

    return migliore;
  }

  /** Punto più vicino sull'anello, con il segmento e la posizione su di esso. */
  function proiettaSullAnello(punti, P) {
    var migliore = null;

    for (var i = 0; i + 1 < punti.length; i += 1) {
      var a = punti[i];
      var b = punti[i + 1];
      var dx = b[0] - a[0];
      var dy = b[1] - a[1];
      var quadro = dx * dx + dy * dy;
      var t = quadro ? ((P[0] - a[0]) * dx + (P[1] - a[1]) * dy) / quadro : 0;
      t = Math.max(0, Math.min(1, t));

      var q = [a[0] + t * dx, a[1] + t * dy];
      var d = distanza(q, P);
      if (!migliore || d < migliore.distanza) {
        migliore = { segmento: i, frazione: t, distanza: d, punto: q };
      }
    }

    return migliore;
  }

  /**
   * Percorso lungo l'anello da un punto all'altro, nel verso in avanti,
   * passando per i vertici intermedi del confine.
   */
  function percorsoAnello(punti, n, da, a) {
    var tratto = [da.punto.slice()];

    // stesso segmento: ci si arriva solo se la posizione avanza
    if (da.segmento === a.segmento) {
      if (a.frazione < da.frazione) return null;
      tratto.push(a.punto.slice());
      return tratto;
    }

    var i = da.segmento;
    var giri = 0;
    while (giri <= n) {
      i = (i + 1) % n;
      tratto.push(punti[i].slice());
      if (i === a.segmento) break;
      giri += 1;
    }

    tratto.push(a.punto.slice());
    return tratto;
  }

  /**
   * Rimette nella sorgente le particelle già lette, perché la calamita le
   * registri di nuovo: l'aggancio impara i contorni quando vengono aggiunti,
   * e riagganciare l'interazione azzera quell'elenco.
   */
  function ripassaAllaCalamita() {
    if (!sorgenteCatasto) return;
    var presenti = sorgenteCatasto.getFeatures();
    if (!presenti.length) return;

    var copia = presenti.slice();
    sorgenteCatasto.clear();
    copia.forEach(function (feature) {
      sorgenteCatasto.addFeature(feature);
    });
  }

  function aggancioCatasto(attivo) {
    if (!map) return;
    var interazione = preparaAggancio();
    var presenti = map.getInteractions().getArray();

    if (attivo) {
      // Sempre in fondo alla pila: le interazioni ricevono i movimenti in
      // ordine, e la calamita deve vederli DOPO lo strumento di disegno,
      // altrimenti è il disegno a consumarli e non si aggancia nulla.
      if (presenti.indexOf(interazione) !== -1) map.removeInteraction(interazione);
      map.addInteraction(interazione);

      // Riagganciarla la scollega dalle particelle che aveva in memoria:
      // senza questo passaggio la calamita resta senza niente su cui far
      // presa, e la modalità «segui i confini» non trova nessuna linea.
      ripassaAllaCalamita();

      caricaContorniAggancio(false);
    } else if (presenti.indexOf(interazione) !== -1) {
      map.removeInteraction(interazione);
    }
  }

  function setModify(enabled) {
    if (modifyInteraction) {
      map.removeInteraction(modifyInteraction);
      modifyInteraction = null;
      detachLive();
    }

    if (!enabled) {
      if (hooks.onToolChange) hooks.onToolChange(null);
      return;
    }

    modifyInteraction = new ol.interaction.Modify({
      source: source,
      style: styles.vertex,
      pixelTolerance: 12
    });

    modifyInteraction.on('modifystart', function (event) {
      var feature = event.features.item(0);
      if (feature) {
        activeFeature = feature;
        feature.set('selected', true);
        attachLive(feature.getGeometry());
        // si annota la forma di partenza: se alla fine è identica, il gesto
        // non è stato un trascinamento ma un tocco sul vertice
        formaAllInizio = JSON.stringify(feature.getGeometry().getCoordinates());
      }
    });

    modifyInteraction.on('modifyend', function (event) {
      detachLive();
      var feature = event.features.item(0);
      if (!feature) return;

      setActiveFeature(feature);

      var formaAllaFine = JSON.stringify(feature.getGeometry().getCoordinates());
      var tocco = formaAllInizio !== null && formaAllaFine === formaAllInizio;
      formaAllInizio = null;

      if (tocco && event.mapBrowserEvent) {
        // tocco secco su un vertice: lo si toglie (se il poligono resta tale)
        var indice = verticeSottoIlClic(
          map.getCoordinateFromPixel(event.mapBrowserEvent.pixel)
        );
        if (indice >= 0 && eliminaVertice(indice)) {
          refreshFeature(feature);
          return;
        }
      }

      refreshFeature(feature);
    });

    map.addInteraction(modifyInteraction);

    // come per il disegno: la calamita deve restare l'ultima
    aggancioCatasto(true);
    if (hooks.onToolChange) hooks.onToolChange('Modify');
  }

  // ------------------------------------------------------------ API pubblica

  /**
   * Attiva uno strumento di disegno, la modifica, oppure disattiva tutto.
   * @param {string|null} tool 'Polygon' | 'Box' | 'Circle' | 'Modify' | null
   */
  /** Quando è stato chiuso l'ultimo disegno (per ignorare quel clic). */
  var ultimaFineDisegno = 0;

  function setTool(tool) {
    // la calamita serve solo mentre si mettono o si spostano vertici
    aggancioCatasto(tool === 'Modify' || tool === 'Polygon' || tool === 'Box' || tool === 'Circle');

    if (tool === 'Modify') {
      removeDrawInteraction();
      setModify(true);
      return;
    }

    if (tool === 'Polygon' || tool === 'Box' || tool === 'Circle') {
      setModify(false);
      startDraw(tool);
      return;
    }

    removeDrawInteraction();
    setModify(false);
  }

  function getTool() {
    if (modifyInteraction) return 'Modify';
    return activeTool;
  }

  /** Aggiunge una feature (tipicamente un appezzamento richiamato dal salvataggio). */
  function addFeature(feature) {
    if (!feature) return;
    if (!feature.get('kind')) feature.set('kind', 'saved');
    source.addFeature(feature);
  }

  function deleteActive() {
    if (!activeFeature) return null;
    var removed = activeFeature;

    detachLive();
    source.removeFeature(removed);
    activeFeature = null;

    if (hooks.onChange) hooks.onChange(null, null);
    return removed;
  }

  function clearFeatures() {
    detachLive();
    activeFeature = null;
    source.clear();
    if (hooks.onChange) hooks.onChange(null, null);
  }

  function removeFeature(feature) {
    if (!feature) return;
    if (feature === activeFeature) activeFeature = null;
    source.removeFeature(feature);
  }

  function count() {
    return source ? source.getFeatures().length : 0;
  }

  /**
   * Inizializza il modulo.
   * @param {ol.Map} olMap
   * @param {ol.source.Vector} vectorSource
   * @param {Object} callbacks { onChange(feature, misure), onToolChange(tool) }
   */
  /**
   * Indice del vertice più vicino al punto cliccato, se è abbastanza vicino
   * perché il clic valga come «tocca il vertice». La soglia è in pixel, così
   * vale allo stesso modo con il dito e con il mouse.
   */
  function verticeSottoIlClic(coordinate) {
    if (!activeFeature || !map) return -1;

    var geometria = activeFeature.getGeometry();
    if (!geometria || geometria.getType() !== 'Polygon') return -1;

    var anello = geometria.getCoordinates()[0];
    var pixel = map.getPixelFromCoordinate(coordinate);
    if (!pixel || !anello) return -1;

    var soglia = 11 * 11;
    var vicino = -1;
    var minima = soglia;

    // l'ultimo punto ripete il primo: non è un vertice a sé
    for (var i = 0; i < anello.length - 1; i += 1) {
      var suo = map.getPixelFromCoordinate(anello[i]);
      if (!suo) continue;
      var distanza = Math.pow(suo[0] - pixel[0], 2) + Math.pow(suo[1] - pixel[1], 2);
      if (distanza < minima) {
        minima = distanza;
        vicino = i;
      }
    }

    return vicino;
  }

  /**
   * Toglie un vertice dal poligono attivo. Il poligono deve restare tale:
   * sotto i tre vertici non si scende.
   */
  function eliminaVertice(indice) {
    if (!activeFeature || indice < 0) return false;

    var geometria = activeFeature.getGeometry();
    if (!geometria || geometria.getType() !== 'Polygon') return false;

    var anelli = geometria.getCoordinates();
    var punti = anelli[0].slice(0, anelli[0].length - 1);
    if (punti.length <= 3) return false;

    punti.splice(indice, 1);
    punti.push(punti[0].slice());
    anelli[0] = punti;
    geometria.setCoordinates(anelli);
    return true;
  }

  function init(olMap, vectorSource, callbacks) {
    map = olMap;
    source = vectorSource;
    hooks = callbacks || {};
    styles = Campagna.map.getStyles();

    // Snap sui vertici esistenti: comodo per appezzamenti confinanti.
    snapInteraction = new ol.interaction.Snap({ source: source, pixelTolerance: 10 });
    map.addInteraction(snapInteraction);

    // Click per selezionare un appezzamento (o per deselezionare).
    // spostandosi, i contorni della nuova zona arrivano in sottofondo
    map.on('moveend', function () {
      if (!getTool()) return;
      caricaContorniAggancio(false);
    });

    map.on('singleclick', function (event) {
      if (getTool()) return; // durante disegno/modifica il click non seleziona
      var hit = map.forEachFeatureAtPixel(
        event.pixel,
        function (feature) {
          return feature;
        },
        {
          hitTolerance: 6,
          layerFilter: function (layer) {
            return layer === Campagna.map.getVectorLayer();
          }
        }
      );
      setActiveFeature(hit || null);
    });
  }

  return {
    init: init,
    setTool: setTool,
    getTool: getTool,
    ricaricaContorniAggancio: function () {
      caricaContorniAggancio(true);
    },
    segueConfini: segueConfini,
    impostaSeguiConfini: impostaSeguiConfini,
    aderisciAiConfini: aderisciAiConfini,
    eliminaVerticeSotto: function (coordinate) {
      var indice = verticeSottoIlClic(coordinate);
      if (indice < 0) return false;
      var fatto = eliminaVertice(indice);
      if (fatto) refreshFeature(activeFeature);
      return fatto;
    },
    ultimaFineDisegno: function () {
      return ultimaFineDisegno;
    },
    addFeature: addFeature,
    removeFeature: removeFeature,
    getActiveFeature: function () {
      return activeFeature;
    },
    setActiveFeature: setActiveFeature,
    refreshActive: function () {
      return refreshFeature(activeFeature);
    },
    deleteActive: deleteActive,
    clearFeatures: clearFeatures,
    count: count
  };
})();

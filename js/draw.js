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
      removeDrawInteraction();
      refreshFeature(feature);
      if (hooks.onToolChange) hooks.onToolChange(null);
    });

    map.addInteraction(drawInteraction);
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

  function aggancioCatasto(attivo) {
    if (!map) return;
    var interazione = preparaAggancio();
    var presenti = map.getInteractions().getArray();

    if (attivo) {
      if (presenti.indexOf(interazione) === -1) map.addInteraction(interazione);
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

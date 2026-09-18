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
      }
    });

    modifyInteraction.on('modifyend', function (event) {
      detachLive();
      var feature = event.features.item(0);
      if (feature) {
        setActiveFeature(feature);
        refreshFeature(feature);
      }
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
  function init(olMap, vectorSource, callbacks) {
    map = olMap;
    source = vectorSource;
    hooks = callbacks || {};
    styles = Campagna.map.getStyles();

    // Snap sui vertici esistenti: comodo per appezzamenti confinanti.
    snapInteraction = new ol.interaction.Snap({ source: source, pixelTolerance: 10 });
    map.addInteraction(snapInteraction);

    // Click per selezionare un appezzamento (o per deselezionare).
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

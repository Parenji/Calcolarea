/* ==========================================================================
   Campagna AI — mappa di base
   --------------------------------------------------------------------------
   Crea la mappa OpenLayers: sfondo stradale (OpenStreetMap) o satellitare
   (Esri World Imagery + overlay etichette), il livello vettoriale degli
   appezzamenti e i controlli di scala/coordinate.

   Nota sui tile server: entrambi inviano `Access-Control-Allow-Origin: *`,
   quindi impostiamo `crossOrigin: 'anonymous'` per evitare che il canvas
   della mappa venga "sporcato" e possa essere esportato in PNG.
   ========================================================================== */

Campagna.map = (function () {
  'use strict';

  var BASE_NAMES = {
    street: 'Mappa',
    satellite: 'Satellite'
  };

  var SATELLITE_URL =
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
  var LABELS_URL =
    'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';

  var map = null;
  var vectorSource = null;
  var vectorLayer = null;
  var labelsLayer = null;
  var catastoGroup = null;
  var baseLayers = {};
  var currentBase = 'street';
  var labelsWanted = true;
  var styles = null;

  function buildStyles() {
    return {
      /** Appezzamento appena disegnato / attivo. */
      active: new ol.style.Style({
        // azzurro, non verde: il verde si confonde con i fogli catastali
        fill: new ol.style.Fill({ color: 'rgba(41, 128, 185, 0.20)' }),
        stroke: new ol.style.Stroke({ color: '#2b7fb8', width: 2.5 })
      }),
      /** Appezzamento richiamato dal salvataggio locale. */
      saved: new ol.style.Style({
        fill: new ol.style.Fill({ color: 'rgba(230, 126, 34, 0.14)' }),
        stroke: new ol.style.Stroke({ color: '#e67e22', width: 2, lineDash: [7, 5] })
      }),
      /** Appezzamento attualmente selezionato. */
      selected: new ol.style.Style({
        fill: new ol.style.Fill({ color: 'rgba(41, 128, 185, 0.18)' }),
        stroke: new ol.style.Stroke({ color: '#1f6f9e', width: 3.5 })
      }),
      /** Traccia durante il disegno. */
      sketch: new ol.style.Style({
        fill: new ol.style.Fill({ color: 'rgba(41, 128, 185, 0.12)' }),
        stroke: new ol.style.Stroke({ color: '#2b7fb8', width: 2, lineDash: [5, 5] })
      }),
      /** Maniglie dei vertici, mostrate mentre si disegna o si modifica. */
      vertex: new ol.style.Style({
        image: new ol.style.Circle({
          radius: 6,
          fill: new ol.style.Fill({ color: '#ffffff' }),
          stroke: new ol.style.Stroke({ color: '#2b7fb8', width: 2 })
        })
      })
    };
  }

  /** Sotto questo zoom l'etichetta di un appezzamento non si mostra. */
  var ZOOM_ETICHETTA = 15.5;
  /** Lato minimo, in pixel, perché l'etichetta stia dentro l'appezzamento. */
  var LATO_MINIMO_ETICHETTA = 60;

  /**
   * Vero se a questo zoom ha senso scrivere superficie e perimetro.
   *
   * Con molte aree e zoom basso le etichette diventano un intrico: si mostrano
   * solo quando l'appezzamento è abbastanza grande sullo schermo da contenerle.
   * Per l'area di Latera (9,5 ha) la soglia è zoom 15,5, come richiesto.
   */
  function etichettaUtile(geometry) {
    if (!map) return false;

    var vista = map.getView();
    var zoom = vista.getZoom();
    if (zoom == null || zoom < ZOOM_ETICHETTA) return false;

    var risoluzione = vista.getResolution();
    if (!risoluzione) return false;

    var extent = geometry.getExtent();
    if (!isFinite(extent[0])) return false;

    var larghezza = (extent[2] - extent[0]) / risoluzione;
    var altezza = (extent[3] - extent[1]) / risoluzione;
    return Math.min(larghezza, altezza) >= LATO_MINIMO_ETICHETTA;
  }

  /**
   * Etichetta dell'appezzamento, ancorata dentro l'appezzamento: due righe,
   * il **nome** sopra e la **superficie** sotto. Il perimetro non si scrive
   * sulla mappa: non serve a colpo d'occhio e affolla.
   */
  function labelStyle(feature) {
    var superficie = feature.get('measureLabel');
    if (!superficie) return null;

    var nome = feature.get('name');
    var text = nome ? nome + '\n' + superficie : superficie;

    var geometry = feature.getGeometry();
    if (!geometry) return null;

    if (!etichettaUtile(geometry)) return null;

    var point = Campagna.measure.anchorPoint(geometry);
    if (!point) return null;

    return new ol.style.Style({
      geometry: point,
      zIndex: 500,
      text: new ol.style.Text({
        text: text,
        font: '600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fill: new ol.style.Fill({ color: '#12261a' }),
        stroke: new ol.style.Stroke({ color: 'rgba(255,255,255,0.92)', width: 4 }),
        overflow: true,
        textAlign: 'center',
        textBaseline: 'middle',
        lineHeight: 1.25
      })
    });
  }

  function styleFunction(feature) {
    if (feature.get('kind') === 'vertex') return styles.vertex;

    var result = [];
    if (feature.get('selected')) {
      result.push(styles.selected);
    } else if (feature.get('kind') === 'saved') {
      result.push(styles.saved);
    } else {
      result.push(styles.active);
    }

    var label = labelStyle(feature);
    if (label) result.push(label);

    return result;
  }

  function createBaseLayers() {
    var osm = new ol.layer.Tile({
      properties: { key: 'street', title: 'Mappa' },
      visible: true,
      source: new ol.source.OSM({
        crossOrigin: 'anonymous',
        attributions: Campagna.config.attributions.osm
      })
    });

    var satellite = new ol.layer.Tile({
      properties: { key: 'satellite', title: 'Satellite' },
      visible: false,
      source: new ol.source.XYZ({
        url: SATELLITE_URL,
        maxZoom: 19,
        crossOrigin: 'anonymous',
        attributions: Campagna.config.attributions.esri
      })
    });

    labelsLayer = new ol.layer.Tile({
      visible: false,
      source: new ol.source.XYZ({
        url: LABELS_URL,
        maxZoom: 19,
        crossOrigin: 'anonymous'
      })
    });

    baseLayers.street = osm;
    baseLayers.satellite = satellite;
    return [osm, satellite];
  }

  function updateLabelsVisibility() {
    if (!labelsLayer) return;
    labelsLayer.setVisible(labelsWanted && currentBase === 'satellite');
  }

  function setBase(key) {
    if (!baseLayers[key]) return;
    currentBase = key;
    baseLayers.street.setVisible(key === 'street');
    baseLayers.satellite.setVisible(key === 'satellite');
    updateLabelsVisibility();
    if (aggiornaBaseControl) aggiornaBaseControl();
  }

  function setLabelsVisible(visible) {
    labelsWanted = !!visible;
    updateLabelsVisibility();
    if (aggiornaBaseControl) aggiornaBaseControl();
  }

  /**
   * Indicatore sempre visibile di zoom e scala correnti.
   *
   * Ogni livello catastale si accende solo entro un certo intervallo di scala:
   * senza un riferimento numerico sotto gli occhi l'utente vede "niente" e non
   * ha modo di distinguere un catasto fuori scala da un catasto che non
   * funziona. Sta sulla mappa, non nel pannello, perché il pannello può
   * richiedere di scorrere.
   */
  function createZoomReadout() {
    var el = document.createElement('div');
    el.className = 'ol-zoom-readout';

    var ultimo = null;

    function aggiorna() {
      var view = map.getView();
      var zoom = view.getZoom();
      var resolution = view.getResolution();
      if (zoom == null || !isFinite(zoom) || !isFinite(resolution)) return;

      // Stessa convenzione della barra di scala: 1 px = 0,0002645833 m (96 dpi).
      var scala = Math.round(resolution / 0.0002645833);
      var testo =
        'zoom ' +
        (Math.round(zoom * 10) / 10).toLocaleString('it-IT') +
        ' · 1:' +
        scala.toLocaleString('it-IT');

      if (testo !== ultimo) {
        el.textContent = testo;
        ultimo = testo;
      }
    }

    map.getView().on('change:resolution', aggiorna);
    map.on('moveend', aggiorna);
    aggiorna();

    return new ol.control.Control({ element: el });
  }

  /**
   * Comandi di visualizzazione, sulla mappa: sfondo (mappa o satellite) ed
   * etichette dei luoghi. Stanno qui e non nel pannello laterale perché si
   * usano guardando la mappa, e il pannello è lungo da scorrere.
   */
  function createBaseControl() {
    var el = document.createElement('div');
    el.className = 'ol-base-switch';

    var gruppoSfondo = document.createElement('div');
    gruppoSfondo.className = 'ol-base-group';

    var voci = [
      { chiave: 'street', testo: 'Mappa' },
      { chiave: 'satellite', testo: 'Satellite' }
    ];

    voci.forEach(function (voce) {
      var bottone = document.createElement('button');
      bottone.type = 'button';
      bottone.textContent = voce.testo;
      bottone.setAttribute('data-base', voce.chiave);
      bottone.addEventListener('click', function () {
        setBase(voce.chiave);
      });
      gruppoSfondo.appendChild(bottone);
    });

    var etichette = document.createElement('label');
    etichette.className = 'ol-base-labels';

    var casella = document.createElement('input');
    casella.type = 'checkbox';
    casella.checked = labelsWanted;
    casella.addEventListener('change', function () {
      setLabelsVisible(casella.checked);
    });

    var testo = document.createElement('span');
    testo.textContent = 'Etichette';

    etichette.appendChild(casella);
    etichette.appendChild(testo);

    // Qui sotto vanno anche i comandi del catasto, con la stessa grafica.
    var catastoBox = document.createElement('div');
    catastoBox.className = 'ol-catasto-controls';
    catastoBox.id = 'catasto-controls';

    el.appendChild(gruppoSfondo);
    el.appendChild(etichette);
    el.appendChild(catastoBox);

    function aggiorna() {
      Array.prototype.forEach.call(el.querySelectorAll('[data-base]'), function (bottone) {
        bottone.classList.toggle('attivo', bottone.getAttribute('data-base') === currentBase);
      });
      casella.checked = labelsWanted;
    }

    aggiorna();

    return {
      control: new ol.control.Control({ element: el }),
      aggiorna: aggiorna
    };
  }

  var aggiornaBaseControl = null;

  function createControls() {
    var scaleLine = new ol.control.ScaleLine({
      units: 'metric',
      bar: false,
      steps: 2,
      text: true,
      minWidth: 90
    });

    var mousePosition = new ol.control.MousePosition({
      projection: 'EPSG:4326',
      placeholder: '',
      className: 'ol-mouse-position',
      coordinateFormat: function (coord) {
        if (!coord || !isFinite(coord[0]) || !isFinite(coord[1])) return '';
        return coord[1].toFixed(5) + '°, ' + coord[0].toFixed(5) + '°';
      }
    });

    var baseControl = createBaseControl();
    aggiornaBaseControl = baseControl.aggiorna;

    return [scaleLine, mousePosition, createZoomReadout(), baseControl.control];
  }

  /**
   * Crea la mappa e vi aggancia l'overlay catastale.
   *
   * @param {string} targetId id dell'elemento che ospita la mappa
   * @param {Object} options  { catastoContainer, catastoNote }
   * @returns {ol.Map}
   */
  function init(targetId, options) {
    options = options || {};
    styles = buildStyles();

    var base = createBaseLayers();

    vectorSource = new ol.source.Vector();
    vectorLayer = new ol.layer.Vector({
      source: vectorSource,
      style: styleFunction,
      zIndex: 100,
      updateWhileAnimating: true,
      updateWhileInteracting: true
    });

    catastoGroup = new ol.layer.Group({ properties: { title: 'Catasto' } });

    map = new ol.Map({
      target: targetId,
      layers: base.concat([labelsLayer, catastoGroup, vectorLayer]),
      view: new ol.View({
        center: ol.proj.fromLonLat(Campagna.config.view.center),
        zoom: Campagna.config.view.zoom,
        minZoom: 3,
        maxZoom: 21
      })
    });

    createControls().forEach(function (control) {
      map.addControl(control);
    });

    // I layer catastali vanno creati dopo la mappa, così `catasto` può
    // consultarne la risoluzione per l'avviso di scala; vengono inseriti
    // nel gruppo dedicato, sotto al livello vettoriale degli appezzamenti.
    // I controlli del catasto stanno sulla mappa, dentro il gruppo creato qui
    // sopra: si cercano adesso, non prima, altrimenti non esistono ancora.
    var catastoLayers = Campagna.catasto.init(
      map,
      options.catastoContainer || document.getElementById('catasto-controls') || null,
      options.catastoNote || null
    );
    catastoGroup.getLayers().extend(catastoLayers);

    map.on('moveend', function () {
      Campagna.catasto.updateResolution();
    });

    // Anche la dimensione della mappa conta: la GetMap non può superare 2048 px,
    // quindi su una mappa più larga serve uno zoom maggiore per raggiungere la
    // stessa scala. Le soglie vanno ricalcolate anche quando cambia la finestra.
    map.on('change:size', function () {
      Campagna.catasto.updateResolution();
    });

    updateLabelsVisibility();
    return map;
  }

  /** Porta la vista sull'appezzamento indicato. */
  function zoomToFeature(feature) {
    if (!map || !feature) return;
    var geometry = feature.getGeometry();
    if (!geometry) return;

    var extent = geometry.getExtent();
    if (!extent || !isFinite(extent[0]) || extent[0] === extent[2]) return;

    map.getView().fit(extent, {
      padding: [90, 90, 90, 90],
      maxZoom: 19,
      duration: 450
    });
  }

  /** Imposta il testo dell'etichetta (superficie · perimetro) sulla feature. */
  function setMeasureLabel(feature, text) {
    if (!feature) return;
    feature.set('measureLabel', text || null);
  }

  return {
    init: init,
    getMap: function () {
      return map;
    },
    getVectorSource: function () {
      return vectorSource;
    },
    getVectorLayer: function () {
      return vectorLayer;
    },
    getCatastoGroup: function () {
      return catastoGroup;
    },
    getLabelsLayer: function () {
      return labelsLayer;
    },
    getStyles: function () {
      return styles;
    },
    setBase: setBase,
    getBase: function () {
      return currentBase;
    },
    getBaseName: function () {
      return BASE_NAMES[currentBase] || currentBase;
    },
    setLabelsVisible: setLabelsVisible,
    zoomToFeature: zoomToFeature,
    setMeasureLabel: setMeasureLabel
  };
})();

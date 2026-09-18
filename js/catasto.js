/* ==========================================================================
   Campagna AI — overlay della cartografia catastale (Agenzia delle Entrate)
   --------------------------------------------------------------------------
   Servizio: WMS "Cartografia Catastale" (INSPIRE View Service)
   Licenza:  CC BY 4.0 — dato pubblico, attribuzione obbligatoria

   Quattro vincoli del servizio, tutti verificati sul campo, determinano
   l'implementazione:

   1. NON supporta EPSG:3857 (la proiezione della mappa). Si usa quindi la sua
      proiezione nativa EPSG:4258 e si lascia che OpenLayers riproietti le
      immagini; EPSG:4258 viene registrato a runtime perché non è noto a OL.

   2. NON invia header CORS. La richiesta passa quindi dal nostro dominio
      (/catasto/*): in produzione via rewrite di Vercel, in sviluppo via
      scripts/dev-proxy.js. Essendo same-origin, il canvas della mappa non
      viene "sporcato" e le linee catastali compaiono nell'immagine esportata.

   3. NON accetta immagini più grandi di 2048x2048 px: risponde con una
      ServiceException XML (`InvalidFormat`) e OpenLayers, che si aspettava un
      PNG, non disegna NULLA — senza alcun errore visibile all'utente.

   4. Disegna ogni livello solo entro un intervallo di scala stretto: i contorni
      delle particelle da ~1,6e-5 gradi per pixel (circa 1:5.000), i loro numeri
      da ~6e-6. Una immagine grande quanto la vista e troppo grossolana per
      quelle scale.

   I punti 3 e 4 si risolvono chiedendo la stessa area **a più pixel**: il BBOX
   resta quello della vista, ma l'immagine viene richiesta alla scala fine che
   serve al servizio. La richiesta resta cosi entro i 2048 px del limite e le
   particelle compaiono da **zoom 17** invece che da zoom 19. Si usa **una sola immagine per vista**, non tessere: una carta che
   si compone a pezzi e molto piu fastidiosa da guardare di una che compare
   tutta insieme, e la scala raggiungibile con una immagine sola basta.

   Inoltre si usa deliberatamente WMS 1.1.1: in 1.3.0 il servizio interpreta il
   BBOX in ordine lat,lon, mentre in 1.1.1 il BBOX è sempre lon,lat (nessuno
   scambio di assi). Scelta deterministica e indipendente dall'ordine degli assi.
   ========================================================================== */

Campagna.catasto = (function () {
  'use strict';

  var DEFS = [
    {
      key: 'particelle',
      // Contorni e numeri viaggiano nella stessa richiesta, quindi si vedono
      // sempre insieme: il servizio però scrive i numeri solo a una scala molto
      // più fine di quella dei contorni (misurato: 6,0e-6 gradi/px per i
      // numeri, 1,6e-5 per i soli contorni), e la richiesta va tarata sulla più
      // fine delle due. Chiedere i contorni da soli li farebbe comparire prima,
      // ma senza numeri: qui si preferisce che non si vedano mai separati.
      layername: 'CP.CadastralParcel',
      title: 'Particelle catastali',
      short: 'Particelle',
      hint:
        'Contorni e numeri delle particelle, sempre insieme. Da zoom 15 in su.',
      enabled: true,
      minZoom: 15,
      risoluzioneLimite: 1.6e-5,
      // Il servizio riempie le particelle di beige (253, 236, 189): è una
      // campitura del disegno, non un fondo voluto, e coprirebbe lo sfondo
      // dell'app rendendo inutile il suo comando di opacità. Si toglie qui.
      fondoDaTogliere: [253, 236, 189]
    },
    {
      key: 'fogli',
      layername: 'CP.CadastralZoning',
      title: 'Fogli / zone censuarie',
      short: 'Fogli',
      hint: 'Suddivisione in fogli di mappa.',
      enabled: true,
      // Prima di zoom 13 i fogli sono solo un intrico di linee verdi: si
      // mostrano da 13 in su (e con loro compare anche lo sfondo chiaro).
      minZoom: 13,
      risoluzioneLimite: 5.0e-4
    },
    {
      key: 'fabbricati',
      layername: 'fabbricati',
      title: 'Fabbricati',
      short: 'Fabbricati',
      hint: 'Sagome degli edifici.',
      enabled: false,
      minZoom: 16,
      risoluzioneLimite: 1.6e-5
    },
    {
      key: 'viabilita',
      // NB: il layer di gruppo `Cartografia_Catastale` NON è utilizzabile come
      // overlay: qualunque BBOX si chieda, il servizio restituisce sempre la
      // stessa immagine fissa dell'Italia con le sigle delle province. Si
      // chiedono quindi i due livelli geografici che lo compongono.
      layername: 'strade,acque',
      title: 'Strade e acque',
      short: 'Strade e acque',
      hint: 'Viabilità e acque.',
      enabled: false,
      minZoom: 12,
      risoluzioneLimite: 1.2e-4
    }
  ];

  /**
   * Lato massimo accettato dal servizio catastale, in pixel.
   * Oltre questo valore risponde con una ServiceException XML e OpenLayers non
   * disegna nulla: va quindi rispettato lato client.
   */
  var MAX_WMS_PX = 2048;

  /** Margine di sicurezza sul calcolo della risoluzione da chiedere. */
  var MARGINE_SCALA = 1.15;

  /**
   * In OpenLayers `minZoom` è **esclusivo** (`zoom > minZoom`, verificato in
   * `ol/layer/Layer.js`): un layer con `minZoom: 17` resterebbe invisibile
   * proprio a zoom 17, cioè dove l'app dice di andare. Si scavalca quindi la
   * soglia di un margine trascurabile per l'utente, così "da zoom 17" significa
   * davvero "anche a zoom 17".
   */
  var MARGINE_MIN_ZOOM = 0.01;

  var layers = {};
  var defsByKey = {};
  var map = null;
  var zoomNoteEl = null;

  /** Errori di caricamento per layer (immagine non valida dal servizio). */
  var errori = {};

  /**
   * Indica se l'inoltro `/catasto/*` è disponibile.
   * Se non lo è (tipico quando si apre il progetto con un server statico come
   * Live Server di VS Code) si ripiega sull'URL diretto del servizio: il
   * catasto resta visibile, ma non potrà entrare nell'immagine esportata.
   */
  var proxyAvailable = true;

  DEFS.forEach(function (def) {
    defsByKey[def.key] = def;
  });

  /**
   * EPSG:4258 (ETRS89) non è conosciuto da OpenLayers di default: va registrato,
   * altrimenti la riproiezione da/verso EPSG:3857 non è possibile.
   *
   * Due accorgimenti necessari, entrambi verificati con un test in browser:
   *
   * 1. OpenLayers non concatena le trasformazioni: dichiarare EPSG:4258
   *    equivalente a EPSG:4326 NON basta a ottenere una trasformazione verso
   *    EPSG:3857 (la proiezione della vista). Serve registrarne una esplicita,
   *    riutilizzando quelle di EPSG:4326, che è lo stesso datum in gradi.
   *
   * 2. Si adotta `axisOrientation: 'neu'`, la stessa che OpenLayers usa per
   *    EPSG:4326, così le due proiezioni restano davvero equivalenti.
   *    L'ordine degli assi non incide comunque sulla GetMap: con WMS 1.1.1
   *    OpenLayers non scambia il BBOX (lo farebbe solo con versioni >= 1.3).
   */
  function registerProjection() {
    var code = Campagna.config.catasto.serverProjection;
    if (ol.proj.get(code)) return;

    ol.proj.addProjection(
      new ol.proj.Projection({
        code: code,
        units: 'degrees',
        axisOrientation: 'neu',
        extent: [-180, -90, 180, 90],
        global: true
      })
    );

    ol.proj.addEquivalentProjections([ol.proj.get('EPSG:4326'), ol.proj.get(code)]);

    var toMercator = ol.proj.getTransform('EPSG:4326', 'EPSG:3857');
    var fromMercator = ol.proj.getTransform('EPSG:3857', 'EPSG:4326');

    if (toMercator && fromMercator) {
      ol.proj.addCoordinateTransforms(code, 'EPSG:3857', toMercator, fromMercator);
    } else {
      console.error('[catasto] trasformazioni EPSG:4326 <-> EPSG:3857 non disponibili');
    }
  }

  /**
   * Sorgente WMS "ricomposta".
   *
   * Il servizio accetta immagini di al massimo 2048 px e disegna i vari livelli
   * solo a scale precise: a zoom 15 servirebbe una immagine larga 2,7 volte la
   * vista, cioè più di 2048 px. Si chiede quindi **più immagini**, ognuna entro
   * il limite, che coprono ciascuna un pezzetto di vista; OpenLayers le
   * ricompone poi in un canvas solo, quindi all'utente la carta compare
   * *tutta insieme*, non a pezzi come con le tessere.
   *
   * Le immagini sono tenute in cache per area: spostando la mappa si riusano
   * quelle già scaricate.
   */
  /** Un pezzo di carta: la sua immagine e il riquadro che copre (in gradi). */
  var pezzi = {};
  var ordinePezzi = [];
  /** Quanti pezzi tenere in memoria (sono immagini di carta: pesano qualche MB). */
  var MAX_PEZZI = 24;

  function chiavePezzo(def, riquadro) {
    return (
      def.key + '|' + riquadro[0].toFixed(4) + ',' + riquadro[1].toFixed(4) + ',' +
      riquadro[2].toFixed(4) + ',' + riquadro[3].toFixed(4)
    );
  }

  function ricordaPezzo(chiave) {
    ordinePezzi.push(chiave);
    while (ordinePezzi.length > MAX_PEZZI) {
      var vecchio = ordinePezzi.shift();
      if (vecchio !== chiave) delete pezzi[vecchio];
    }
  }

  /**
   * Passo della griglia, in gradi per pixel: la scala che serve al layer, mai
   * più fine di quella della vista (sarebbe banda sprecata).
   */
  function passoPezzi(def) {
    var limite = def.risoluzioneLimite ? def.risoluzioneLimite / MARGINE_SCALA : Infinity;
    var dellaVista = map ? map.getView().getResolution() / 111319.4908 : limite;
    return Math.min(limite, dellaVista);
  }

  function urlPezzo(def, riquadro, passo) {
    var params = {
      SERVICE: 'WMS',
      VERSION: Campagna.config.catasto.version,
      REQUEST: 'GetMap',
      LAYERS: def.layername,
      STYLES: '',
      FORMAT: 'image/png',
      // sempre trasparente: lo sfondo è un layer a parte, dell'app
      TRANSPARENT: true,
      SRS: Campagna.config.catasto.serverProjection,
      WIDTH: Math.min(MAX_WMS_PX, Math.max(1, Math.round((riquadro[2] - riquadro[0]) / passo))),
      HEIGHT: Math.min(MAX_WMS_PX, Math.max(1, Math.round((riquadro[3] - riquadro[1]) / passo))),
      BBOX: riquadro.join(',')
    };

    return (
      Campagna.config.catasto.url +
      '?' +
      Object.keys(params)
        .map(function (chiave) {
          return chiave + '=' + encodeURIComponent(params[chiave]);
        })
        .join('&')
    );
  }

  /**
   * Divide la vista nei pezzi che servono a coprirla alla scala richiesta.
   *
   * Ogni pezzo resta entro i 2048 px del servizio, e il numero di pezzi è il
   * minimo possibile: a zoom 15 sono 4, da zoom 16 in su uno solo. Il canvas li
   * ricompone in una immagine sola, quindi la carta compare tutta insieme.
   */
  function pezziDellaVista(def, extent, passo) {
    var nx = Math.max(1, Math.ceil((extent[2] - extent[0]) / passo / MAX_WMS_PX));
    var ny = Math.max(1, Math.ceil((extent[3] - extent[1]) / passo / MAX_WMS_PX));
    var elenco = [];
    var dx = (extent[2] - extent[0]) / nx;
    var dy = (extent[3] - extent[1]) / ny;

    for (var iy = 0; iy < ny; iy += 1) {
      for (var ix = 0; ix < nx; ix += 1) {
        elenco.push([
          extent[0] + ix * dx,
          extent[1] + iy * dy,
          extent[0] + (ix + 1) * dx,
          extent[1] + (iy + 1) * dy
        ]);
      }
    }
    return elenco;
  }

  /**
   * Toglie la campitura del servizio da un'immagine appena scaricata.
   *
   * Il servizio disegna le particelle riempite di beige (253, 236, 189): su un
   * fondo nostro quella campitura coprirebbe tutto e il comando di opacita'
   * dello sfondo non avrebbe alcun effetto. Si rende quindi trasparente il solo
   * colore della campitura.
   *
   * Le soglie sono strette apposta: la campitura e' una tinta esatta, mentre i
   * pixel sul bordo delle linee sono miscele linea+campitura. Con una soglia
   * larga sparirebbero anche quelle e a zoom alti — dove le linee sono spesse
   * un pixel — i contorni si sbiadirebbero fino a non vedersi piu'.
   * Misurato: la campitura scende da 98% a 0% e i pixel scuri delle linee
   * restano tutti (5390 su 5390).
   *
   * @param {HTMLImageElement} immagine immagine appena caricata
   * @param {Array<number>} colore tinta della campitura, [r, g, b]
   * @returns {HTMLCanvasElement|HTMLImageElement} immagine senza campitura
   */
  function togliFondo(immagine, colore) {
    var canvas = document.createElement('canvas');
    canvas.width = immagine.naturalWidth;
    canvas.height = immagine.naturalHeight;

    var ctx = canvas.getContext('2d');
    ctx.drawImage(immagine, 0, 0);

    var dati;
    try {
      dati = ctx.getImageData(0, 0, canvas.width, canvas.height);
    } catch (err) {
      // canvas "sporco" (immagini cross-origin, senza inoltro): resta com'e'
      return canvas;
    }

    var px = dati.data;
    var VICINO = 6;
    var LONTANO = 12;
    var intervallo = LONTANO - VICINO;

    for (var i = 0; i < px.length; i += 4) {
      if (px[i + 3] === 0) continue;
      var d = Math.max(
        Math.abs(px[i] - colore[0]),
        Math.abs(px[i + 1] - colore[1]),
        Math.abs(px[i + 2] - colore[2])
      );
      if (d <= VICINO) {
        px[i + 3] = 0;
      } else if (d < LONTANO) {
        px[i + 3] = Math.round((px[i + 3] * (d - VICINO)) / intervallo);
      }
    }

    ctx.putImageData(dati, 0, 0);
    return canvas;
  }

  /**
   * Chiede subito i pezzi che mancano per la vista corrente, senza l'attesa
   * del cambio di vista, e restituisce una promessa che si risolve quando sono
   * tutti arrivati. Serve all'esportazione: senza aspettare, l'immagine può
   * essere composta prima che i pezzi siano scaricati e uscire senza catasto.
   */
  function caricaPezziOra() {
    if (!map) return Promise.resolve();

    var attese = [];
    DEFS.forEach(function (def) {
      var layer = layers[def.key];
      var source = layer && layer.getSource();
      if (!source || !inScala(def)) return;
      attese.push(caricaPezzi(def, source, def.crossOrigin || null));
    });

    return Promise.all(attese);
  }

  /** Chiede i pezzi che mancano per la vista corrente. */
  function caricaPezzi(def, source, crossOrigin) {
    if (!map) return;
    var vista = map.getView();
    var passo = passoPezzi(def);
    if (!isFinite(passo) || passo <= 0) return;

    var extent = ol.proj.transformExtent(
      vista.calculateExtent(map.getSize()),
      'EPSG:3857',
      Campagna.config.catasto.serverProjection
    );

    var attese = [];

    pezziDellaVista(def, extent, passo).forEach(function (riquadro) {
      var chiave = chiavePezzo(def, riquadro);
      if (pezzi[chiave]) return;

      pezzi[chiave] = { inCorso: true };

      var immagine = new Image();
      if (crossOrigin) immagine.crossOrigin = crossOrigin;

      attese.push(
        new Promise(function (risolvi) {
          immagine.onload = function () {
            var pronta = def.fondoDaTogliere
              ? togliFondo(immagine, def.fondoDaTogliere)
              : immagine;
            pezzi[chiave] = { riquadro: riquadro, immagine: pronta, passo: passo };
            ricordaPezzo(chiave);
            if (errori[def.key]) {
              errori[def.key] = 0;
              updateZoomNote();
            }
            source.changed();
            risolvi();
          };

          immagine.onerror = function () {
            delete pezzi[chiave];
            errori[def.key] = (errori[def.key] || 0) + 1;
            updateZoomNote();
            risolvi();
          };

          immagine.src = urlPezzo(def, riquadro, passo);
        })
      );
    });

    return Promise.all(attese);
  }

  /**
   * Crea la sorgente di un layer catastale: canvas unico composto dai pezzi.
   */
  function createImageSource(def, crossOrigin) {
    var source = new ol.source.ImageCanvas({
      projection: Campagna.config.catasto.serverProjection,
      attributions: Campagna.config.attributions.catasto,
      canvasFunction: function (extent, resolution, pixelRatio, size) {
        var canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(size[0]));
        canvas.height = Math.max(1, Math.round(size[1]));

        var ctx = canvas.getContext('2d');
        var passoX = (extent[2] - extent[0]) / canvas.width;
        var passoY = (extent[3] - extent[1]) / canvas.height;

        // Si disegnano solo i pezzi della scala corrente: quelli rimasti in
        // cache da una zoomata precedente hanno un'altra scala, e
        // sovrapponendoli si vedrebbero le stesse etichette due volte, una più
        // grande e una più piccola.
        var passoOra = passoPezzi(def);

        Object.keys(pezzi).forEach(function (chiave) {
          var pezzo = pezzi[chiave];
          if (!pezzo || !pezzo.immagine) return;
          if (passoOra > 0 && Math.abs(pezzo.passo - passoOra) > passoOra * 0.02) return;

          var x = (pezzo.riquadro[0] - extent[0]) / passoX;
          var y = (extent[3] - pezzo.riquadro[3]) / passoY;
          var w = (pezzo.riquadro[2] - pezzo.riquadro[0]) / passoX;
          var h = (pezzo.riquadro[3] - pezzo.riquadro[1]) / passoY;
          if (x > canvas.width || y > canvas.height || x + w < 0 || y + h < 0) return;

          try {
            ctx.drawImage(pezzo.immagine, x, y, w, h);
          } catch (err) {
            // immagine non disegnabile: si salta il pezzo
          }
        });

        return canvas;
      }
    });

    return source;
  }

  function createLayer(def) {
    def.crossOrigin = 'anonymous';
    var source = createImageSource(def, def.crossOrigin);
    return new ol.layer.Image({
      visible: def.enabled,
      // Applicate davvero, non solo annunciate: fuori da questo intervallo di
      // zoom OpenLayers non chiede nemmeno le immagini al servizio (che
      // risponderebbe comunque a vuoto, o con un errore).
      minZoom: def.minZoom == null ? undefined : def.minZoom - MARGINE_MIN_ZOOM,
      maxZoom: def.maxZoom,
      properties: { catastoKey: def.key, title: def.title },
      source: source
    });
  }

  /**
   * I numeri delle particelle si disegnano nell'app (vedi js/numeri.js) e
   * devono comparire e sparire insieme ai contorni: qui si dice al modulo dei
   * numeri se le particelle sono accese e con quale opacità.
   */
  function aggiornaNumeri() {
    if (!Campagna.numeri) return;
    var def = defsByKey.particelle;
    Campagna.numeri.aggiorna(!!def && inScala(def), 1);
  }

  /**
   * Applica a ogni layer lo zoom minimo: le soglie dichiarate nei DEFS.
   */
  function aggiornaSoglie() {
    DEFS.forEach(function (def) {
      var layer = layers[def.key];
      if (!layer) return;
      var minimo = zoomMinimoEffettivo(def);
      if (layer.getMinZoom() !== minimo - MARGINE_MIN_ZOOM) {
        layer.setMinZoom(minimo - MARGINE_MIN_ZOOM);
      }
    });
  }

  /**
   * Allinea i pezzi di tutti i layer alla vista corrente. Va chiamata a ogni
   * cambio di vista: i pezzi mancanti vengono chiesti, quelli già scaricati
   * riusati, e la sorgente ridisegnata.
   */
  var attesaPezzi = null;

  function aggiornaPezzi() {
    if (!map) return;
    // Si aspetta che la vista si sia fermata: durante una zoomata le viste
    // intermedie chiederebbero immagini che non servono piu.
    clearTimeout(attesaPezzi);
    attesaPezzi = setTimeout(function () {
      DEFS.forEach(function (def) {
        var layer = layers[def.key];
        var source = layer && layer.getSource();
        if (!source || !inScala(def)) return;
        caricaPezzi(def, source, def.crossOrigin || null);
      });
    }, 250);
  }

  /**
   * Sfondo monocolore unico, sotto tutti i layer catastali.
   *
   * Il servizio sa disegnare i layer su fondo pieno (`TRANSPARENT=false`), ma
   * il fondo resterebbe impastato con le linee: abbassando l'opacità del layer
   * sbiadirebbero anche i contorni e i numeri. Lo sfondo è quindi un layer a
   * parte, dell'app: un rettangolo chiaro con **un solo** comando di opacità,
   * mentre linee e numeri restano sempre pieni.
   */
  function createSfondo() {
    var layer = new ol.layer.Image({
      visible: false,
      properties: { catastoKey: '__sfondo', title: 'Sfondo catasto' },
      source: new ol.source.ImageCanvas({
        canvasFunction: function (extent, resolution, pixelRatio, size) {
          var canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(size[0]));
          canvas.height = Math.max(1, Math.round(size[1]));
          var ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          return canvas;
        }
      })
    });
    return layer;
  }

  /** Opacità dello sfondo, in percentuale (0 = nessuno sfondo). */
  var sfondoOpacita = 30;

  /**
   * Zoom minimo a cui un layer è disegnabile: è la soglia dichiarata nel layer.
   * Con la ricomposizione il numero di immagini necessarie non dipende più
   * dalla larghezza della mappa, quindi non serve ricalcolarla.
   */
  function zoomMinimoEffettivo(def) {
    return def.minZoom == null ? 0 : def.minZoom;
  }

  /**
   * Accende lo sfondo quando c'è davvero qualcosa di catastale da guardare.
   */
  function aggiornaSfondo() {
    var layer = layers.__sfondo;
    if (!layer) return;
    var qualcosa = DEFS.some(function (def) {
      return inScala(def);
    });
    layer.setOpacity(sfondoOpacita / 100);
    layer.setVisible(qualcosa && sfondoOpacita > 0);
  }

  /** Applica coerenza tra stato "attivo" e opacità. */
  function refresh(def) {
    var layer = layers[def.key];
    if (!layer) return;
    // linee e numeri sempre pieni: l'opacità è solo dello sfondo
    layer.setOpacity(1);
    layer.setVisible(!!def.enabled);
  }

  function setEnabled(key, enabled) {
    var def = defsByKey[key];
    if (!def) return;
    def.enabled = !!enabled;
    refresh(def);
    aggiornaSfondo();
    aggiornaNumeri();
    updateZoomNote();
  }

  /** Imposta l'opacità dello sfondo catastale (0-1). */
  function setOpacity(valore) {
    sfondoOpacita = Math.max(0, Math.min(100, Math.round(valore * 100)));
    aggiornaSfondo();
  }

  /** Vero se il layer sta effettivamente disegnando a questo zoom. */
  function inScala(def) {
    if (!def.enabled) return false;
    var zoom = map ? map.getView().getZoom() : null;
    if (zoom == null) return false;
    if (zoom < zoomMinimoEffettivo(def)) return false;
    if (def.maxZoom != null && zoom > def.maxZoom) return false;
    return true;
  }

  /**
   * Mostra o nasconde temporaneamente tutti i layer catastali.
   *
   * Serve durante l'esportazione quando l'inoltro `/catasto` non è disponibile:
   * in quel caso le immagini WMS sono cross-origin e senza header CORS, quindi
   * "sporcherebbero" il canvas impedendo di generare il PNG.
   */
  function setVisible(visible) {
    DEFS.forEach(function (def) {
      var layer = layers[def.key];
      if (layer) layer.setVisible(!!visible && !!def.enabled);
    });
    // i numeri seguono le particelle: se il catasto esce dall'esportazione
    // (inoltro non disponibile) non devono restare da soli
    if (!visible && Campagna.numeri) Campagna.numeri.aggiorna(false, 1);
  }

  /**
   * Zoom e scala approssimata della vista corrente.
   *
   * La scala si ricava dalla risoluzione (metri per pixel) assumendo la
   * convenzione di 96 dpi: 1 px = 0,0002645833 m. È lo stesso calcolo che usa
   * la barra di scala di OpenLayers, quindi i due valori concordano.
   */
  function vistaCorrente() {
    if (!map) return null;
    var view = map.getView();
    var zoom = view.getZoom();
    var resolution = view.getResolution();
    if (zoom == null || !isFinite(zoom) || !isFinite(resolution)) return null;
    return { zoom: zoom, scala: Math.round(resolution / 0.0002645833) };
  }

  function numeroIt(valore) {
    return valore.toLocaleString('it-IT');
  }

  /** Porta la vista allo zoom indicato, mantenendo il centro attuale. */
  function vaiAZoom(zoom) {
    if (!map) return;
    map.getView().animate({ zoom: zoom, duration: 450 });
  }

  /**
   * Aggiorna il blocco informativo del catasto. Mostra sempre zoom e scala
   * correnti, poi — se serve — gli avvisi e un pulsante che porta la vista
   * allo zoom in cui il layer attivo diventa visibile.
   *
   * Serve perché il servizio disegna ogni livello solo entro certi rapporti di
   * scala: senza un riferimento numerico l'utente vede semplicemente "niente"
   * e non ha modo di sapere se il catasto è rotto o solo fuori scala.
   */
  function updateZoomNote() {
    if (!zoomNoteEl) return;

    zoomNoteEl.innerHTML = '';

    var vista = vistaCorrente();
    var info = document.createElement('p');
    info.className = 'catasto-zoom';
    info.textContent = vista
      ? 'Zoom ' + numeroIt(Math.round(vista.zoom * 10) / 10) + ' · scala ≈ 1:' + numeroIt(vista.scala)
      : '';
    zoomNoteEl.appendChild(info);

    var messages = [];

    if (!proxyAvailable) {
      messages.push(
        "Inoltro /catasto non disponibile: la cartografia catastale è visibile, ma non potrà " +
          "essere inclusa nell'immagine esportata. Avvia l'app con «npm run dev» (o su Vercel) " +
          'per abilitarlo.'
      );
    }

    // Layer attivi che il servizio ha rifiutato: senza questo avviso il
    // fallimento sarebbe invisibile (nessuna linea e nessuna spiegazione).
    var inErrore = DEFS.filter(function (def) {
      return !!def.enabled && errori[def.key];
    });
    if (inErrore.length) {
      messages.push(
        'Il servizio catastale non ha restituito un\'immagine valida per ' +
          inErrore
            .map(function (def) {
              return def.title.toLowerCase();
            })
            .join(' e ') +
          '. Riprova fra poco; se persiste, il servizio potrebbe essere momentaneamente ' +
          'non disponibile.'
      );
    }

    var zoom = vista ? vista.zoom : null;
    var active = DEFS.filter(function (def) {
      return !!def.enabled;
    });
    var azione = null;

    if (zoom != null) {
      var daIngrandire = active.filter(function (def) {
        return zoom < zoomMinimoEffettivo(def);
      });
      if (daIngrandire.length) {
        // arrotondato per eccesso al decimo: le soglie dipendono dalla
        // larghezza della mappa e non sono numeri tondi
        var zoomNecessario =
          Math.ceil(
            Math.max.apply(
              null,
              daIngrandire.map(function (def) {
                return zoomMinimoEffettivo(def);
              })
            ) * 10
          ) / 10;
        messages.push(
          'Ingrandisci almeno fino a zoom ' +
            numeroIt(zoomNecessario) +
            ' per vedere ' +
            daIngrandire
              .map(function (def) {
                return def.title.toLowerCase();
              })
              .join(' e ') +
            '.'
        );
        azione = { label: 'Portami a zoom ' + numeroIt(zoomNecessario), zoom: zoomNecessario };
      }

      var daAllontanare = active.filter(function (def) {
        return def.maxZoom && zoom >= def.maxZoom;
      });
      if (daAllontanare.length) {
        var zoomMassimo = Math.min.apply(
          null,
          daAllontanare.map(function (def) {
            return def.maxZoom;
          })
        );
        messages.push(
          'Allontana (sotto zoom ' +
            numeroIt(zoomMassimo) +
            ') per vedere ' +
            daAllontanare
              .map(function (def) {
                return def.title.toLowerCase();
              })
              .join(' e ') +
            '.'
        );
        if (!azione) azione = { label: 'Portami a zoom ' + numeroIt(zoomMassimo), zoom: zoomMassimo };
      }
    }

    if (!messages.length) return;

    // Cosa si sta effettivamente vedendo a questo zoom: senza questa riga
    // l'utente vede solo ciò che manca e non sa se il catasto stia funzionando.
    var visibili = active.filter(function (def) {
      return zoom >= zoomMinimoEffettivo(def) && (!def.maxZoom || zoom < def.maxZoom);
    });
    if (visibili.length) {
      var elenco = document.createElement('p');
      elenco.className = 'hint small';
      elenco.textContent =
        'Visibili a questo zoom: ' +
        visibili
          .map(function (def) {
            return def.title.toLowerCase();
          })
          .join(', ') +
        '.';
      zoomNoteEl.appendChild(elenco);
    }

    var avviso = document.createElement('p');
    avviso.className = 'hint small warn';
    avviso.textContent = messages.join(' ');
    zoomNoteEl.appendChild(avviso);

    if (azione) {
      var bottone = document.createElement('button');
      bottone.type = 'button';
      bottone.className = 'ghost';
      bottone.setAttribute('data-catasto-zoom', String(azione.zoom));
      bottone.textContent = azione.label;
      zoomNoteEl.appendChild(bottone);
    }
  }

  /** Verifica che l'inoltro /catasto risponda davvero con un'immagine WMS. */
  /**
   * C'è l'inoltro `/catasto/*`?
   *
   * Attenzione a non confondere due cose diverse: un **404** vuol dire che
   * l'inoltro non c'è, mentre un errore del servizio (500, XML di errore,
   * risposta lenta) non dice niente sull'inoltro. Con un solo tentativo un
   * capriccio del servizio faceva concludere «inoltro assente» e l'app passava
   * agli indirizzi diretti: lì le immagini non sono più leggibili dal canvas
   * (e la campitura beige tornava visibile) e la GetFeatureInfo dei popup
   * falliva. Si ritenta quindi qualche volta, e si rinuncia solo davanti a un
   * 404 o a tentativi tutti falliti.
   */
  function probeProxy(tentativo) {
    var prova = tentativo || 0;
    var url =
      Campagna.config.catasto.proxyPath +
      '?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&STYLES=&FORMAT=image/png' +
      '&TRANSPARENT=true&LAYERS=CP.CadastralZoning&WIDTH=32&HEIGHT=32' +
      '&SRS=EPSG:4258&BBOX=11.09,42.74,11.11,42.76';

    function riprova() {
      if (prova >= 3) return false;
      return new Promise(function (risolvi) {
        setTimeout(risolvi, 400 * (prova + 1));
      }).then(function () {
        return probeProxy(prova + 1);
      });
    }

    return fetch(url, { method: 'GET' })
      .then(function (response) {
        var type = response.headers.get('content-type') || '';
        if (response.status === 404) return false;
        if (response.ok && type.indexOf('image') !== -1) return true;
        // qualcosa è arrivato: l'inoltro c'è, è il servizio ad aver fallito
        if (response.status && response.status !== 404 && response.status < 500) return true;
        return riprova();
      })
      .catch(function () {
        return riprova();
      });
  }

  /** Costruisce i controlli nel pannello laterale: sfondo + caselle dei layer. */
  function buildUI(container) {
    container.innerHTML = '';

    // Intestazione che apre e chiude: di partenza è chiusa, così sulla mappa
    // resta solo una riga.
    var intestazione = document.createElement('button');
    intestazione.type = 'button';
    intestazione.className = 'catasto-titolo';
    intestazione.title = 'Cartografia catastale dell\u2019Agenzia delle Entrate';

    var testoIntestazione = document.createElement('span');
    testoIntestazione.textContent = 'Dati catastali';

    var freccia = document.createElement('span');
    freccia.className = 'catasto-freccia';
    freccia.textContent = '\u25be';

    intestazione.appendChild(testoIntestazione);
    intestazione.appendChild(freccia);
    container.appendChild(intestazione);

    var corpo = document.createElement('div');
    corpo.className = 'catasto-corpo';
    container.appendChild(corpo);

    var aperto = false;

    function mostraCorpo(apri) {
      aperto = apri;
      container.classList.toggle('aperto', apri);
      intestazione.setAttribute('aria-expanded', apri ? 'true' : 'false');
    }

    intestazione.setAttribute('aria-expanded', 'false');
    intestazione.addEventListener('click', function () {
      mostraCorpo(!aperto);
    });


    DEFS.forEach(function (def) {
      var row = document.createElement('div');
      row.className = 'catasto-row';

      var label = document.createElement('label');
      label.className = 'row';

      var checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = def.enabled;
      checkbox.setAttribute('data-catasto-toggle', def.key);

      var title = document.createElement('span');
      // sulla mappa lo spazio è poco: nome breve, descrizione nel suggerimento
      title.textContent = def.short || def.title;
      title.title = def.hint;

      label.appendChild(checkbox);
      label.appendChild(title);
      row.appendChild(label);
      corpo.appendChild(row);
    });

    // Un solo comando di opacità, per lo sfondo monocolore comune.
    var rigaSfondo = document.createElement('div');
    rigaSfondo.className = 'catasto-row';

    var testaSfondo = document.createElement('div');
    testaSfondo.className = 'catasto-head';

    var labelSfondo = document.createElement('label');
    labelSfondo.className = 'row';
    labelSfondo.setAttribute('for', 'catasto-sfondo');

    var titoloSfondo = document.createElement('span');
    titoloSfondo.textContent = 'Sfondo bianco';

    labelSfondo.appendChild(titoloSfondo);

    var valoreSfondo = document.createElement('span');
    valoreSfondo.className = 'opacity-value';
    valoreSfondo.textContent = sfondoOpacita + '%';

    testaSfondo.appendChild(labelSfondo);
    testaSfondo.appendChild(valoreSfondo);

    var sliderSfondo = document.createElement('input');
    sliderSfondo.type = 'range';
    sliderSfondo.id = 'catasto-sfondo';
    sliderSfondo.min = '0';
    sliderSfondo.max = '100';
    sliderSfondo.step = '5';
    sliderSfondo.value = String(sfondoOpacita);
    sliderSfondo.setAttribute('data-catasto-sfondo', '1');
    sliderSfondo.setAttribute('aria-label', 'Opacità dello sfondo bianco sotto il catasto');

    rigaSfondo.appendChild(testaSfondo);
    rigaSfondo.appendChild(sliderSfondo);
    corpo.appendChild(rigaSfondo);
  }

  function handleUIEvent(event) {
    var target = event.target;
    if (!target || !target.getAttribute) return;

    if (target.getAttribute('data-catasto-sfondo')) {
      setOpacity(Number(target.value) / 100);
      var badge = document.querySelector('.catasto-row .opacity-value');
      if (badge) badge.textContent = Math.round(Number(target.value)) + '%';
      return;
    }

    var toggleKey = target.getAttribute('data-catasto-toggle');
    if (toggleKey) {
      setEnabled(toggleKey, target.checked);
    }
  }

  /**
   * Inizializza l'overlay catastale.
   * @param {ol.Map} olMap    istanza della mappa
   * @param {Element} container pannello in cui costruire i controlli
   * @param {Element} noteEl   elemento in cui mostrare l'avviso di scala
   * @returns {Array<ol.layer.Base>} i layer creati, dal basso verso l'alto
   */
  function init(olMap, container, noteEl) {
    map = olMap;
    zoomNoteEl = noteEl || null;

    registerProjection();

    var created = [];

    var sfondo = createSfondo();
    layers.__sfondo = sfondo;
    created.push(sfondo);

    DEFS.forEach(function (def) {
      var layer = createLayer(def);
      layers[def.key] = layer;
      created.push(layer);
    });

    if (container) {
      buildUI(container);
      container.addEventListener('input', handleUIEvent);
      container.addEventListener('change', handleUIEvent);
    }

    // Il pulsante «Portami a zoom …» vive dentro il blocco informativo.
    if (zoomNoteEl) {
      zoomNoteEl.addEventListener('click', function (event) {
        var target = event.target;
        if (!target || !target.getAttribute) return;
        var zoom = target.getAttribute('data-catasto-zoom');
        if (zoom) vaiAZoom(Number(zoom));
      });
    }

    // Verifica che l'inoltro /catasto esista davvero. Senza di esso — per
    // esempio aprendo il progetto con Live Server di VS Code, che serve solo
    // file statici — la GetMap finirebbe su un percorso inesistente (404) e non
    // si vedrebbe alcun catasto. In quel caso si ripiega sull'URL diretto.
    //
    // Le sorgenti a immagine unica hanno l'URL fissato alla creazione: va
    // aggiornato e le immagini già chieste vanno richieste di nuovo.
    probeProxy().then(function (ok) {
      proxyAvailable = ok;

      if (!ok) {
        // Senza inoltro il servizio non manda header CORS: chiedere le immagini
        // con crossOrigin le farebbe fallire, quindi si ripiega su richieste
        // normali (il canvas risultera "sporco" e il catasto verra escluso
        // dall'esportazione, come spiegato in main.js).
        Campagna.config.catasto.url = Campagna.config.catasto.directUrl;
        pezzi = {};
        ordinePezzi = [];
        DEFS.forEach(function (def) {
          def.crossOrigin = null;
          var layer = layers[def.key];
          if (layer) layer.setSource(createImageSource(def, null));
        });
        aggiornaPezzi();
      }

      updateZoomNote();
    });

    aggiornaSfondo();
    aggiornaSoglie();
    aggiornaPezzi();
    aggiornaNumeri();
    updateZoomNote();
    return created;
  }

  /**
   * Ricalcola soglie, sfondo e avviso: da chiamare a ogni cambio di vista o
   * di dimensione della mappa (la scala raggiungibile dipende da quanto è
   * larga la mappa).
   */
  function updateResolution() {
    aggiornaSoglie();
    aggiornaSfondo();
    aggiornaPezzi();
    aggiornaNumeri();
    updateZoomNote();
  }

  /** Stato corrente, utile per la fascia dati dell'immagine esportata. */
  function activeLabels() {
    return DEFS.filter(function (def) {
      return def.enabled;
    }).map(function (def) {
      return def.title;
    });
  }

  return {
    init: init,
    updateResolution: updateResolution,
    caricaPezziOra: caricaPezziOra,
    setEnabled: setEnabled,
    setOpacity: setOpacity,
    setVisible: setVisible,
    isProxyAvailable: function () {
      return proxyAvailable;
    },
    activeLabels: activeLabels,
    defs: DEFS
  };
})();

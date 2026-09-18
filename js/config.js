/* ==========================================================================
   Campagna AI — configurazione
   --------------------------------------------------------------------------
   Tutti gli script sono caricati come <script> classici (nessun bundler),
   quindi condividono un unico namespace globale: `Campagna`.
   ========================================================================== */

window.Campagna = window.Campagna || {};

Campagna.config = {
  /**
   * Servizio WMS della cartografia catastale dell'Agenzia delle Entrate.
   *
   * IMPORTANTE — URL relativo, non assoluto:
   * in produzione Vercel inoltra `/catasto/*` verso
   * https://wms.cartografia.agenziaentrate.gov.it/inspire/wms/*
   * grazie al rewrite in `vercel.json`; in sviluppo lo fa `scripts/dev-proxy.js`.
   *
   * Il servizio NON invia header CORS, quindi una chiamata cross-origin
   * funzionerebbe a schermo ma "sporcerebbe" il canvas, impedendo di includere
   * le linee catastali nell'immagine PNG esportata. Inoltrando la richiesta
   * dal nostro dominio tutto diventa same-origin e il problema sparisce.
   */
  catasto: {
    /**
     * Percorso servito dal nostro dominio.
     * In produzione: rewrite di Vercel. In sviluppo: scripts/dev-proxy.js.
     * NB: un semplice server statico (es. Live Server di VS Code, porta 5500)
     * NON fa questo inoltro → risponde 404 → nessuna linea catastale e canvas
     * "sporcato". L'app se ne accorge all'avvio e ripiega sull'URL diretto.
     */
    proxyPath: '/catasto/ows01.php',

    /**
     * URL diretto del servizio.
     * Usato come ripiego quando l'inoltro non è disponibile: la cartografia
     * catastale diventa così visibile comunque, ma — non inviando il servizio
     * gli header CORS — il canvas risulterebbe "sporcato" e le linee catastali
     * non potrebbero entrare nell'immagine esportata. In quel caso l'app
     * esclude automaticamente il catasto dall'esportazione e avvisa l'utente.
     */
    directUrl: 'https://wms.cartografia.agenziaentrate.gov.it/inspire/wms/ows01.php',

    /** URL effettivamente in uso: viene deciso all'avvio dopo la verifica. */
    url: '/catasto/ows01.php',

    /**
     * Proiezione nativa del servizio: EPSG:4258 (ETRS89, gradi).
     * Il servizio NON supporta EPSG:3857 (Web Mercator), la proiezione della
     * mappa: OpenLayers provvede a riproiettare automaticamente le immagini.
     */
    serverProjection: 'EPSG:4258',

    /**
     * Versione WMS 1.1.1 scelta deliberatamente.
     *
     * Verificato sul servizio reale:
     *   - 1.3.0 → il servizio interpreta il BBOX in ordine lat,lon (axis order
     *             "neu" previsto dalla specifica per EPSG:4258);
     *   - 1.1.1 → il BBOX è sempre minX,minY,maxX,maxY (lon,lat), nessuna
     *             ambiguità e nessuno scambio di assi.
     * Con 1.1.1 la richiesta è deterministica e indipendente dall'ordine degli
     * assi configurato lato client.
     */
    version: '1.1.1'
  },

  /** Chiave di salvataggio locale degli appezzamenti (localStorage). */
  storageKey: 'campagna_ai.parcels.v1',

  /** Vista iniziale: l'Italia intera. */
  view: {
    center: [12.5, 42.0], // lon, lat
    zoom: 6
  },

  /**
   * Oltre questa risoluzione (metri per pixel del Web Mercator) le particelle
   * catastali non vengono disegnate dal servizio: in pratica si vedono da
   * circa zoom 17 in su. Calcolato empiricamente sui limiti di scala (1:5.000).
   */
  catastoMinResolution: 1.2,

  attributions: {
    osm: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    esri: 'Imagery © <a href="https://www.esri.com" target="_blank" rel="noopener">Esri</a>, Maxar, Earthstar Geographics',
    catasto: 'Cartografia catastale © <a href="https://www.agenziaentrate.gov.it" target="_blank" rel="noopener">Agenzia delle Entrate</a> (CC BY 4.0)'
  }
};

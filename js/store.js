/* ==========================================================================
   Campagna AI — persistenza locale degli appezzamenti
   --------------------------------------------------------------------------
   Gli appezzamenti vengono salvati in localStorage: restano sul dispositivo
   dell'utente, senza alcun server. L'export/import JSON permette di fare
   copie di sicurezza o di spostarli su un altro browser.
   ========================================================================== */

Campagna.store = (function () {
  'use strict';

  var KEY = Campagna.config.storageKey;
  var listeners = [];

  function geojson() {
    return new ol.format.GeoJSON();
  }

  /**
   * Contenuto salvato: gli appezzamenti e i gruppi (le "cartelle") in cui sono
   * ordinati. I file scritti dalle versioni precedenti erano un semplice
   * elenco: vengono letti lo stesso.
   */
  function leggiTutto() {
    try {
      var raw = window.localStorage.getItem(KEY);
      if (!raw) return { parcels: [], gruppi: [] };
      var parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return { parcels: parsed, gruppi: [] };
      return {
        parcels: Array.isArray(parsed.parcels) ? parsed.parcels : [],
        gruppi: Array.isArray(parsed.gruppi) ? parsed.gruppi : []
      };
    } catch (err) {
      console.error('[store] lettura non riuscita', err);
      return { parcels: [], gruppi: [] };
    }
  }

  function read() {
    return leggiTutto().parcels;
  }

  function scriviTutto(dati) {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(dati));
    } catch (err) {
      console.error('[store] scrittura non riuscita', err);
      throw new Error('Spazio di archiviazione locale esaurito o non disponibile.');
    }
    emit();
  }

  function write(list) {
    var dati = leggiTutto();
    dati.parcels = list;
    scriviTutto(dati);
  }

  /** Nomi dei gruppi, nell'ordine in cui sono stati creati. */
  function gruppi() {
    return leggiTutto().gruppi;
  }

  function creaGruppo(nome) {
    var pulito = String(nome || '').trim();
    if (!pulito) throw new Error('Il gruppo ha bisogno di un nome.');

    var dati = leggiTutto();
    if (dati.gruppi.indexOf(pulito) !== -1) {
      throw new Error('Esiste già un gruppo con questo nome.');
    }
    dati.gruppi.push(pulito);
    scriviTutto(dati);
    return pulito;
  }

  function rinominaGruppo(vecchio, nuovo) {
    var pulito = String(nuovo || '').trim();
    if (!pulito) throw new Error('Il gruppo ha bisogno di un nome.');

    var dati = leggiTutto();
    if (dati.gruppi.indexOf(pulito) !== -1) {
      throw new Error('Esiste già un gruppo con questo nome.');
    }

    dati.gruppi = dati.gruppi.map(function (nome) {
      return nome === vecchio ? pulito : nome;
    });
    dati.parcels = dati.parcels.map(function (record) {
      return record.group === vecchio ? Object.assign({}, record, { group: pulito }) : record;
    });
    scriviTutto(dati);
    return pulito;
  }

  /** Elimina un gruppo: gli appezzamenti restano, senza gruppo. */
  function eliminaGruppo(nome) {
    var dati = leggiTutto();
    dati.gruppi = dati.gruppi.filter(function (item) {
      return item !== nome;
    });
    dati.parcels = dati.parcels.map(function (record) {
      if (record.group !== nome) return record;
      var copia = Object.assign({}, record);
      delete copia.group;
      return copia;
    });
    scriviTutto(dati);
  }

  /** Sposta un appezzamento in un gruppo ('' o null per toglierlo). */
  function sposta(id, gruppo) {
    return update(id, { group: gruppo || null });
  }

  function emit() {
    var list = read();
    listeners.forEach(function (fn) {
      try {
        fn(list);
      } catch (err) {
        console.error('[store] listener in errore', err);
      }
    });
  }

  function subscribe(fn) {
    listeners.push(fn);
    return function unsubscribe() {
      listeners = listeners.filter(function (item) {
        return item !== fn;
      });
    };
  }

  function all() {
    return read();
  }

  function get(id) {
    return (
      read().filter(function (item) {
        return item.id === id;
      })[0] || null
    );
  }

  function newId() {
    return 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /**
   * Costruisce un record salvabile a partire da una feature disegnata.
   * La geometria è serializzata in GeoJSON in EPSG:4326 (lon/lat).
   */
  function createFromFeature(feature, options) {
    options = options || {};
    var geometry = feature.getGeometry();
    var misure = Campagna.measure.describe(geometry);

    var geometryObject;
    try {
      geometryObject = geojson().writeGeometryObject(geometry, {
        featureProjection: 'EPSG:3857',
        dataProjection: 'EPSG:4326'
      });
    } catch (err) {
      console.error('[store] serializzazione geometria non riuscita', err);
      throw new Error('Impossibile salvare questo appezzamento.');
    }

    return {
      id: newId(),
      name: options.name || 'Appezzamento del ' + new Date().toLocaleDateString('it-IT'),
      notes: options.notes || '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      areaM2: misure.areaM2,
      perimeterM: misure.perimeterM,
      areaText: misure.areaText,
      perimeterText: misure.perimeterText,
      vertices: misure.vertices,
      centroid: misure.centroid,
      geometry: geometryObject,
      baseLayer: options.baseLayer || 'street',
      group: options.group || null
    };
  }

  /** Ricostruisce una feature OpenLayers a partire da un record salvato. */
  function toFeature(record) {
    var geometry;
    try {
      geometry = geojson().readGeometry(record.geometry, {
        featureProjection: 'EPSG:3857',
        dataProjection: 'EPSG:4326'
      });
    } catch (err) {
      console.error('[store] geometria non leggibile per il record', record.id, err);
      return null;
    }
    if (!geometry) return null;

    var feature = new ol.Feature({ geometry: geometry });
    feature.setProperties(
      {
        kind: 'saved',
        recordId: record.id,
        name: record.name,
        createdAt: record.createdAt
      },
      true
    );
    return feature;
  }

  function add(record) {
    var list = read();
    list.push(record);
    write(list);
    return record;
  }

  function update(id, patch) {
    var list = read();
    var found = null;
    list = list.map(function (item) {
      if (item.id !== id) return item;
      found = Object.assign({}, item, patch, { updatedAt: new Date().toISOString() });
      return found;
    });
    if (found) write(list);
    return found;
  }

  function rename(id, name) {
    return update(id, { name: name });
  }

  function remove(id) {
    var list = read().filter(function (item) {
      return item.id !== id;
    });
    write(list);
    return list;
  }

  function clear() {
    write([]);
  }

  /** Scarica tutti gli appezzamenti come file JSON. */
  function exportJson() {
    var dati = leggiTutto();
    var parcels = dati.parcels;
    var payload = {
      app: 'campagna-ai',
      version: 2,
      exportedAt: new Date().toISOString(),
      gruppi: dati.gruppi,
      parcels: parcels
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = 'campagna-ai-appezzamenti-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
    return parcels.length;
  }

  /**
   * Importa appezzamenti da un file JSON esportato in precedenza.
   * I record con lo stesso id già presenti vengono sostituiti.
   */
  function importJson(text) {
    var parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error('Il file non contiene JSON valido.');
    }

    var incoming = parsed && Array.isArray(parsed.parcels) ? parsed.parcels : parsed;
    if (!Array.isArray(incoming)) {
      throw new Error('Formato non riconosciuto: atteso un elenco di appezzamenti.');
    }

    var valid = incoming.filter(function (item) {
      return item && item.geometry && typeof item.geometry === 'object';
    });
    if (!valid.length) {
      throw new Error('Nessun appezzamento valido trovato nel file.');
    }

    var list = read();
    var byId = {};
    list.forEach(function (item) {
      byId[item.id] = true;
    });

    var added = 0;
    var replaced = 0;

    valid.forEach(function (item) {
      var record = Object.assign({}, item);
      if (!record.id) record.id = newId();
      if (record.group) {
        var dati = leggiTutto();
        if (dati.gruppi.indexOf(record.group) === -1) {
          dati.gruppi.push(record.group);
          scriviTutto(dati);
        }
      }
      if (!record.name) record.name = 'Appezzamento importato';

      if (record.areaM2 == null || record.perimeterM == null) {
        var feature = toFeature(record);
        if (feature) {
          var misure = Campagna.measure.describe(feature.getGeometry());
          record.areaM2 = misure.areaM2;
          record.perimeterM = misure.perimeterM;
          record.areaText = misure.areaText;
          record.perimeterText = misure.perimeterText;
          record.centroid = misure.centroid;
        }
      }

      if (byId[record.id]) {
        list = list.map(function (existing) {
          return existing.id === record.id ? record : existing;
        });
        replaced += 1;
      } else {
        list.push(record);
        byId[record.id] = true;
        added += 1;
      }
    });

    write(list);
    return { added: added, replaced: replaced, total: list.length };
  }

  return {
    subscribe: subscribe,
    all: all,
    gruppi: gruppi,
    creaGruppo: creaGruppo,
    rinominaGruppo: rinominaGruppo,
    eliminaGruppo: eliminaGruppo,
    sposta: sposta,
    get: get,
    add: add,
    update: update,
    rename: rename,
    remove: remove,
    clear: clear,
    createFromFeature: createFromFeature,
    toFeature: toFeature,
    exportJson: exportJson,
    importJson: importJson
  };
})();

/* ==========================================================================
   Campagna AI — misura di superfici e perimetri
   --------------------------------------------------------------------------
   Le misure sono geodetiche (ellissoide WGS84) tramite `ol.sphere`, quindi
   accurate e indipendenti dalla proiezione della mappa.
   ========================================================================== */

Campagna.measure = (function () {
  'use strict';

  var ACRI_IN_M2 = 4046.8564224;

  var nf = function (value, decimals) {
    return value.toLocaleString('it-IT', {
      minimumFractionDigits: 0,
      maximumFractionDigits: decimals
    });
  };

  /**
   * `ol.sphere.getArea`/`getLength` accettano poligoni e linee, non i cerchi.
   * Un cerchio viene quindi convertito in un poligono con molti lati, così da
   * poterne calcolare area e perimetro come per qualsiasi altra geometria.
   */
  function asMeasurable(geometry) {
    if (!geometry) return null;
    if (typeof ol.geom.Circle === 'function' && geometry instanceof ol.geom.Circle) {
      return ol.geom.Polygon.fromCircle(geometry, 128);
    }
    return geometry;
  }

  /** Superficie in metri quadrati, oppure `null` se non calcolabile. */
  function areaM2(geometry) {
    var g = asMeasurable(geometry);
    if (!g || typeof g.getType !== 'function') return null;
    var type = g.getType();
    if (type !== 'Polygon' && type !== 'MultiPolygon') return null;
    var value = ol.sphere.getArea(g);
    return isFinite(value) ? value : null;
  }

  /** Perimetro in metri, oppure `null` se non calcolabile. */
  function perimeterM(geometry) {
    var g = asMeasurable(geometry);
    if (!g || typeof g.getType !== 'function') return null;
    var type = g.getType();
    if (type !== 'Polygon' && type !== 'MultiPolygon' && type !== 'LineString') return null;
    var value = ol.sphere.getLength(g);
    return isFinite(value) ? value : null;
  }

  /** Numero di vertici del contorno (escluso il punto di chiusura). */
  function vertexCount(geometry) {
    if (!geometry || typeof geometry.getType !== 'function') return null;
    var type = geometry.getType();
    try {
      if (type === 'Polygon') {
        return geometry.getCoordinates()[0].length - 1;
      }
      if (type === 'MultiPolygon') {
        return geometry.getCoordinates().reduce(function (total, polygon) {
          return total + polygon[0].length - 1;
        }, 0);
      }
    } catch (err) {
      return null;
    }
    return null; // i cerchi non hanno vertici significativi
  }

  /**
   * Punto rappresentativo della geometria, usato per ancorare l'etichetta
   * con le misure. Restituisce una `ol.geom.Point` in EPSG:3857.
   */
  function anchorPoint(geometry) {
    if (!geometry) return null;
    try {
      if (typeof geometry.getInteriorPoint === 'function') {
        return geometry.getInteriorPoint();
      }
      if (typeof geometry.getCenter === 'function') {
        return new ol.geom.Point(geometry.getCenter());
      }
    } catch (err) {
      // geometria degenere: si prosegue con il centro dell'extent
    }
    var center = ol.extent.getCenter(geometry.getExtent());
    return new ol.geom.Point(center);
  }

  /** Formattazione "umana" della superficie: m² → ha → km². */
  function formatArea(m2) {
    if (m2 == null || !isFinite(m2)) return '—';
    if (m2 < 100) return nf(m2, 1) + ' m²';
    if (m2 < 10000) return nf(m2, 0) + ' m²';
    if (m2 < 1000000) return nf(m2 / 10000, 2) + ' ha';
    return nf(m2 / 1000000, 3) + ' km²';
  }

  /** Formattazione del perimetro: m → km. */
  function formatLength(m) {
    if (m == null || !isFinite(m)) return '—';
    if (m < 1000) return nf(m, 1) + ' m';
    return nf(m / 1000, 2) + ' km';
  }

  /** Superficie in acri (unità agraria usata in alcuni contesti). */
  function formatAcres(m2) {
    if (m2 == null || !isFinite(m2)) return '—';
    return nf(m2 / ACRI_IN_M2, 2) + ' acri';
  }

  /** Coordinate in formato leggibile: 42.750123° N, 11.100456° E */
  function formatCoords(lonLat) {
    if (!lonLat) return '—';
    var lat = lonLat[1];
    var lon = lonLat[0];
    var ns = lat >= 0 ? 'N' : 'S';
    var ew = lon >= 0 ? 'E' : 'O';
    return Math.abs(lat).toFixed(6) + '° ' + ns + ', ' + Math.abs(lon).toFixed(6) + '° ' + ew;
  }

  /**
   * Tutte le misure di una geometria in un colpo solo.
   * `centroid` è in gradi (lon, lat) ed è comodo per il salvataggio e l'export.
   */
  function describe(geometry) {
    var area = areaM2(geometry);
    var perimeter = perimeterM(geometry);
    var point = anchorPoint(geometry);

    var centroid = null;
    if (point) {
      var coord = point.getCoordinates();
      if (isFinite(coord[0]) && isFinite(coord[1])) {
        centroid = ol.proj.toLonLat(coord);
      }
    }

    // Sulla mappa si scrive solo la superficie: il perimetro resta nel
    // pannello Misure e nell'immagine esportata.
    var labelText = area == null ? '' : formatArea(area);

    return {
      areaM2: area,
      perimeterM: perimeter,
      areaText: formatArea(area),
      perimeterText: formatLength(perimeter),
      acresText: formatAcres(area),
      vertices: vertexCount(geometry),
      centroid: centroid,
      centroidText: formatCoords(centroid),
      labelText: labelText
    };
  }

  return {
    areaM2: areaM2,
    perimeterM: perimeterM,
    vertexCount: vertexCount,
    anchorPoint: anchorPoint,
    formatArea: formatArea,
    formatLength: formatLength,
    formatAcres: formatAcres,
    formatCoords: formatCoords,
    describe: describe,
    ACRI_IN_M2: ACRI_IN_M2
  };
})();

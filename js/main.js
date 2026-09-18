/* ==========================================================================
   Campagna AI — collegamento fra interfaccia, mappa, disegno e salvataggio
   ========================================================================== */

Campagna.main = (function () {
  'use strict';

  var els = {};
  var toolButtons = [];
  /** Gruppi aperti/richiusi nell'elenco delle aree salvate. */
  var gruppiAperti = {};

  // ------------------------------------------------------------------ toast

  var toastTimer = null;

  function toast(message, kind) {
    if (!els.toast) return;
    els.toast.textContent = message;
    els.toast.className = 'toast visible' + (kind === 'error' ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      els.toast.className = 'toast' + (kind === 'error' ? ' error' : '');
    }, kind === 'error' ? 6500 : 3200);
  }

  // ------------------------------------------------------------- interfaccia

  function renderMeasure(feature, misure) {
    if (!feature || !misure) {
      els.area.textContent = '—';
      els.perimeter.textContent = '—';
      els.vertices.textContent = '—';
      els.save.disabled = true;
      els.download.disabled = true;
      // senza un'area attiva la barra delle misure sparisce
      if (els.barraMisure) els.barraMisure.hidden = true;
      return;
    }

    if (els.barraArea) {
      els.barraArea.textContent = misure.areaText;
      els.barraPerimetro.textContent = misure.perimeterText;
    }
    if (els.barraMisure) els.barraMisure.hidden = false;

    els.area.textContent = misure.areaText;
    els.perimeter.textContent = misure.perimeterText;
    els.vertices.textContent = misure.vertices == null ? '—' : String(misure.vertices);
    els.save.disabled = false;
    if (els.barraSalva) els.barraSalva.disabled = false;
    els.download.disabled = false;
  }

  var HINTS = {
    Polygon: 'Clicca i vertici sulla mappa. Doppio clic (o Invio) per chiudere il poligono.',
    Box: 'Tieni premuto e trascina per disegnare il rettangolo.',
    Circle: 'Clicca il centro, poi clicca (o trascina) per definire il raggio.',
    Modify: 'Trascina i vertici per correggere il contorno. I numeri si aggiornano da soli.',
    null: 'Scegli uno strumento e clicca sulla mappa. Doppio clic per chiudere il poligono.'
  };

  function renderTool(tool) {
    toolButtons.forEach(function (button) {
      button.classList.toggle('active', button.getAttribute('data-tool') === tool);
    });
    els.modify.classList.toggle('active', tool === 'Modify');
    els.drawHint.textContent = HINTS[tool] || HINTS[null];
  }

  /**
   * Inquadratura iniziale: se c'è almeno un appezzamento salvato la mappa si
   * apre su quelli, con il maggior ingrandimento possibile ma **mai oltre zoom
   * 14**, e con un margine attorno perché non stiano appiccicati al bordo.
   */
  function inquadraAppezzamentiSalvati() {
    var record = Campagna.store.all();
    if (!record.length) return;

    var extent = null;
    record.forEach(function (voce) {
      var feature;
      try {
        feature = Campagna.store.toFeature(voce);
      } catch (err) {
        return;
      }
      var geometria = feature.getGeometry();
      if (!geometria) return;
      var suo = geometria.getExtent();
      extent = extent ? ol.extent.extend(extent, suo) : suo.slice();
    });

    if (!extent || !isFinite(extent[0]) || extent[0] === extent[2]) return;

    Campagna.map.getMap().getView().fit(extent, {
      padding: [48, 48, 48, 48],
      maxZoom: 14,
      duration: 0
    });
    Campagna.catasto.updateResolution();
  }

  function findFeatureByRecordId(recordId) {
    if (!recordId) return null;
    var features = Campagna.map.getVectorSource().getFeatures();
    for (var i = 0; i < features.length; i += 1) {
      if (features[i].get('recordId') === recordId) return features[i];
    }
    return null;
  }

  /** Un appezzamento nell'elenco: nome per esteso, dati e azioni. */
  function voceAppezzamento(record, activeId) {
    var li = document.createElement('div');
    li.className = 'saved-item';
    if (record.id && record.id === activeId) li.classList.add('selected');

    var main = document.createElement('div');
    main.className = 'saved-main';
    main.title = 'Carica e inquadra questo appezzamento';

    var name = document.createElement('span');
    name.className = 'saved-name';
    name.textContent = record.name || 'Appezzamento';

    var meta = document.createElement('span');
    meta.className = 'saved-meta';
    meta.textContent =
      (record.areaText || Campagna.measure.formatArea(record.areaM2)) +
      ' · ' +
      (record.perimeterText || Campagna.measure.formatLength(record.perimeterM));

    main.appendChild(name);
    main.appendChild(meta);
    main.addEventListener('click', function () {
      loadRecord(record);
    });

    var actions = document.createElement('div');
    actions.className = 'saved-actions';

    var zoomBtn = document.createElement('button');
    zoomBtn.type = 'button';
    zoomBtn.className = 'ghost';
    zoomBtn.textContent = 'Inquadra';
    zoomBtn.addEventListener('click', function () {
      loadRecord(record);
    });

    var renameBtn = document.createElement('button');
    renameBtn.type = 'button';
    renameBtn.className = 'ghost';
    renameBtn.textContent = 'Rinomina';
    renameBtn.addEventListener('click', function () {
      renameRecord(record);
    });

    var moveBtn = document.createElement('button');
    moveBtn.type = 'button';
    moveBtn.className = 'ghost';
    moveBtn.textContent = 'Sposta';
    moveBtn.addEventListener('click', function () {
      spostaRecord(record);
    });

    var delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'ghost danger';
    delBtn.textContent = 'Elimina';
    delBtn.addEventListener('click', function () {
      deleteRecord(record);
    });

    actions.appendChild(zoomBtn);
    actions.appendChild(renameBtn);
    actions.appendChild(moveBtn);
    actions.appendChild(delBtn);

    li.appendChild(main);
    li.appendChild(actions);
    return li;
  }

  /** Un gruppo richiudibile con dentro i suoi appezzamenti. */
  function sezioneGruppo(nome, records, activeId, aperto) {
    var sezione = document.createElement('section');
    sezione.className = 'saved-group';

    var testa = document.createElement('div');
    testa.className = 'saved-group-head';

    var freccia = document.createElement('span');
    freccia.className = 'saved-group-arrow';
    freccia.textContent = aperto ? '▾' : '▸';

    var titolo = document.createElement('span');
    titolo.className = 'saved-group-name';
    titolo.textContent = nome;

    var conta = document.createElement('span');
    conta.className = 'badge';
    conta.textContent = String(records.length);

    testa.appendChild(freccia);
    testa.appendChild(titolo);
    testa.appendChild(conta);

    if (nome !== 'Senza gruppo') {
      var rinomina = document.createElement('button');
      rinomina.type = 'button';
      rinomina.className = 'ghost';
      rinomina.textContent = 'Rinomina';
      rinomina.addEventListener('click', function (evento) {
        evento.stopPropagation();
        rinominaGruppo(nome);
      });
      testa.appendChild(rinomina);

      var elimina = document.createElement('button');
      elimina.type = 'button';
      elimina.className = 'ghost danger';
      elimina.textContent = 'Elimina';
      elimina.addEventListener('click', function (evento) {
        evento.stopPropagation();
        eliminaGruppo(nome, records.length);
      });
      testa.appendChild(elimina);
    }

    testa.addEventListener('click', function () {
      gruppiAperti[nome] = !aperto;
      renderSavedList();
    });

    sezione.appendChild(testa);

    if (aperto) {
      var corpo = document.createElement('div');
      corpo.className = 'saved-group-body';
      records.forEach(function (record) {
        corpo.appendChild(voceAppezzamento(record, activeId));
      });
      sezione.appendChild(corpo);
    }

    return sezione;
  }

  function renderSavedList() {
    var records = Campagna.store.all();
    var gruppi = Campagna.store.gruppi();
    els.savedCount.textContent = String(records.length);
    els.savedList.innerHTML = '';

    if (!records.length) {
      var vuoto = document.createElement('p');
      vuoto.className = 'saved-empty';
      vuoto.textContent = 'Nessun appezzamento salvato. Disegnane uno e premi «Salva».';
      els.savedList.appendChild(vuoto);
      return;
    }

    var active = Campagna.draw.getActiveFeature();
    var activeId = active ? active.get('recordId') : null;

    gruppi.forEach(function (nome) {
      var dentro = records.filter(function (record) {
        return record.group === nome;
      });
      if (!dentro.length && gruppiAperti[nome] === undefined) return;
      els.savedList.appendChild(
        sezioneGruppo(nome, dentro, activeId, gruppiAperti[nome] !== false)
      );
    });

    var senza = records.filter(function (record) {
      return !record.group;
    });
    if (senza.length) {
      els.savedList.appendChild(sezioneGruppo('Senza gruppo', senza, activeId, true));
    }
  }

  /** Sposta un appezzamento in un gruppo, o ne crea uno al volo. */
  function spostaRecord(record) {
    var gruppi = Campagna.store.gruppi();
    var elenco = gruppi.concat(['— nessun gruppo —', '— nuovo gruppo… —']);
    var scelta = window.prompt(
      'Sposta «' + (record.name || 'Appezzamento') + '» nel gruppo:\n\n' +
        elenco.map(function (nome, indice) { return indice + 1 + ') ' + nome; }).join('\n') +
        '\n\nScrivi il numero, oppure direttamente il nome di un gruppo nuovo.',
      gruppi.indexOf(record.group) !== -1 ? String(gruppi.indexOf(record.group) + 1) : ''
    );
    if (scelta === null) return;

    var testo = String(scelta).trim();
    if (!testo) return;

    var indice = Number(testo);
    var nome;

    if (indice >= 1 && indice <= gruppi.length) {
      nome = gruppi[indice - 1];
    } else if (indice === gruppi.length + 1) {
      nome = null;
    } else if (indice === gruppi.length + 2) {
      nome = window.prompt('Nome del nuovo gruppo:', '');
      if (!nome) return;
      try {
        Campagna.store.creaGruppo(nome);
      } catch (err) {
        toast(err.message, 'error');
        return;
      }
    } else {
      nome = testo;
      if (gruppi.indexOf(nome) === -1) {
        try {
          Campagna.store.creaGruppo(nome);
        } catch (err) {
          toast(err.message, 'error');
          return;
        }
      }
    }

    Campagna.store.sposta(record.id, nome);
    if (nome) gruppiAperti[nome] = true;
    toast(nome ? 'Spostato in «' + nome + '».' : 'Tolto dal gruppo.');
  }

  function rinominaGruppo(nome) {
    var nuovo = window.prompt('Nuovo nome del gruppo:', nome);
    if (nuovo === null) return;
    var pulito = String(nuovo).trim();
    if (!pulito || pulito === nome) return;

    try {
      Campagna.store.rinominaGruppo(nome, pulito);
      if (gruppiAperti[nome] !== undefined) {
        gruppiAperti[pulito] = gruppiAperti[nome];
        delete gruppiAperti[nome];
      }
      toast('Gruppo rinominato.');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function eliminaGruppo(nome, quanti) {
    var conferma = window.confirm(
      'Eliminare il gruppo «' + nome + '»?' +
        (quanti ? '\nI ' + quanti + ' appezzamenti restano, senza gruppo.' : '')
    );
    if (!conferma) return;
    Campagna.store.eliminaGruppo(nome);
    delete gruppiAperti[nome];
    toast('Gruppo eliminato.');
  }

  // --------------------------------------------------- salvataggio e richiamo

  function writeGeometry(feature) {
    return new ol.format.GeoJSON().writeGeometryObject(feature.getGeometry(), {
      featureProjection: 'EPSG:3857',
      dataProjection: 'EPSG:4326'
    });
  }

  function saveActive() {
    var feature = Campagna.draw.getActiveFeature();
    if (!feature) {
      toast('Disegna prima un appezzamento.', 'error');
      return;
    }

    var misure = Campagna.measure.describe(feature.getGeometry());
    if (misure.areaM2 == null) {
      toast('Questo contorno non ha una superficie calcolabile.', 'error');
      return;
    }

    var recordId = feature.get('recordId');
    var payload = {
      areaM2: misure.areaM2,
      perimeterM: misure.perimeterM,
      areaText: misure.areaText,
      perimeterText: misure.perimeterText,
      vertices: misure.vertices,
      centroid: misure.centroid,
      geometry: writeGeometry(feature),
      baseLayer: Campagna.map.getBase()
    };

    try {
      if (recordId && Campagna.store.get(recordId)) {
        Campagna.store.update(recordId, payload);
        feature.set('kind', 'saved');
        toast('Appezzamento aggiornato.');
      } else {
        var proposed = 'Appezzamento del ' + new Date().toLocaleDateString('it-IT');
        Campagna.draw.refreshActive();

        chiediNomeEGruppo(proposed).then(function (scelta) {
          // Annulla: non si salva nulla, e l'area resta com'era
          if (!scelta) {
            toast('Salvataggio annullato.');
            return;
          }

          try {
            var record = Campagna.store.add(
              Campagna.store.createFromFeature(feature, {
                name: scelta.name,
                baseLayer: payload.baseLayer,
                group: scelta.group
              })
            );

            feature.set('kind', 'saved');
            feature.set('recordId', record.id);
            feature.set('name', record.name);
            if (scelta.group) gruppiAperti[scelta.group] = true;
            toast(scelta.group
              ? 'Appezzamento salvato in «' + scelta.group + '».'
              : 'Appezzamento salvato in locale.');
          } catch (err) {
            toast(err.message, 'error');
            return;
          }

          Campagna.draw.refreshActive();
          renderSavedList();
        });
        return;
      }
    } catch (err) {
      toast(err.message, 'error');
      return;
    }

    Campagna.draw.refreshActive();
    renderSavedList();
  }

  /**
   * Chiede nome e gruppo prima di salvare. Restituisce una promessa che si
   * risolve con `{ name, group }`, oppure con `null` se si annulla: premendo
   * Annulla non si salva nulla.
   */
  function chiediNomeEGruppo(proposto) {
    return new Promise(function (risolvi) {
      var gruppi = Campagna.store.gruppi();
      var NUOVO = '\u002b nuovo gruppo\u2026';

      els.salvaNome.value = proposto;
      els.salvaGruppo.innerHTML = '';

      var nessuno = document.createElement('option');
      nessuno.value = '';
      nessuno.textContent = '\u2014 nessun gruppo \u2014';
      els.salvaGruppo.appendChild(nessuno);

      gruppi.forEach(function (nome) {
        var voce = document.createElement('option');
        voce.value = nome;
        voce.textContent = nome;
        els.salvaGruppo.appendChild(voce);
      });

      var nuovo = document.createElement('option');
      nuovo.value = NUOVO;
      nuovo.textContent = NUOVO;
      els.salvaGruppo.appendChild(nuovo);

      els.salvaNuovoCampo.hidden = true;
      els.salvaNuovo.value = '';
      els.salvaModale.hidden = false;
      els.salvaNome.focus();
      els.salvaNome.select();

      function chiudi(esito) {
        els.salvaModale.hidden = true;
        els.salvaConferma.removeEventListener('click', conferma);
        els.salvaAnnulla.removeEventListener('click', annulla);
        els.salvaModale.removeEventListener('keydown', tasto);
        els.salvaGruppo.removeEventListener('change', cambiaGruppo);
        risolvi(esito);
      }

      function conferma() {
        var nome = String(els.salvaNome.value || '').trim() || proposto;
        var gruppo = els.salvaGruppo.value;

        if (gruppo === NUOVO) {
          gruppo = String(els.salvaNuovo.value || '').trim();
          if (!gruppo) {
            toast('Scrivi il nome del nuovo gruppo.', 'error');
            els.salvaNuovo.focus();
            return;
          }
          try {
            Campagna.store.creaGruppo(gruppo);
          } catch (err) {
            // se esiste già va benissimo: si usa quello
          }
        }

        chiudi({ name: nome, group: gruppo || null });
      }

      function annulla() {
        chiudi(null);
      }

      function tasto(evento) {
        if (evento.key === 'Escape') annulla();
        if (evento.key === 'Enter' && evento.target !== els.salvaNuovo) conferma();
      }

      function cambiaGruppo() {
        var nuovoScelto = els.salvaGruppo.value === NUOVO;
        els.salvaNuovoCampo.hidden = !nuovoScelto;
        if (nuovoScelto) els.salvaNuovo.focus();
      }

      els.salvaConferma.addEventListener('click', conferma);
      els.salvaAnnulla.addEventListener('click', annulla);
      els.salvaModale.addEventListener('keydown', tasto);
      els.salvaGruppo.addEventListener('change', cambiaGruppo);
    });
  }

  function loadRecord(record) {
    var feature = findFeatureByRecordId(record.id);

    if (!feature) {
      feature = Campagna.store.toFeature(record);
      if (!feature) {
        toast('Questo appezzamento non è caricabile.', 'error');
        return;
      }
      Campagna.draw.addFeature(feature);
    }

    Campagna.draw.setActiveFeature(feature);
    Campagna.draw.refreshActive();
    Campagna.map.zoomToFeature(feature);
    renderSavedList();
  }

  function renameRecord(record) {
    var input = window.prompt('Nuovo nome:', record.name || 'Appezzamento');
    if (input === null) return;

    var name = String(input).trim();
    if (!name) return;

    Campagna.store.rename(record.id, name);

    var feature = findFeatureByRecordId(record.id);
    if (feature) feature.set('name', name);

    toast('Nome aggiornato.');
  }

  function deleteRecord(record) {
    var confirmed = window.confirm(
      'Eliminare definitivamente «' + (record.name || 'Appezzamento') + '» dal salvataggio locale?'
    );
    if (!confirmed) return;

    var feature = findFeatureByRecordId(record.id);
    if (feature) Campagna.draw.removeFeature(feature);

    Campagna.store.remove(record.id);
    toast('Appezzamento eliminato.');
  }

  // ------------------------------------------------------------- esportazione

  function downloadImage() {
    var feature = Campagna.draw.getActiveFeature();
    if (!feature) {
      toast('Seleziona o disegna un appezzamento da esportare.', 'error');
      return;
    }

    var misure = Campagna.measure.describe(feature.getGeometry());
    var name = feature.get('name') || 'Appezzamento';
    els.download.disabled = true;
    els.download.textContent = 'Preparazione…';

    // Senza l'inoltro /catasto (per esempio con Live Server) le immagini WMS
    // sono cross-origin e senza header CORS: sporcherebbero il canvas e
    // impedirebbero di generare il PNG. Si esclude quindi il catasto per la
    // durata dell'esportazione.
    var escludiCatasto = !Campagna.catasto.isProxyAvailable();
    if (escludiCatasto) Campagna.catasto.setVisible(false);

    function ripristina() {
      if (escludiCatasto) Campagna.catasto.setVisible(true);
      els.download.disabled = false;
      els.download.textContent = 'Scarica immagine PNG';
    }

    // Cosa c'è dentro l'area (comuni, fogli, numeri di particella): si chiede
    // prima di comporre l'immagine, così finisce nella fascia dati.
    var dentro = escludiCatasto || !Campagna.numeri
      ? Promise.resolve(null)
      : Campagna.numeri.infoArea(feature.getGeometry());

    dentro
      .catch(function () {
        return null;
      })
      .then(function (catastoDentro) {
        return Campagna.exporter.download({
          map: Campagna.map.getMap(),
          feature: feature,
          misure: misure,
          name: name,
          // il gruppo va scritto accanto al nome nella fascia dell'immagine
          group: (function () {
            var record = feature.get('recordId') && Campagna.store.get(feature.get('recordId'));
            return record ? record.group : null;
          })(),
          baseName: Campagna.map.getBaseName(),
          catastoLabels: escludiCatasto ? [] : Campagna.catasto.activeLabels(),
          catastoDentro: catastoDentro
        });
      })
      .then(function (size) {
        ripristina();
        if (escludiCatasto) {
          toast(
            'Immagine scaricata (' +
              Math.round(size / 1024) +
              ' KB) ma senza il catasto: avvia l\u2019app con «npm run dev» per includerlo.',
            'error'
          );
        } else {
          toast('Immagine scaricata (' + Math.round(size / 1024) + ' KB).');
        }
      })
      .catch(function (err) {
        ripristina();
        console.error('[export]', err);
        toast(err.message, 'error');
      });
  }

  /** Ricarica dallo storage tutti gli appezzamenti salvati. */
  function restoreSaved() {
    Campagna.store.all().forEach(function (record) {
      var feature = Campagna.store.toFeature(record);
      if (!feature) return;
      Campagna.draw.addFeature(feature);
      var misure = Campagna.measure.describe(feature.getGeometry());
      Campagna.map.setMeasureLabel(feature, misure.labelText);
    });
  }

  // ------------------------------------------------------------------- avvio

  var lastActiveRecordId = '__init__';

  function cacheElements() {
    els = {
      toast: document.getElementById('toast'),
      area: document.getElementById('m-area'),
      perimeter: document.getElementById('m-perimeter'),
      vertices: document.getElementById('m-vertices'),
      save: document.getElementById('btn-save'),
      download: document.getElementById('btn-download'),
      modify: document.getElementById('btn-modify'),
      del: document.getElementById('btn-delete'),
      drawHint: document.getElementById('draw-hint'),
      savedList: document.getElementById('saved-list'),
      savedCount: document.getElementById('saved-count'),
      exportJson: document.getElementById('btn-export-json'),
      importJson: document.getElementById('btn-import-json'),
      importFile: document.getElementById('import-file'),
      salvaModale: document.getElementById('salva-modale'),
      salvaNome: document.getElementById('salva-nome'),
      salvaGruppo: document.getElementById('salva-gruppo'),
      salvaNuovoCampo: document.getElementById('salva-nuovo-gruppo-campo'),
      salvaNuovo: document.getElementById('salva-nuovo-gruppo'),
      salvaConferma: document.getElementById('salva-conferma'),
      salvaAnnulla: document.getElementById('salva-annulla'),
      maniglia: document.getElementById('maniglia-pannello'),
      chiudiPannello: document.getElementById('chiudi-pannello'),
      menuCerca: document.getElementById('rapido-cerca-pannello'),
      menuDisegna: document.getElementById('rapido-disegna-pannello'),
      rapidoCerca: document.getElementById('rapido-cerca'),
      rapidoDisegna: document.getElementById('rapido-disegna'),
      barraMisure: document.getElementById('barra-misure'),
      barraArea: document.getElementById('b-area'),
      barraPerimetro: document.getElementById('b-perimetro'),
      barraSalva: document.getElementById('barra-salva'),
      barraPng: document.getElementById('barra-png'),
      clearAll: document.getElementById('btn-clear-all'),
      nuovoGruppo: document.getElementById('group-nuovo'),
      creaGruppo: document.getElementById('btn-nuovo-gruppo')
    };
  }

  function wireTools() {
    toolButtons = Array.prototype.slice.call(
      document.querySelectorAll('#draw-tools button[data-tool]')
    );

    toolButtons.forEach(function (button) {
      button.addEventListener('click', function () {
        var tool = button.getAttribute('data-tool');
        Campagna.draw.setTool(Campagna.draw.getTool() === tool ? null : tool);
      });
    });

    els.modify.addEventListener('click', function () {
      Campagna.draw.setTool(Campagna.draw.getTool() === 'Modify' ? null : 'Modify');
    });

    els.del.addEventListener('click', function () {
      var removed = Campagna.draw.deleteActive();
      if (!removed) {
        toast('Nessun appezzamento selezionato.', 'error');
        return;
      }
      var recordId = removed.get('recordId');
      if (recordId) Campagna.store.remove(recordId);
      toast('Appezzamento rimosso dalla mappa.');
    });

    els.save.addEventListener('click', saveActive);
    els.download.addEventListener('click', downloadImage);

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        Campagna.draw.setTool(null);
      } else if (event.key === 'Enter' && Campagna.draw.getTool() === 'Modify') {
        Campagna.draw.setTool(null);
      }
    });
  }

  function wireStorage() {
    els.exportJson.addEventListener('click', function () {
      var count = Campagna.store.exportJson();
      if (!count) {
        toast('Non ci sono appezzamenti da esportare.', 'error');
        return;
      }
      toast('Esportati ' + count + ' appezzamenti in JSON.');
    });

    els.importJson.addEventListener('click', function () {
      els.importFile.click();
    });

    els.importFile.addEventListener('change', function () {
      var file = els.importFile.files && els.importFile.files[0];
      if (!file) return;

      var reader = new FileReader();

      reader.onload = function () {
        try {
          var outcome = Campagna.store.importJson(String(reader.result));
          toast('Importati: ' + outcome.added + ' nuovi, ' + outcome.replaced + ' sostituiti.');
          Campagna.draw.clearFeatures();
          restoreSaved();
          renderSavedList();
        } catch (err) {
          toast(err.message, 'error');
        }
      };

      reader.onerror = function () {
        toast('Lettura del file non riuscita.', 'error');
      };

      reader.readAsText(file);
      els.importFile.value = '';
    });

    // Le sezioni del pannello si aprono e si chiudono toccando il titolo.
    Array.prototype.forEach.call(document.querySelectorAll('#sidebar .panel'), function (sezione) {
      var titolo = sezione.querySelector('h2');
      if (!titolo) return;
      titolo.setAttribute('role', 'button');
      titolo.setAttribute('tabindex', '0');
      titolo.addEventListener('click', function () {
        sezione.classList.toggle('aperta');
      });
      titolo.addEventListener('keydown', function (evento) {
        if (evento.key === 'Enter' || evento.key === ' ') {
          evento.preventDefault();
          sezione.classList.toggle('aperta');
        }
      });
    });

    /** Apre il pannello dal basso su una sezione precisa. */
    function apriSezione(indice) {
      var sezioni = document.querySelectorAll('#sidebar .panel');
      Array.prototype.forEach.call(sezioni, function (sezione, i) {
        sezione.classList.toggle('aperta', i === indice);
      });
      var pannello = document.getElementById('sidebar');
      pannello.classList.add('aperta');
      if (els.maniglia) els.maniglia.setAttribute('aria-expanded', 'true');

      var scelta = sezioni[indice];
      if (scelta) {
        setTimeout(function () {
          scelta.scrollIntoView({ block: 'start', behavior: 'smooth' });
          Campagna.map.getMap().updateSize();
        }, 300);
      }
    }

    function indiceSezione(testo) {
      var sezioni = document.querySelectorAll('#sidebar .panel');
      for (var i = 0; i < sezioni.length; i += 1) {
        var titolo = sezioni[i].querySelector('h2');
        if (titolo && titolo.textContent.trim().indexOf(testo) === 0) return i;
      }
      return -1;
    }

    /**
     * I menu rapidi sulla mappa: ci si sposta dentro la sezione corrispondente
     * del pannello, così i comandi sono quelli di sempre ma in una scheda
     * piccola. Su schermo grande le sezioni restano dove sono: lo spostamento
     * avviene solo quando serve, e si annulla tornando in grande.
     */
    var sezioniSpostate = [];

    function schermoPiccolo() {
      return window.matchMedia(
        '(max-width: 860px), (pointer: coarse) and (max-width: 1100px)'
      ).matches;
    }

    function sezioneConTitolo(testo) {
      var trovate = document.querySelectorAll('#sidebar .panel');
      for (var i = 0; i < trovate.length; i += 1) {
        var h2 = trovate[i].querySelector('h2');
        if (h2 && h2.textContent.trim().indexOf(testo) === 0) return trovate[i];
      }
      return null;
    }

    /** Il segnalibro dei salvati sta nella stessa colonna delle scorciatoie. */
    function sistemaManiglia() {
      var maniglia = els.maniglia;
      var colonna = document.getElementById('comandi-rapidi');
      if (!maniglia || !colonna) return;
      var postoOriginale = maniglia.getAttribute('data-posto') || 'corpo';

      if (schermoPiccolo()) {
        if (maniglia.parentNode !== colonna) colonna.appendChild(maniglia);
      } else if (maniglia.parentNode !== document.body) {
        document.body.appendChild(maniglia);
      }
    }

    function sistemaSezioni() {
      sistemaManiglia();
      var piccolo = schermoPiccolo();
      var cerca = sezioneConTitolo('Cerca');
      var disegno = sezioneConTitolo('Disegno');

      if (piccolo && !sezioniSpostate.length) {
        [
          [cerca, els.menuCerca],
          [disegno, els.menuDisegna]
        ].forEach(function (coppia) {
          var sezione = coppia[0];
          var menu = coppia[1];
          if (!sezione || !menu) return;
          var contenuto = menu.querySelector('.menu-rapido-contenuto');
          sezioniSpostate.push({ sezione: sezione, dove: sezione.parentNode });
          contenuto.appendChild(sezione);
        });

        // nel pannello dal basso restano solo le aree salvate
        Array.prototype.forEach.call(
          document.querySelectorAll('#sidebar .panel'),
          function (sezione) {
            var h2 = sezione.querySelector('h2');
            if (!h2) return;
            var titolo = h2.textContent.trim();
            if (
              titolo.indexOf('Visualizzazione') === 0 ||
              titolo.indexOf('Misure') === 0
            ) {
              sezione.setAttribute('data-mobile', 'nascosta');
            }
          }
        );
      }

      if (!piccolo && sezioniSpostate.length) {
        sezioniSpostate.forEach(function (voce) {
          voce.dove.appendChild(voce.sezione);
        });
        sezioniSpostate = [];
      }

      Array.prototype.forEach.call(
        document.querySelectorAll('#sidebar .panel'),
        function (sezione) {
          if (!piccolo) sezione.removeAttribute('data-mobile');
        }
      );
    }

    ['rapido-cerca-pannello', 'rapido-disegna-pannello'].forEach(function (id) {
      var menu = document.getElementById(id);
      if (!menu) return;
      var chiudi = menu.querySelector('.menu-rapido-chiudi');
      if (chiudi) {
        chiudi.addEventListener('click', function () {
          menu.hidden = true;
        });
      }
    });

    sistemaSezioni();
    window.addEventListener('resize', function () {
      clearTimeout(sistemaSezioni.attesa);
      sistemaSezioni.attesa = setTimeout(sistemaSezioni, 250);
    });

    if (els.rapidoCerca && els.menuCerca) {
      els.rapidoCerca.addEventListener('click', function () {
        if (els.menuDisegna) els.menuDisegna.hidden = true;
        els.menuCerca.hidden = !els.menuCerca.hidden;
      });
    }

    if (els.rapidoDisegna && els.menuDisegna) {
      els.rapidoDisegna.addEventListener('click', function () {
        if (els.menuCerca) els.menuCerca.hidden = true;
        els.menuDisegna.hidden = !els.menuDisegna.hidden;
      });
    }

    // La barra delle misure riprende i pulsanti che stanno nel pannello.
    if (els.barraSalva) {
      els.barraSalva.addEventListener('click', function () {
        document.getElementById('btn-save').click();
      });
    }
    if (els.barraPng) {
      els.barraPng.addEventListener('click', function () {
        document.getElementById('btn-download').click();
      });
    }

    if (els.chiudiPannello) {
      els.chiudiPannello.addEventListener('click', function () {
        document.getElementById('sidebar').classList.remove('aperta');
        if (els.maniglia) els.maniglia.setAttribute('aria-expanded', 'false');
        setTimeout(function () {
          Campagna.map.getMap().updateSize();
        }, 280);
      });
    }

    if (els.maniglia) {
      els.maniglia.addEventListener('click', function () {
        var pannello = document.getElementById('sidebar');
        // dal segnalibro si aprono le aree salvate
        var salvati = indiceSezione('Aree salvate');
        if (salvati !== -1 && !pannello.classList.contains('aperta')) {
          apriSezione(salvati);
          return;
        }
        var aperto = pannello.classList.toggle('aperta');
        els.maniglia.setAttribute('aria-expanded', aperto ? 'true' : 'false');
        // la mappa va ridisegnata: cambia lo spazio visibile
        setTimeout(function () {
          Campagna.map.getMap().updateSize();
        }, 280);
      });
    }

    if (els.creaGruppo) {
      els.creaGruppo.addEventListener('click', function () {
        var nome = els.nuovoGruppo ? els.nuovoGruppo.value : '';
        if (!String(nome).trim()) {
          toast('Scrivi il nome del gruppo.', 'error');
          return;
        }
        try {
          Campagna.store.creaGruppo(nome);
          gruppiAperti[String(nome).trim()] = true;
          if (els.nuovoGruppo) els.nuovoGruppo.value = '';
          toast('Gruppo creato.');
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    }

    els.clearAll.addEventListener('click', function () {
      if (!Campagna.store.all().length) {
        toast('Non ci sono appezzamenti salvati.', 'error');
        return;
      }
      if (!window.confirm('Eliminare tutti gli appezzamenti salvati localmente?')) return;
      Campagna.store.clear();
      Campagna.draw.clearFeatures();
      toast('Salvataggio locale svuotato.');
    });
  }

  function init() {
    cacheElements();

    // 1. Mappa: crea anche i layer catastali e i relativi controlli
    Campagna.map.init('map', {
      // il contenitore nasce con i controlli della mappa: si cerca adesso
      catastoContainer: document.getElementById('catasto-controls'),
    });

    // 2. Disegno e misure
    Campagna.draw.init(Campagna.map.getMap(), Campagna.map.getVectorSource(), {
      onChange: function (feature, misure) {
        renderMeasure(feature, misure);

        // La lista viene ridisegnata solo quando cambia il record selezionato:
        // durante il trascinamento dei vertici sarebbe uno spreco.
        var id = feature ? feature.get('recordId') || null : null;
        if (id !== lastActiveRecordId) {
          lastActiveRecordId = id;
          renderSavedList();
        }
      },
      onToolChange: renderTool
    });

    // 3. Interfaccia
    wireTools();
    wireStorage();
    renderTool(null);
    Campagna.store.subscribe(renderSavedList);

    // 3b. Numeri delle particelle disegnati dall'app
    if (Campagna.numeri) Campagna.numeri.init(Campagna.map.getMap());

    // 3c. Ricerca per comune / foglio / particella
    if (Campagna.ricerca) Campagna.ricerca.init(Campagna.map.getMap());

    // 3d. Informazioni di un punto della mappa
    if (Campagna.punto) Campagna.punto.init(Campagna.map.getMap());

    // 3e. Se ci sono appezzamenti salvati, la mappa si apre su quelli
    inquadraAppezzamentiSalvati();

    // 4. Appezzamenti già salvati sul dispositivo
    restoreSaved();
    renderSavedList();
    renderMeasure(null, null);

  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return { init: init };
})();

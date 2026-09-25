# CALCOLAREA

Web app per **disegnare appezzamenti di terreno** su mappa o vista satellitare, leggerne
**superficie e perimetro**, sovrapporre la **cartografia catastale italiana** ed esportare
un'**immagine PNG** con l'appezzamento evidenziato e i dati.

## Funzionalità

- **Mappa** con due sfondi intercambiabili: **Mappa** (OpenStreetMap) e **Satellite**
  (Esri World Imagery). I comandi — sfondo ed **etichette dei luoghi**, queste ultime
  accese di default — stanno **sulla mappa**, sotto i pulsanti di zoom, perché si usano
  guardando la mappa e non cercandoli nel pannello.
- **Disegno rapido** di poligoni (click sui vertici), rettangoli (trascina) e cerchi
  (centro + raggio), più **modifica dei vertici** e **snap** sui contorni esistenti.
- **Superficie e perimetro calcolati in tempo reale** (geodetici, ellissoide WGS84)
  mentre si disegna o si spostano i vertici. Formattazione automatica m² → ha → km²,
  con anche il valore in acri.
- **Cartografia catastale** dell'Agenzia delle Entrate come overlay, con **slider di
  opacità indipendenti** per ogni livello (particelle, **numeri delle particelle**,
  fogli/zone, fabbricati, strade e acque) e, nel pannello, **zoom e scala correnti**
  sempre visibili: ogni livello si accende solo entro il proprio intervallo di scala, e
  un pulsante «Portami a zoom …» ci porta direttamente. Contorni e numeri delle particelle
  sono un layer solo: si vedono sempre insieme. Il layer più in basso riceve dal
  servizio anche uno **sfondo pieno**, così le linee verdi restano leggibili anche sopra
  la vista satellitare. Ogni vista è **una sola immagine** per layer: la carta compare
  tutta insieme, mai a pezzi.
- **Ricerca di una particella** per **regione → comune → foglio → particella**, con foglio
  e particella facoltativi: solo il comune inquadra il comune, con il foglio si inquadra il
  foglio, con la particella si arriva alla singola (e il contorno esatto viene evidenziato
  in rosso, chiesto al WFS dell'Agenzia delle Entrate).
- **Salvataggio locale** degli appezzamenti (localStorage), con **gruppi** (cartelle)
  richiudibili, nomi per esteso, rinomina, spostamento ed eliminazione, oltre a
  **export/import JSON** come copia di sicurezza.
- **Download PNG** con lo sfondo in uso, l'appezzamento evidenziato e una fascia dati con
  superficie, perimetro, acri, vertici, centro, **i comuni (con la regione), i fogli e i
  numeri di tutte le particelle che l'area contiene o anche solo tocca**, data e
  attribuzioni.

## Avvio in locale

Serve solo Node.js (>= 20). Non ci sono dipendenze da installare.

```bash
npm run dev          # oppure: node scripts/dev-proxy.js
```

Poi apri <http://localhost:5173>.

`scripts/dev-proxy.js` fa due cose: serve i file statici **e** inoltra le richieste
`/catasto/*` al WMS e `/wfs/*` al WFS dell'Agenzia delle Entrate, replicando esattamente
i rewrite di produzione. Per questo non basta aprire `index.html` come file: la mappa
funziona, ma l'overlay catastale no.

Su una porta diversa:

```bash
PORT=8080 node scripts/dev-proxy.js
```

## Deploy su Vercel

Il progetto è di fatto **statico**: l'unica cosa che Vercel deve fare è inoltrare due
rotte, cosa che si ottiene con poche righe di configurazione. Non ci sono funzioni
serverless, quindi il consumo di risorse resta minimo e **rientra nel piano Hobby
gratuito**.

```bash
npm i -g vercel
vercel            # primo deploy
vercel --prod     # messa in produzione
```

In alternativa, importa il repository da <https://vercel.com/new>: Vercel rileva un
sito statico e applica `vercel.json` automaticamente.

`vercel.json`:

```json
{
  "rewrites": [
    {
      "source": "/catasto/:resource",
      "destination": "https://wms.cartografia.agenziaentrate.gov.it/inspire/wms/:resource"
    },
    {
      "source": "/wfs/:resource",
      "destination": "https://wfs.cartografia.agenziaentrate.gov.it/inspire/wfs/:resource"
    }
  ]
}
```

Per provare in locale esattamente ciò che gira su Vercel puoi usare `vercel dev` al
posto di `npm run dev`.

## Struttura del progetto

```
├── index.html              interfaccia: mappa, strumenti, misure, ricerca, catasto, aree
├── vercel.json             rewrite /catasto/* -> WMS e /wfs/* -> WFS Agenzia Entrate
├── package.json            solo lo script "dev"
├── css/style.css           stile dell'interfaccia
├── data/comuni.json        elenco comuni (regione, provincia, codice catastale)
├── js/
│   ├── config.js           configurazione (URL catasto, proiezione, vista, attribuzioni)
│   ├── measure.js          superfici e perimetri geodetici + formattazione
│   ├── store.js            salvataggio locale (appezzamenti e gruppi), export/import JSON
│   ├── catasto.js          overlay WMS, soglie di scala, sfondo dei layer
│   ├── map.js              mappa OpenLayers, sfondi, layer vettoriale, controlli
│   ├── draw.js             disegno, modifica vertici, selezione, misure live
│   ├── export.js           composizione ed esportazione dell'immagine PNG
│   ├── ricerca.js          ricerca particella (comune/foglio/particella) + contorno WFS
│   ├── numeri.js           numeri delle particelle disegnati dall'app
│   └── main.js             collegamento fra interfaccia e moduli
├── test/self-test.html     test end-to-end eseguito in un browser reale
└── scripts/dev-proxy.js    server di sviluppo + inoltro catasto e WFS
```

Non c'è alcun bundler: OpenLayers è caricato da CDN come build UMD
(`ol@10.10.0/dist/ol.js`) e i moduli comunicano tramite un unico namespace globale
`Campagna`. Per questo `index.html` carica gli script in un ordine preciso. Le due
librerie della ricerca (`hyparquet` e il suo decompressore ZSTD) sono invece caricate
**solo quando servono**, con un `import()` dinamico da CDN.

## Scelte tecniche e perché

Le decisioni seguenti derivano da **verifiche eseguite direttamente sul servizio
catastale**, non da assunzioni.

### 1. OpenLayers invece di Leaflet

Il servizio catastale **non supporta EPSG:3857** (Web Mercator), la proiezione usata da
Leaflet e da quasi tutte le mappe web. Verificato con una `GetMap` di prova:

| CRS richiesto | Esito |
|---|---|
| `EPSG:3857` | `ServiceException` — `InvalidFormat` |
| `EPSG:4258` | PNG valido |
| `EPSG:6706` | PNG valido |
| `CRS:84` | PNG valido |

OpenLayers sa richiedere le immagini in una proiezione diversa da quella della vista e
riproiettarle al volo (`projection` nel `source`). Leaflet non è in grado di farlo.
In più, OpenLayers include già tutto il resto: `ol.sphere.getArea`/`getLength` per le
misure geodetiche, `ol.interaction.Draw` (con `createBox()` per il rettangolo) e la
tecnica ufficiale di esportazione della mappa su canvas.

### 2. `EPSG:4258` registrato a runtime (con trasformazioni esplicite)

OpenLayers non conosce `EPSG:4258` (ETRS89) di default: va registrato, altrimenti la
riproiezione non è possibile.

`EPSG:4326` **non è utilizzabile come alternativa**: il servizio risponde con
`ServiceException — InvalidFormat` alla richiesta `SRS=EPSG:4326` (verificato). Serve
proprio `EPSG:4258`.

Due accorgimenti, entrambi scoperti grazie al test di `test/self-test.html`:

1. **Le trasformazioni vanno aggiunte a mano.** OpenLayers non concatena le
   trasformazioni: dichiarare `EPSG:4258` equivalente a `EPSG:4326` basta per
   `4258 <-> 4326`, ma **non** crea `4258 <-> 3857`. Senza quella, la richiesta WMS
   non parte affatto (il layer resta muto, senza errori evidenti). La soluzione è
   registrare `4258 <-> 3857` riutilizzando le trasformazioni di `EPSG:4326`.
2. **`axisOrientation: 'neu'`**, la stessa che OpenLayers usa per `EPSG:4326`, così le
   due proiezioni restano davvero equivalenti.

### 3. WMS 1.1.1 invece di 1.3.0

Nella specifica WMS 1.3.0 il `BBOX` va espresso nell'ordine degli assi della proiezione:
per `EPSG:4258` significa **lat,lon**. Verificato: a parità di area,

- `1.3.0` + `BBOX=lon,lat` → immagine vuota;
- `1.3.0` + `BBOX=lat,lon` → contenuto corretto;
- `1.1.1` + `BBOX=lon,lat` → contenuto corretto.

Si usa quindi **1.1.1**, dove il `BBOX` è sempre `minX,minY,maxX,maxY`, senza scambio di
assi. La richiesta è deterministica e non dipende da dettagli di configurazione del
client. (Confermato anche nel codice di OpenLayers: lo scambio degli assi avviene solo
per versioni `>= 1.3`.)

### 4. Perché serve un inoltro (il "proxy") per il catasto

Il WMS dell'Agenzia delle Entrate **non invia header CORS**. Conseguenze:

- l'overlay si vedrebbe comunque a schermo (una `<img>` non ha bisogno di CORS);
- ma il canvas della mappa resterebbe "sporcato", quindi `toBlob()` fallirebbe e le
  linee catastali **non potrebbero comparire nell'immagine esportata**.

Inoltrando la richiesta dal nostro dominio (`/catasto/*`) tutto diventa **same-origin**
per il browser: nessun CORS da gestire e canvas esportabile. L'inoltro è realizzato
dal rewrite di Vercel in produzione e da `scripts/dev-proxy.js` in sviluppo — stesso
percorso, stesso comportamento.

### 5. Ogni livello catastale si vede solo entro un intervallo di scala

I livelli catastali hanno limiti di scala lato server. Misurati in browser, contando i
pixel dell'area mappa che cambiano accendendo un solo layer (finestra da 1280 px, mappa
larga 908 px):

| Livello | Scala che il servizio pretende | Zoom a cui compare |
|---|---|---|
| `CP.CadastralZoning` (fogli / zone) | 5,0·10⁻⁴ gradi/px | **13** |
| `strade,acque` (viabilità e acque) | 1,2·10⁻⁴ | **12** |
| `fabbricati` | 1,6·10⁻⁵ | **15** |
| `CP.CadastralParcel` (particelle, **con i numeri**) | 1,6·10⁻⁵ (≈ 1:5.000) | **15** |

Le particelle compaiono da **zoom 15**, e non da zoom 19 come con una richiesta normale
(una `GetMap` grande quanto la vista è troppo grossolana): il punto 6 spiega come. I numeri
li disegna l'app (punto 7), quindi non alzano la soglia.

Lo zoom di comparsa **non è un numero fisso**: dipende da quanto è larga la mappa, perché
la `GetMap` non può superare 2048 px (punto 6). Su una mappa stretta le particelle
compaiono prima, su una larga dopo. L'app calcola la soglia vera per la larghezza corrente
(`zoomMinimoEffettivo`), la usa per decidere cosa mostrare e la scrive nell'avviso, invece
di dire un numero che potrebbe non valere.

Sotto zoom 11 il servizio non disegna **nulla**, e la vista iniziale è zoom 6 sull'Italia:
per questo l'app mostra sempre zoom e scala correnti e, quando un livello attivo è fuori
scala, lo dice e offre il pulsante per raggiungere lo zoom giusto. Fuori scala non viene
nemmeno inviata una richiesta a vuoto.

Attenzione a un dettaglio di OpenLayers: `minZoom` è **esclusivo** (`zoom > minZoom`). Un
layer con `minZoom: 17` resterebbe invisibile proprio a zoom 17, cioè dove l'app dice di
andare; il codice scavalca la soglia di un margine trascurabile (`MARGINE_MIN_ZOOM`).

### 6. Immagini ricomposte: la carta compare tutta insieme, anche a zoom 15

Due limiti del servizio, entrambi verificati, si sommano:

1. il WMS accetta al massimo **2048×2048 px** per `GetMap`: oltre risponde con una
   `ServiceException` XML, che OpenLayers — in attesa di un PNG — non sa decodificare. Il
   layer **non disegna nulla, a qualunque zoom, senza alcun errore visibile** (in console
   resta solo un `EncodingError: The source image cannot be decoded`). Il problema si
   presentava sugli schermi larghi, perché riproiettando da EPSG:3857 a EPSG:4258
   OpenLayers chiede un'immagine **più larga della mappa**: con 2028 px di mappa chiedeva
   `WIDTH=2726`, e oltre ~1500 px di mappa il catasto spariva del tutto;
2. le particelle si disegnano solo a scala fine: a zoom 15 la vista è a 4,3·10⁻⁵ gradi/px e
   il servizio ne vuole 1,6·10⁻⁵, cioè una immagine **2,7 volte** più grande della vista.
   Per una mappa da 908 px significherebbe 2436 px: oltre il limite.

La soluzione: la vista viene divisa nei **pezzi minori possibili** che coprono la scala
richiesta restando entro i 2048 px (a zoom 15 sono quattro, da zoom 16 in su uno solo), e
OpenLayers li **ricompone in un canvas unico**. All'utente la carta compare quindi *tutta
insieme*, mai a pezzi; il `BBOX` di ogni pezzo è esatto, quindi la geometria resta corretta.
Le immagini già scaricate restano in memoria (ultime 24) e si riusano spostandosi.

Misurato a 1280 px di finestra, solo particelle: 4 immagini e **2,9 MB a zoom 15**, 1
immagine e 0,55 MB a zoom 16, 1 e 0,22 MB a zoom 17.

**Perché non a tessere.** Con le tessere (griglia fissa da 512 px) la carta arriverebbe a
pezzi: misurato, 16-20 tessere per vista, una alla volta. Ricomporle in un canvas unico
costa la stessa banda e non si vede.

La filigrana «© Agenzia delle Entrate» che il servizio disegna dentro ogni immagine compare
quindi **una volta per pezzo** (a zoom 15, quattro): è l'attribuzione del servizio, che
resta anche nel controllo attribuzioni di OpenLayers, nel pannello e nell'immagine
esportata.

### 7. I numeri delle particelle li disegna l'app

Il servizio scrive il numero di ogni particella nel layer `codice_plla`, ma **solo a scala
molto più fine** di quella dei contorni. Misurata con passi fini, contando i pixel che
cambiano chiedendo anche `codice_plla`:

| Scala richiesta | Contorni | Numeri |
|---|---|---|
| 4,3·10⁻⁵ gradi/px (zoom 15) | disegnati | **nessun numero** |
| 2,0·10⁻⁵ | disegnati | **nessun numero** |
| 6,5·10⁻⁶ | disegnati | **nessun numero** |
| 6,0·10⁻⁶ | disegnati | numeri |

Il motivo è che il servizio disegna i numeri *dentro* la mappa che sta renderizzando: per
averli a zoom 15 bisognerebbe chiedergli la vista a 6·10⁻⁶, cioè **sette volte** più
grande, e poi rimpicciolirla di sette volte per mostrarla — il testo diventerebbe alto poco
più di un pixel. A zoom 15 servirebbero per giunta sedici immagini da 2048 px di soli
numeri (37 milioni di pixel da renderizzare).

I numeri si disegnano quindi **nell'app**, come testo vettoriale sopra la carta:

- restano leggibili a qualunque zoom (il corpo del testo va da 8,5 px a zoom 15 a 11,5 px
  da zoom 18 in su) e non costano nemmeno una richiesta in più;
- la posizione e il numero di ogni particella vengono dai dati aperti OnData (gli stessi
  della ricerca), letti **una volta per comune** e tenuti in memoria;
- il comune della vista si scopre chiedendo al servizio, per qualche punto, il foglio che
  lo contiene: la risposta riporta il riferimento del comune (es. `E202_0087D0`);
- OpenLayers nasconde da solo le etichette che si sovrappongono, partendo dalle particelle
  più grandi (stimate dalla distanza dalla particella più vicina): a zoom 15 restano
  quindi i numeri che hanno spazio per essere letti, come su una carta vera.

Contorni e numeri si vedono sempre insieme: l'interruttore è uno solo.

### 8. Uno sfondo solo, con un solo comando di opacità

Le linee catastali sono verdi e, sopra la vista satellitare, si perdono nel verde della
vegetazione: serve un fondo chiaro. Se però il fondo lo chiedesse al servizio
(`TRANSPARENT=false`), resterebbe impastato con le linee dentro la stessa immagine:
abbassando l'opacità del layer sbiadirebbero anche i contorni e i numeri — che è
esattamente ciò che non deve succedere.

Lo sfondo è quindi un **layer a parte, dell'app**: un rettangolo bianco sotto tutti i layer
catastali, con **un solo comando di opacità** valido per tutto il catasto (fogli,
particelle, fabbricati, strade e acque). Le immagini del servizio sono sempre chieste
trasparenti e i layer restano a **opacità piena**: linee e numeri non sbiadiscono mai.
Portando l'opacità a zero resta la sola cartografia a tratti, sopra la mappa o il
satellite.

### 9. La campitura delle particelle si toglie nel canvas

Il layer `CP.CadastralParcel` **riempie le particelle di beige**: misurato, il colore
(253, 236, 189) copre il **97-98%** dei pixel disegnati, ed è lo stesso in tutta Italia
(verificato a Grosseto, Milano e Palermo: 97%, 95%, 92%). Il servizio non offre uno stile
alternativo — l'unico stile dichiarato per quel layer è `default` — quindi quella
campitura coprirebbe il fondo dell'app e renderebbe inutile il suo comando di opacità.

Si toglie quindi **nell'app**, nel canvas dove le immagini del servizio vengono già
ricomposte: appena un pezzo arriva, i pixel della campitura diventano trasparenti. Le
soglie sono strette apposta (distanza ≤ 6 → trasparente, ≥ 12 → intatto): la campitura è
una tinta esatta, mentre i pixel sul bordo delle linee sono miscele linea+campitura, e con
una soglia larga sparirebbero anche quelle — a zoom alti, dove le linee sono spesse un
pixel, i contorni si sbiadirebbero fino a non vedersi più. Misurato sul risultato: la
campitura scende da **98% a 0%** e i pixel scuri delle linee restano **tutti** (5390 su
5390).

Costo: una passata sui pixel di ogni pezzo, una volta sola, fuori dal percorso di disegno
(~30-60 ms per pezzo). Se il servizio cambiasse tinta, il filtro semplicemente non
troverebbe più la campitura e tutto tornerebbe come prima: la costante da aggiornare è
`fondoDaTogliere` nella definizione del layer.

### 10. Perché lo slider «Cartografia catastale (gruppo)» non esiste più

Il layer di gruppo `Cartografia_Catastale` **non è utilizzabile come overlay**: qualunque
`BBOX` e qualunque `STYLES` si chiedano, il servizio restituisce sempre la stessa
immagine fissa dell'Italia con le sigle delle province (verificato: `md5` identico per
`BBOX` da 0,6° e da 0,00045°). Al suo posto lo slider offre `strade,acque`, i due livelli
geografici che compongono quel gruppo e che rispondono davvero al `BBOX`.

### 11. Esportazione PNG: come è composta

Si segue l'approccio dell'esempio ufficiale "export map" di OpenLayers:

1. la vista viene momentaneamente inquadrata sull'appezzamento;
2. si attende `rendercomplete`, che segnala il caricamento di tutti i tile e layer;
3. i canvas dei singoli layer vengono ricomposti in un unico canvas, rispettando
   opacità e trasformazioni (quindi **lo slider di opacità del catasto si ritrova
   identico nell'immagine scaricata**);
4. si aggiunge una fascia con titolo, superficie, perimetro, acri, vertici, centro,
   data e attribuzioni;
5. si esporta con `toBlob()` e si ripristina la vista precedente.

Funziona perché OpenStreetMap ed Esri inviano `Access-Control-Allow-Origin: *`
(verificato) e i layer catastali sono same-origin grazie all'inoltro.

### 12. Cercare una particella: perché servono i dati di OnData

Il servizio dell'Agenzia **non sa cercare per attributo**, e non è una svista di questa
app — è stato verificato su entrambi i servizi:

| Prova | Esito |
|---|---|
| WMS `GetMap` con `FILTER` | `ServiceException` `InvalidFormat` |
| WFS `GetFeature` con filtro FES | `ServiceException` `InvalidFormat` |
| WFS `GetFeature` con `CQL_FILTER=LABEL='999999'` | HTTP 200 con la **stessa** particella: il filtro è ignorato |
| `GetFeatureInfo` (che pure conosce `NationalCadastralReference`) | risponde solo per un punto cliccato, non si può interrogare per attributo |

Resta la geometria: il WFS `wfs.cartografia.agenziaentrate.gov.it/inspire/wfs/owfs01.php`
(che esiste davvero, ed è distinto dal WMS) risponde a un `BBOX` con le particelle
contenute, **con la loro geometria e il loro identificativo** (`NATIONALCADASTRALREFERENCE`,
es. `E202_0087D0.888`), ma il riquadro è limitato a circa 2 km: per trovare una particella
in un comune intero servirebbero decine di richieste e decine di MB.

Per passare da (comune, foglio, particella) a un punto si usano quindi i **dati aperti di
[OnData](https://github.com/ondata/dati_catastali)** (licenza CC BY 4.0), che contengono il
punto interno di ogni particella d'Italia con le chiavi `comune`, `foglio`, `particella`.
I file regionali pesano 6–72 MB e non si scaricano interi: si legge **solo la parte che
serve**, con richieste HTTP Range. Il file è ordinato per comune e ogni blocco (row group)
porta le statistiche min/max della colonna `comune`, quindi si saltano i blocchi che non
possono contenere il comune cercato. Misurato: **7 richieste, ~1,6 MB e 0,3–3,5 s** per
ricerca, con `hyparquet` e il suo decompressore ZSTD caricati da CDN solo al primo uso.

| Ricerca | File regionale | Blocchi letti | Esito | Dati |
|---|---|---|---|---|
| E202 (Grosseto) foglio 87 particella 888 | 09_Toscana (5,7 M righe) | 1 su 57 | 42,750394 · 11,100643 | 1,6 MB, 0,5 s |
| F205 (Milano) foglio 390 particella 270 | 03_Lombardia (8,8 M righe) | 2 su 88 | 45,463868 · 9,190104 | 1,6 MB, 3,5 s |
| M011 (Villarosa) foglio 2 particella 2 | 19_Sicilia (8,2 M righe) | 1 su 83 | 37,639896 · 14,181642 | 1,6 MB, 2,7 s |

Le coordinate così trovate sono state verificate contro il WFS: per `M011/2/2` il contorno
restituito è proprio `M011_000200.2`.

Trovato il punto, il contorno esatto si chiede al WFS con un riquadro di ±40 m attorno al
punto (bastano poche decine di KB). Il GML si legge a mano: MapServer incapsula la
geometria in un elemento non standard (`CP:msGeometry`) che `ol.format.WFS` non riconosce
— provato, restituisce zero feature.

### Come si comporta la ricerca con i campi vuoti

Solo il **comune** è obbligatorio; foglio e particella sono facoltativi e la ricerca si
ferma al livello di dettaglio che le è stato chiesto:

| Inserito | Cosa fa |
|---|---|
| solo comune | inquadra l'intero comune (sono tutte le sue particelle a definire il riquadro) |
| comune + foglio | inquadra il foglio |
| comune + particella | se il numero esiste in **un solo** foglio va sulla particella e ne carica il contorno; se esiste in più fogli li inquadra tutti e ti dice quali sono |

Un numero di particella da solo, infatti, non è univoco nemmeno dentro un comune: a
Grosseto la particella `888` esiste in 9 fogli diversi e la `1` in 40. Per questo il
foglio serve solo quando il numero è ambiguo.

**Limiti da conoscere:** il **Trentino-Alto Adige non è coperto** (non è nell'archivio) e i
dati sono la fotografia dell'ultimo aggiornamento del dataset (maggio 2025): particelle
nate dopo possono mancare. L'elenco dei comuni proposto dall'app (`data/comuni.json`,
211 KB, caricato solo alla prima ricerca) è già filtrato su quelli presenti nell'archivio.

## Dati catastali: cosa si può avere (e cosa no)

Fonte: **Agenzia delle Entrate — WMS "Cartografia Catastale"** (INSPIRE View Service),
`https://wms.cartografia.agenziaentrate.gov.it/inspire/wms/ows01.php`.

| Aspetto | Valore |
|---|---|
| Licenza | **CC BY 4.0** (`<Fees>CC BY 4.0</Fees>`, `<AccessConstraints>Dato pubblico</AccessConstraints>`) |
| Riuso | consentito con **attribuzione obbligatoria** all'Agenzia delle Entrate |
| Copertura | tutta l'Italia |
| Formato | PNG/JPEG, max 2048×2048 px |
| Proiezioni | `EPSG:4258`, `EPSG:6706`, `EPSG:25832/33/34`, `EPSG:3044/45/46` — **non** `EPSG:3857` |

Livelli disponibili, esposti nell'app come slider di opacità:

| Livello | Contenuto | Visibile da | Attivo di default |
|---|---|---|---|
| `CP.CadastralParcel` + numeri disegnati dall'app | **particelle catastali con i numeri** | zoom 15 | sì |
| `CP.CadastralZoning` | fogli / zone censuarie | zoom 11 | sì |
| `fabbricati` | sagome degli edifici | zoom 16 | no |
| `strade,acque` | viabilità e acque della cartografia catastale | zoom 12 | no |

Lo zoom di comparsa dipende dalla larghezza della mappa (vedi la voce 6): i valori qui
sopra sono per una mappa da 908 px.

I numeri li disegna l'app sopra i contorni (vedi la voce 7 fra le scelte tecniche): si
vedono sempre insieme alle particelle, mai uno senza l'altro. Il numero compare dove c'è
spazio per leggerlo, quindi sulle particelle più piccole può mancare.

Il gruppo `Cartografia_Catastale` esiste nel servizio ma **non è utilizzabile** come
overlay (restituisce sempre la stessa immagine fissa dell'Italia, qualunque `BBOX`): vedi
la voce 10 fra le scelte tecniche.

### Cosa **non** si può avere

I dati **censuari/alfanumerici** — intestatari, subalterni, rendite, visure — **non sono
open data**: richiedono l'accesso ai servizi dell'Agenzia (Sister, visure a pagamento).
Questa app può quindi mostrare e misurare le **sagome** delle particelle, ma non
riportare la proprietà o i dati catastali reddituali.

### Attribuzioni (obbligatorie)

Sono già incluse nell'interfaccia e nell'immagine esportata:

- Cartografia catastale © Agenzia delle Entrate (CC BY 4.0)
- © OpenStreetMap contributors
- Imagery © Esri, Maxar, Earthstar Geographics
- Particelle per la ricerca: dati resi disponibili da
  [OnData](https://github.com/ondata/dati_catastali) (CC BY 4.0)

## Limiti e avvertenze

- **Uso commerciale.** Il piano Vercel Hobby è pensato per progetti personali/non
  commerciali; per un prodotto commerciale serve il piano Pro. Analogamente i tile Esri
  World Imagery sono gratuiti con attribuzione per uso non commerciale: per volumi
  elevati o uso commerciale conviene una sottoscrizione Esri o un altro provider
  (MapTiler, Google) con API key.
- **Salvataggio locale.** Gli appezzamenti stanno nel `localStorage` del browser: non
  sono sincronizzati, non sono condivisi tra dispositivi e possono andare persi
  cancellando i dati del sito. Usa **Esporta JSON** per le copie di sicurezza.
- **Tile OpenStreetMap.** Il servizio pubblico è adatto a un uso leggero; per volumi
  consistenti va usato un provider dedicato o un server di tile proprio.
- **Accuratezza delle misure.** Le superfici sono geodetiche (ellissoide WGS84) e si
  riferiscono al contorno disegnato a mano: non sostituiscono un rilievo topografico
  né una misura catastale ufficiale.
- **Il cerchio.** Lo strumento cerchio usa il raggio in metri di Web Mercator: a
  latitudini italiane la circonferenza disegnata corrisponde a un cerchio a terra più
  piccolo (fattore `cos(lat)`), ma **la superficie riportata è quella reale a terra**.
  Per lavori precisi conviene comunque tracciare il contorno con il poligono.
- **Circa il file `vercel.json`.** I rewrite inoltrano `/catasto/*` verso il WMS e
  `/wfs/*` verso il WFS. Se in futuro i servizi cambiassero dominio o percorso, vanno
  aggiornati quel file **e** le costanti `UPSTREAM` / `UPSTREAM_WFS` in
  `scripts/dev-proxy.js`.
- **Ricerca particella.** Dipende da un archivio di terze parti (OnData) aggiornato a
  maggio 2025 e non copre il Trentino-Alto Adige; ogni ricerca scarica ~1,6 MB. Se
  l'archivio cambia indirizzo, va aggiornata la costante `ARCHIVIO` in `js/ricerca.js`.
- **Zoom di comparsa.** Le particelle con i numeri compaiono da zoom 15 (4 immagini
  ricomposte, ~2,9 MB); da zoom 16 in su basta una immagine per vista.

## Verifica funzionale

Il progetto include un test end-to-end che gira in un browser reale e verifica i punti
critici (proiezione, ordine degli assi del `BBOX`, calcolo delle superfici, salvataggio
locale, ricerca di una particella, esportazione PNG senza canvas "sporcato").

```bash
npm run dev                                   # in un terminale
'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  --headless=new --disable-gpu --virtual-time-budget=40000 --dump-dom \
  http://localhost:5173/test/self-test.html
```

Il risultato compare nel `<pre id="results">` del DOM. Esito attuale: **15 controlli su
15 superati**, incluso il test della `GetMap` realmente generata da OpenLayers:

```
/catasto/ows01.php?REQUEST=GetMap&SERVICE=WMS&VERSION=1.1.1&FORMAT=image/png&
STYLES=&TRANSPARENT=true&LAYERS=CP.CadastralZoning&WIDTH=192&HEIGHT=192&
SRS=EPSG:4258&BBOX=11.104...,42.754...,11.105...,42.755...
```

Il `BBOX` è nell'ordine **longitudine, latitudine** (i due valori sono ~11 e ~42), cioè
**non scambiato**: è esattamente ciò che il servizio si aspetta con WMS 1.1.1. Il test
verifica anche che il browser carichi la GetMap dal proxy e che l'immagine PNG finale
venga generata senza che il canvas risulti "sporcato". Va eseguito con il server di
sviluppo attivo, perché usa l'inoltro `/catasto/*`.

Due controlli riguardano i punti che in passato si sono rotti:

- **limite di 2048 px**: il test allarga la mappa a 2400 px (il caso che rendeva invisibile
  il catasto, quando OpenLayers avrebbe chiesto `WIDTH=3226`) e verifica che ogni `GetMap`
  resti entro il limite del servizio;
- **ricerca di una particella**: risolve `E202` foglio `87` particella `888` leggendo i
  dati OnData via HTTP Range e confronta le coordinate con quelle note
  (`42.750394, 11.100643`).

Il test compie richieste di rete reali, quindi i tempi possono variare: se l'esito appare
incompleto, aumenta `--virtual-time-budget` e il tempo di attesa. Il PNG prodotto viene
esposto come data URL in `<div id="exported-data">`, così è ispezionabile dall'esterno
(dimensioni attese 600×576: 600×400 di mappa + 176 di fascia dati).

## Possibili sviluppi

- **Cache dei tile catastali** tramite funzione serverless `/api/catasto.js` che
  riscriva `Cache-Control` (l'origine invia `no-cache, must-revalidate`). Ridurrebbe
  sensibilmente la banda, al costo di consumare una invocation per richiesta.
- **IndexedDB** al posto di localStorage, se il numero o la complessità degli
  appezzamenti crescono.
- **Export aggiuntivi** (GeoJSON, KML, PDF) e stampa in scala.
- **Ricerca per indirizzo** (Nominatim) per inquadrare rapidamente una zona.
- **Gestione multi-particella** con somma automatica delle superfici.

## Pubblicazione

Il sito è statico: nessun bundler, nessuna build. Su Vercel vengono pubblicati
direttamente i file del repository, e gli inoltri `/catasto/*` e `/wfs/*` sono
dichiarati in `vercel.json` (così le immagini del catasto arrivano dalla stessa
origine e restano leggibili dal canvas, senza il problema del canvas "sporco").

```bash
# prima volta
npx vercel login
npx vercel --prod          # pubblica; il progetto prende il nome "calcolarea"

# dalle volte successive
npx vercel --prod
```

Per pubblicare da GitHub: crea un repository vuoto, poi

```bash
git remote add origin git@github.com:UTENTE/calcolarea.git
git push -u origin main
```

e su Vercel «Add New → Project → Import Git Repository» scegliendo il repository:
framework preset **Other**, build command vuoto, output directory `.`.

## Controlli

Dopo **ogni** modifica si lanciano i test: le modifiche fatte "per intervallo"
possono portare via una funzione senza che la sintassi se ne accorga, e il
guasto si vede solo usando l'app.

```bash
npm run test:api   # controlla i sorgenti: funzioni attese, graffe, inoltri
npm run test:app   # apre l'app in un browser e prova i comportamenti
npm test           # tutti e due
```

`test:app` richiede il server di sviluppo acceso (`npm run dev`) e un Chrome
installato; su macOS lo trova da solo, altrove si indica con `CHROME_PATH`.
Prova: caricamento dei moduli, assenza di eccezioni, numeri delle particelle,
sfondo del catasto, calamita agganciata, superficie di una particella,
eliminazione di un vertice con un clic vero, misure, ricerca.

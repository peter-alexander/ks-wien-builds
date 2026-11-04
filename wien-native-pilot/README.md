# Eigenständiger Z15-Gebäude-Pilot – Straußengasse

**Status:** funktionsfähiger Build für neun zusammenhängende Wiener Z15-Kacheln.
Ein isolierter MapLibre-Viewer wird auf GitHub Pages als
`WienBuildings/NativePilot/index.html` veröffentlicht.

## Architektur

Der Build verwendet **keine Maptoolkit-/Stadtplan-Gebäudekacheln**.

1. Die aktuellen FMZK-Baukörper kommen aus unseren selbst gebauten und
   auf `gh-pages` publizierten `WienBuildings/LOD1`-Kacheln.
2. Optional werden nur historische LOD2.1-Dächer ergänzt, die anhand
   aktueller `KS_ID`-Baukörperteile eindeutig geprüft sind, aus dem
   vorhandenen `wien-lod21/targets.production.json`.
3. Historische Dächer werden im Pilot nur für `direct-strong` und
   `manual-pilot-strong` berücksichtigt, falls ihre beidseitigen
   Footprint-Restflächen jeweils **höchstens 0,5 m²** betragen. Die
   aktuellen FMZK-Teile werden **erst bei tatsächlich gebautem Dachmesh**
   anhand ihrer exakten `KS_ID` unterdrückt.
4. Ohne sicheren historischen Treffer wird ausschließlich unser
   aktuelles FMZK-Flachdach dargestellt. Das ist kein Runtime-Fallback
   auf eine Fremdquelle.
5. Ein GPU-Custom-Layer in MapLibre liest die Terrainhöhe je
   Gebäudeteil aus `renderTerrainHeightMap()`. Terrain wird nicht
   in den Gebäudekacheln gespeichert.

## Eigenes Format `KSWN0001`

Die Z15-Tiles liegen als `tiles/15/{x}/{y}.bin.gz` vor.
Gzip wird **im Client explizit dekodiert**. Die dekomprimierte Datei
enthält:

- 32-Byte-Header mit Magic, Version, Umfang und Offsets,
- kleines JSON-Verzeichnis der Baukörperteile (Vertex-/Indexbereiche,
  räumliche Anker),
- pro Vertex 16 Byte (lokale XY als Int16, relative Höhe als cm-Uint16,
  Normalen als drei Int16 und Materialkennung),
- Dreiecksindices als UInt32.

Die Geometrie wird offline trianguliert, der Browser erzeugt weder
Grundrisse noch Dachflächen neu. Das Format ist **exklusiv für die neue
Kartensammlung**, es gibt keine Rückwärtskompatibilitätsauflagen.

## Größe des ersten realen Piloten

Erfolgreicher erster Build am 4. November 2026 für
`15/17872..17874/11363..11365`:

| Merkmal | Gesamt (9 Z15-Tiles) |
| --- | ---: |
| Baukörperteile | 24.623 |
| Davon aktuelle FMZK-Teile | 24.604 |
| Davon strenge historische Dachmodelle | 19 |
| Vertices | 1.451.256 |
| Dreiecke | 827.638 |
| Unkomprimiert | 37.023.840 Byte |
| Gzip | 10.010.355 Byte |

Die Werte beschreiben **Baukörperteile**, nicht 24.623 verschiedene
Gebäude. Der Anteil sicherer historischer Dächer ist derzeit bewusst
klein. Das vollständige alte CityGML-Dachmodell muss später unabhängig
vom früheren Maptoolkit-Fallback-Prozess neu und stadtweit an FMZK
angepasst werden.

**Wichtig:** Das sind noch keine akzeptablen Produktionsgrößen.
Die Kacheln sind ein Last- und Qualitätsbenchmark. Die Kombination
aus 1,45 Mio Vertices und einem 3×3-Viewport ist auf mobilen GPUs
ausdrücklich auf Renderzeit und Speicherverbrauch zu prüfen.
Gzip reduziert die Übertragung, nicht die GPU-Geometrie.

## Separater Test: vollständiger Original-CityGML-Dachbestand

Am **4. November 2026** wurde der Pipeline-Test von der bisherigen,
für Maptoolkit-Lücken geprüften Auswahl abgekoppelt. Er lädt **20
Original-CityGML-Blätter** direkt von der Stadt Wien. Die ursprüngliche
LODGML-Quelle umfasst weit mehr Gebäude als die knapp 2.300 früheren
Fallback-Ziele.

Die neue Prüfung verknüpft historische Dachflächen über ihren
Adresscode mit aktuellen FMZK-Baukörperteilen und validiert zusätzlich
deren Geometrie in EPSG:31256. Historische Dächer werden nur
übernommen, wenn:

- der aktuelle historische Adresscode genau einer heutigen BW_GEB_ID
  zugeordnet ist;
- alle betroffenen Geometrien vollständig in derselben Z15-Kachel
  liegen (mit Randpuffer);
- Dachform wirklich geneigt ist (mindestens 0,35 m Höhenunterschied);
- historische und aktuelle Grundrissdeckung in beide Richtungen
  mindestens **96,5 %** und Intersection-over-Union mindestens
  **94 %** beträgt;
- ein vollständiges Dachmesh entsteht, bevor die zugehörigen heutigen
  FMZK-Körperteile entfernt werden.

**Erfolgreicher Build**:
`wien-native-roofs-pilot.yml` → `WienBuildings/NativePilotRoofs/`.

| Kennzahl | Alter Pilot | Neuer Originaldach-Pilot |
| --- | ---: | ---: |
| Z15-Kacheln | 9 | 9 |
| Gesamt-Baukörperteile | 24.623 | 18.818 |
| Selbst erzeugte historische Dachmodelle | 19 | **1.906** |
| Verbleibende FMZK-Baukörperteile | 24.604 | 16.912 |
| Vertices | 1.451.256 | 1.645.004 |
| Gzip-Kachelvolumen | 10,01 MB | 11,55 MB |
| Tatsächlich triangulierte geneigte Dachflächen | 1.252 Dreiecke | **103.883 Dreiecke** |

Das Originalmodell wurde in 3.678 relevanten CityGML-Objekten der
20 Blätter untersucht. Von 4.066 aktuellen Gebäude-Adresscodes wurden
**1.877** eindeutig zugeordnet. Weitere wurden aufgrund von
Kachelgrenzen, unzureichender Deckung, Mehrfachidentitäten oder
fehlender bzw. flacher historischer Dächer bewusst nicht ersetzt.

Die streng gekachelte Abnahme ist für diesen Last- und Sichttest
absichtlich konservativ. Sie ist **noch keine** vollständige Abdeckung
Wiens und kein Beweis für die optische Genauigkeit jedes 2013
erfassten Dachmodells. Die Geländehöhen kommen weiterhin aus MapLibre,
aber der fundamentbezogene Übergang historischer Modelle bleibt
visuell zu prüfen. Es gibt keinen Maptoolkit-Fallback.

**Testseite:** `WienBuildings/NativePilotRoofs/index.html` (separat vom
ersten flachdachlastigen Piloten). 
**Audit:** `WienBuildings/NativePilotRoofs/roof-matching-audit.json`.

## Offene technische Fragen

- Der FMZK-Grundriss wird aktuell aus unseren bereits gekachelten
  Z15-MVT-Daten eingelesen. Ein Baukörper an einer Kachelgrenze
  bekommt dadurch pro Teilkachel einen separaten Geländeanker; das
  kann sichtbare Geländesprünge bewirken. Für einen finalen Build
  braucht es eindeutige gebäudeweite Anker aus unbeschnittenen
  Ursprungsgeometrien.
- Das historische Dachmodell stammt aus einem älteren Datenstand.
  Für hohe Dachabdeckung wird ein neues vollständiges Matching
  inklusive Hybrid-/Restflächenmodell benötigt.
- Geometrie-Deduplizierung, Indizes, Normalenquantisierung,
  Material- und Vertex-Packing und Rendering-Culling sollten gegen
  GLB + Meshopt gemessen werden, bevor das Format festgelegt wird.
- Die derzeitige DEM-Textur deckt den ganzen 3×3-Ausschnitt mit
  512×512 Texeln ab. Genauigkeit bei Hängen, Kamera-Pitch und
  Kachelgrenzen sowie iPhone-GPU-Performance sind noch offen.
- Der Pilot enthält ausschließlich Z15. Z13/Z14 und OSM außerhalb
  der Wiener Stadtgrenze werden anschließend separat umgesetzt.

## Benutzung

Der Workflow `.github/workflows/wien-native-pilot.yml` führt Unit-Tests
aus, baut neun vollständige Kacheln, überprüft die Größen und publiziert
nur `WienBuildings/NativePilot`. Er verwendet ausschließlich das
öffentliche Repository und damit keine privaten GitHub-Actions-Minuten.

Die Karte zeigt standardmäßig **keine nativen OpenFreeMap-Extrusionen**.
Ein optionaler Schalter erlaubt den direkten Vergleich.

Source: `wien-native-pilot/build.mjs`.
Tests: `node --test wien-native-pilot/build.test.mjs`.

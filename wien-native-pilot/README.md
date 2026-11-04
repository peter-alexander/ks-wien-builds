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

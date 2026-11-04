# Wiener 3D-Gebäude: stadtweiter Geometrie-Build und Originaldach-Inventur

Stand 4. November 2026. Quelle nur **amtliche Wiener Baukörper und Dachmodelle**,
keine Maptoolkit-Gebäudekacheln. Die Karte wird noch nicht umgestellt.

## Abgeschlossener Z15-Ganz-Wien-Durchlauf

GitHub Actions **41863949238**: 8/8 Build-Shards plus
gesamtstädtische Prüfstufe erfolgreich.

| Kennzahl | Gesamtergebnis |
| --- | ---: |
| Vorhandene, selbst gebaute Wiener Z15-Kacheln | 678 |
| Baukörperteile (inkl. Teilkacheln) | 739.167 |
| Davon aktuelle FMZK-Teile | 738.817 |
| Davon bisher streng geprüfte historische LOD2.1-Teile | 350 |
| Vertices | 31.998.802 |
| Dreiecke | 17.803.012 |
| Komprimierte Bytes gesamt | 221.799.071 (221,8 MB) |
| Unkomprimierte Bytes gesamt | 840.890.088 (840,9 MB) |
| Größte komprimierte Z15-Kachel | 1.464.453 Byte |
| Lücken in den 678 Indexkacheln | **0** |

Dieser Test beweist den **städtweiten technischen Durchlauf der aktuellen
Baukörper**, nicht die vollständige Abdeckung mit geneigten Dächern.

Die fertigen Datentiles sind vorerst **nur temporäre
GitHub-Actions-Artefakte**, nicht produktiv veröffentlicht.

## Vollständige Inventur der amtlichen 500-m-CityGML-Blätter

GitHub Actions **41869224002**: Quellindex aus sämtlichen 678 aktuellen
FMZK-Z15-Kacheln erstellt und auf `main` gesichert.

- **1.588** potenzielle originale LOD2.1-CityGML-Downloadblätter;
- **18** räumlich gruppierte 8×8-Z15-Verarbeitungsregionen;
- **736.332** auf aktuelle Gebäudepolygone bezogene
  Kachel-Feature-Vorkommen in der Inventur;
- Persistenter Quellindex: `wien-native-city/roof-inventory.snapshot.json`.

Der Index gibt die räumliche Lage aus dem aktuellen FMZK an. **1.588
bedeutet noch nicht, dass jede einzelne historische Datei beim
Webserver verfügbar ist.** Der eigentliche Download und
Geometriematching werden in einem eigenen Schritt geprüft.

## Größerer Original-LOD2.1-Test

`wien-native-city/roof-sector-plan.json` beschreibt **16 statt bisher
9** Z15-Kacheln (Straußengasse und Umgebung). Die zugehörige
Downloadliste umfasst **132** historische 500-m-Blätter.

Die erste Aktion **41870099652** hat nach 19 erfolgreichen Downloads
TCP-Verbindungsfehler zum offiziellen Wiener Webserver gemeldet
(`curl`-Code 7/28, also **keine** bestätigten HTTP-404-Fehler).

Der ursprüngliche Einzeljob scheiterte erneut am TCP-Verbindungsaufbau.
Die Source-Pipeline ist deshalb auf **16 unabhängige GitHub-Actions-Jobs**
(je 8–9 Originalblätter, höchstens 4 Jobs gleichzeitig) umgestellt.
Jeder Job verwendet maximal eine Verbindung zur Zeit. Die originalen
ZIP-Dateien werden auf Plausibilität geprüft und nach jeder Jobausführung,
**auch nach einem Fehlversuch**, im GitHub-Actions-Cache gesichert.

Bei späteren Läufen werden ZIP und HTTP-Metadaten zurückgeladen.
Wenn der Wiener Server einen `ETag` oder `Last-Modified` zurückgibt,
schickt der Client `If-None-Match` bzw. `If-Modified-Since`.
Bei **HTTP 304** wird der bereits geprüfte ZIP-Bestand verwendet –
**ohne erneute Übertragung** der Archivdaten. Bei **HTTP 200** wird
die geänderte ZIP-Datei validiert und atomar ersetzt.

Im strengen Modus wird bei fehlendem Validator die Quelle vollständig
neu abgefragt. Ohne Servervalidator gibt es technisch keine zuverlässige
Möglichkeit, ihre Unverändertheit ohne einen erneuten Datenbezug
festzustellen. Der Header-Test des Wiener Servers ist noch separat zu
verifizieren; wir behaupten deshalb nicht, dass 304 bereits funktioniert.

**Wichtig:** Actions-Caches unterliegen einem begrenzten Speicherbudget
und automatischer Bereinigung. Sie sind zunächst ein wiederaufnehmbarer
Arbeitscache und **kein dauerhaftes Quellarchiv**. Für langfristige
inkrementelle Aktualisierungen ist ein dauerhafter, versionierter
Speicher (z. B. Repository-Releases oder Objektspeicher) notwendig.

Das eigentliche originale Dachmatching und der 16-Kachel-Build folgen
erst nach einem erfolgreichen Quellenbezug. Keine fehlerhafte
Source-Quelle wird unbemerkt durch Maptoolkit ersetzt.

## LOD2.4 – Testdaten eignen sich für einen Adapter

Die offizielle Wiener Downloadseite liefert zwei frei zugängliche
Testarchive. Die Datei `3d-modell-flaechen.zip` enthält
DXF/DWG, WRL **und CityGRID-1.14-XML**; die XML-Datei enthält
250 `Element`- und 314 `Polygon`-Strukturen.
`3d-modell-linien.zip` enthält Liniengeometrien als XML/DXF/DWG.

Der Testbereich ist **wertvoll für Formatprüfung und Regressionstests**
eines zukünftigen LOD2.4-Adapters, aber viel zu klein für eine
relevante Wien-Abdeckung. Auch die kostenlosen Demoarchive sind
**nicht automatisch ein Nachweis für ein Recht zur freien
Weiterveröffentlichung des vollständigen kostenpflichtigen Bestands**.

Ein vollständiger LOD2.4-Datenzugang einschließlich Publikationsrecht
muss separat geklärt werden. Bis dahin gilt:
`FMZK aktuell → geometrisch passendes LOD2.1 → FMZK Flachdach`.
Sobald LOD2.4 verfügbar und geprüft ist, bekommt es vor LOD2.1
Priorität; der aktuelle FMZK-Bestand bleibt maßgeblich für Existenz und
Gebäudeidentität.

## Noch offen

- Für die *gesamte* Dachabdeckung müssen die Originaldaten in
  wiederaufnehmbaren Blöcken verarbeitet werden (kein großer
  Einzel-Download).
- Das noch konservative Matching schließt alle
  Z15-kachelübergreifenden Dächer aus. Das verhindert falsche
  Überschreibungen, muss aber später mit stabilen gebäudeweiten
  Ankern und exakter Geometrie überarbeitet werden.
- Der künftige Renderer benötigt Kachelnachladen, GPU-Culling,
  Cache-Limits und LOD-Übergänge. Die jetzigen Stadt-Builds sind
  noch kein vollständiger Produktions-Runtime.

## Neuer Stand: inkrementeller Neubau vorbereitet und regional verifiziert

Die ursprüngliche FMZK-Ganz-Wien-Buildprüfung wurde mit
**stabilen KS_ID-basierten Bauteilidentitäten** und **ohne historische
Legacy-LOD2.1-Tiles** erneut vollständig bestanden:
GitHub Actions **41887290492**, 678/678 Z15-Kacheln,
739.463 FMZK-Bauteile, **222.523.331 gzip-Bytes** und **0 geneigte
historische Dach-Bauteile**. Das ist die saubere technische Ausgangsbasis,
nicht der fertige Ganz-Wien-Dachdatensatz.

Der regionale **16-Kachel-Build mit 131 originalen CityGML-Archiven
und einem amtlich bestätigten HTTP-404-Blatt** wurde in
GitHub Actions **41887938123** vollständig bestanden:
**3.838** aktuelle Gebäudecodes mit passend überprüften historischen
Dächern und **3.872** erzeugte historische Dach-Bauteile.
Ein ungültiges historisches Polygon wurde mit Audit-Warnung
ausgeschlossen; an seiner Stelle bleibt der FMZK-Baukörper erhalten.

Die Komponenten des geplanten dauerhaften inkrementellen Builds
sind bereits im Repository:

- `wien-native-city/source-state.mjs`: SHA256- und HTTP-Revision
  aller vollständigen Originalarchive bzw. verifizierte HTTP-404-Fehldateien.
  Die große GML-Quelle muss im finalen Release nicht gespeichert bleiben.
- `wien-native-city/incremental-plan.mjs`: Voll- vs. Teilneubau
  bzw. vollständig unveränderte Veröffentlichung anhand des
  FMZK-Releases, Geometrie-Build-Fingerprints, pro-Blatt-ETags und
  konservativer Abhängigkeitsregionen.
- `wien-native-city/native-tile-patch.mjs`: prüft bereits veröffentlichte
  `KSWN0001`-Geometrien, übernimmt nicht betroffene Vertex- und Index-Daten
  bytegenau und ergänzt veränderte Gebäude ohne erneute Triangulation
  unveränderter Originaldächer.

**Noch nicht erfolgt:** Download/Matching aller 1.588 potentiellen
CityGML-Quellen, neuer kompletter Wiener Roof-Release, produktives
inkrementelles Update-Verfahren, veröffentlichter Wechsel der Kartensammlung.
Der vorherige produktive Datenbestand wird **nicht vor einem vollständig
geprüften und erreichbaren Ersatz gelöscht**. Insbesondere die separate
amtliche FMZK/LOD1-Quelle bleibt für notwendige Flachdach-Fallbacks erhalten.

# Wiener 3D-Gebäude – produktive native Datenpipeline

Verantwortlich: `.github/workflows/wien-native-production.yml`.

## Veröffentlichter Datenbestand

Nur der aktuelle XYZ-Bestand wird auf `gh-pages` gehalten:

```text
WienBuildings/
  release.json
  release-z13.json
  release-z14.json
  release-z15.json
  building-index.json.gz
  tiles/13/{x}/{y}/{chunk}.bin.gz
  tiles/14/{x}/{y}.bin.gz
  tiles/15/{x}/{y}.bin.gz
```

Z13 wird aus technischen Gründen in unabhängig dekodierbare Chunks
unterteilt. Es gibt **keine** unterschiedlichen Release-Verzeichnisse,
keine öffentliche LOD1-Zwischenquelle und keine Pilot-Publikation.

## Ablauf

1. Ein einziger offizieller WFS-Durchlauf für die aktuellen FMZK-Baukörper.
   Die temporäre GeoJSONSeq- und PBF-Z13–Z15-Quelle wird in Actions erzeugt
   und **nicht** auf GitHub Pages veröffentlicht.
2. Ein SHA-256 des vollständigen normalisierten FMZK-Exports wird mit dem
   zuletzt veröffentlichten WFS-Fingerprint verglichen. Bei identischem
   Inhalt kann die ursprüngliche FMZK-Quellkennung beibehalten werden.
3. Aus denselben temporären Z15-PBF wird die originale CityGML-Blatt- und
   Regionenzuordnung **für diesen Lauf** berechnet. Kein überholter
   fest eingetragener Actions-Run und kein veraltetes Inventar ist
   Produktionsquelle.
4. Jede 8x8-Region wird wieder in **unabhängige Download-Shards mit
   höchstens sechs CityGML-Quelldateien** aufgeteilt. Im wiederverwendbaren
   Workflow `.github/workflows/wien-native-region-pipeline.yml`
   laufen bis zu vier Shards gleichzeitig, jeweils auf separaten
   GitHub-hosted Runnern. Neue Runner haben eigene Netzwerkumgebungen,
   aber nicht zwingend verschiedene öffentliche IP-Adressen.
   Bei wiederholten TCP-/Connect-Fehlern wird ein Shard frühzeitig
   beendet, statt auf derselben möglicherweise blockierten IP alle
   übrigen Quellen weiter zu versuchen.

   Erfolgreiche ZIPs und HTTP-Metadaten werden unabhängig von fehlgeschlagenen
   Downloads als kurzlebige Artefakte und Cache-Zustände gespeichert.
   **Nur unvollständige Shards** werden in zwei möglichen Reparaturphasen
   auf neuen Runnern erneut geprüft. Ein alter ZIP-Hash allein zählt
   dabei nicht als Beweis der Aktualität: die Quelle muss im aktuellen
   Build per HTTP bestätigt worden sein.

   Anschließend werden die neuesten verfügbaren Dateien disjunkt
   zusammengeführt, anhand der vollständigen ursprünglichen Quellenliste
   geprüft und erst danach die nativen Gebäudegeometrien erzeugt.
   Ungeklärte HTTP-/Netzwerkfehler verhindern weiterhin die
   Veröffentlichung; bestätigte historische 404-Dateien werden
   auditiert und durch FMZK-Fallbackgeometrie abgedeckt.
5. Hat sich der FMZK-Quellinhalt **nicht** geändert, können Regionen
   wiederverwendet werden, wenn sämtliche Original-Quellen und der
   Geometrie-Builder unverändert sind. Diese Regionen werden anhand
   der veröffentlichten SHA-256-Prüfsummen erneut validiert.
   Andernfalls werden die betroffenen Regionen mit ihren historischen
   Dächern neu aufgebaut. Eine geänderte FMZK-Quelle erzwingt zurzeit
   konservativ einen vollständigen Z15-Neubau.
6. Bei unverändertem FMZK und unverändertem Z13/Z14-Builder werden die
   existierenden Lowzoom-Geometrien wiederverwendet. Andernfalls
   erfolgt ein Neubau der Z13-/Z14-LOD1-Gebäude aus dem aktuellen WFS.
7. Erst wenn alle Z13-, Z14- und Z15-Ausgaben und der Gebäudeindex
   vorliegen, wird alles auf Integrität, Quellversion und Vollständigkeit
   geprüft. **Ein einzelner Commit** ersetzt die betroffenen
   XYZ-Dateien und den aktuellen Versionsindex auf `gh-pages`.
   Ungültige oder unvollständige Builds verändern den bisherigen
   veröffentlichten Bestand überhaupt nicht.

Bei identischen Kachel-Bytes bleibt der Cache-Buster identisch;
er wird aus den tatsächlichen geprüften Geometrie-Prüfsummen
abgeleitet und nicht aus der WFS-Downloadzeit.

## Quellen und Geometrie

- FMZK-Baukörper: verpflichtende aktuelle amtliche OGD-Quelle.
- LOD2.1: originale Stadt-Wien-CityGML-Dächer, nur bei geprüftem
  geometrischen Match mit einem heutigen FMZK-Gebäude.
- FMZK-Prisma mit flachem Dach als Fallback, wenn kein nachweislich
  passendes historisches Dach vorliegt.
- LOD2.4 nicht eingebaut, da kein automatisierbar verfügbarer
  vollständiger Datensatz nachgewiesen ist.
- Die nativen `KSWN0001`-Kacheln enthalten relative Höhen für die
  spätere Terrain-Anpassung; keine proprietären Maptoolkit-Meshes.

## Workflows und Sicherheit

- `workflow_dispatch`: vollständigen aktuellen Build manuell starten.
- Sonntag 02:19 UTC: regelmäßige Prüfung/Neuerstellung.
- `push` auf Änderungen der produktiven Builder: **nur Tests**;
  keine umfangreichen Downloads und kein Deployment.
- Parallelismusschutz: jede produktive Region erhält einen geprüften,
  unveränderlichen FMZK-Quellstand.
- Veröffentlichung schlägt im Fehlerfall fehl und bewahrt die zuvor
  geprüften Kacheln.

**Die erste komplette Aktualisierung ist naturgemäß aufwendiger**:
Der bisher veröffentlichte Datensatz besitzt noch keinen
`fmzkSourceSha256`. Deshalb ist bis zu einem vollständigen erfolgreichen
Produktionslauf ein konservativer Ganz-Wien-Neubau nötig. Danach ist
kachelweise Wiederverwendung der unveränderten regionalen Daten möglich.

Dieses Repository erstellt und veröffentlicht **nur die Tiles**.
Die Integration in den Renderer der Kartensammlung ist eine
separate Aufgabe und wird hier ausdrücklich nicht vorgenommen.

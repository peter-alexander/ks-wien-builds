# Wien – Gebäude-Pipeline und stadtweiter Build-Durchlauf

Stand: 4. November 2026. Dies ist **keine produktive Veröffentlichung**,
sondern der kontrollierte Übergang vom 3×3-Z15-Prototyp zu ganz Wien.

## Verbindliche Quellpriorität

**Die aktuellen amtlichen FMZK-Baukörper definieren, welche Gebäude existieren.**
Dachgeometrien dürfen nur dann einen aktuellen Baukörper ersetzen, wenn sie
eindeutig zu diesem passen. Die Reihenfolge der Prüfung ist:

1. **Aktuelles Wiener Baukörpermodell** – FMZKBKMOGD, derzeit
   unsere selbst veröffentlichten `WienBuildings/LOD1`-Z15-Vektorkacheln,
   erzeugt aus dem offenen amtlichen WFS. WFS enthält Grundrisse und
   attribuierte absolute Höhen (`O_KOTE`, `U_KOTE`, `T_KOTE`).
   Unser Build speichert **nur relative Höhen**.
2. **Detailliertes Wiener Dachmodell LOD2.4** – höchste gewünschte
   Dachpriorität, *soweit ein rechtmäßig verfügbarer aktueller Datensatz
   und eine überprüfte Geometriezuordnung vorliegen*. **Nicht integriert**:
   Die offizielle Produktseite veröffentlicht derzeit nur Testdaten;
   ein vollständiger frei automatisiert herunterladbarer Bestand ist
   nicht nachgewiesen. Bezug über MA 41 klären.
3. **Generalisiertes Dachmodell LOD2.1** – öffentliches originales
   CityGML aus offiziellen 500×500-m-Blättern. Der Datenstand wurde
   großteils aus einem Oberflächenmodell von **2013** modelliert.
   Historische Dächer nur bei nachgewiesener Identität und räumlicher
   Überdeckung übernehmen. Der 20-Blätter-Pilot schaffte
   **1.877 aktuelle Gebäudecodes** und **1.906 historische Gebäudeteile**.
4. **FMZK-Baukörper mit flachem Dach**, wenn 2.4 und 2.1 fehlen oder
   geometrisch nicht passen.

**Ausgeschlossen:** Maptoolkit-/Stadtplan-Gebäudegeometrien, CesiumJS,
Fremd-Fallbacks und absolute DEM-Höhen in den Gebäudevertices.

## Durchlauf 1: Aktueller Gebäudebestand für ganz Wien

`.github/workflows/wien-native-city-audit.yml` startet einen vollständig
getrennten Build aus **acht deterministischen Z15-Shards**. Alle Shards
beziehen sich auf dieselbe amtliche FMZK-Releasekennung. Ein neuer Release
während des Laufs lässt den Build absichtlich scheitern: keine Vermischung
unterschiedlicher Datenstände.

Ausgangspunkt (OGD-Release vom 3. November 2026):

- 669.051 geladene amtliche Baukörperfeatures,
- 668.938 nach Höhenprüfung ausgegebene Features,
- **678 offiziell vorhandene Z15-Quellkacheln**.

`wien-native-city/build.mjs` verwendet dafür den erprobten
`KSWN0001`-Encoder und nimmt die bereits freigegebenen historischen
LOD2.1-Dächer mit. Es ist zunächst ausdrücklich **kein**
vollständiges, stadtweites historisches Dachmodell.

Jeder Shard prüft Kachelanzahl, Dateigröße, Herkunft, Vertices,
Dreiecksindizes und Materialklassifikation. Im Ergebnis entstehen:

- `wien-native-city-report-{shard}`: kleine Pläne und Qualitätsberichte,
- `wien-native-city-tiles-{shard}`: alle erzeugten Z15-`.bin.gz`-Kacheln
  als temporäre GitHub-Actions-Artefakte,
- `wien-native-city-final-report`: aggregierte Kennzahlen **nur dann**,
  wenn alle **678 Z15-Kacheln** erfolgreich gebaut und eindeutig zugeordnet
  wurden.

**Keine Veröffentlichung nach `gh-pages` und keine Änderung der produktiven
Kartensammlung.** Ein ganzes Git-Repository mit hunderten Megabyte an
Binärkacheln wäre ohne Größenmessung/Hostingentscheidung unvernünftig.

Das ist ein vollwertiger stadtweiter **Build-through-Test**, kein
behaupteter vollständiger LOD2.4-/LOD2.1-Dachimport.

## Nächster Daten-Build

Vor einem produktiven Ganz-Wien-Datenstand fehlen noch:

1. Offizielles LOD2.4-Inventar/Downloadzugang, Formatprüfung und Adapter
   für die 3D-Dach- und Fassadenflächen. Ohne Zugang wird LOD2.4
   *ausgelassen*, niemals vorgetäuscht.
2. Originale LOD2.1-CityGML-Blätter für den gesamten vorhandenen
   FMZK-Bestand inventarisieren und in **kleinen wiederholbaren Blöcken**
   laden und gegen den jeweiligen aktuellen Baukörper matchen. Der alte
   `wien-lod21/targets.production.json` ist nur ein früherer,
   für Maptoolkit-Lücken auditierter **Teilbestand**.
3. Kachelübergreifende Gebäudeanker/Geometrien aus den ungeschnittenen
   amtlichen Ausgangsgeometrien bauen. Die aktuelle MVT-Z15-Quelle ist
   bereits gekachelt und hat an ihren Kachelrändern sonst potenzielle
   Geländesprünge.
4. Erst nach erfolgreichen vollständigen Quellen- und Integritätsprüfungen
   Datenverteilung, Z13/Z14, inkrementelle Updates und Kartenintegration
   umsetzen.

## Befehle

Der große Build läuft derzeit mit acht Shards öffentlich auf GitHub Actions.
Für lokale Testläufe mit denselben Regeln:

```bash
npm ci
npm install --no-save @mapbox/vector-tile@3.0.0 pbf@5.1.2 three@0.186.1
node --test wien-native-city/build.test.mjs wien-native-city/aggregate.test.mjs
node wien-native-city/build.mjs --shard 0 --shards 8 --dry-run
node wien-native-city/build.mjs --shard 0 --shards 8
```

Der vollständige Lauf verteilt die Shards auf GitHub Actions und führt
danach `wien-native-city/aggregate.mjs` zur Datenabnahme aus.

## Amtliche Referenzen

- [Wien: detailliertes Dachmodell LOD2.4](https://www.wien.gv.at/stadtplanung/detailliertes-dachmodell-daten-beziehen)
- [Wien: 2.4-Produktinformation und Datenstand](https://www.wien.gv.at/stadtplanung/detailliertes-dachmodell-produktinformation)
- [Wien: generalisiertes Dachmodell LOD2.1 als OGD](https://www.wien.gv.at/stadtplanung/generalisiertes-dachmodell)
- [Wien: amtliche OGD-Baukörper und Geodaten](https://www.wien.gv.at/stadtplanung/geodatenviewer-ogd-daten-herunterladen)

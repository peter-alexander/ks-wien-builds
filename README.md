# Wiener Kartendaten-Builds

Builds für den Wiener Baumkataster, das Baukörpermodell (LOD1), den geprüften LOD2.1-Dach-Fallback und den Stadtplan-Wien-Style-Snapshot, einschließlich der LOD2.1-Analysewerkzeuge.

## Veröffentlichung

Die Daten werden vom Workflow `.github/workflows/publish.yml` **inkrementell** auf den Branch `gh-pages` übertragen. Bei einem Lauf wird ausschließlich der ausgewählte Datensatz aktualisiert, nicht das gesamte Pages-Verzeichnis.

- Baumkataster: https://peter-alexander.github.io/ks-wien-builds/Baumkataster/tilejson.json
- Gebäude LOD1: https://peter-alexander.github.io/ks-wien-builds/WienBuildings/LOD1/tilejson.json
- Gebäude LOD2.1: https://peter-alexander.github.io/ks-wien-builds/WienBuildings/LOD21/
- Stadtplan Wien: https://peter-alexander.github.io/ks-wien-builds/StadtplanWien/style.json
- Versionen: https://peter-alexander.github.io/ks-wien-builds/asset-versions.json

**Einmalige GitHub-Einstellung:** Settings → Pages → Build and deployment → Deploy from a branch → `gh-pages` → `/(root)` → Save.

Anschließend unter Actions → **Build and publish Vienna data to GitHub Pages** → Run workflow die Optionen `baumkataster`, `buildings-lod1`, `buildings-lod21` und `stadtplan` einzeln ausführen. LOD1 und LOD2.1 werden unabhängig gebaut, validiert und in ihre jeweiligen Pages-Unterverzeichnisse veröffentlicht. Fehler bei LOD2.1 verhindern eine LOD1-Veröffentlichung nicht. Erst nach erfolgreicher Publikation und Prüfung der tatsächlichen URLs sollten die alten Build-Workflows abgeschaltet und Karten-URLs umgestellt werden.

## Regelmäßige Aktualisierung

Stadtplan täglich um 00:19 UTC, Baumkataster täglich um 02:37 UTC; LOD1 Dienstag und Freitag um 03:23 UTC, LOD2.1 separat Dienstag und Freitag um 04:23 UTC. Die LOD2.1-Analyseworkflows sind weiterhin manuell. Alle Veröffentlichungen verwenden dieselbe GitHub-Pages-Concurrency-Gruppe, damit sich gleichzeitige Pushes auf `gh-pages` nicht überschreiben.

Bei der GitHub-Pages-Veröffentlichung werden die bisher gzip-komprimierten LOD1-PBF-Kacheln entpackt, da GitHub Pages dafür keine eigenen `Content-Encoding`-Header konfigurieren lässt.

## LOD2.1-Downloaddiagnose

Der manuell startbare Workflow `.github/workflows/wien-lod21-download-diagnostics.yml` vergleicht die Wiener LOD2.1-ZIP-Endpunkte für die Blätter `104078`, `105080`, `105082` und `106082`, jeweils mit dem alten und neuen User-Agent. Acht Abfragen erfolgen seriell, acht weitere in zwei Vierergruppen parallel. Jede Abfrage verwendet einen HTTPS-Range-GET (Byte 0), höchstens 64 KiB Download, 12 s Connect-Timeout und 30 s Gesamt-Timeout ohne Wiederholungen.

Im Actions-Job erscheinen die Verbindungsmetriken als Summary-Tabelle. Das Artifact `wien-lod21-download-diagnostics` enthält zusätzlich DNS-Informationen, curl-Timings, vollständige HTTP-Header sowie Verbose-Logs. Ein curl-Fehlercode 63 bei vorhandenem HTTP-Status ist durch die absichtliche Größenbegrenzung erklärbar; Range-Abfragen sind nicht völlig identisch mit dem produktiven ZIP-Download.

Der Workflow läuft einmalig beim Hinzufügen/Ändern seiner Diagnose-Dateien und kann bei Bedarf über `workflow_dispatch` erneut gestartet werden. Er baut keine 3D-Daten, verändert keinen produktiven Download und veröffentlicht nichts.

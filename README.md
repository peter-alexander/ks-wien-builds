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

Der manuell startbare Workflow `.github/workflows/wien-lod21-download-diagnostics.yml` vergleicht die Wiener LOD2.1-ZIP-Endpunkte für die Blätter `104078`, `105080`, `105082` und `106082`, jeweils mit dem alten und neuen User-Agent. Acht Range-GETs erfolgen seriell, acht weitere in zwei Vierergruppen parallel (Byte 0, höchstens 64 KiB je Anfrage). Danach folgen vier vollständige, serielle ZIP-Downloads und vier vollständige, parallele ZIP-Downloads mit den jeweils anderen User-Agents. Die ZIP-Dateien sind auf 15 MB je Datei begrenzt, werden mit `unzip -tqq` geprüft und anschließend gelöscht. Alle Anfragen verwenden 12 s Connect-Timeout ohne Wiederholungen.

Im Actions-Job erscheinen die Verbindungsmetriken als Summary-Tabelle. Das Artifact `wien-lod21-download-diagnostics` enthält zusätzlich DNS-Informationen, curl-Timings, vollständige HTTP-Header sowie Verbose-Logs. Ein curl-Fehlercode 63 bei vorhandenem HTTP-Status ist durch die absichtliche Größenbegrenzung erklärbar; Range-Abfragen sind nicht völlig identisch mit dem produktiven ZIP-Download.

Der Workflow läuft einmalig beim Hinzufügen/Ändern seiner Diagnose-Dateien und kann bei Bedarf über `workflow_dispatch` erneut gestartet werden. Er baut keine 3D-Daten, verändert keinen produktiven Download und veröffentlicht nichts.

## LOD2.1-Download mit Begrenzung und Wiederaufnahme

Der Download wurde aus `wien-lod21/run.sh` nach `wien-lod21/download-sheets.mjs` ausgelagert. Standardmäßig starten höchstens **2 parallele Downloads**, mit **1,5 Sekunden Mindestabstand** zwischen neuen Verbindungen. Ein Blatt erhält maximal **3 Versuche**. Nach **2 aufeinanderfolgenden Downloadfehlern** wird die nächste Verbindung für **90 Sekunden** aufgeschoben, nach mehr als **2 Pausen** wird kontrolliert abgebrochen. Konfigurierbare Umgebungsvariablen: `WIEN_LOD21_DOWNLOAD_PARALLEL`, `WIEN_LOD21_INTERVAL_MS`, `WIEN_LOD21_DOWNLOAD_ATTEMPTS`, `WIEN_LOD21_FAILURE_THRESHOLD`, `WIEN_LOD21_COOLDOWN_MS`, `WIEN_LOD21_MAX_COOLDOWNS` und `WIEN_LOD21_RETRY_MS`.

Vollständig heruntergeladene ZIPs bleiben in `wien-lod21/build/downloads/` und werden bei einem erneuten Aufruf im **selben Arbeitsverzeichnis** nach `unzip -tqq` wiederverwendet. Ungültige oder nur teilweise heruntergeladene Dateien werden nicht übernommen. Ein neuer GitHub-Actions-Run bekommt einen neuen Runner; es wird **kein** großer ZIP-Cache zwischen GitHub-Runs übertragen.

Zum kontrollierten Belastungstest dient `.github/workflows/wien-lod21-download-pacing.yml`: Er lädt 120 nach Blattnummer sortierte Blätter aus dem Produktionsmanifest und überprüft anschließend die Wiederverwendung aus dem Cache. Er **baut und veröffentlicht keine 3D-Daten** und archiviert ausschließlich JSON-Berichte, nicht die ZIP-Dateien.

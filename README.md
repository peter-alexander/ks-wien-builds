# Wiener Kartendaten-Builds

Builds für den Wiener Baumkataster, das Baukörpermodell (LOD1) und den geprüften LOD2.1-Dach-Fallback, einschließlich der LOD2.1-Analysewerkzeuge.

## Veröffentlichung

Die Daten werden vom Workflow `.github/workflows/publish.yml` **inkrementell** auf den Branch `gh-pages` übertragen. Bei einem Lauf wird ausschließlich der ausgewählte Datensatz aktualisiert, nicht das gesamte Pages-Verzeichnis.

- Baumkataster: https://peter-alexander.github.io/ks-wien-builds/Baumkataster/tilejson.json
- Gebäude LOD1: https://peter-alexander.github.io/ks-wien-builds/WienBuildings/LOD1/tilejson.json
- Gebäude LOD2.1: https://peter-alexander.github.io/ks-wien-builds/WienBuildings/LOD21/

**Einmalige GitHub-Einstellung:** Settings → Pages → Build and deployment → Deploy from a branch → `gh-pages` → `/(root)` → Save.

Anschließend unter Actions → **Build and publish Vienna data to GitHub Pages** → Run workflow die Datensätze `baumkataster`, `lod1` und `lod21` jeweils einmal ausführen. Erst nach erfolgreicher Publikation und Prüfung der tatsächlichen URLs sollten die alten Build-Workflows abgeschaltet und Karten-URLs umgestellt werden.

## Regelmäßige Aktualisierung

Baumkataster täglich um 02:37 UTC; LOD1 Dienstag und Freitag um 03:23 UTC. LOD2.1 bewusst nur manuell. Die LOD2.1-Analyseworkflows sind ebenfalls manuell.

Bei der GitHub-Pages-Veröffentlichung werden die bisher gzip-komprimierten LOD1-PBF-Kacheln entpackt, da GitHub Pages dafür keine eigenen `Content-Encoding`-Header konfigurieren lässt. Die ursprünglichen Produktionsdateien auf Lima City bleiben unberührt.

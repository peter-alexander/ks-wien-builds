# Wiener Kartendaten-Builds

Dieses Repository erstellt und veröffentlicht vier Datensätze auf GitHub Pages, aufgeteilt in **zwei produktive Workflows**.

| Datensatz | Intervall (UTC) | Workflow | Veröffentlichung |
|---|---|---|---|
| Stadtplan Wien | täglich 00:19 | `publish.yml` | `StadtplanWien/style.json` |
| Baumkataster | täglich 02:37 | `publish.yml` | `Baumkataster/tilejson.json` |
| Gebäude LOD1 | Di und Fr 03:23 | `publish.yml` | `WienBuildings/LOD1/tilejson.json` |
| Gebäude LOD2.1 | Di und Fr 04:23 | `wien-lod21-publish.yml` | `WienBuildings/LOD21/release.json` |

Alle Uhrzeiten sind UTC und können durch GitHub-Actions-Warteschlangen verzögert ausgeführt werden. Alle vier Datensätze lassen sich zudem über `workflow_dispatch` manuell erstellen.

## Veröffentlichung

Die Workflows bauen aus `main`, validieren die Ausgabedaten und aktualisieren auf `gh-pages` **ausschließlich den jeweiligen Datensatz und `asset-versions.json`**. Andere Layer werden nicht gelöscht. Die gemeinsame Veröffentlichungs-Concurrency-Gruppe `wien-pages-publish` schützt vor gleichzeitigen Workflow-Pushes. Externe Änderungen am Branch werden unmittelbar vor dem Push über `git fetch` + `git rebase` berücksichtigt; bei einem Push-Rennen erfolgen höchstens drei Versuche ohne Force-Push.

GitHub Pages ist auf **Deploy from a branch → `gh-pages` → `/(root)`** eingestellt. Der automatisch von GitHub gestartete Lauf **pages build and deployment** ist nicht der Kartendaten-Build, sondern die Veröffentlichung der Änderungen aus `gh-pages`.

Der veröffentlichte Branch soll nur `.nojekyll`, `asset-versions.json` und die Ausgabeordner `Baumkataster/`, `StadtplanWien/`, `WienBuildings/` enthalten.

## LOD2.1

Die 734 Quellblätter werden in 63 getrennten Downloadpaketen geladen; vorhandene ZIPs werden über GitHub-Actions-Cache wiederverwendet. Erst wenn alle Pakete erfolgreich sind, wird das 3D-Modell gebaut und mit `validate-production.mjs` geprüft. Die Produktionsliste umfasst derzeit 2.309 ausgewählte historische Dach-Fallbacks.

Die Änderung zweier nicht mehr gültiger Wiener FMZK-IDs ist in `wien-lod21/current-source-reconciliation.json` dokumentiert und per Unit-Test abgesichert. Bei Änderungen am Bestand der Quellblätter muss der LOD2.1-ZIP-Cache-Namespace bewusst angepasst werden, damit keine veralteten Blätter übernommen werden.

## Entwicklungs- und Wartungsdateien

Die für Builds notwendigen Skripte und die Produktionsmanifeste bleiben auf `main`. Temporäre Netzwerkdiagnosen, experimentelle Matching-Workflows und ad-hoc-Analysen wurden entfernt. Die generierten Audit-Dateien und das Skript zur bewussten Neugenerierung der LOD2.1-Produktionsliste bleiben erhalten.

# etechnis-welt

Persönliche Themenwelt von **Bastian** – Erfinder, Bastler, Ingenieur.
Eine schlanke, statische Webseite (reines HTML/CSS/JS, ohne Build-Schritt),
die als Sandbox dient und Schritt für Schritt um neue Themen und Rechner
erweitert wird. Als **Progressive Web App** installierbar.

## Struktur

```
/
├── index.html                         Startseite mit Navigation und allen Themen
├── elektroauto-kostenvergleich.html   Rechner: Kostenvergleich Verbrenner vs. Elektroauto
├── elektroauto-nachtfahrt.html        Ratgeber: Langstrecke – Tipps für Nachtfahrten
├── zendure-simulation.html            Simulation: Zendure-Speicher im Verbund
├── weihnachtsquiz.html                Konzept: Quiz-Abend in 4 Runden, Papier/Handy umschaltbar (eigenständig, nicht in der Navigation)
├── css/
│   ├── site.css                       Design-System (Tokens) + Basis + Navigation
│   └── tools.css                      Wiederverwendbare Bausteine für Rechner/Tools
├── js/
│   ├── app.js                         Gemeinsame Logik (Nav, Update-Banner, PWA)
│   └── zendure-sim.js                 Regel-Engine (Port Zendure-HA) + Ersatzmodell
├── sw.js                              Service Worker (Offline + Update-Erkennung)
├── manifest.webmanifest               PWA-Manifest
├── icons/                             App-Icons (SVG + PNG, inkl. maskable)
└── img/                               Bilder zu den Themen
```

## Design-System (wichtig für neue Rechner)

Damit alle Seiten – besonders künftige Rechner/Tools – **automatisch gleich
aussehen**, ist das Design zentral abgelegt:

- **`css/site.css`** definiert alle **Design-Tokens** als CSS-Variablen
  (`:root`): Farben (Markenfarbe Blau `--accent`, Flächen, Datenreihen
  `--series-a`/`--series-b`), Typo-Skala (`--fs-*`), Radien. Farben und
  Größen nur hier ändern – sie wirken überall.
- **`css/tools.css`** enthält fertige Bausteine (`.tool`, `.panel`,
  `.readout`, `.tabs`/`.tab`, `.controls`/`.slider`, `table.data`,
  Tooltip …), die ausschließlich auf diesen Tokens aufbauen.

**Neuen Rechner anlegen:** eine HTML-Seite erstellen, `site.css` **und**
`tools.css` einbinden, die vorhandenen Klassen verwenden – fertig, das
Look & Feel passt ohne zusätzliches Styling.

## Navigation & Themen

Links liegt eine feste Navigationsleiste (mobil als ausklappbares Menü),
die die Themen gruppiert: **Elektromobilität** (inkl. Nachtfahrt-Ratgeber und Kostenvergleich Elektroauto),
**Energie & Wärme** (inkl. Speicher-Simulation Zendure), **Weitere Themen**. Ganz unten ein Zahnrad-Menü mit
„App installieren" und „Nach Updates suchen".

## PWA & Update-Erkennung

- `manifest.webmanifest` + `sw.js` machen die Seite installierbar und offline
  nutzbar. Installation über das Zahnrad-Menü unten in der Navigation.
- Der Service Worker erkennt neue Versionen. **Beim Deploy die `CACHE`-Version
  in `sw.js` erhöhen** – Besucher sehen dann automatisch das Banner
  „Neue Version verfügbar – Neu laden".

## Rechner: Kostenvergleich Verbrenner vs. Elektroauto

Interaktiv, dependency-frei (Diagramme als Inline-SVG). Vergleicht reale
Super-E10-Monatspreise (Sep 2022 – Aug 2026) mit den einstellbaren Ladekosten
eines Elektroautos (Mix aus Photovoltaik, Netz und unterwegs). Über einen
einstellbaren **Betrachtungszeitraum** (von Monat/Jahr bis Monat/Jahr) lässt
sich die Rechnung auf einen beliebigen Ausschnitt der Preisreihe einschränken;
die Gesamtfahrleistung wird dabei gleichmäßig auf die Monate des Zeitraums
verteilt. Reglerwerte und Zeitraum werden lokal gespeichert (localStorage) und
bleiben beim nächsten Besuch erhalten; neue Felder nach einem Update fallen
sauber auf ihre Standardwerte zurück.

Die Monatspreise sind bewusst **fest hinterlegt** (historische
Durchschnittswerte, rekonstruiert aus ADAC-/Statista-/en2x-Daten) und werden
nicht live geladen: Die Seite ist statisch/offlinefähig (PWA), historische
Monatsmittel ändern sich rückwirkend nicht, und es gibt keine frei nutzbare
API dafür. Neue Monate werden beim Deploy einfach am Ende der `PRICES`-Liste
ergänzt – der Rechner bleibt dadurch dauerhaft korrekt und funktioniert auch
in Zukunft ohne externe Abhängigkeit.

## Ratgeber: Langstrecke – Nachtfahrt mit dem Elektroauto

`elektroauto-nachtfahrt.html` – „Ladepause als Kraftpause“: Kaffee-Nap im
Ladestopp, Sitzposition, Schlafumgebung, Aufwachen, Fahrstrategie für die
Nacht, Essen & Trinken und Packliste. Reine Textseite; die Artikel-Bausteine
(`.guide`, `.guide-lead`, `.warn`, `.packlist`) liegen in `css/tools.css`
und sind für weitere Ratgeber-Seiten wiederverwendbar.

**Quellenangaben wie in einer wissenschaftlichen Arbeit:** Jede Zahl und jede
Aussage aus der Literatur trägt eine hochgestellte Fußnote (`<sup class="fn">`),
die auf das nummerierte Quellenverzeichnis am Seitenende (`#quelle-n`) springt;
von dort führt ↩ zurück zur ersten Textstelle (`#ref-n`). Nummeriert wird in
der Reihenfolge des ersten Auftretens, Fachartikel werden mit DOI zitiert.
Eine Druckansicht (`@media print` in `tools.css`) blendet Navigation und
Hintergrund aus und druckt hell, die URLs stehen ausgeschrieben im Verzeichnis.

## Simulation: Zendure-Speicher im Verbund

`zendure-simulation.html` + `js/zendure-sim.js` – Live-Simulation von einem
oder mehreren Zendure SolarFlow-Speichern (bis 8 Geräte – die Integration
selbst hat keine Obergrenze). PV-Leistung,
Hauslast, Wallbox, Messrauschen, Wolkenzug und Lastspitzen sind einstellbar,
der Zeitraffer stufenlos von 1× bis 1000× (logarithmischer Regler).
Gerätekarten, Verlaufsdiagramm (Leistung / Ladestand), Auswertung und ein
Regelprotokoll zeigen, was die Regelung tut. Ein Energiefluss-Diagramm
(nach dem Vorbild des Home-Assistant-Energie-Dashboards) zeigt live, wohin
die Energie fließt – PV, Netz, Haus, Wallbox und jeder Speicher einzeln.

- **Regelung = portierter Original-Code** der Home-Assistant-Integration
  [Zendure-HA](https://github.com/Zendure/Zendure-HA) (`manager.py`,
  `fusegroup.py`, `device.py`, `const.py`), Stand main @ `8d59bac`
  (11.10.2026) – die Regelung ist identisch mit Release 1.4.4. Kommentare im
  JS verweisen auf die Originalzeilen. Wird die Integration aktualisiert:
  Diff der vier Dateien seit diesem Commit nachziehen und `SOURCE` in
  `js/zendure-sim.js` anpassen.
- **Entlade-/Ladelimit je Gerät** als Schieberegler (Standard je 2400 W),
  wirken sofort in der laufenden Simulation. Mit „Integration kennt die
  Limits“ (Gerät meldet `inverseMaxPower`/`chargeMaxLimit`) rechnet die
  Regelung mit denselben Werten; ohne Haken mit ihren Code-Werten
  (`setLimits`, 2400 AC+: 2400/3200 W), während das Gerät nur die
  eingestellten Limits umsetzt – die Seite zeigt dann die Folgen.
- **Ersatzmodell** (Gerät folgt dem Sollwert mit Totzeit + PT1, Wirkungsgrade,
  Zählertakt) ist bewusst getrennt (`DevicePlant`, `Simulator`); die
  Parameter sind Annahmen und auf der Seite einstellbar. Wirkungsgrad als
  Round-Trip (Standard 85 %, real gemessener Wert), je Richtung √RT. Der Zähler löst wie
  Home Assistant nur bei geändertem Wert ein Ereignis aus.
- **Schaltvorgänge** werden gezählt wie in der Integration (`packState` → 0);
  Richtungswechsel Laden ↔ Entladen zusätzlich separat.
- **Verlauf:** komplette Historie ab Neustart (1 Wert/s, ab 48 h automatisch
  ausgedünnt), zoombar (Bereich aufziehen, Übersichtsleiste, Strg/⌘ +
  Mausrad, Buttons), Ereignisband mit allen Schaltvorgängen je Gerät,
  Zählung im gewählten Ausschnitt, Legende zum Ein-/Ausblenden von Linien.
- Nicht abgebildet: DC-Solareingang am Gerät (Bypass), Off-Grid-Steckdose,
  HEMS, Kalibrierfahrten, Akkuheizung, Legacy-Geräte (Hyper, Hub).
- Einstellungen werden lokal gespeichert (localStorage, Schlüssel
  `ew-zendure-sim-v3`). Die Engine läuft auch unter Node
  (`require("./js/zendure-sim.js")`) – praktisch für Tests.

Die Bausteine `.sim-bar`, `.speed-ctl`, `.btn`, `.dev-grid`/`.dev-card`,
`.powerbar`, `.socbar`, `.cfg-devs`/`.cfg-dev`, `.chart-tools`, `.chart-ov`, `.leg-btn`
und `.log-box` liegen in `css/tools.css` und sind für weitere Simulationen
wiederverwendbar; `--series-c` bis `--series-h` ergänzen die
Datenreihen-Farben in `css/site.css`.


## Hinweise

- Ausgelegt für GitHub Pages (statisch, relative Pfade).
- Bild-Dateinamen sind case-sensitive (z. B. `elektronik.JPG`).
- **Offen:** Bilder für „Photovoltaik & Speicher" sowie ein Impressum nach
  § 5 DDG (Name, Anschrift, Kontakt) ergänzen.

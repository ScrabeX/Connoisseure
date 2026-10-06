# Connoisseure

Statisches Frontend. `index.html`, `styles.css`, `app.js` und das lokale Auswahlpfeil-Icon `chevron.svg` liegen im Repository-Root; ein Build-Schritt ist nicht erforderlich. Die Oberfläche verwendet lokale SVG-Icons und Systemschriften, ohne zusätzliche UI-CDNs.

## Bedienung

Unter 1024 px gibt es eine einzige feste Navigation für **Dashboard**, **Historie** und **Statistik**. Das Kontosymbol im Kopfbereich öffnet das ausgewählte Profil, **Vorname wechseln** und **Abmelden**; auf größeren Bildschirmen liegen diese Aktionen in der Seitenleiste. Offene Fressungen stehen vor den abgeschlossenen Erlebnissen und Kennzahlen.

Während einer laufenden Fressung bleiben alle Bewertungen verborgen, bis das aktuell ausgewählte Mitglied selbst bewertet hat. Danach werden die eigene und alle bisher abgegebenen Bewertungen sichtbar, ohne auf die übrigen Teilnehmenden zu warten. Wer nicht teilnimmt, sieht sie erst nach Abschluss. Restaurant-Durchschnitte erscheinen weiterhin erst nach Abschluss; der Abgabestatus der Teilnehmenden bleibt sichtbar. Auch beim Vornamenwechsel und Zurücknavigieren wird die Anzeige für das aktuell ausgewählte Mitglied aktualisiert.

Die vier Bewertungskategorien erlauben weiterhin 0 bis 5 Sterne in 0,5er-Schritten: links auf einen Stern tippen für den halben Wert, rechts für den ganzen Wert; **0** setzt null Sterne. Mit Tab wird jede Kategorie erreicht, Pfeiltasten ändern den Wert um 0,5, **Pos1** setzt 0 und **Ende** setzt 5. Enter/Leertaste auf einem Stern wählt den ganzen Wert. Aktueller Wert und Halbsterne bleiben sichtbar. Dialoge unterstützen Escape, halten den Tastaturfokus und geben ihn beim Schließen zurück. Fehlermeldungen bleiben bis zur nächsten Aktion beziehungsweise bis zum Schließen sichtbar.

Für den Restaurant-Score, Gruppen-Durchschnitt und das Leaderboard wird **Essen dreifach** gewichtet; Service, Ambiente und Preis-Leistung zählen jeweils einfach. Die Einzelwerte der Kategorien bleiben unverändert. Die Gewichtung ist bei Essen mit `x3` markiert.

Goldene Fokusrahmen werden nicht verwendet. Bei Tastaturbedienung markieren dezente Unterstreichungen beziehungsweise Hintergrundtöne den aktiven Control; automatischer Fokus, Mausklicks und Touch erzeugen keine zusätzlichen Markierungsrahmen. Formularränder und die Auswahl der Teilnehmenden bleiben erhalten.

## Lokale Oberflächenprüfung

### Website lokal im Browser ansehen

Wechsle zuerst in den Branch, den du prüfen möchtest (zum Beispiel `git switch dev`). Im Repository-Ordner startest du dann in PowerShell den statischen Webserver:

```powershell
py -m http.server 8000
```

Öffne `http://localhost:8000` im Browser. Nach Änderungen an `index.html`, `styles.css` oder `app.js` kannst du die Seite neu laden; ein Build-Schritt ist nicht erforderlich. Mit **Strg+C** im Terminal beendest du den Server. Der Preview ist nur auf deinem Rechner erreichbar.

Wichtig: Die lokal gestartete Website verwendet bei Login und Aktionen weiterhin das konfigurierte Supabase-Projekt. Für isolierte UI-Prüfungen ohne echte Datenbankaktionen nutze die nachfolgend beschriebenen Browserchecks; sie ersetzen Supabase und OpenStreetMap durch Testdaten.

Die Website selbst benötigt keine npm-Abhängigkeiten. Die optionalen Browserchecks in `tests/` nutzen nur Playwright als Entwicklungswerkzeug:

```powershell
npm ci --prefix tests
node --check app.js
npm --prefix tests run check
```

Standardmäßig wird ein lokal installiertes Microsoft Edge verwendet. Für andere Chromium-Installationen kann `BROWSER_CHANNEL` z. B. auf `chrome` gesetzt werden. Der WebKit-Test ist separat möglich:

```powershell
Set-Location tests
npx playwright install webkit
$env:BROWSER_ENGINE = 'webkit'
npm run check
```

Für Firefox analog `npx playwright install firefox` ausführen und `BROWSER_ENGINE` auf `firefox` setzen. Firefox wird bei mobilen Breiten mit schmalem Viewport und Touch-Unterstützung geprüft, nicht mit einer emulierten mobilen Browser-Engine. `FOCUS_ONLY=1` beschränkt den Lauf auf die Fokusrahmen-Regressionsfälle bei 390 und 1440 px.

`CHECK_FILTER` beschränkt den Lauf auf Prüfgruppen, deren Namen den angegebenen Text enthalten. Die Bewertungs-Sichtbarkeit lässt sich gezielt mit `$env:CHECK_FILTER = 'submitted reviews'` und `npm --prefix tests run check` aus dem Repository-Root prüfen; danach `$env:CHECK_FILTER = ''` für den vollständigen Lauf setzen. Diese Fälle prüfen bei 390 und 1440 px die Sperre bis zur eigenen Abgabe, sofortige Freigabe bereits eingegangener Bewertungen, Nichtteilnehmende, Vornamenwechsel/Zurücknavigation sowie die endgültige Freigabe aller Bewertungen nach Abschluss.

Der Check startet und beendet seinen eigenen lokalen HTTP-Server unter einem simulierten `/Connoisseure/`-Unterpfad. Sämtliche externen Anfragen werden abgefangen: Supabase wird durch synthetische Mitglieder/Fressungen und RPC-Fixtures ersetzt, OSM durch lokale Antworten. Es werden keine echten Logins, Datenänderungen oder öffentlichen Suchanfragen ausgeführt. Geprüft werden Ansichten und Dialoge bei 320, 375, 390, 768, 1024 und 1440 px, Overflow, Button-Zentrierung/44-px-Touchziele, Fokus/Navigation, Halbsternwerte, Fressungsablauf, Rechte, Durchschnittswerte/Ranking, Mitglieder-Lade-Race sowie OSM-Autofill/Cache/Cooldown. Screenshots und `report.json` landen im temporären Ordner `connoisseure-ui-checks`; `SCREENSHOT_DIR` kann einen anderen Ausgabeordner festlegen.

Die kurzen Viewport-Checks simulieren den verbleibenden Platz bei geöffneter Bildschirmtastatur. Sie ersetzen keinen Test auf einem physischen iOS-/Android-Gerät oder mit einem Screenreader.

## Veröffentlichung mit GitHub Pages

1. In GitHub **Settings → Pages** öffnen.
2. Unter **Build and deployment → Source** die Option **GitHub Actions** auswählen.
3. Änderungen nach `main` pushen. Der Workflow **Deploy static site to GitHub Pages** veröffentlicht die Seite; alternativ lässt er sich unter **Actions** manuell starten.

Die Projektseite ist anschließend unter `https://scrabex.github.io/Connoisseure/` erreichbar. Das Frontend verwendet derzeit keine root-absoluten Asset- oder Navigationspfade und funktioniert daher auch unter dem Repository-Unterpfad.

Der Pages-Workflow veröffentlicht nur Änderungen auf `main`; Pushes auf `dev` aktualisieren die öffentliche Projektseite nicht.

## Supabase

Das Frontend verwendet Supabase JS v2 über ein Browser-CDN und die öffentliche Publishable-Key-Konfiguration direkt in `app.js`. Es enthält weder den Gruppen-PIN noch einen Secret- oder `service_role`-Key. Der PIN wird ausschließlich im Anmeldeformular eingegeben; angemeldet wird mit dem fest konfigurierten gemeinsamen Gruppen-Konto.

Vor dem ersten Login muss dieses Auth-Konto in Supabase manuell angelegt werden (E-Mail `connoisseur.pro@gmx.de`, PIN als Passwort; Signups bleiben deaktiviert). Danach müssen die additiven Migrationen in `supabase/migrations/` angewendet werden: Sie erlauben den durch RLS beschränkten Mitglieder-Insert und tragen die vorhandene Gruppen-Auth-ID in `private.group_access` ein. Die Allowlist-Migration setzt voraus, dass das Auth-Konto bereits angelegt wurde. Die App nutzt `signInWithPassword` und navigiert dabei nicht per Auth-Redirect; **Authentication → URL Configuration** ist deshalb keine Voraussetzung für diesen Login. Site URL und Redirect-Allowlist sollten auf `https://scrabex.github.io/Connoisseure/` zeigen, falls später Bestätigungs-, Recovery- oder andere Redirect-Flows verwendet werden. Die erste Gruppenperson muss nicht vorab geseedet werden: Der erste Login kann den eigenen Vornamen direkt in der App eintragen.

Die App lädt Mitglieder, Fressungen, Teilnehmende und Bewertungen nach der Anmeldung aus dem bereits eingerichteten Schema. Sie fügt neue Fressungen als `waiting` ein und nutzt ausschließlich `start_meal` und `submit_meal_rating` für die durch RPC geschützten Schreibvorgänge. Weil alle Mitglieder dieselbe Auth-Identität verwenden, ist die ausgewählte Mitglieds-ID nur eine lokale Browser-Auswahl und kein individueller Identitätsnachweis.

Das Zurückhalten fremder Bewertungen bis zur eigenen Abgabe (beziehungsweise bis zum Abschluss für Nichtteilnehmende) ist eine Anzeigeregel, keine Zugriffssperre in der Datenbank: Das gemeinsame Gruppen-Konto lädt weiterhin die Bewertungsdaten. Ein technisch neugieriger angemeldeter Nutzer kann diese über Browserwerkzeuge einsehen; eine serverseitige Sperre pro Person würde individuelle Identitäten und angepasste Datenbankregeln voraussetzen.

## Restaurant-Suche mit OpenStreetMap

Das Formular fragt den öffentlichen Nominatim-Dienst von OpenStreetMap erst nach einem Klick auf **Suchen** (oder Enter) ab; es gibt keine Live-Suche während des Tippens. Die Anfrage liefert höchstens fünf Treffer. Anfragen werden im Tab serialisiert und, sofern unterstützt, browserübergreifend zwischen Tabs auf mindestens eine Sekunde Abstand begrenzt. Ergebnisse werden bis zu 24 Stunden lokal zwischengespeichert, und auf HTTP 429/503 wird mindestens eine Minute pausiert. Die Suchergebnisse zeigen die erforderliche Attribution zu [OpenStreetMap-Mitwirkenden](https://www.openstreetmap.org/copyright). Es ist weder API-Key noch Supabase-Schemaänderung erforderlich.

Der öffentliche Nominatim-Endpunkt ist kostenlos nutzbar, aber ein gemeinsamer Best-Effort-Dienst ohne Verfügbarkeitsgarantie; die Treffer hängen davon ab, was in OpenStreetMap eingetragen ist, daher bleiben alle Felder bearbeitbar und manuell ausfüllbar. Seine Grenze von maximal einer Anfrage pro Sekunde gilt für die gesamte Anwendung. Ein statisches Frontend kann gleichzeitige Zugriffe über verschiedene Geräte nicht zentral koordinieren oder die Gesamtgrenze garantieren. Deshalb ist diese Integration nur für gelegentliche Suchen einer kleinen Gruppe gedacht, nicht für viel oder automatisierten Traffic. Bei HTTP 429/503 nicht weiterprobieren; warten und Suchanfragen reduzieren. Details stehen in der [Nominatim Usage Policy](https://operations.osmfoundation.org/policies/nominatim/).

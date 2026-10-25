# Scoreboard Livestream

Ein interaktives Live-Scoreboard-System für Roundnet-Spiele mit Echtzeit-Synchronisation über Firebase.

## 📁 Seiten & Navigation

```
index.html  „Live Matches“ (Übersicht, Startseite)  ⇄  input.html „Input Panel“   (Links neben dem Titel)
 ├─ Karte anklicken ────────► display.html?org=&court=&theme=spectator  (Zuschauer-Ansicht, ← zurück)
 ├─ ✎ (Login, eigene Courts) ► input.html?org=&court=
 └─ ⧉ (Login, eigene Courts) ► kopiert den Stream-Link display.html?org=&court=&theme=<Theme der Org>
```

Der **Login ist seitenübergreifend** (`js/auth.js`): Firebase merkt sich die Sitzung pro Domain – wer sich in der Übersicht anmeldet, ist auch im Input-Panel angemeldet und umgekehrt (gleiche Feldnamen, Passwort-Manager füllen beide). Nach dem Login filtert die Übersicht auf die eigene Org. Ohne Login ist alles außer dem Input-Panel nutzbar.

### `index.html` - Übersicht (Startseite)
**Alle Courts aller Orgs** auf einen Blick, öffentlich. Angemeldete Accounts sehen bei ihren Courts zusätzlich den Weg ins Input-Panel und zum Output. Alte Links auf den Court (`index.html?org=&court=`, `?channel=`, `?theme=`) leiten automatisch auf `display.html` weiter – Stream-, OBS- und Playerzone-Links bleiben gültig; `?org=` allein ist der Org-Filter der Übersicht.

- **Was läuft?** Entscheidet `summarizeMatch()` in `js/matchStatus.js` allein aus den Match-Daten:
  - *Live* – `updated_at` jünger als 10 Minuten und schon Punkte (die Playerzone blendet erst nach 20 Minuten aus)
  - *Not started* – kürzlich geändert, aber noch 0:0 (z. B. gerade ein PZ-Spiel geladen)
  - *Just finished* – laut Spielmodus (`game_settings.set_mode`) entschieden und in den letzten 20 Minuten geändert
  - *Inactive* – alles andere: ein laufendes Spiel nach 10, ein entschiedenes nach 20 Minuten ohne Änderung, oder nie ein `updated_at`
- **Pro Court:** Spieltitel (`phase`) und Event, darunter Org · Court; Teams mit Farbe, Flagge, Club- oder Team-Logo und Spielern – so, wie es in den Einstellungen des Courts (`admin_settings`) eingeschaltet ist –, Aufschlag (aus Score und `starting_server`, wie die Boards), Squad-Score (nur wenn *Group Score* für den Court an ist) und alle Satzstände (aktueller Satz hervorgehoben), laufender Timeout/Medical/Break mit Countdown, „On court since“ (aus `live_games`) bzw. letzte Änderung.
- **Squad-Spiele (Liga):** Courts, deren `match-<kanal>/playerzone.main_game_id` gleich ist (ab zwei Courts), erscheinen als ein Block (`js/squadGroups.js`): oben beide Squads mit einem **berechneten Squad-Stand** – Anzahl der entschiedenen Teilspiele je Squad (`summarizeMatch().winner`), nur lesend, nichts wird nach Firebase geschrieben –, darunter die Teilspiele mit Court, Paarungen und Satzständen. Zählt nur, was gerade auf den Courts steht: ein Teilspiel, dessen Court schon das nächste Spiel geladen hat, fehlt. Die Seiten: die Playerzone setzt in jedem Teilspiel team1 des Hauptspiels als `team_a`; wurden die Namen auf einem Court vertauscht, wird das Teilspiel über die Namen gedreht. Der Block steht in der Gruppe seines aktivsten Teilspiels; ein Suchtreffer in einem Teilspiel zeigt den ganzen Block.
- **Gruppen:** *On court* ist immer offen, *Just finished* und *Inactive courts* lassen sich über den Chevron auf- und zuklappen (Inactive ist anfangs zu; wird pro Browser gemerkt).
- **Links:** Karte → Zuschauer-Ansicht; *Playerzone* (nur bei verknüpftem Spiel, öffnet `…/tournaments/game-info/<game_id>`); mit Login für die eigenen Courts Input-Panel und Output.
- **Filter:** Suche (Team, Spieler, Court, Event), Org-Auswahl – auch als Link: `index.html?org=<org>`.
- Liest pro Court nur die Knoten, die eine Karte braucht – nie `event_history`.

### `display.html` - Live-Display
Das **Scoreboard eines Courts** – für Livestream/OBS (Themes `rg`, `small`, `tops`, `france`, `eura`, `irf`; transparent) und für Zuschauer und Bildschirme am Court (`spectator`, auch ohne `theme` und für alte `theme=full`-Links): `display.html?org=<org>&court=<court>&theme=<theme>`. Ein neues Stream-Theme gehört auch in `streamThemes` in `display.html` (sonst lädt es mit dunklem Hintergrund).

**Theme `spectator`** (`css/style-spectator.css`, `js/spectator.js`): großes Board in Teamfarben (Oswald) mit Flagge bzw. Club-/Team-Logos und Aufschlag-Punkten wie in den Stream-Themes, darüber ein Header: zurück zur Übersicht, Spiel, Event · Org · Court · Modus und rechts *Statistics* (Match / aktueller Satz; Score-Verlauf und Match-Preview sind vorerst raus). Die öffnet jede:r Zuschauer:in für sich – die Overlay-Einstellungen des Courts für den Stream (`admin_settings.show_…`) gelten dort nicht. Größen über Container-Queries: Teams nebeneinander im Querformat, untereinander im Hochformat, vom Handy bis zum TV.

### `input.html` - Input-Panel
Bedienung eines Courts (Login nötig): Scores, Spieldaten, Playerzone-Anbindung, Anzeige-Einstellungen, Output-URL für den Stream.

## 🔐 Orgs, Courts & Rechte

Jede Org (Verband/Veranstalter) bedient ihre eigenen **Courts 1..n**. Gespeichert wird weiterhin unter `match-<kanal>`, damit LED-Boards und Bridges unverändert bleiben – welcher Court welcher Kanal ist, steht in `orgs`.

| Knoten | Inhalt | Lesen | Schreiben |
|---|---|---|---|
| `match-<kanal>` | Spielstand | alle | Admins + Accounts, deren Org den Kanal in `channels` hat |
| `orgs/<org>` | `{ name, channels: { <kanal>: <court> }, theme? }` – `theme` = Stream-Theme der Org für kopierte Stream-Links (Standard `rg`) | alle | nur Console |
| `accounts/<uid>` | `{ org, role: "operator" \| "admin", email }` | der Account selbst, Admins | nur Console |
| `match-<kanal>/playerzone` | `{ game_id, main_game_id, event_id }` des geladenen Playerzone-Spiels | alle | wie `match-<kanal>` |
| `match-<kanal>/updated_at` | Server-Zeitstempel des letzten Schreibens (Score, Timer) | alle | wie `match-<kanal>` |
| `live_games/<game_id>` | `{ channel, main_game_id, org, court, since }` – Spiele, die gerade auf einem Court laufen | alle | Admins + Accounts, deren Org den Kanal hat – für den alten **und** den neuen `channel` |
| `match-<kanal>/squad_auto` | `{ main_game_id, results: { <game_id>: { winner, side } } }` – bekannte Teilspiel-Ergebnisse für den automatischen Squad-Score | alle | wie `match-<kanal>` |
| `bridgeConfig` | Bridge-Konfiguration | alle | Admins |

Output-Links: `display.html?org=<org>&court=<court>&theme=<theme>` (alt, weiterhin gültig: `?channel=<kanal>`). Login nur per E-Mail.

### Playerzone-Anbindung
Im Input-Panel unter *Playerzone* ein Turnier, eine Phase und ein Spiel auswählen – oder die Game-ID einfügen, die der Button auf der Spielkarte in der Playerzone kopiert. Das Spiel wird über `GET /api/games/<id>/scoreboard` geladen und wie ein Import übernommen (gesperrte Felder bleiben). Zusätzlich wird es für die Live-Anzeige der Playerzone verknüpft:

- `match-<kanal>/playerzone` und `live_games/<game_id>` werden gesetzt, der `live_games`-Eintrag des vorherigen Spiels auf diesem Court entfernt (nur, solange er noch auf diesen Kanal zeigt).
- Die Playerzone liest daraus `match-<kanal>/score/set_N/team_a_score|team_b_score` und `active_set` (`team_a` = PZ-Team 1) und blendet ein Spiel aus, wenn sich `updated_at` 20 Minuten nicht geändert hat.
- *End game* entfernt `live_games/<game_id>` und `match-<kanal>/playerzone`.
- Zwischenergebnis: `POST /api/games/<id>/scoreboard-sync` lässt die Playerzone den aktuellen Stand aus Firebase speichern – nach jedem Satzende, vor dem Laden eines anderen Spiels, vor *End game* und vor *Reset Scores* (Game-ID jeweils aus `match-<kanal>/playerzone/game_id`), beim Schließen des Tabs per `sendBeacon`. Max. 5 s, schlägt er fehl, gibt es nur einen Hinweis.

Zum Testen gegen eine lokale Playerzone: `input.html?pz=http://localhost:8000` (wird im Browser gemerkt, zurück mit `?pz=default`). Wirkt nur, wenn das Scoreboard selbst auf `localhost` läuft – auf der Live-Seite wird `?pz=` ignoriert.

### Neue Org anlegen
1. Account in der Firebase Console unter *Authentication → Users* anlegen und die **User UID** kopieren.
2. Freie Kanalnummern wählen – ein Kanal darf nur in **einer** Org stehen.
3. In der Realtime Database eintragen:
   - `orgs/<org>` = `{ "name": "…", "channels": { "<kanal>": 1, "<kanal>": 2 } }` (Kanal → Court-Nummer)
   - `accounts/<uid>` = `{ "org": "<org>", "role": "operator", "email": "…" }` (`email` ist nur zur Übersicht)

### Weiteren Account zu einer Org hinzufügen
Account anlegen, UID kopieren, dann `accounts/<uid>` = `{ "org": "<org>", "role": "operator", "email": "…" }`.

### Admin festlegen
`role` des Accounts auf `"admin"` setzen (zurück: `"operator"`). Admins dürfen in jeden Kanal und in `bridgeConfig` schreiben und sehen im Input-Panel die Courts aller Orgs, ihre eigene Org zuerst. Ein Admin braucht keine Org (`org` darf fehlen).

### Regeln testen
Vor jeder Regeländerung lokal gegen den Firebase-Emulator testen (braucht Java, z. B. `brew install openjdk`):

```bash
npm install
npm run test:rules
```

### Automatischer Squad-Score
Im Input-Panel unter *Display Options → Squad Score* zwischen *Manual* und *Automatic* wählen (`admin_settings.group_score_mode`). Automatisch zählt das Panel die entschiedenen Teilspiele des verknüpften PZ-Squad-Spiels und schreibt sie als normalen Squad-Score (`score.squad_score`) – Boards, Overlays, LED-Boards und Übersicht zeigen ihn also ohne Änderung. Logik in `js/autoSquadScore.js` und `js/squadGroups.js`:

- Die anderen Teilspiele findet es über `live_games` (gleiche `main_game_id`, braucht `.indexOn` in den Regeln).
- Ein Teilspiel zählt, sobald es laut Spielmodus entschieden ist; der Sieger wird über den Teamnamen zugeordnet (Teilspiele tragen die Squad-Namen), sonst über die Seite.
- Weil *End game* die Verknüpfung löscht, merkt sich jeder Court die bekannten Ergebnisse unter `squad_auto`; die Courts lesen sie gegenseitig. Ein Court, der ein Teilspiel gerade trägt, überschreibt das gespeicherte Ergebnis (z. B. nach einer Korrektur).
- Gerechnet wird nur, solange ein Panel für den Court offen ist; ohne PZ-Teilspiel auf dem Court bleibt der Score manuell. Die Felder sind gesperrt, solange automatisch gezählt wird.

### Score-History
`match-<kanal>/event_history` hält pro Team und Satz eine lückenlose Folge 1, 2, 3, … bis zum aktuellen Score (Logik in `js/scoreHistory.js`). Jede Score-Änderung „gleicht ab“ statt Events anzuhängen: niedriger entfernt alle Punkte darüber, höher füllt jeden fehlenden Punkt auf – idempotent, also auch bei Tippfehlern und zwei Geräten auf einem Court konsistent. Getippte Werte (z. B. „15“ über eine 10) zählen erst nach 0,7 s Tipp-Pause oder beim Verlassen des Feldes; ±1-Buttons und Pfeiltasten sofort. Die Anzeigen lesen die History zusätzlich bereinigt (nur steigende Scores, keiner über dem tatsächlichen). Tests ohne Emulator:

```bash
npm run test:unit
```

### Ergebnis bestätigen
Ist ein Match vorbei, zeigt das Input-Panel über *Reset Scores* den Button **Validate Result**: Beide Teams bestätigen den Endstand, der dann als `match-<kanal>/result_validated` = `{ nonce, sets: [[a, b], …], at }` geschrieben wird – derselbe Knoten, den die LED-Scoreboards schreiben (Pedal halten auf „OK? / HOLD“ oder Button im Board-Portal). RoundnetFranceConnect (Turnier-App des französischen Verbands) trägt genau diesen Stand ein und antwortet in `match-<kanal>/rfc_result` = `{ nonce, status: "recorded" | "rejected", message?, next?: { team_a, team_b } }` (`next` = Court des nächsten Matches jedes Teams); das Panel zeigt die Antwort zur gleichen `nonce` unter dem Button. Eine Bestätigung gilt nur für genau den Stand, für den sie gegeben wurde – nach einer Korrektur erscheint der Button wieder, *Reset Scores* löscht sie. Logik in `js/resultValidation.js`, Tests in `npm run test:unit`.

### Regeln deployen
Die Regeln liegen in [`database.rules.json`](database.rules.json). Entweder in der Console unter *Realtime Database → Rules* einfügen oder per CLI:

```bash
npx firebase-tools deploy --only database
```

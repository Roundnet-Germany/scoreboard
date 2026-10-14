# Scoreboard Livestream

Ein interaktives Live-Scoreboard-System für Roundnet-Spiele mit Echtzeit-Synchronisation über Firebase.

## 📁 HTML-Dateien

### `input.html` - Admin-Interface
Das **Admin-Interface** für die Spielleitung und Turnierorganisatoren:

- **Zweck**: Eingabe und Verwaltung aller Spielerdaten, Scores und Einstellungen
- **Funktionen**:
  - Live-Score-Eingabe für beide Teams
  - Theme-Auswahl für verschiedene Nutzer und Anwendungsfälle
  - Channel-Management für mehrere Spielfelder
  - Match-Statistiken einblenden

### `index.html` - Live-Display
Das **Live-Display** für Zuschauer und Livestream:

- **Zweck**: Anzeige der aktuellen Spielstände und Statistiken für das Publikum
- **Funktionen**:
  - Live-Score-Anzeige
  - Spieler-Namen und Team-Farben
  - Serve-Indikatoren
  - Match-Statistiken-Overlay
  - Score-Historie und Charts

## 🔄 Workflow

1. **Admin** öffnet `input.html` und loggt sich ein
2. **Spieldaten** werden über das Admin-Interface eingegeben
3. **Live-Display** (`index.html`) zeigt automatisch alle Änderungen in Echtzeit
4. **Zuschauer** sehen das Live-Display auf Großbildschirmen oder im Livestream
## 🔐 Orgs, Courts & Rechte

Jede Org (Verband/Veranstalter) bedient ihre eigenen **Courts 1..n**. Gespeichert wird weiterhin unter `match-<kanal>`, damit LED-Boards und Bridges unverändert bleiben – welcher Court welcher Kanal ist, steht in `orgs`.

| Knoten | Inhalt | Lesen | Schreiben |
|---|---|---|---|
| `match-<kanal>` | Spielstand | alle | Admins + Accounts, deren Org den Kanal in `channels` hat |
| `orgs/<org>` | `{ name, channels: { <kanal>: <court> } }` | alle | nur Console |
| `accounts/<uid>` | `{ org, role: "operator" \| "admin", email }` | der Account selbst, Admins | nur Console |
| `bridgeConfig` | Bridge-Konfiguration | alle | Admins |

Output-Links: `index.html?org=<org>&court=<court>&theme=<theme>` (alt, weiterhin gültig: `?channel=<kanal>`). Login nur per E-Mail.

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

### Regeln deployen
Die Regeln liegen in [`database.rules.json`](database.rules.json). Entweder in der Console unter *Realtime Database → Rules* einfügen oder per CLI:

```bash
npx firebase-tools deploy --only database
```

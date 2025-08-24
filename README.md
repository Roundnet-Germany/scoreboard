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
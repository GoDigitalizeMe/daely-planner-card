# Daely Planner Card

Lovelace-Karte im Stil des [Dæly Familienkalenders](https://daely-shop.com/products/daely-calendar-familienkalender-familienplaner-15-6):
ein Wochenraster mit farbcodierten Terminen aus mehreren Kalendern.

Diese Karte ist der reine Anzeige-Layer. Die eigentliche Logik (Kalenderauswahl,
Farben, Datenabruf) übernimmt die zugehörige Python-Integration:
👉 **[daely-planner-ha](https://github.com/GoDigitalizeMe/daely-planner-ha)**
– dort zuerst installieren und einrichten, bevor diese Karte einen
gültigen `entity`-Wert zur Auswahl hat.

## Installation über HACS

1. HACS → Dashboard (bzw. Frontend/Plugin, je nach HACS-Version) →
   benutzerdefiniertes Repository hinzufügen:
   `https://github.com/GoDigitalizeMe/daely-planner-card`, Typ **Dashboard**
   (ältere HACS-Versionen: **Plugin**).
2. „Daely Planner Card" in der Liste öffnen und herunterladen.
3. Home Assistant Frontend neu laden (harter Browser-Reload reicht i. d. R.).

## Manuelle Installation

1. `dist/daely-planner-card.js` nach `config/www/daely-planner-card.js` kopieren.
2. Einstellungen → Dashboards → Ressourcen → Ressource hinzufügen:
   URL `/local/daely-planner-card.js`, Typ „JavaScript-Modul".

## Verwendung

Dashboard bearbeiten → Karte hinzufügen → „Daely Planner Card" (visueller
Editor) oder manuell per YAML:

```yaml
type: custom:daely-planner-card
entity: sensor.familie_termine   # Sensor der daely_planner-Integration
title: Familienplaner
language: de
first_day_of_week: monday
show_weekends: true
show_legend: true
```

| Option | Standard | Beschreibung |
| --- | --- | --- |
| `entity` | *(erforderlich)* | Sensor-Entity der Daely-Planner-Integration |
| `title` | Entity-Titel | Überschrift der Karte |
| `language` | `de` | Sprache für Wochentage/Monate (`de`/`en`) |
| `first_day_of_week` | `monday` | Wochenstart |
| `days` | `7` (bzw. `5` bei `show_weekends: false`) | Anzahl angezeigter Tage |
| `show_weekends` | `true` | `false` blendet Sa/So aus |
| `show_legend` | `true` | Farblegende der Kalender ein-/ausblenden |

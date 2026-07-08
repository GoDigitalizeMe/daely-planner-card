# Daely Planner Card

Lovelace-Karte im Stil des [Dæly Familienkalenders](https://daely-shop.com/products/daely-calendar-familienkalender-familienplaner-15-6):
ein Tages-Zeitraster (Standard 08:00–18:00 Uhr) mit farbcodierten Terminen
aus mehreren Kalendern, wahlweise mit Personen-Avataren statt Farbpunkten.

- **Termine mit Uhrzeit** erscheinen im Zeitraster genau dort, wo sie
  stattfinden (überlappende Termine werden automatisch nebeneinander
  gesetzt).
- **Ganztägige und mehrtägige Termine** (auch mehrtägige Termine *mit*
  Uhrzeit, z. B. eine Dienstreise) werden als Banner oberhalb des
  Zeitrasters über die betroffenen Tage angezeigt.

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
day_start_hour: 8
day_end_hour: 18
show_weekends: true
show_legend: true
```

| Option | Standard | Beschreibung |
| --- | --- | --- |
| `entity` | *(erforderlich)* | Sensor-Entity der Daely-Planner-Integration |
| `title` | Entity-Titel | Überschrift der Karte |
| `language` | `de` | Sprache für Wochentage/Monate (`de`/`en`) |
| `first_day_of_week` | `monday` | Wochenstart |
| `day_start_hour` | `8` | Erste angezeigte Stunde im Zeitraster |
| `day_end_hour` | `18` | Letzte angezeigte Stunde im Zeitraster |
| `days` | `7` (bzw. `5` bei `show_weekends: false`) | Anzahl angezeigter Tage |
| `show_weekends` | `true` | `false` blendet Sa/So aus |
| `show_legend` | `true` | Farblegende der Kalender ein-/ausblenden |

## Kalender einer Person zuordnen

Verknüpfe in der [Integration](https://github.com/GoDigitalizeMe/daely-planner-ha)
einen Kalender optional mit einer `person.*`-Entity. Ist eine Person
hinterlegt, zeigt die Karte automatisch deren Profilbild statt eines
schlichten Farbpunkts – an Terminen, in der Legende und im Detail-Popup.

## Filtern nach Person oder Kalender

Im Footer der Karte gibt es zwei klickbare Zeilen: oben die **Personen**,
unten die **Kalender**. Ein Klick markiert die Auswahl (mehrere gleichzeitig
möglich) und hebt deren Termine im Zeitraster deutlicher hervor
(kräftigerer Rahmen/Schatten), während alle anderen Termine transparenter
dargestellt werden – nichts wird komplett ausgeblendet. Erneutes Klicken
hebt die Auswahl wieder auf.

# Familyboard Planner Card

Lovelace-Karte für einen Familien-Wandkalender: ein Tages-Zeitraster
(Standard 06:00–18:00 Uhr) mit farbcodierten Terminen aus mehreren
Kalendern, wahlweise mit Personen-Avataren statt Farbpunkten.

- **Termine mit Uhrzeit** erscheinen im Zeitraster genau dort, wo sie
  stattfinden (überlappende Termine werden automatisch nebeneinander
  gesetzt).
- **Ganztägige und mehrtägige Termine** (auch mehrtägige Termine *mit*
  Uhrzeit, z. B. eine Dienstreise) werden als Banner oberhalb des
  Zeitrasters über die betroffenen Tage angezeigt.
- Das Zeitraster zeigt standardmäßig **06:00–18:00 Uhr** ohne Scrollen
  (per `day_start_hour`/`day_end_hour` frei einstellbar), lässt sich aber
  nach oben/unten scrollen, um frühere/spätere Termine zu sehen – der
  volle Tag (00:00–24:00) ist immer erreichbar.
- **Wochennavigation**: Pfeile und ein Dropdown im Header wechseln zur
  vorherigen/nächsten bzw. einer frei wählbaren Woche (±12 Wochen).

Diese Karte ist der reine Anzeige-Layer. Die eigentliche Logik (Kalenderauswahl,
Farben, Datenabruf) übernimmt die zugehörige Python-Integration:
👉 **[familyboard-planner-ha](https://github.com/GoDigitalizeMe/familyboard-planner-ha)**
– dort zuerst installieren und einrichten, bevor diese Karte einen
gültigen `entity`-Wert zur Auswahl hat.

## Installation über HACS

1. HACS → Dashboard (bzw. Frontend/Plugin, je nach HACS-Version) →
   benutzerdefiniertes Repository hinzufügen:
   `https://github.com/GoDigitalizeMe/familyboard-planner-card`, Typ **Dashboard**
   (ältere HACS-Versionen: **Plugin**).
2. „Familyboard Planner Card" in der Liste öffnen und herunterladen.
3. Home Assistant Frontend neu laden (harter Browser-Reload reicht i. d. R.).

## Manuelle Installation

1. `dist/familyboard-planner-card.js` nach `config/www/familyboard-planner-card.js` kopieren.
2. Einstellungen → Dashboards → Ressourcen → Ressource hinzufügen:
   URL `/local/familyboard-planner-card.js`, Typ „JavaScript-Modul".

## Verwendung

Dashboard bearbeiten → Karte hinzufügen → „Familyboard Planner Card"
(visueller Editor) oder manuell per YAML:

```yaml
type: custom:familyboard-planner-card
entity: sensor.familie_termine   # Sensor der familyboard_planner-Integration
title: Familienplaner
language: de
first_day_of_week: monday
day_start_hour: 6
day_end_hour: 18
viewport_padding_minutes: 30
show_weekends: true
show_legend: true
```

| Option | Standard | Beschreibung |
| --- | --- | --- |
| `entity` | *(erforderlich)* | Sensor-Entity der Familyboard-Planner-Integration |
| `title` | Entity-Titel | Überschrift der Karte |
| `language` | `de` | Sprache für Wochentage/Monate (`de`/`en`) |
| `first_day_of_week` | `monday` | Wochenstart |
| `day_start_hour` | `6` | Ohne Scrollen sichtbarer Bereich beginnt hier |
| `day_end_hour` | `18` | Ohne Scrollen sichtbarer Bereich endet hier |
| `viewport_padding_minutes` | `30` | Zusätzlicher Rand oben/unten, damit die Randstunden nicht abgeschnitten wirken |
| `days` | `7` (bzw. `5` bei `show_weekends: false`) | Anzahl angezeigter Tage |
| `show_weekends` | `true` | `false` blendet Sa/So aus |
| `show_legend` | `true` | Farblegende der Kalender ein-/ausblenden |
| `exclude_persons` | `[]` | Liste von `person.*`-Entities, die im Header/Filter nicht angezeigt werden (z. B. ein Display-/Wallboard-Account) |

## Kalender einer Person zuordnen

Verknüpfe in der [Integration](https://github.com/GoDigitalizeMe/familyboard-planner-ha)
einen Kalender optional mit einer `person.*`-Entity. Ist eine Person
hinterlegt, zeigt die Karte automatisch deren Profilbild statt eines
schlichten Farbpunkts – an Terminen, in der Legende und im Detail-Popup.

## Filtern nach Person oder Kalender

**Personen** (Kalender mit zugewiesener `person.*`-Entity) erscheinen oben
im Header neben dem Titel. Kalender **ohne** Personenzuordnung stehen
weiterhin unten im Footer. Beide Bereiche sind klickbar und funktionieren
als Filter (Mehrfachauswahl möglich): Ein Klick hebt die zugehörigen
Termine im Zeitraster deutlicher hervor (kräftigerer Rahmen/Schatten),
während alle anderen Termine nur transparenter dargestellt werden – nichts
wird komplett ausgeblendet. Erneutes Klicken hebt die Auswahl wieder auf.

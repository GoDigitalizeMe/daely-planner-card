/**
 * Daely Planner Card
 *
 * A Lovelace card styled after the Daely family calendar: a weekly grid
 * with one column per day, events from several Home Assistant calendars
 * stacked underneath, each colored per the "Daely Planner" custom
 * integration's configuration. Talks to the backend only through the
 * `daely_planner/get_events` WebSocket command exposed by that integration.
 */

const WEEKDAY_LABELS = {
  de: ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"],
  en: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
};

const MONTH_LABELS = {
  de: [
    "Januar", "Februar", "März", "April", "Mai", "Juni",
    "Juli", "August", "September", "Oktober", "November", "Dezember",
  ],
  en: [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ],
};

function pad2(n) {
  return String(n).padStart(2, "0");
}

function toDateKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function hexToRgba(hex, alpha) {
  const clean = (hex || "#8FC1D4").replace("#", "");
  const bigint = parseInt(clean, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

class DaelyPlannerCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = null;
    this._data = null;
    this._lastSignature = null;
    this._refreshTimer = null;
    this._tickTimer = null;
    this._fetching = false;
  }

  setConfig(config) {
    if (!config || !config.entity) {
      throw new Error("daely-planner-card: 'entity' is required (the Daely Planner sensor entity).");
    }
    this._config = {
      title: null,
      language: "de",
      first_day_of_week: "monday",
      days: null,
      show_weekends: true,
      show_legend: true,
      ...config,
    };
    this._render();
  }

  set hass(hass) {
    const prevEntityState = this._hass ? this._hass.states[this._config.entity] : null;
    this._hass = hass;
    if (!this._config) return;

    const entityState = hass.states[this._config.entity];
    if (!entityState) {
      this._render();
      return;
    }

    const signature = `${entityState.state}|${entityState.attributes.range_start}|${entityState.attributes.range_end}`;
    if (signature !== this._lastSignature || !prevEntityState) {
      this._lastSignature = signature;
      this._fetchEvents(entityState);
    } else if (!this._data) {
      this._render();
    }
  }

  connectedCallback() {
    // Keep "today" highlighting correct on a display left running for days,
    // and re-fetch periodically as a safety net beyond the entity-change trigger.
    this._tickTimer = window.setInterval(() => this._render(), 60 * 1000);
    this._refreshTimer = window.setInterval(() => {
      if (this._hass && this._config) {
        const entityState = this._hass.states[this._config.entity];
        if (entityState) this._fetchEvents(entityState);
      }
    }, 5 * 60 * 1000);
  }

  disconnectedCallback() {
    if (this._tickTimer) window.clearInterval(this._tickTimer);
    if (this._refreshTimer) window.clearInterval(this._refreshTimer);
  }

  async _fetchEvents(entityState) {
    if (!this._hass || this._fetching) return;
    const configEntryId = entityState.attributes.config_entry_id;
    if (!configEntryId) {
      this._render();
      return;
    }
    this._fetching = true;
    try {
      const result = await this._hass.connection.sendMessagePromise({
        type: "daely_planner/get_events",
        config_entry_id: configEntryId,
      });
      this._data = result;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("daely-planner-card: failed to fetch events", err);
    } finally {
      this._fetching = false;
      this._render();
    }
  }

  getCardSize() {
    return 6;
  }

  static getStubConfig(hass) {
    const match = Object.keys(hass.states).find(
      (id) => id.startsWith("sensor.") && "config_entry_id" in hass.states[id].attributes
    );
    return { entity: match || "sensor.familienplaner_termine" };
  }

  static getConfigElement() {
    return document.createElement("daely-planner-card-editor");
  }

  _weekRange() {
    const lang = this._config.language === "en" ? "en" : "de";
    const firstDay = this._config.first_day_of_week === "sunday" ? 0 : 1;
    const days = this._config.days || (this._config.show_weekends === false ? 5 : 7);

    const today = startOfDay(new Date());
    const jsDay = today.getDay(); // 0 = Sunday
    const diff = (jsDay - firstDay + 7) % 7;
    const weekStart = addDays(today, -diff);

    const dates = [];
    for (let i = 0; i < days; i++) dates.push(addDays(weekStart, i));
    return { dates, today, lang };
  }

  _eventsByDay(dates) {
    const byDay = new Map(dates.map((d) => [toDateKey(d), []]));
    const events = (this._data && this._data.events) || [];

    for (const event of events) {
      if (event.all_day) {
        const start = startOfDay(new Date(event.start));
        // "end" for all-day events is exclusive per iCal convention.
        const end = event.end ? startOfDay(new Date(event.end)) : addDays(start, 1);
        for (let d = start; d < end; d = addDays(d, 1)) {
          const key = toDateKey(d);
          if (byDay.has(key)) byDay.get(key).push(event);
        }
      } else {
        const start = new Date(event.start);
        const key = toDateKey(start);
        if (byDay.has(key)) byDay.get(key).push(event);
      }
    }

    for (const list of byDay.values()) {
      list.sort((a, b) => {
        if (a.all_day !== b.all_day) return a.all_day ? -1 : 1;
        return new Date(a.start) - new Date(b.start);
      });
    }
    return byDay;
  }

  _render() {
    if (!this.shadowRoot) return;

    if (!this._config) {
      this.shadowRoot.innerHTML = "";
      return;
    }

    if (!this._hass || !this._hass.states[this._config.entity]) {
      this.shadowRoot.innerHTML = this._styles() + `
        <div class="daely-card">
          <div class="warning">Entity "${escapeHtml(this._config.entity)}" not found.</div>
        </div>`;
      return;
    }

    const { dates, today, lang } = this._weekRange();
    const byDay = this._eventsByDay(dates);
    const calendars = (this._data && this._data.calendars) || [];
    const title = this._config.title || "Familienplaner";

    const first = dates[0];
    const last = dates[dates.length - 1];
    const monthLabel =
      first.getMonth() === last.getMonth()
        ? `${MONTH_LABELS[lang][first.getMonth()]} ${first.getFullYear()}`
        : `${MONTH_LABELS[lang][first.getMonth()]} – ${MONTH_LABELS[lang][last.getMonth()]} ${last.getFullYear()}`;
    const rangeLabel = `${first.getDate()}. – ${last.getDate()}.`;

    const columns = dates
      .map((date) => {
        const key = toDateKey(date);
        const isToday = toDateKey(today) === key;
        const dayEvents = byDay.get(key) || [];
        const weekdayLabel = WEEKDAY_LABELS[lang][(date.getDay() + 6) % 7];

        const chips = dayEvents.length
          ? dayEvents
              .map((event) => {
                const time = event.all_day
                  ? lang === "de" ? "Ganztägig" : "All day"
                  : new Date(event.start).toLocaleTimeString(lang, {
                      hour: "2-digit",
                      minute: "2-digit",
                    });
                return `
                  <button class="chip" style="
                      border-left-color:${event.color};
                      background:${hexToRgba(event.color, 0.16)};
                    "
                    data-summary="${escapeHtml(event.summary)}"
                    data-time="${escapeHtml(time)}"
                    data-location="${escapeHtml(event.location || "")}"
                    data-description="${escapeHtml(event.description || "")}"
                    data-calendar="${escapeHtml(event.calendar_name)}"
                    data-color="${escapeHtml(event.color)}"
                  >
                    <span class="chip-time">${time}</span>
                    <span class="chip-summary">${escapeHtml(event.summary)}</span>
                  </button>`;
              })
              .join("")
          : `<div class="empty-day">·</div>`;

        return `
          <div class="day-column ${isToday ? "today" : ""}">
            <div class="day-header">
              <span class="day-weekday">${weekdayLabel}</span>
              <span class="day-number">${date.getDate()}</span>
            </div>
            <div class="day-events">${chips}</div>
          </div>`;
      })
      .join("");

    const legend = this._config.show_legend
      ? `<div class="legend">${calendars
          .map(
            (cal) =>
              `<div class="legend-item"><span class="dot" style="background:${cal.color}"></span>${escapeHtml(cal.name)}</div>`
          )
          .join("")}</div>`
      : "";

    this.shadowRoot.innerHTML = this._styles() + `
      <div class="daely-card">
        <div class="header">
          <div class="header-title">${escapeHtml(title)}</div>
          <div class="header-range">${monthLabel} · ${rangeLabel}</div>
        </div>
        <div class="grid" style="grid-template-columns: repeat(${dates.length}, 1fr);">
          ${columns}
        </div>
        ${legend}
        <div class="modal-backdrop" hidden>
          <div class="modal">
            <div class="modal-bar"></div>
            <div class="modal-calendar"></div>
            <div class="modal-summary"></div>
            <div class="modal-time"></div>
            <div class="modal-location"></div>
            <div class="modal-description"></div>
            <button class="modal-close">${lang === "de" ? "Schließen" : "Close"}</button>
          </div>
        </div>
      </div>`;

    this._attachEventHandlers(lang);
  }

  _attachEventHandlers(lang) {
    const root = this.shadowRoot;
    const backdrop = root.querySelector(".modal-backdrop");
    const closeModal = () => backdrop.setAttribute("hidden", "");

    root.querySelectorAll(".chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        const { summary, time, location, description, calendar, color } = chip.dataset;
        backdrop.querySelector(".modal-bar").style.background = color;
        backdrop.querySelector(".modal-calendar").textContent = calendar;
        backdrop.querySelector(".modal-calendar").style.color = color;
        backdrop.querySelector(".modal-summary").textContent = summary;
        backdrop.querySelector(".modal-time").textContent = time;
        const locationEl = backdrop.querySelector(".modal-location");
        locationEl.textContent = location ? `📍 ${location}` : "";
        locationEl.style.display = location ? "block" : "none";
        backdrop.querySelector(".modal-description").textContent = description || "";
        backdrop.removeAttribute("hidden");
      });
    });

    backdrop.addEventListener("click", (ev) => {
      if (ev.target === backdrop) closeModal();
    });
    root.querySelector(".modal-close").addEventListener("click", closeModal);
  }

  _styles() {
    return `<style>
      :host { display: block; }
      .daely-card {
        font-family: var(--paper-font-body1_-_font-family, "Nunito", "Segoe UI", sans-serif);
        background: var(--ha-card-background, var(--card-background-color, #fff));
        border-radius: var(--ha-card-border-radius, 16px);
        box-shadow: var(--ha-card-box-shadow, 0 2px 6px rgba(0,0,0,0.15));
        overflow: hidden;
        color: var(--primary-text-color);
      }
      .header {
        padding: 16px 20px;
        background: var(--daely-header-background, linear-gradient(135deg, #F2A6A0, #F6D186));
        color: #2b2320;
      }
      .header-title {
        font-size: 1.3em;
        font-weight: 700;
        letter-spacing: 0.02em;
      }
      .header-range {
        margin-top: 2px;
        font-size: 0.9em;
        opacity: 0.85;
        text-transform: capitalize;
      }
      .grid {
        display: grid;
        gap: 1px;
        background: var(--divider-color, #e4e4e4);
      }
      .day-column {
        background: var(--card-background-color, #fff);
        min-height: 160px;
        display: flex;
        flex-direction: column;
      }
      .day-column.today {
        background: var(--daely-today-background, rgba(242, 166, 160, 0.08));
      }
      .day-header {
        text-align: center;
        padding: 8px 4px 6px;
        border-bottom: 1px solid var(--divider-color, #eee);
      }
      .day-weekday {
        display: block;
        font-size: 0.75em;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--secondary-text-color);
      }
      .day-number {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        margin-top: 2px;
        width: 28px;
        height: 28px;
        border-radius: 50%;
        font-weight: 700;
        font-size: 1em;
      }
      .day-column.today .day-number {
        background: #F2A6A0;
        color: #fff;
      }
      .day-events {
        flex: 1;
        padding: 6px;
        display: flex;
        flex-direction: column;
        gap: 4px;
        overflow-y: auto;
      }
      .chip {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 1px;
        border: none;
        border-left: 4px solid;
        border-radius: 6px;
        padding: 4px 6px;
        font: inherit;
        text-align: left;
        cursor: pointer;
        color: var(--primary-text-color);
        width: 100%;
      }
      .chip-time {
        font-size: 0.68em;
        font-weight: 600;
        opacity: 0.75;
      }
      .chip-summary {
        font-size: 0.78em;
        line-height: 1.2;
        overflow: hidden;
        text-overflow: ellipsis;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
      }
      .empty-day {
        color: var(--disabled-text-color, #ccc);
        text-align: center;
        margin-top: 8px;
      }
      .legend {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        padding: 10px 16px;
        border-top: 1px solid var(--divider-color, #eee);
      }
      .legend-item {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 0.82em;
        color: var(--secondary-text-color);
      }
      .dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        display: inline-block;
      }
      .warning {
        padding: 16px;
        color: var(--error-color, #db4437);
      }
      .modal-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.45);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
      }
      .modal-backdrop[hidden] { display: none; }
      .modal {
        background: var(--card-background-color, #fff);
        color: var(--primary-text-color);
        border-radius: 12px;
        width: min(360px, 88vw);
        overflow: hidden;
        box-shadow: 0 8px 24px rgba(0,0,0,0.3);
      }
      .modal-bar { height: 6px; }
      .modal-calendar {
        padding: 12px 16px 0;
        font-size: 0.78em;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .modal-summary {
        padding: 4px 16px 0;
        font-size: 1.15em;
        font-weight: 700;
      }
      .modal-time {
        padding: 6px 16px 0;
        color: var(--secondary-text-color);
      }
      .modal-location {
        padding: 4px 16px 0;
        color: var(--secondary-text-color);
      }
      .modal-description {
        padding: 8px 16px 0;
        font-size: 0.9em;
        color: var(--secondary-text-color);
        white-space: pre-wrap;
      }
      .modal-close {
        display: block;
        margin: 16px;
        margin-top: 16px;
        margin-left: auto;
        padding: 8px 16px;
        border: none;
        border-radius: 8px;
        background: var(--primary-color, #F2A6A0);
        color: #fff;
        font: inherit;
        font-weight: 600;
        cursor: pointer;
      }
    </style>`;
  }
}

customElements.define("daely-planner-card", DaelyPlannerCard);

const EDITOR_LABELS = {
  entity: "Entity",
  title: "Titel",
  language: "Sprache",
  first_day_of_week: "Wochenstart",
  show_weekends: "Wochenende anzeigen",
  show_legend: "Legende anzeigen",
};

const EDITOR_HELPERS = {
  entity: "Sensor-Entity der Daely-Planner-Integration",
};

class DaelyPlannerCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = config;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  connectedCallback() {
    this._render();
  }

  _schema() {
    return [
      {
        name: "entity",
        required: true,
        selector: { entity: { filter: { integration: "daely_planner" } } },
      },
      { name: "title", selector: { text: {} } },
      {
        name: "language",
        selector: {
          select: {
            mode: "dropdown",
            options: [
              { value: "de", label: "Deutsch" },
              { value: "en", label: "English" },
            ],
          },
        },
      },
      {
        name: "first_day_of_week",
        selector: {
          select: {
            mode: "dropdown",
            options: [
              { value: "monday", label: "Montag" },
              { value: "sunday", label: "Sonntag" },
            ],
          },
        },
      },
      { name: "show_weekends", selector: { boolean: {} } },
      { name: "show_legend", selector: { boolean: {} } },
    ];
  }

  _render() {
    if (!this._hass || !this._config) return;

    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.addEventListener("value-changed", (ev) => {
        ev.stopPropagation();
        this._config = ev.detail.value;
        this.dispatchEvent(
          new CustomEvent("config-changed", { detail: { config: this._config } })
        );
      });
      this.appendChild(this._form);
    }

    const defaults = {
      language: "de",
      first_day_of_week: "monday",
      show_weekends: true,
      show_legend: true,
    };

    this._form.hass = this._hass;
    this._form.data = { ...defaults, ...this._config };
    this._form.schema = this._schema();
    this._form.computeLabel = (item) => EDITOR_LABELS[item.name] || item.name;
    this._form.computeHelper = (item) => EDITOR_HELPERS[item.name] || "";
  }
}

customElements.define("daely-planner-card-editor", DaelyPlannerCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "daely-planner-card",
  name: "Daely Planner Card",
  description: "Familienkalender im Daely-Stil mit mehreren farbcodierten Kalendern.",
  preview: false,
});

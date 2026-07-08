/**
 * Daely Planner Card
 *
 * A Lovelace card styled after the Daely family calendar: a fixed daily
 * time grid (default 08:00-18:00) with one column per day. Timed events
 * are positioned/sized where they actually occur; all-day and multi-day
 * events are shown as spanning banners above the grid. Colors (and
 * optionally a person's avatar) come from the "Daely Planner" custom
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

const HOUR_HEIGHT_PX = 56;
const MIN_EVENT_HEIGHT_PX = 22;
const BANNER_ROW_HEIGHT_PX = 26;
const GUTTER_WIDTH_PX = 46;

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

function clampDate(date, min, max) {
  if (date < min) return new Date(min);
  if (date > max) return new Date(max);
  return new Date(date);
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

/**
 * Classifies an event as a "banner" item (rendered above the time grid) if
 * it's marked all-day, OR if it's a timed event spanning more than one
 * calendar day (e.g. a trip logged as Mon 09:00 - Wed 17:00). Everything
 * else is a single-day timed event rendered inside the grid.
 */
function eventSpan(event) {
  const start = new Date(event.start);
  const startDay = startOfDay(start);
  let endExclusive;
  if (event.all_day) {
    // "end" for all-day events is exclusive per iCal convention.
    endExclusive = event.end ? startOfDay(new Date(event.end)) : addDays(startDay, 1);
  } else {
    const end = event.end ? new Date(event.end) : start;
    endExclusive = addDays(startOfDay(end), 1);
  }
  const isMultiDay = endExclusive - startDay > 24 * 60 * 60 * 1000;
  return { startDay, endExclusive, isBanner: Boolean(event.all_day) || isMultiDay };
}

/** Packs overlapping timed events into side-by-side lanes, per connected cluster. */
function layoutLanes(entries) {
  const sorted = [...entries].sort((a, b) => a.start - b.start || a.end - b.end);
  const clusters = [];
  let current = [];
  let currentMaxEnd = -Infinity;
  for (const entry of sorted) {
    if (current.length === 0 || entry.start < currentMaxEnd) {
      current.push(entry);
      currentMaxEnd = Math.max(currentMaxEnd, entry.end.getTime());
    } else {
      clusters.push(current);
      current = [entry];
      currentMaxEnd = entry.end.getTime();
    }
  }
  if (current.length) clusters.push(current);

  const positioned = [];
  for (const cluster of clusters) {
    const laneEnds = [];
    for (const entry of cluster) {
      let lane = laneEnds.findIndex((end) => end <= entry.start.getTime());
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(entry.end.getTime());
      } else {
        laneEnds[lane] = entry.end.getTime();
      }
      positioned.push({ ...entry, lane });
    }
    const totalLanes = laneEnds.length;
    for (const entry of positioned.slice(-cluster.length)) entry.totalLanes = totalLanes;
  }
  return positioned;
}

/** Stacks banner (all-day/multi-day) items into rows so overlapping date ranges don't collide. */
function layoutBannerRows(items) {
  const sorted = [...items].sort(
    (a, b) => a.startCol - b.startCol || b.endCol - b.startCol - (a.endCol - a.startCol)
  );
  const rowEndCol = [];
  for (const item of sorted) {
    let row = rowEndCol.findIndex((endCol) => endCol < item.startCol);
    if (row === -1) {
      row = rowEndCol.length;
      rowEndCol.push(item.endCol);
    } else {
      rowEndCol[row] = item.endCol;
    }
    item.row = row;
  }
  return { items: sorted, rowCount: rowEndCol.length };
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
      day_start_hour: 8,
      day_end_hour: 18,
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
    const hours = this._gridHours();
    return Math.ceil((hours * HOUR_HEIGHT_PX + 180) / 50);
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

  _gridHours() {
    const start = Number(this._config?.day_start_hour ?? 8);
    const end = Number(this._config?.day_end_hour ?? 18);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 10;
    return Math.min(24, end - start);
  }

  _gridWindow() {
    const start = Number(this._config?.day_start_hour ?? 8);
    const end = Number(this._config?.day_end_hour ?? 18);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 24) {
      return { startHour: 8, endHour: 18 };
    }
    return { startHour: Math.max(0, start), endHour: Math.min(24, end) };
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

  /** Splits events into banner (all-day/multi-day) items and per-day timed, lane-packed events. */
  _layout(dates) {
    const events = (this._data && this._data.events) || [];
    const { startHour, endHour } = this._gridWindow();
    const dateIndex = new Map(dates.map((d, i) => [toDateKey(d), i]));

    const bannerCandidates = [];
    const timedByDay = new Map(dates.map((d) => [toDateKey(d), []]));

    for (const event of events) {
      const { startDay, endExclusive, isBanner } = eventSpan(event);

      if (isBanner) {
        let firstIdx = -1;
        let lastIdx = -1;
        for (let d = new Date(startDay); d < endExclusive; d = addDays(d, 1)) {
          const idx = dateIndex.get(toDateKey(d));
          if (idx !== undefined) {
            if (firstIdx === -1) firstIdx = idx;
            lastIdx = idx;
          }
        }
        if (firstIdx !== -1) bannerCandidates.push({ event, startCol: firstIdx, endCol: lastIdx });
        continue;
      }

      const key = toDateKey(startDay);
      if (!timedByDay.has(key)) continue;

      const gridStart = new Date(startDay);
      gridStart.setHours(startHour, 0, 0, 0);
      const gridEnd = new Date(startDay);
      gridEnd.setHours(endHour, 0, 0, 0);

      const rawStart = new Date(event.start);
      const rawEnd = event.end ? new Date(event.end) : new Date(rawStart.getTime() + 30 * 60000);
      const start = clampDate(rawStart, gridStart, gridEnd);
      let end = clampDate(rawEnd, gridStart, gridEnd);
      if (end <= start) end = new Date(Math.min(gridEnd.getTime(), start.getTime() + 60000));

      timedByDay.get(key).push({ event, start, end, gridStart });
    }

    const timedLayoutByDay = new Map();
    for (const [key, entries] of timedByDay.entries()) {
      timedLayoutByDay.set(key, layoutLanes(entries));
    }

    const banner = layoutBannerRows(bannerCandidates);
    return { banner, timedLayoutByDay, startHour, endHour };
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
    const { banner, timedLayoutByDay, startHour, endHour } = this._layout(dates);
    const calendars = (this._data && this._data.calendars) || [];
    const title = this._config.title || "Familienplaner";
    const gridHours = endHour - startHour;
    const gridHeight = gridHours * HOUR_HEIGHT_PX;
    const columnsTemplate = `${GUTTER_WIDTH_PX}px repeat(${dates.length}, 1fr)`;

    const first = dates[0];
    const last = dates[dates.length - 1];
    const monthLabel =
      first.getMonth() === last.getMonth()
        ? `${MONTH_LABELS[lang][first.getMonth()]} ${first.getFullYear()}`
        : `${MONTH_LABELS[lang][first.getMonth()]} – ${MONTH_LABELS[lang][last.getMonth()]} ${last.getFullYear()}`;
    const rangeLabel = `${first.getDate()}. – ${last.getDate()}.`;

    const avatarOrDot = (item) =>
      item.picture
        ? `<img class="avatar" src="${escapeHtml(item.picture)}" alt="">`
        : `<span class="dot" style="background:${item.color}"></span>`;

    const chipDataAttrs = (event) => `
      data-summary="${escapeHtml(event.summary)}"
      data-location="${escapeHtml(event.location || "")}"
      data-description="${escapeHtml(event.description || "")}"
      data-calendar="${escapeHtml(event.calendar_name)}"
      data-color="${escapeHtml(event.color)}"
      data-picture="${escapeHtml(event.picture || "")}"
    `;

    const weekdayRow = `
      <div class="row weekday-row" style="grid-template-columns: ${columnsTemplate};">
        <div class="gutter-cell"></div>
        ${dates
          .map((date) => {
            const isToday = toDateKey(today) === toDateKey(date);
            const weekdayLabel = WEEKDAY_LABELS[lang][(date.getDay() + 6) % 7];
            return `
              <div class="day-heading ${isToday ? "today" : ""}">
                <span class="day-weekday">${weekdayLabel}</span>
                <span class="day-number">${date.getDate()}</span>
              </div>`;
          })
          .join("")}
      </div>`;

    const bannerRow =
      banner.rowCount > 0
        ? `
      <div class="row banner-row" style="grid-template-columns: ${columnsTemplate}; grid-auto-rows: ${BANNER_ROW_HEIGHT_PX}px; min-height: ${banner.rowCount * BANNER_ROW_HEIGHT_PX}px;">
        <div class="gutter-cell banner-gutter-label">${lang === "de" ? "Ganztägig" : "All day"}</div>
        ${banner.items
          .map((item) => {
            const time =
              item.startCol === item.endCol
                ? ""
                : `<span class="chip-time">${lang === "de" ? "Mehrtägig" : "Multi-day"}</span>`;
            return `
              <button class="chip chip-banner" style="
                  grid-column: ${item.startCol + 2} / ${item.endCol + 3};
                  grid-row: ${item.row + 1};
                  border-left-color:${item.event.color};
                  background:${hexToRgba(item.event.color, 0.18)};
                "${chipDataAttrs(item.event)}
                data-time="${escapeHtml(lang === "de" ? "Ganztägig" : "All day")}"
              >
                ${avatarOrDot({ picture: item.event.picture, color: item.event.color })}
                <span class="chip-summary">${escapeHtml(item.event.summary)}</span>
                ${time}
              </button>`;
          })
          .join("")}
      </div>`
        : "";

    const hourGutter = Array.from({ length: gridHours + 1 })
      .map((_, i) => {
        const hour = startHour + i;
        const top = i * HOUR_HEIGHT_PX;
        return `<div class="hour-label" style="top:${top}px;">${pad2(hour % 24)}:00</div>`;
      })
      .join("");

    const dayColumns = dates
      .map((date) => {
        const key = toDateKey(date);
        const isToday = toDateKey(today) === key;
        const entries = timedLayoutByDay.get(key) || [];

        const blocks = entries
          .map((entry) => {
            const top = ((entry.start - entry.gridStart) / 3600000) * HOUR_HEIGHT_PX;
            const rawHeight = ((entry.end - entry.start) / 3600000) * HOUR_HEIGHT_PX;
            const height = Math.max(MIN_EVENT_HEIGHT_PX, rawHeight);
            const widthPct = 100 / entry.totalLanes;
            const leftPct = widthPct * entry.lane;
            const timeLabel = new Date(entry.event.start).toLocaleTimeString(lang, {
              hour: "2-digit",
              minute: "2-digit",
            });
            return `
              <button class="chip chip-timed" style="
                  top:${top}px;
                  height:${height}px;
                  left:calc(${leftPct}% + 2px);
                  width:calc(${widthPct}% - 4px);
                  border-left-color:${entry.event.color};
                  background:${hexToRgba(entry.event.color, 0.18)};
                "${chipDataAttrs(entry.event)}
                data-time="${escapeHtml(timeLabel)}"
              >
                <span class="chip-time">${timeLabel}</span>
                <span class="chip-summary">${escapeHtml(entry.event.summary)}</span>
              </button>`;
          })
          .join("");

        return `<div class="day-col ${isToday ? "today" : ""}" style="height:${gridHeight}px;">${blocks}</div>`;
      })
      .join("");

    const timeGridRow = `
      <div class="row timegrid-row" style="grid-template-columns: ${columnsTemplate}; height:${gridHeight}px;">
        <div class="hour-gutter" style="height:${gridHeight}px;">${hourGutter}</div>
        ${dayColumns}
      </div>`;

    const legend = this._config.show_legend
      ? `<div class="legend">${calendars
          .map(
            (cal) =>
              `<div class="legend-item">${avatarOrDot(cal)}${escapeHtml(cal.name)}</div>`
          )
          .join("")}</div>`
      : "";

    this.shadowRoot.innerHTML = this._styles() + `
      <div class="daely-card">
        <div class="header">
          <div class="header-title">${escapeHtml(title)}</div>
          <div class="header-range">${monthLabel} · ${rangeLabel}</div>
        </div>
        ${weekdayRow}
        ${bannerRow}
        ${timeGridRow}
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

    this._attachEventHandlers();
  }

  _attachEventHandlers() {
    const root = this.shadowRoot;
    const backdrop = root.querySelector(".modal-backdrop");
    const closeModal = () => backdrop.setAttribute("hidden", "");

    root.querySelectorAll(".chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        const { summary, time, location, description, calendar, color, picture } = chip.dataset;
        backdrop.querySelector(".modal-bar").style.background = color;
        backdrop.querySelector(".modal-calendar").textContent = calendar;
        backdrop.querySelector(".modal-calendar").style.color = color;
        backdrop.querySelector(".modal-summary").textContent = summary;
        backdrop.querySelector(".modal-time").textContent = time;
        const locationEl = backdrop.querySelector(".modal-location");
        locationEl.textContent = location ? `📍 ${location}` : "";
        locationEl.style.display = location ? "block" : "none";
        backdrop.querySelector(".modal-description").textContent = description || "";
        const bar = backdrop.querySelector(".modal-bar");
        bar.innerHTML = picture
          ? `<img class="avatar avatar-lg" src="${escapeHtml(picture)}" alt="">`
          : "";
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
      .row {
        display: grid;
      }
      .gutter-cell {
        border-right: 1px solid var(--divider-color, #eee);
      }
      .weekday-row {
        border-bottom: 1px solid var(--divider-color, #eee);
      }
      .day-heading {
        text-align: center;
        padding: 8px 4px 6px;
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
        width: 26px;
        height: 26px;
        border-radius: 50%;
        font-weight: 700;
        font-size: 0.95em;
      }
      .day-heading.today .day-number {
        background: #F2A6A0;
        color: #fff;
      }
      .banner-row {
        border-bottom: 1px solid var(--divider-color, #eee);
        padding: 3px 0;
        row-gap: 2px;
      }
      .banner-gutter-label {
        writing-mode: vertical-rl;
        text-orientation: mixed;
        font-size: 0.62em;
        color: var(--secondary-text-color);
        text-align: center;
        padding: 2px 0;
        align-self: stretch;
      }
      .timegrid-row {
        position: relative;
      }
      .hour-gutter {
        position: relative;
      }
      .hour-label {
        position: absolute;
        right: 6px;
        transform: translateY(-50%);
        font-size: 0.65em;
        color: var(--secondary-text-color);
      }
      .day-col {
        position: relative;
        border-right: 1px solid var(--divider-color, #f0f0f0);
        background-image: repeating-linear-gradient(
          to bottom,
          var(--divider-color, #eee) 0,
          var(--divider-color, #eee) 1px,
          transparent 1px,
          transparent ${HOUR_HEIGHT_PX}px
        );
      }
      .day-col.today {
        background-color: var(--daely-today-background, rgba(242, 166, 160, 0.08));
      }
      .chip {
        display: flex;
        align-items: center;
        gap: 4px;
        border: none;
        border-left: 4px solid;
        border-radius: 6px;
        padding: 3px 6px;
        font: inherit;
        text-align: left;
        cursor: pointer;
        color: var(--primary-text-color);
        overflow: hidden;
      }
      .chip-timed {
        position: absolute;
        flex-direction: column;
        align-items: flex-start;
        gap: 0;
        z-index: 1;
      }
      .chip-banner {
        width: 100%;
      }
      .chip-time {
        font-size: 0.65em;
        font-weight: 600;
        opacity: 0.75;
        white-space: nowrap;
      }
      .chip-summary {
        font-size: 0.78em;
        line-height: 1.2;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex: 1;
      }
      .chip-timed .chip-summary {
        white-space: normal;
        display: -webkit-box;
        -webkit-line-clamp: 3;
        -webkit-box-orient: vertical;
      }
      .dot {
        width: 9px;
        height: 9px;
        min-width: 9px;
        border-radius: 50%;
        display: inline-block;
      }
      .avatar {
        width: 16px;
        height: 16px;
        min-width: 16px;
        border-radius: 50%;
        object-fit: cover;
      }
      .avatar-lg {
        width: 40px;
        height: 40px;
        min-width: 40px;
        margin: 12px 0 0 16px;
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
      .modal-bar { min-height: 6px; }
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
  day_start_hour: "Startzeit (Stunde)",
  day_end_hour: "Endzeit (Stunde)",
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
      {
        type: "grid",
        name: "",
        schema: [
          { name: "day_start_hour", selector: { number: { min: 0, max: 23, mode: "box" } } },
          { name: "day_end_hour", selector: { number: { min: 1, max: 24, mode: "box" } } },
        ],
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
      day_start_hour: 8,
      day_end_hour: 18,
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
  description: "Familienkalender im Daely-Stil mit Zeitraster, farbcodierten Kalendern und Personen-Avataren.",
  preview: false,
});

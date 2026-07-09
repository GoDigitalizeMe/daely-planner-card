/**
 * Familyboard Planner Card
 *
 * A Lovelace card for a family wall calendar: a fixed daily time grid
 * (default 08:00-18:00) with one column per day. Timed events are
 * positioned/sized where they actually occur; all-day and multi-day
 * events are shown as spanning banners above the grid. Colors (and
 * optionally a person's avatar) come from the "Familyboard Planner"
 * custom integration's configuration. Talks to the backend only through
 * the `familyboard_planner/get_events` WebSocket command exposed by that
 * integration.
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
const GUTTER_WIDTH_PX = 56;
const FULL_DAY_HOURS = 24;
const WEEK_NAV_RANGE = 12; // dropdown covers +/- this many weeks

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

class FamilyboardPlannerCard extends HTMLElement {
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
    this._filter = { persons: new Set(), calendars: new Set() };
    this._weekOffset = 0;
    this._forceScrollReset = true;
  }

  setConfig(config) {
    if (!config || !config.entity) {
      throw new Error("familyboard-planner-card: 'entity' is required (the Familyboard Planner sensor entity).");
    }
    this._config = {
      title: null,
      language: "de",
      first_day_of_week: "monday",
      days: null,
      show_weekends: true,
      show_legend: true,
      day_start_hour: 6,
      day_end_hour: 18,
      viewport_padding_minutes: 30,
      ...config,
    };
    this._render();
  }

  _viewportPaddingPx() {
    const minutes = Number(this._config?.viewport_padding_minutes ?? 30);
    if (!Number.isFinite(minutes) || minutes < 0) return HOUR_HEIGHT_PX / 2;
    return (Math.min(180, minutes) / 60) * HOUR_HEIGHT_PX;
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
        type: "familyboard_planner/get_events",
        config_entry_id: configEntryId,
      });
      this._data = result;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("familyboard-planner-card: failed to fetch events", err);
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
    return document.createElement("familyboard-planner-card-editor");
  }

  _gridHours() {
    const start = Number(this._config?.day_start_hour ?? 6);
    const end = Number(this._config?.day_end_hour ?? 18);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 12;
    return Math.min(24, end - start);
  }

  _gridWindow() {
    const start = Number(this._config?.day_start_hour ?? 6);
    const end = Number(this._config?.day_end_hour ?? 18);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 24) {
      return { startHour: 6, endHour: 18 };
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
    const baseWeekStart = addDays(today, -diff);
    const weekStart = addDays(baseWeekStart, (this._weekOffset || 0) * 7);

    const dates = [];
    for (let i = 0; i < days; i++) dates.push(addDays(weekStart, i));
    return { dates, today, lang, days, baseWeekStart, weekStart };
  }

  _formatRange(weekStart, days, lang) {
    const first = weekStart;
    const last = addDays(weekStart, days - 1);
    const monthLabel =
      first.getMonth() === last.getMonth()
        ? `${MONTH_LABELS[lang][first.getMonth()]} ${first.getFullYear()}`
        : `${MONTH_LABELS[lang][first.getMonth()]} – ${MONTH_LABELS[lang][last.getMonth()]} ${last.getFullYear()}`;
    const rangeLabel = `${first.getDate()}. – ${last.getDate()}.`;
    return { monthLabel, rangeLabel };
  }

  _goToWeek(offset, absolute) {
    this._weekOffset = absolute ? offset : (this._weekOffset || 0) + offset;
    this._forceScrollReset = true;
    this._render();
  }

  /**
   * Splits events into banner (all-day/multi-day) items and per-day timed,
   * lane-packed events. Timed events are positioned against the full
   * 00:00-24:00 day (not clipped to the configured focus window) so that
   * scrolling the grid still reveals early/late events in their real spot.
   */
  _layout(dates) {
    const events = (this._data && this._data.events) || [];
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
      const gridEnd = addDays(startDay, 1);

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
    return { banner, timedLayoutByDay };
  }

  /** Groups calendars by their linked person, deduplicated, in first-seen order. */
  _personsFromCalendars(calendars) {
    const byId = new Map();
    for (const cal of calendars) {
      const personId = cal.person_entity_id;
      if (!personId) continue;
      if (!byId.has(personId)) {
        byId.set(personId, {
          person_entity_id: personId,
          name: cal.person_name || personId,
          picture: cal.picture,
          color: cal.color,
          calendarIds: new Set(),
        });
      }
      byId.get(personId).calendarIds.add(cal.entity_id);
    }
    return Array.from(byId.values());
  }

  /** Calendar entity_ids to highlight, derived from the selected persons/calendars filters. */
  _highlightedCalendarIds(persons) {
    const set = new Set();
    for (const person of persons) {
      if (this._filter.persons.has(person.person_entity_id)) {
        for (const id of person.calendarIds) set.add(id);
      }
    }
    for (const id of this._filter.calendars) set.add(id);
    return set;
  }

  _toggleFilter(type, id) {
    const set = type === "person" ? this._filter.persons : this._filter.calendars;
    if (set.has(id)) set.delete(id);
    else set.add(id);
    this._render();
  }

  _render() {
    if (!this.shadowRoot) return;

    if (!this._config) {
      this.shadowRoot.innerHTML = "";
      return;
    }

    if (!this._hass || !this._hass.states[this._config.entity]) {
      this.shadowRoot.innerHTML = this._styles() + `
        <div class="familyboard-card">
          <div class="warning">Entity "${escapeHtml(this._config.entity)}" not found.</div>
        </div>`;
      return;
    }

    const existingScroller = this.shadowRoot.querySelector(".timegrid-scroll");
    const preservedScrollTop =
      !this._forceScrollReset && existingScroller ? existingScroller.scrollTop : null;
    this._forceScrollReset = false;

    const { dates, today, lang, days, baseWeekStart } = this._weekRange();
    const { banner, timedLayoutByDay } = this._layout(dates);
    const { startHour: focusStart, endHour: focusEnd } = this._gridWindow();
    const calendars = (this._data && this._data.calendars) || [];
    const persons = this._personsFromCalendars(calendars);
    const highlightSet = this._highlightedCalendarIds(persons);
    const chipEmphasis = (calendarEntityId) => {
      if (highlightSet.size === 0) return "";
      return highlightSet.has(calendarEntityId) ? " chip-highlighted" : " chip-dimmed";
    };
    const title = this._config.title || "Familienplaner";
    const focusHours = focusEnd - focusStart;
    const viewportPadding = this._viewportPaddingPx();
    const viewportHeight = focusHours * HOUR_HEIGHT_PX + 2 * viewportPadding;
    const fullGridHeight = FULL_DAY_HOURS * HOUR_HEIGHT_PX;
    const defaultScrollTop = Math.max(0, focusStart * HOUR_HEIGHT_PX - viewportPadding);
    const columnsTemplate = `${GUTTER_WIDTH_PX}px repeat(${dates.length}, 1fr)`;

    const weekOptions = [];
    for (let o = -WEEK_NAV_RANGE; o <= WEEK_NAV_RANGE; o++) {
      const optionStart = addDays(baseWeekStart, o * 7);
      const optionLabels = this._formatRange(optionStart, days, lang);
      weekOptions.push({ offset: o, label: `${optionLabels.rangeLabel} ${optionLabels.monthLabel}` });
    }

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
        <div class="gutter-cell"></div>
        ${banner.items
          .map((item) => {
            const time =
              item.startCol === item.endCol
                ? ""
                : `<span class="chip-time">${lang === "de" ? "Mehrtägig" : "Multi-day"}</span>`;
            return `
              <button class="chip chip-banner${chipEmphasis(item.event.calendar_entity_id)}" style="
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

    const hourGutter = Array.from({ length: FULL_DAY_HOURS + 1 })
      .map((_, hour) => {
        const top = hour * HOUR_HEIGHT_PX;
        return `<div class="hour-label" style="top:${top}px;">${pad2(hour)}:00</div>`;
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
              <button class="chip chip-timed${chipEmphasis(entry.event.calendar_entity_id)}" style="
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

        return `<div class="day-col ${isToday ? "today" : ""}" style="height:${fullGridHeight}px;">${blocks}</div>`;
      })
      .join("");

    const timeGridRow = `
      <div class="timegrid-scroll" style="height:${viewportHeight}px;">
        <div class="row timegrid-row" style="grid-template-columns: ${columnsTemplate}; height:${fullGridHeight}px;">
          <div class="hour-gutter" style="height:${fullGridHeight}px;">${hourGutter}</div>
          ${dayColumns}
        </div>
      </div>`;

    const legendButton = (type, id, item, active, inactive, showName = true) => `
      <button class="legend-item ${showName ? "" : "avatar-only"} ${active ? "active" : ""} ${inactive ? "inactive" : ""}"
        style="${active ? `box-shadow: 0 0 0 2px ${item.color};` : ""}"
        data-filter-type="${type}" data-filter-id="${escapeHtml(id)}"
        title="${escapeHtml(item.name)}"
      >${avatarOrDot(item)}${showName ? escapeHtml(item.name) : ""}</button>`;

    const personsRow = persons.length
      ? `<div class="header-persons">${persons
          .map((person) => {
            const active = this._filter.persons.has(person.person_entity_id);
            const anyOverlap = [...person.calendarIds].some((id) => highlightSet.has(id));
            const inactive = highlightSet.size > 0 && !anyOverlap;
            return legendButton("person", person.person_entity_id, person, active, inactive, false);
          })
          .join("")}</div>`
      : "";

    // Calendars linked to a person are represented by that person in the
    // header instead, so the footer only lists the unassigned ones.
    const calendarsWithoutPerson = calendars.filter((cal) => !cal.person_entity_id);
    const calendarsRow = calendarsWithoutPerson.length
      ? `<div class="legend-row legend-calendars">${calendarsWithoutPerson
          .map((cal) => {
            const active = this._filter.calendars.has(cal.entity_id);
            const inactive = highlightSet.size > 0 && !highlightSet.has(cal.entity_id);
            return legendButton("calendar", cal.entity_id, cal, active, inactive);
          })
          .join("")}</div>`
      : "";

    const legend =
      this._config.show_legend && calendarsRow ? `<div class="legend">${calendarsRow}</div>` : "";

    const headerNav = `
      <div class="header-nav">
        <button class="nav-btn" data-nav="prev" aria-label="${lang === "de" ? "Vorherige Woche" : "Previous week"}">‹</button>
        <select class="week-select" aria-label="${lang === "de" ? "Woche wählen" : "Select week"}">
          ${weekOptions
            .map(
              (opt) =>
                `<option value="${opt.offset}" ${opt.offset === (this._weekOffset || 0) ? "selected" : ""}>${escapeHtml(opt.label)}</option>`
            )
            .join("")}
        </select>
        <button class="nav-btn" data-nav="next" aria-label="${lang === "de" ? "Nächste Woche" : "Next week"}">›</button>
      </div>`;

    this.shadowRoot.innerHTML = this._styles() + `
      <div class="familyboard-card">
        <div class="header">
          <div class="header-titles">
            <div class="header-title">${escapeHtml(title)}</div>
            ${headerNav}
          </div>
          ${personsRow}
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

    const scroller = this.shadowRoot.querySelector(".timegrid-scroll");
    if (scroller) {
      const scrollbarWidth = scroller.offsetWidth - scroller.clientWidth;
      if (scrollbarWidth > 0) {
        this.shadowRoot.querySelectorAll(".weekday-row, .banner-row").forEach((el) => {
          el.style.paddingRight = `${scrollbarWidth}px`;
        });
      }
      scroller.scrollTop = preservedScrollTop !== null ? preservedScrollTop : defaultScrollTop;
    }

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

    root.querySelectorAll(".legend-item").forEach((el) => {
      el.addEventListener("click", () => {
        const { filterType, filterId } = el.dataset;
        this._toggleFilter(filterType, filterId);
      });
    });

    root.querySelectorAll(".nav-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        this._goToWeek(btn.dataset.nav === "prev" ? -1 : 1);
      });
    });
    const weekSelect = root.querySelector(".week-select");
    if (weekSelect) {
      weekSelect.addEventListener("change", () => {
        this._goToWeek(Number(weekSelect.value), true);
      });
    }
  }

  _styles() {
    return `<style>
      :host { display: block; }
      .familyboard-card {
        font-family: var(--paper-font-body1_-_font-family, "Nunito", "Segoe UI", sans-serif);
        background: var(--ha-card-background, var(--card-background-color, #fff));
        border-radius: var(--ha-card-border-radius, 16px);
        box-shadow: var(--ha-card-box-shadow, 0 2px 6px rgba(0,0,0,0.15));
        overflow: hidden;
        color: var(--primary-text-color);
      }
      .header {
        display: flex;
        flex-wrap: wrap;
        align-items: flex-start;
        justify-content: space-between;
        gap: 10px 16px;
        padding: 16px 20px;
        background: var(--familyboard-header-background, linear-gradient(135deg, #F2A6A0, #F6D186));
        color: #2b2320;
      }
      .header-title {
        font-size: 1.3em;
        font-weight: 700;
        letter-spacing: 0.02em;
      }
      .header-nav {
        display: flex;
        align-items: center;
        gap: 2px;
        margin-top: 2px;
      }
      .nav-btn {
        border: none;
        background: rgba(255,255,255,0.4);
        color: #2b2320;
        width: 22px;
        height: 22px;
        border-radius: 50%;
        font-size: 0.9em;
        line-height: 1;
        cursor: pointer;
        flex: none;
      }
      .nav-btn:hover {
        background: rgba(255,255,255,0.7);
      }
      .week-select {
        appearance: none;
        border: none;
        background: transparent;
        color: #2b2320;
        font: inherit;
        font-size: 0.9em;
        opacity: 0.9;
        text-transform: capitalize;
        cursor: pointer;
        padding: 2px 4px;
      }
      .header-persons {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
      }
      .header-persons .legend-item {
        color: #2b2320;
        background: rgba(255,255,255,0.4);
      }
      .header-persons .avatar {
        width: 32px;
        height: 32px;
        min-width: 32px;
      }
      .header-persons .dot {
        width: 14px;
        height: 14px;
        min-width: 14px;
      }
      .header-persons .legend-item.active {
        color: #2b2320;
        background: rgba(255,255,255,0.9);
        box-shadow: 0 1px 4px rgba(0,0,0,0.2) !important;
      }
      .header-persons .legend-item.inactive {
        opacity: 0.55;
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
      .timegrid-scroll {
        overflow-y: auto;
        overflow-x: hidden;
      }
      .timegrid-row {
        position: relative;
      }
      .hour-gutter {
        position: relative;
      }
      .hour-label {
        position: absolute;
        right: 0;
        transform: translateY(-50%);
        font-size: 0.68em;
        font-variant-numeric: tabular-nums;
        color: var(--secondary-text-color);
        background: var(--card-background-color, #fff);
        padding: 1px 8px 1px 6px;
        white-space: nowrap;
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
        background-color: var(--familyboard-today-background, rgba(242, 166, 160, 0.08));
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
        transition: opacity 0.15s ease, box-shadow 0.15s ease;
      }
      .chip-banner {
        width: 100%;
        transition: opacity 0.15s ease, box-shadow 0.15s ease;
      }
      .chip-dimmed {
        opacity: 0.3;
      }
      .chip-highlighted {
        opacity: 1;
        border-left-width: 6px;
        box-shadow: 0 1px 4px rgba(0,0,0,0.25);
        z-index: 2;
      }
      .chip-timed.chip-highlighted {
        z-index: 3;
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
        flex-direction: column;
        gap: 6px;
        padding: 10px 16px;
        border-top: 1px solid var(--divider-color, #eee);
      }
      .legend-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .legend-row + .legend-row {
        padding-top: 6px;
        border-top: 1px dashed var(--divider-color, #eee);
      }
      .legend-item {
        display: flex;
        align-items: center;
        gap: 6px;
        font: inherit;
        font-size: 0.82em;
        color: var(--secondary-text-color);
        background: none;
        border: none;
        border-radius: 14px;
        padding: 3px 8px 3px 3px;
        cursor: pointer;
        transition: opacity 0.15s ease, background 0.15s ease;
      }
      .legend-item.active {
        color: var(--primary-text-color);
        font-weight: 700;
        background: var(--secondary-background-color, rgba(0,0,0,0.05));
      }
      .legend-item.inactive {
        opacity: 0.4;
      }
      .legend-item.avatar-only {
        padding: 2px;
        border-radius: 50%;
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

customElements.define("familyboard-planner-card", FamilyboardPlannerCard);

const EDITOR_LABELS = {
  entity: "Entity",
  title: "Titel",
  language: "Sprache",
  first_day_of_week: "Wochenstart",
  day_start_hour: "Sichtbar ab (Stunde)",
  day_end_hour: "Sichtbar bis (Stunde)",
  viewport_padding_minutes: "Rand oben/unten (Minuten)",
  show_weekends: "Wochenende anzeigen",
  show_legend: "Legende anzeigen",
};

const EDITOR_HELPERS = {
  entity: "Sensor-Entity der Familyboard-Planner-Integration",
  viewport_padding_minutes: "Zusätzlicher Platz, damit die Rand-Uhrzeiten nicht abgeschnitten wirken",
};

class FamilyboardPlannerCardEditor extends HTMLElement {
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
        selector: { entity: { filter: { integration: "familyboard_planner" } } },
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
      {
        name: "viewport_padding_minutes",
        selector: { number: { min: 0, max: 180, step: 5, mode: "box" } },
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
      day_start_hour: 6,
      day_end_hour: 18,
      viewport_padding_minutes: 30,
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

customElements.define("familyboard-planner-card-editor", FamilyboardPlannerCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "familyboard-planner-card",
  name: "Familyboard Planner Card",
  description: "Familienkalender-Karte mit Zeitraster, farbcodierten Kalendern und Personen-Avataren.",
  preview: false,
});

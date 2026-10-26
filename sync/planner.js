/** Pure Apple Calendar planner. No IO, clocks, randomness, or timestamp arbitration.
 *
 * Persist newTasks/newLinks, execute operations, then plan against a refreshed
 * snapshot. Only observed convergence advances baselines. The caller MUST fetch
 * the dedicated calendar and explicitly verify missingEventIds outside its range
 * query. Never treat range-query omissions as deletion.
 *
 * links: {version:1, calendarID, entries:{[taskId]:{
 *   eventId:string|null, externalId?:string,
 *   baseline:null|{task:Fields,event:Fields}
 * }}}. Fields={title,notes,schedule:{start,end,allDay,timeZone}}.
 * Schedule is one atomic field (changing its parts independently can create an
 * invalid event). Title, notes and schedule merge independently.
 */
const VERSION = 1;
const FIELDS = ['title', 'notes', 'schedule'];
const copy = value => JSON.parse(JSON.stringify(value));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;

function validDate(value) {
  return typeof value === 'string' && datePattern.test(value) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
function nextDate(date) {
  if (!validDate(date)) throw new Error('invalid-date');
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
}
function formatter(timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
}
function partsAt(ms, timeZone) {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(new Date(ms))
    .filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, second: parts.second };
}
function candidateInstants(date, time, timeZone) {
  const nominal = Date.parse(`${date}T${time}:00Z`);
  const offsets = new Set();
  // Sampling both sides of any transition collects all plausible IANA offsets,
  // including half-hour transitions and date-line jumps.
  for (let h = -48; h <= 48; h += 3) {
    const sample = nominal + h * 3600000;
    const p = partsAt(sample, timeZone);
    offsets.add(Date.parse(`${p.date}T${p.time}:${p.second}Z`) - sample);
  }
  return [...offsets].map(offset => nominal - offset).sort((a, b) => a - b);
}
/** Rejects DST gaps AND folds: callers must resolve an ambiguous wall time. */
export function localDateTimeToISO(date, time, timeZone = 'UTC') {
  if (!validDate(date) || !timePattern.test(time || '')) throw new Error('invalid-local-date-time');
  const matches = candidateInstants(date, time, timeZone).filter(ms => {
    const p = partsAt(ms, timeZone);
    return p.date === date && p.time === time && p.second === '00';
  });
  if (matches.length !== 1) throw new Error(matches.length ? 'ambiguous-local-time' : 'nonexistent-local-time');
  return new Date(matches[0]).toISOString();
}
function instant(value) {
  // Never interpret an offset-less bridge timestamp in the process timezone.
  if (typeof value !== 'string' || !/(Z|[+-]\d\d:\d\d)$/i.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error('invalid-event-instant');
  }
  return new Date(value).toISOString();
}
function taskInstant(date, time, timeZone, preserved) {
  // Remote fold times and seconds retain their exact instant until edited.
  if (preserved) {
    const value = instant(preserved);
    const p = partsAt(Date.parse(value), timeZone);
    if (p.date === date && p.time === time) return value;
  }
  return localDateTimeToISO(date, time, timeZone);
}
function taskFields(task, defaultZone) {
  if (!task.date) throw new Error('missing-date');
  if (!validDate(task.date)) throw new Error('invalid-date');
  const timeZone = task.appleCalendarTimeZone || defaultZone;
  formatter(timeZone); // Validate even for all-day events.
  const allDay = !task.start;
  let start, end;
  if (allDay) {
    start = task.date;
    end = task.appleCalendarEndDate || nextDate(start);
    if (!validDate(end) || end <= start) throw new Error('invalid-end-date');
  } else {
    start = taskInstant(task.date, task.start, timeZone, task.appleCalendarStartInstant);
    if (task.end) end = taskInstant(task.appleCalendarEndDate || task.date, task.end, timeZone, task.appleCalendarEndInstant);
    else end = new Date(Date.parse(start) + 3600000).toISOString();
    if (end <= start) throw new Error('invalid-event-duration');
  }
  return { title: String(task.title || ''), notes: String(task.notes || ''), schedule: { start, end, allDay, timeZone } };
}
function allDayDate(value, timeZone) {
  if (validDate(value)) return value;
  return partsAt(Date.parse(instant(value)), timeZone).date;
}
function eventFields(event, defaultZone) {
  const timeZone = event.timeZone || defaultZone;
  formatter(timeZone);
  const allDay = !!event.allDay;
  const start = allDay ? allDayDate(event.start, timeZone) : instant(event.start);
  const end = allDay ? allDayDate(event.end, timeZone) : instant(event.end);
  if (allDay && (!validDate(start) || !validDate(end))) throw new Error('invalid-event-date');
  if (end <= start) throw new Error('invalid-event-duration');
  return { title: String(event.title || ''), notes: String(event.notes || ''), schedule: { start, end, allDay, timeZone } };
}
function applyFields(task, fields, changed = FIELDS) {
  const result = { ...task };
  if (changed.includes('title')) result.title = fields.title;
  if (changed.includes('notes')) result.notes = fields.notes;
  if (changed.includes('schedule')) {
    const { start, end, allDay, timeZone } = fields.schedule;
    const first = allDay ? { date: start, time: null } : partsAt(Date.parse(start), timeZone);
    const last = allDay ? { date: end, time: null } : partsAt(Date.parse(end), timeZone);
    result.date = first.date;
    result.start = first.time;
    result.end = last.time;
    result.appleCalendarTimeZone = timeZone;
    if (!allDay) {
      result.appleCalendarStartInstant = start;
      result.appleCalendarEndInstant = end;
    } else {
      delete result.appleCalendarStartInstant;
      delete result.appleCalendarEndInstant;
    }
    if (allDay || first.date !== last.date) result.appleCalendarEndDate = last.date;
    else delete result.appleCalendarEndDate;
  }
  return result;
}
function operation(op, taskId, fields, id) {
  return { op, ...(id ? { id } : {}), taskId, title: fields.title, notes: fields.notes, ...fields.schedule };
}
function dayBoundary(date, timeZone) {
  // Midnight may itself be skipped/repeated. The earliest candidate on the
  // civil date gives its actual start, including midnight DST transitions.
  const candidates = candidateInstants(date, '00:00', timeZone)
    .filter(ms => partsAt(ms, timeZone).date === date);
  return candidates.length ? new Date(candidates[0]).toISOString() : null;
}
function inWindow(fields, start, end) {
  if (!start && !end) return true;
  const schedule = fields.schedule;
  const first = schedule.allDay ? dayBoundary(schedule.start, schedule.timeZone) : schedule.start;
  const last = schedule.allDay ? dayBoundary(schedule.end, schedule.timeZone) : schedule.end;
  if (!first || !last) return false;
  const s = Date.parse(first), e = Date.parse(last);
  return (!start || e > Date.parse(start)) && (!end || s < Date.parse(end));
}
/** Stable collision-free ID for an event within its dedicated calendar. */
export function importedTaskId(calendarID, eventID) {
  return `apple-calendar:${encodeURIComponent(calendarID)}:${encodeURIComponent(eventID)}`;
}

export function planSync({
  tasks = [], events = [], links = null, calendarID, timeZone = 'UTC',
  now, windowStart, windowEnd, missingEventIds = [], undatedPolicy = 'conflict',
  importList = 'inbox', importGroup = '',
} = {}) {
  void now; // Accepted for host diagnostics; never used to guess winners.
  if (!calendarID || typeof calendarID !== 'string') throw new Error('calendarID is required');
  formatter(timeZone);
  for (const bound of [windowStart, windowEnd]) {
    if (bound == null) continue;
    try { if (!validDate(bound)) instant(bound); }
    catch { throw new Error('invalid-sync-window'); }
  }
  if (windowStart && validDate(windowStart)) {
    windowStart = dayBoundary(windowStart, timeZone);
    if (!windowStart) throw new Error('nonexistent-sync-window-date');
  }
  if (windowEnd && validDate(windowEnd)) {
    windowEnd = dayBoundary(windowEnd, timeZone);
    if (!windowEnd) throw new Error('nonexistent-sync-window-date');
  }
  if (windowStart && windowEnd && Date.parse(windowStart) >= Date.parse(windowEnd)) throw new Error('invalid-sync-window');
  if (!['conflict', 'delete'].includes(undatedPolicy)) throw new Error('invalid-undated-policy');
  if (links && (links.version !== VERSION || links.calendarID !== calendarID || !links.entries || Array.isArray(links.entries))) {
    throw new Error('incompatible-links');
  }
  const newTasks = copy(tasks);
  const newLinks = links ? copy(links) : { version: VERSION, calendarID, entries: {} };
  const operations = [], conflicts = [], warnings = [];
  const entries = newLinks.entries;
  const taskMap = new Map();
  for (const task of newTasks) {
    if (typeof task.id !== 'string' || !task.id || taskMap.has(task.id)) throw new Error('invalid-or-duplicate-task-id');
    taskMap.set(task.id, task);
  }
  const eventMap = new Map(), markerMap = new Map();
  for (const event of [...events].sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0))) {
    if (!event.id || eventMap.has(event.id)) throw new Error('invalid-or-duplicate-event-id');
    if (event.calendarID != null && event.calendarID !== calendarID) {
      warnings.push({ type: 'foreign-calendar', eventId: event.id });
      continue;
    }
    eventMap.set(event.id, event);
    if (event.taskId) markerMap.set(event.taskId, [...(markerMap.get(event.taskId) || []), event]);
  }
  const missing = new Set(missingEventIds);
  const consumed = new Set();
  const conflict = (type, taskId, event, extra = {}) => conflicts.push({ type, taskId, eventId: event?.id || entries[taskId]?.eventId || null, ...extra });
  const warn = (type, taskId, event, detail) => warnings.push({ type, ...(taskId ? { taskId } : {}), ...(event ? { eventId: event.id } : {}), ...(detail ? { detail } : {}) });
  const replaceTask = (id, next) => {
    const index = newTasks.findIndex(t => t.id === id);
    newTasks[index] = next;
    taskMap.set(id, next);
  };
  const allIds = [...new Set([...taskMap.keys(), ...Object.keys(entries)])].sort();
  for (const taskId of allIds) {
    const task = taskMap.get(taskId), link = entries[taskId];
    const marked = markerMap.get(taskId) || [];
    let event = link?.eventId ? eventMap.get(link.eventId) : undefined;
    if (!event && marked.length === 1) event = marked[0];
    if (event) consumed.add(event.id);
    if (marked.length > 1) {
      marked.forEach(e => consumed.add(e.id));
      conflict('duplicate-task-marker', taskId, event, { eventIds: marked.map(e => e.id) });
      continue;
    }
    if (event && event.taskId && event.taskId !== taskId) {
      conflict('event-marker-mismatch', taskId, event);
      continue;
    }
    if (event?.recurring) { warn('unsupported-recurring', taskId, event); continue; }
    if (!task) {
      if (!link) continue;
      if (event && link.baseline) {
        try {
          const remote = eventFields(event, timeZone);
          if (!equal(remote, link.baseline.event)) conflict('local-deleted-remote-modified', taskId, event, { remote, baseline: copy(link.baseline) });
          else operations.push({ op: 'delete', id: event.id, taskId });
        } catch (error) { warn('invalid-remote-event', taskId, event, error.message); }
      }
      else if (event) conflict('local-deleted-without-baseline', taskId, event);
      else if (link.eventId && missing.has(link.eventId)) delete entries[taskId];
      else warn('tracked-event-not-in-snapshot', taskId);
      continue;
    }
    if (link?.eventId && !event) {
      if (missing.has(link.eventId)) {
        // Retain every task field, mark it for archive/conflict UI, never erase it.
        replaceTask(taskId, { ...task, appleCalendarSyncConflict: 'remote-deleted' });
        conflict('remote-deleted', taskId, null, { local: copy(task), baseline: copy(link.baseline) });
      } else warn('tracked-event-not-in-snapshot', taskId);
      continue;
    }
    let local;
    try { local = taskFields(task, timeZone); }
    catch (error) {
      if (!task.date && event && undatedPolicy === 'delete' && link?.baseline) {
        try {
          const remote = eventFields(event, timeZone);
          if (!equal(remote, link.baseline.event)) conflict('undated-remote-modified', taskId, event, { remote, baseline: copy(link.baseline) });
          else operations.push({ op: 'delete', id: event.id, taskId });
        } catch (remoteError) { warn('invalid-remote-event', taskId, event, remoteError.message); }
      } else if (link || event) conflict(error.message, taskId, event, { local: copy(task) });
      else if (task.date) warn('invalid-local-task', taskId, null, error.message);
      continue;
    }
    if (!event) {
      if (!inWindow(local, windowStart, windowEnd)) { warn('out-of-window', taskId); continue; }
      entries[taskId] ||= { eventId: null, baseline: null };
      operations.push(operation('create', taskId, local));
      continue;
    }
    let remote;
    try { remote = eventFields(event, timeZone); }
    catch (error) { warn('invalid-remote-event', taskId, event, error.message); continue; }
    if (!link && !inWindow(local, windowStart, windowEnd) && !inWindow(remote, windowStart, windowEnd)) {
      warn('out-of-window', taskId, event); continue;
    }
    const baseline = link?.baseline;
    if (!baseline) {
      if (!equal(local, remote)) {
        // A recovered retry without a baseline cannot safely choose a winner.
        entries[taskId] = { eventId: event.id, ...(event.externalId ? { externalId: event.externalId } : {}), baseline: null };
        conflict('unbased-divergence', taskId, event, { local, remote, baseline: null });
        continue;
      }
    } else {
      const merged = copy(local), collisions = [];
      for (const field of FIELDS) {
        const lc = !equal(local[field], baseline.task[field]);
        const rc = !equal(remote[field], baseline.event[field]);
        if (lc && rc && !equal(local[field], remote[field])) collisions.push(field);
        else if (rc) merged[field] = copy(remote[field]);
      }
      if (collisions.length) {
        conflict('field-conflict', taskId, event, { fields: collisions, local, remote, baseline: copy(baseline) });
        continue; // Freeze the whole pair: retain BOTH versions, no partial writes.
      }
      const incoming = FIELDS.filter(field => !equal(local[field], merged[field]));
      if (incoming.length) replaceTask(taskId, applyFields(task, merged, incoming));
      if (!equal(merged, remote)) {
        // Advance ONLY fields already equal on both observed sides. Otherwise a
        // second remote edit while an unrelated write is pending would be
        // mistaken for a user-local edit of the previously imported value.
        for (const field of FIELDS) {
          if (equal(merged[field], remote[field])) {
            baseline.task[field] = copy(merged[field]);
            baseline.event[field] = copy(remote[field]);
          }
        }
        entries[taskId].eventId = event.id;
        if (event.externalId) entries[taskId].externalId = event.externalId;
        operations.push(operation('update', taskId, merged, event.id));
        continue; // Fields still awaiting a remote write retain their baseline.
      }
      local = merged;
    }
    if (taskMap.get(taskId)?.appleCalendarSyncConflict === 'remote-deleted') {
      const resolved = { ...taskMap.get(taskId) };
      delete resolved.appleCalendarSyncConflict;
      replaceTask(taskId, resolved);
    }
    entries[taskId] = {
      eventId: event.id, ...(event.externalId ? { externalId: event.externalId } : {}),
      baseline: { task: copy(local), event: copy(remote) },
    };
  }
  // Only unmarked, unrelated events can import; orphan markers might represent
  // a user-deleted task after an interrupted sync and must not resurrect it.
  for (const event of eventMap.values()) {
    if (consumed.has(event.id)) continue;
    if (event.recurring) { warn('unsupported-recurring', null, event); continue; }
    if (event.taskId) { warn('orphan-task-marker', event.taskId, event); continue; }
    let fields;
    try { fields = eventFields(event, timeZone); }
    catch (error) { warn('invalid-remote-event', null, event, error.message); continue; }
    if (!inWindow(fields, windowStart, windowEnd)) { warn('out-of-window', null, event); continue; }
    const id = importedTaskId(calendarID, event.id);
    if (taskMap.has(id) || entries[id]) { conflict('import-id-collision', id, event); continue; }
    const task = applyFields({ id, list: importList, group: importGroup, done: false }, fields);
    newTasks.push(task);
    taskMap.set(id, task);
    entries[id] = { eventId: event.id, ...(event.externalId ? { externalId: event.externalId } : {}), baseline: { task: copy(fields), event: copy(fields) } };
  }
  return { newTasks, newLinks, operations, conflicts, warnings };
}

import Foundation
import EventKit
import AppKit
import Darwin

// One process / one request. Only authorize may call an access-request API.
let managedName = "日历清单"
let bundleID = "com.ticklist.calendar-bridge"
let iso = ISO8601DateFormatter()
iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
let plainISO = ISO8601DateFormatter()
plainISO.formatOptions = [.withInternetDateTime]

struct BridgeError: Error {
    let code: String
    let message: String
    init(_ code: String, _ message: String) { self.code = code; self.message = message }
}
func fail(_ code: String, _ message: String) throws -> Never { throw BridgeError(code, message) }
func string(_ input: [String: Any], _ key: String) throws -> String {
    guard let value = input[key] as? String, !value.isEmpty else { try fail("invalid_request", "Missing nonempty string: \(key)") }
    return value
}
func date(_ value: String) throws -> Date {
    guard let result = iso.date(from: value) ?? plainISO.date(from: value) else {
        try fail("invalid_date", "Expected ISO8601 date-time with explicit UTC offset: \(value)")
    }
    return result
}
func emit(_ object: [String: Any], to path: String? = nil) {
    do {
        var data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])
        data.append(0x0A)
        if let path = path { try data.write(to: URL(fileURLWithPath: path), options: .atomic) }
        else { FileHandle.standardOutput.write(data) }
    } catch {
        FileHandle.standardError.write(Data("Cannot write bridge response: \(error)\n".utf8))
        exit(74)
    }
}
func errorJSON(_ error: Error) -> [String: Any] {
    let e = error as? BridgeError
    return ["ok": false, "error": ["code": e?.code ?? "eventkit_error", "message": e?.message ?? error.localizedDescription]]
}
func authorization() -> (String, Bool) {
    let value = EKEventStore.authorizationStatus(for: .event)
    if #available(macOS 14.0, *) {
        if value == .fullAccess { return ("fullAccess", true) }
        if value == .writeOnly { return ("writeOnly", false) }
    }
    switch value {
    case .notDetermined: return ("notDetermined", false)
    case .restricted: return ("restricted", false)
    case .denied: return ("denied", false)
    case .authorized: return ("fullAccess", true)
    default: return ("unknown", false)
    }
}
func requireAccess() throws {
    guard authorization().1 else { try fail("authorization_required", "Full calendar access is required. Explicitly launch the packaged app's authorize command.") }
}
func eligible(_ calendar: EKCalendar) -> Bool {
    calendar.source.sourceType == .calDAV && calendar.allowsContentModifications && !calendar.isSubscribed
}
func calendarJSON(_ c: EKCalendar) -> [String: Any] {
    ["id": c.calendarIdentifier, "title": c.title, "sourceId": c.source.sourceIdentifier,
     "writable": true, "managed": c.title == managedName]
}
func status(_ store: EKEventStore?) -> [String: Any] {
    let auth = authorization()
    var result: [String: Any] = ["ok": true, "authorization": auth.0, "authorized": auth.1,
        "bundleIdentifier": bundleID, "managedCalendarName": managedName,
        "localTimeZone": TimeZone.current.identifier, "sources": [], "calendars": []]
    // Never even construct/query the store until full access was already granted.
    if auth.1, let store = store {
        let calendars = store.calendars(for: .event).filter(eligible)
        let sourceIDs = Set(calendars.map { $0.source.sourceIdentifier })
        result["calendars"] = calendars.map(calendarJSON).sorted { ($0["id"] as! String) < ($1["id"] as! String) }
        result["sources"] = store.sources.filter { $0.sourceType == .calDAV && sourceIDs.contains($0.sourceIdentifier) }.map {
            ["id": $0.sourceIdentifier, "title": $0.title, "type": "calDAV", "writable": true] as [String: Any]
        }.sorted { ($0["id"] as! String) < ($1["id"] as! String) }
    }
    return result
}
func marker(_ taskID: String) -> URL {
    var parts = URLComponents()
    parts.scheme = "ticklist-calendar"; parts.host = "task"; parts.path = "/" + taskID
    return parts.url!
}
func taskID(_ event: EKEvent) -> String? {
    guard let url = event.url, url.scheme == "ticklist-calendar", url.host == "task",
          url.query == nil, url.fragment == nil, url.path.hasPrefix("/") else { return nil }
    let value = String(url.path.dropFirst())
    return value.isEmpty ? nil : value
}
// macOS EventKit exposes all-day ends as inclusive 23:59:59 and a nil
// (floating/default) timeZone. The bridge protocol always uses exclusive ends.
func exclusiveEnd(_ event: EKEvent) -> Date {
    let end = event.endDate!
    guard event.isAllDay else { return end }
    var cal = Calendar(identifier: .gregorian); cal.timeZone = event.timeZone ?? .current
    if cal.startOfDay(for: end) == end { return end }
    return cal.date(byAdding: .day, value: 1, to: cal.startOfDay(for: end))!
}
func eventJSON(_ event: EKEvent) -> [String: Any] {
    ["id": event.eventIdentifier ?? event.calendarItemIdentifier,
     "externalId": event.calendarItemExternalIdentifier as Any? ?? NSNull(),
     "taskId": taskID(event) as Any? ?? NSNull(), "title": event.title ?? "",
     "linkable": event.url == nil || taskID(event) != nil,
     "notes": event.notes as Any? ?? NSNull(), "start": iso.string(from: event.startDate),
     "end": iso.string(from: exclusiveEnd(event)), "allDay": event.isAllDay,
     "timeZone": event.timeZone?.identifier as Any? ?? NSNull(),
     "lastModified": event.lastModifiedDate.map { iso.string(from: $0) } as Any? ?? NSNull(),
     "recurring": event.hasRecurrenceRules || event.isDetached]
}
func selectedCalendar(_ store: EKEventStore, _ id: String) throws -> EKCalendar {
    guard let c = store.calendar(withIdentifier: id) else { try fail("calendar_not_found", "Unknown calendarID") }
    guard eligible(c), c.title == managedName else {
        try fail("calendar_not_managed", "calendarID must identify writable CalDAV calendar named \(managedName)")
    }
    return c
}
func initialize(_ store: EKEventStore, _ sourceID: String) throws -> EKCalendar {
    guard let source = store.source(withIdentifier: sourceID), source.sourceType == .calDAV else {
        try fail("invalid_source", "sourceID must explicitly identify a CalDAV/iCloud source; local fallback is forbidden")
    }
    let matching = store.calendars(for: .event).filter { $0.source.sourceIdentifier == sourceID && $0.title == managedName }
    if matching.count > 1 { try fail("ambiguous_calendar", "Multiple managed calendars exist in this source; select exact calendarID") }
    if let c = matching.first { return try selectedCalendar(store, c.calendarIdentifier) }
    // Source writability has no public EKSource flag. Existing writable event calendars prove capability.
    guard store.calendars(for: .event).contains(where: { $0.source.sourceIdentifier == sourceID && eligible($0) }) else {
        try fail("source_not_writable", "Source has no writable event calendar; cannot establish write capability")
    }
    let c = EKCalendar(for: .event, eventStore: store)
    c.title = managedName; c.source = source
    try store.saveCalendar(c, commit: true)
    return c
}
func windowEvents(_ store: EKEventStore, _ calendar: EKCalendar, _ start: Date, _ end: Date) throws -> [EKEvent] {
    guard end > start else { try fail("invalid_window", "end must be after start") }
    // EventKit truncates predicates exceeding four years. Split rather than silently lose events.
    var cursor = start
    var values: [String: EKEvent] = [:]
    var utc = Calendar(identifier: .gregorian); utc.timeZone = TimeZone(secondsFromGMT: 0)!
    while cursor < end {
        let next = min(utc.date(byAdding: .year, value: 3, to: cursor)!, end)
        for e in store.events(matching: store.predicateForEvents(withStart: cursor, end: next, calendars: [calendar])) {
            let key = (e.eventIdentifier ?? e.calendarItemIdentifier) + ":" + iso.string(from: e.startDate)
            values[key] = e
        }
        cursor = next
    }
    return Array(values.values)
}
// Marker recovery must not depend on the current display window or event dates in a retry.
let supportedStart = plainISO.date(from: "1900-01-01T00:00:00Z")!
let supportedEnd = plainISO.date(from: "2200-01-01T00:00:00Z")!
func snapshot(_ store: EKEventStore, _ input: [String: Any]) throws -> [String: Any] {
    let c = try selectedCalendar(store, string(input, "calendarID"))
    let start = try date(string(input, "start")); let end = try date(string(input, "end"))
    guard end.timeIntervalSince(start) <= 366 * 86400 * 10 else { try fail("invalid_window", "Snapshot window is limited to ten years") }
    let tracked = input["trackedEventIDs"] as? [String] ?? []
    if input["trackedEventIDs"] != nil && !(input["trackedEventIDs"] is [String]) { try fail("invalid_request", "trackedEventIDs must be string[]") }
    guard tracked.count <= 10000 else { try fail("invalid_request", "Too many trackedEventIDs") }
    var events = try windowEvents(store, c, start, end)
    var missing: [String] = []; var outside: [String] = []
    for id in Set(tracked).sorted() {
        // Resolve independently even when outside the window. Never infer deletion from window absence.
        if let e = store.event(withIdentifier: id) {
            if e.calendar.calendarIdentifier == c.calendarIdentifier {
                if !events.contains(where: { $0.eventIdentifier == e.eventIdentifier && $0.startDate == e.startDate }) { events.append(e) }
            } else { outside.append(id) }
        } else { missing.append(id) }
    }
    return ["ok": true, "calendar": calendarJSON(c), "events": events.sorted { $0.startDate < $1.startDate }.map(eventJSON),
            "missingTrackedEventIDs": missing, "outOfCalendarTrackedEventIDs": outside,
            "start": iso.string(from: start), "end": iso.string(from: end)]
}
func mutable(_ e: EKEvent) throws {
    guard !e.hasRecurrenceRules && !e.isDetached else { try fail("recurring_unsupported", "Recurring events and detached occurrences cannot be mutated") }
}
func patch(_ e: EKEvent, _ op: [String: Any], creating: Bool) throws {
    let allowed: Set<String> = ["op", "id", "taskId", "title", "notes", "start", "end", "allDay", "timeZone", "expected"]
    guard Set(op.keys).isSubset(of: allowed) else { try fail("unsupported_field", "Unsupported operation field (recurrence/alarms cannot be supplied)") }
    if creating || op["title"] != nil { e.title = try string(op, "title") }
    if let notes = op["notes"] {
        guard notes is String || notes is NSNull else { try fail("invalid_request", "notes must be string or null") }
        e.notes = notes as? String
    }
    var allDayValue = e.isAllDay
    if let allDay = op["allDay"] {
        guard let number = allDay as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { try fail("invalid_request", "allDay must be boolean") }
        allDayValue = number.boolValue
    }
    // Capture protocol dates before toggling an existing all-day event: EventKit
    // otherwise rounds assigned end dates to inclusive 23:59:59 (an extra day).
    let oldStart = e.startDate
    let oldEnd = e.endDate == nil ? nil : exclusiveEnd(e)
    let startValue = creating || op["start"] != nil ? try date(string(op, "start")) : oldStart
    let endValue = creating || op["end"] != nil ? try date(string(op, "end")) : oldEnd
    e.isAllDay = false
    if let zone = op["timeZone"] {
        if zone is NSNull { e.timeZone = nil }
        else {
            guard let name = zone as? String, let tz = TimeZone(identifier: name) else { try fail("invalid_timezone", "Unknown IANA timeZone") }
            e.timeZone = tz
        }
    } else if creating { e.timeZone = .current }
    e.startDate = startValue
    e.endDate = endValue
    guard let start = e.startDate, let end = e.endDate, end > start, start >= supportedStart, end < supportedEnd else {
        try fail("invalid_date_range", "Require start < end within 1900–2199")
    }
    if allDayValue {
        var cal = Calendar(identifier: .gregorian); cal.timeZone = e.timeZone ?? .current
        guard cal.startOfDay(for: start) == start, cal.startOfDay(for: end) == end else {
            try fail("invalid_all_day", "All-day start/end must be local midnight; end is exclusive (next day for one-day events)")
        }
    }
    // EventKit date/timeZone setters can clear isAllDay. Set it last, preserving
    // the original flag when omitted; validate midnight before any normalization.
    e.isAllDay = allDayValue
    // Only explicitly supplied fields are changed. Alarms, location, availability and other metadata survive.
}
// Pure validation helpers also support tests without authorization or an EventKit store.
struct EventPrecondition {
    let title: String
    let notes: String
    let start: Date
    let end: Date
    let allDay: Bool
    let timeZone: String?
    let comparesLastModified: Bool
    let lastModified: Date?

    init(_ value: [String: Any], strict: Bool = true) throws {
        let required: Set<String> = ["title", "notes", "start", "end", "allDay", "timeZone"]
        guard required.isSubset(of: Set(value.keys)),
              !strict || Set(value.keys).isSubset(of: required.union(["lastModified"])),
              let title = value["title"] as? String,
              value["notes"] is String || value["notes"] is NSNull,
              let boolean = value["allDay"] as? NSNumber, CFGetTypeID(boolean) == CFBooleanGetTypeID(),
              value["timeZone"] is String || value["timeZone"] is NSNull else {
            try fail("invalid_request", "expected requires title, notes, start, end, allDay and timeZone in bridge Event format")
        }
        self.title = title; notes = value["notes"] as? String ?? ""
        start = try date(string(value, "start")); end = try date(string(value, "end"))
        allDay = boolean.boolValue; timeZone = value["timeZone"] as? String
        comparesLastModified = value["lastModified"] != nil
        if let modified = value["lastModified"], !(modified is NSNull) {
            guard let text = modified as? String else { try fail("invalid_request", "expected.lastModified must be ISO8601 or null") }
            lastModified = try date(text)
        } else { lastModified = nil }
    }

    func check(_ current: EventPrecondition) throws {
        // Bridge timestamps have millisecond precision. Compare instants, not ISO spellings.
        guard title == current.title, notes == current.notes, start == current.start, end == current.end,
              allDay == current.allDay, timeZone == current.timeZone,
              !comparesLastModified || lastModified == current.lastModified else {
            try fail("event_conflict", "Event changed since snapshot; take a fresh snapshot and reconcile before retrying")
        }
    }
}
func expected(_ op: [String: Any]) throws -> EventPrecondition? {
    guard let value = op["expected"] else {
        if ["update", "delete"].contains(op["op"] as? String ?? "") {
            try fail("invalid_request", "update/delete require expected snapshot fields")
        }
        return nil
    }
    guard let object = value as? [String: Any] else { try fail("invalid_request", "expected must be an object") }
    return try EventPrecondition(object)
}
func checkExpected(_ op: [String: Any], _ event: EKEvent) throws {
    if let precondition = try expected(op) {
        try precondition.check(EventPrecondition(eventJSON(event), strict: false))
    }
}
func linkNeedsWrite(_ url: URL?, recurring: Bool, task: String) throws -> Bool {
    guard !recurring else { try fail("recurring_unsupported", "Recurring events and detached occurrences cannot be linked") }
    guard let url = url else { return true }
    guard url == marker(task) else { try fail("task_mismatch", "Link cannot overwrite an existing URL or a different task marker") }
    return false
}
func validateOperations(_ input: [String: Any]) throws -> [[String: Any]] {
    guard let operations = input["operations"] as? [[String: Any]], operations.count <= 500 else {
        try fail("invalid_request", "operations must be an array of at most 500 operations")
    }
    var seenTasks = Set<String>()
    var seenIDs = Set<String>()
    for op in operations {
        let kind = try string(op, "op"); let task = try string(op, "taskId")
        guard ["create", "update", "delete", "link"].contains(kind) else { try fail("invalid_request", "Unknown operation") }
        guard seenTasks.insert(task).inserted else { try fail("duplicate_task", "Only one operation per taskId is allowed per batch") }
        if kind != "create" { _ = try string(op, "id") }
        if let id = op["id"] as? String {
            guard seenIDs.insert(id).inserted else { try fail("duplicate_event", "Only one operation per event id is allowed per batch") }
        }
        var allowed: Set<String> = kind == "link" ? ["op", "id", "taskId"] :
            ["op", "id", "taskId", "title", "notes", "start", "end", "allDay", "timeZone"]
        if kind != "create" { allowed.insert("expected") }
        guard Set(op.keys).isSubset(of: allowed) else { try fail("unsupported_field", "Unsupported operation field") }
        _ = try expected(op)
        if kind == "link" { _ = try string(input, "calendarID") }
    }
    return operations
}
func apply(_ store: EKEventStore, _ input: [String: Any]) throws -> [String: Any] {
    // Validate the entire payload before any explicit initialization can create a calendar.
    let operations = try validateOperations(input)
    for op in operations where op["op"] as? String == "create" {
        try patch(EKEvent(eventStore: store), op, creating: true)
    }
    let c: EKCalendar
    if let id = input["calendarID"] as? String, !id.isEmpty { c = try selectedCalendar(store, id) }
    else if let initializeFlag = input["initialize"] as? NSNumber,
            CFGetTypeID(initializeFlag) == CFBooleanGetTypeID(), initializeFlag.boolValue {
        c = try initialize(store, string(input, "sourceID"))
    }
    else { try fail("invalid_request", "apply requires exact calendarID, or explicit initialize:true and sourceID") }

    var markerIndex: [String: [EKEvent]]? = nil
    func recover(_ task: String) throws -> EKEvent? {
        if markerIndex == nil {
            var index: [String: [EKEvent]] = [:]
            for event in try windowEvents(store, c, supportedStart, supportedEnd) {
                if let t = taskID(event) { index[t, default: []].append(event) }
            }
            markerIndex = index
        }
        let matches = markerIndex?[task] ?? []
        guard matches.count <= 1 else { try fail("duplicate_marker", "Multiple events have the same task marker; resolve manually") }
        return matches.first
    }
    var pending: [(String, String, EKEvent?, Bool)] = []
    do {
        // Resolve and validate every operation before staging anything in EventKit.
        for op in operations {
            let kind = try string(op, "op"); let task = try string(op, "taskId")
            if kind == "link" {
                // Linking never recovers another event or falls back to creating one.
                guard let e = store.event(withIdentifier: try string(op, "id")) else {
                    try fail("event_not_found", "Cannot link missing event for task \(task)")
                }
                guard e.calendar.calendarIdentifier == c.calendarIdentifier else { try fail("calendar_mismatch", "Event id belongs to a different calendar") }
                try checkExpected(op, e)
                let write = try linkNeedsWrite(e.url, recurring: e.hasRecurrenceRules || e.isDetached, task: task)
                if let other = try recover(task), other.eventIdentifier != e.eventIdentifier {
                    try fail("duplicate_marker", "Another event already has this task marker")
                }
                // Defer even the URL assignment until the full batch has validated.
                pending.append((kind, task, e, write)); continue
            }
            var existing: EKEvent? = nil
            if let id = op["id"] as? String, let found = store.event(withIdentifier: id) {
                guard found.calendar.calendarIdentifier == c.calendarIdentifier else { try fail("calendar_mismatch", "Event id belongs to a different calendar") }
                guard taskID(found) == task else { try fail("task_mismatch", "Event task marker does not match taskId") }
                existing = found
            }
            if existing == nil { existing = try recover(task) }
            if let e = existing {
                try mutable(e)
                if kind != "create" { try checkExpected(op, e) }
            }
            if kind == "delete" { pending.append((kind, task, existing, existing != nil)); continue }
            if kind == "update" && existing == nil { try fail("event_not_found", "Cannot update missing event for task \(task)") }
            if kind == "create", let existing = existing {
                // Recovery is intentionally a no-op, not an old payload overwriting a newer edit.
                pending.append(("recovered", task, existing, false)); continue
            }
            let e = existing ?? EKEvent(eventStore: store)
            if existing == nil { e.calendar = c; e.url = marker(task) }
            // Validate patches on a scratch event; never dirty the fetched object before rechecking.
            let candidate = EKEvent(eventStore: store)
            candidate.title = e.title; candidate.notes = e.notes
            candidate.startDate = e.startDate; candidate.endDate = e.endDate
            candidate.isAllDay = e.isAllDay; candidate.timeZone = e.timeZone
            try patch(candidate, op, creating: existing == nil)
            pending.append((kind, task, e, true))
        }
        for index in pending.indices {
            let (kind, task, event, write) = pending[index]
            guard let original = event, kind != "recovered" else { continue }
            let op = operations[index]
            let e: EKEvent
            if kind == "create" { e = original }
            else {
                // Refresh only this clean object, not the store (which may already hold staged writes).
                guard let fresh = store.event(withIdentifier: original.eventIdentifier ?? original.calendarItemIdentifier),
                      fresh.refresh() else { try fail("event_conflict", "Event disappeared before staging") }
                e = fresh
                guard e.calendar.calendarIdentifier == c.calendarIdentifier else { try fail("event_conflict", "Event moved before staging") }
                try mutable(e)
                try checkExpected(op, e)
                if kind == "link" { _ = try linkNeedsWrite(e.url, recurring: false, task: task) }
                else if taskID(e) != task { try fail("event_conflict", "Event marker changed before staging") }
            }
            pending[index].2 = e
            let needsWrite = kind == "link" ? try linkNeedsWrite(e.url, recurring: false, task: task) : write
            pending[index].3 = needsWrite
            guard needsWrite else { continue }
            if kind == "delete" { try store.remove(e, span: .thisEvent, commit: false) }
            else {
                if kind == "link" { e.url = marker(task) }
                else { try patch(e, op, creating: kind == "create") }
                try store.save(e, span: .thisEvent, commit: false)
            }
        }
        if pending.contains(where: { $0.3 }) { try store.commit() }
    } catch { store.reset(); throw error }
    let results: [[String: Any]] = pending.map { kind, task, e, _ in
        var result: [String: Any] = ["op": kind, "taskId": task]
        if kind == "delete" { result["deleted"] = true; result["alreadyMissing"] = e == nil }
        else if let e = e { result["event"] = eventJSON(e) }
        return result
    }
    return ["ok": true, "calendar": calendarJSON(c), "results": results]
}

// Both transports use exactly the same noninteractive dispatcher. Never request access here.
func dispatchRequest(_ data: Data) throws -> [String: Any] {
    guard data.count <= 4 * 1024 * 1024 else { try fail("invalid_request", "Input exceeds 4 MiB") }
    guard let input = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { try fail("invalid_request", "Expected a JSON object") }
    let command = try string(input, "command")
    if command == "status" { return status(authorization().1 ? EKEventStore() : nil) }
    if command == "authorize" { try fail("app_launch_required", "authorize is never accepted in JSON; explicitly launch the app with authorize --status-file") }
    guard ["snapshot", "initialize", "apply"].contains(command) else { try fail("unknown_command", "Unknown command: \(command)") }
    try requireAccess()
    let store = EKEventStore()
    switch command {
    case "snapshot": return try snapshot(store, input)
    case "initialize": return ["ok": true, "calendar": calendarJSON(try initialize(store, string(input, "sourceID")))]
    default: return try apply(store, input)
    }
}

// Private IPC directory + descriptor-relative operations prevent symlink substitution.
// Publish by exclusive hard link: readers see the complete response, never partial JSON.
final class FileTransport {
    let directory: Int32
    let requestName: String
    let resultName: String
    init(request: String, result: String) throws {
        func checkedURL(_ path: String) throws -> URL {
            guard path.hasPrefix("/"), !path.utf8.contains(0) else { try fail("invalid_transport", "IPC paths must be absolute") }
            let url = URL(fileURLWithPath: path)
            let components = path.split(separator: "/", omittingEmptySubsequences: false).dropFirst()
            guard components.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else {
                try fail("invalid_transport", "IPC paths must be canonical")
            }
            let parent = url.deletingLastPathComponent().path
            // Foundation normalizes /private/var back to /var on macOS; POSIX
            // realpath is required to compare against the caller's real path.
            guard let canonical = realpath(parent, nil) else { try fail("invalid_transport", "Cannot resolve IPC directory") }
            defer { free(canonical) }
            guard String(cString: canonical) == parent else {
                try fail("invalid_transport", "IPC paths must have no symlink parents")
            }
            return url
        }
        let requestURL = try checkedURL(request), resultURL = try checkedURL(result)
        let parent = requestURL.deletingLastPathComponent().path
        guard parent == resultURL.deletingLastPathComponent().path, request != result else {
            try fail("invalid_transport", "Distinct request/result files must share one private IPC directory")
        }
        let fd = open(parent, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { try fail("invalid_transport", "Cannot open IPC directory") }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_uid == getuid(), info.st_mode & 0o7777 == 0o700 else {
            close(fd); try fail("invalid_transport", "IPC directory must be owned by current user with mode 0700")
        }
        directory = fd; requestName = requestURL.lastPathComponent; resultName = resultURL.lastPathComponent
    }
    deinit { close(directory) }
    func validateResult() throws {
        var info = stat()
        guard fstatat(directory, resultName, &info, AT_SYMLINK_NOFOLLOW) == -1, errno == ENOENT else {
            try fail("invalid_transport", "Result file must not already exist")
        }
    }
    func readRequest() throws -> Data {
        let fd = openat(directory, requestName, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { try fail("invalid_transport", "Cannot open request file") }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
              info.st_uid == getuid(), info.st_mode & 0o7777 == 0o600, info.st_nlink == 1 else {
            try fail("invalid_transport", "Request must be a regular single-link file owned by current user with mode 0600")
        }
        let limit = 4 * 1024 * 1024
        guard info.st_size <= limit else { try fail("invalid_request", "Input exceeds 4 MiB") }
        var data = Data(), buffer = [UInt8](repeating: 0, count: 65536)
        while true {
            let count = Darwin.read(fd, &buffer, min(buffer.count, limit + 1 - data.count))
            if count < 0 { if errno == EINTR { continue }; try fail("invalid_transport", "Cannot read request file") }
            if count == 0 { break }
            data.append(contentsOf: buffer.prefix(count))
            guard data.count <= limit else { try fail("invalid_request", "Input exceeds 4 MiB") }
        }
        return data
    }
    func writeResponse(_ object: [String: Any]) throws {
        var data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])
        data.append(0x0A)
        let temporary = ".response-" + UUID().uuidString
        let fd = openat(directory, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { try fail("output_write_failed", "Cannot create private response file") }
        defer { close(fd); unlinkat(directory, temporary, 0) }
        guard fchmod(fd, 0o600) == 0 else { try fail("output_write_failed", "Cannot restrict response permissions") }
        try data.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                let count = Darwin.write(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { try fail("output_write_failed", "Cannot write response") }
                offset += count
            }
        }
        guard fsync(fd) == 0, linkat(directory, temporary, directory, resultName, 0) == 0 else {
            try fail("output_write_failed", "Cannot atomically publish fresh response")
        }
    }
}

// AppKit owns the main-thread run loop; the async permission callback never waits on it.
final class AuthorizationDelegate: NSObject, NSApplicationDelegate {
    let path: String
    var store: EKEventStore?
    init(path: String) { self.path = path }
    func applicationDidFinishLaunching(_ notification: Notification) {
        let store = EKEventStore(); self.store = store
        func done(_ granted: Bool, _ error: Error?) {
            DispatchQueue.main.async {
                var result = status(authorization().1 ? store : nil)
                result["granted"] = granted
                if let error = error { result["authorizationError"] = error.localizedDescription }
                emit(result, to: self.path)
                NSApplication.shared.terminate(nil)
            }
        }
        if #available(macOS 14.0, *) { store.requestFullAccessToEvents(completion: done) }
        else { store.requestAccess(to: .event, completion: done) }
    }
}

final class RunDelegate: NSObject, NSApplicationDelegate {
    let transport: FileTransport
    init(transport: FileTransport) { self.transport = transport }
    func applicationDidFinishLaunching(_ notification: Notification) {
        var response: [String: Any]
        var code: Int32 = 0
        do { response = try dispatchRequest(transport.readRequest()) }
        catch { response = errorJSON(error); code = 1 }
        do { try transport.writeResponse(response) }
        catch {
            FileHandle.standardError.write(Data("Cannot write bridge response: \(error)\n".utf8))
            exit(74)
        }
        // No permission API is reachable here. Exit only after atomic response publication.
        exit(code)
    }
}

let args = Array(CommandLine.arguments.dropFirst())
if args.first == "authorize" {
    guard Bundle.main.bundleURL.pathExtension == "app", Bundle.main.bundleIdentifier == bundleID,
          args.count == 3, args[1] == "--status-file", args[2].hasPrefix("/") else {
        emit(errorJSON(BridgeError("app_launch_required", "Use open -n -W <app> --args authorize --status-file <absolute-path>")))
        exit(2)
    }
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let delegate = AuthorizationDelegate(path: args[2]); app.delegate = delegate
    app.run()
    withExtendedLifetime(delegate) {}
} else if args.first == "run" {
    do {
        guard args.count == 5, args[1] == "--request-file", args[3] == "--result-file" else {
            try fail("invalid_transport", "Use run --request-file <absolute-path> --result-file <absolute-path>")
        }
        let transport = try FileTransport(request: args[2], result: args[4])
        try transport.validateResult()
        guard Bundle.main.bundleURL.pathExtension == "app", Bundle.main.bundleIdentifier == bundleID else {
            try transport.writeResponse(errorJSON(BridgeError("app_launch_required", "Launch the packaged app using open -n -W")))
            exit(2)
        }
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let delegate = RunDelegate(transport: transport); app.delegate = delegate
        app.run()
        withExtendedLifetime(delegate) {}
    } catch {
        // An invalid destination must never be written to. No stdout is needed by LS.
        FileHandle.standardError.write(Data("Invalid bridge transport: \(error)\n".utf8))
        exit(2)
    }
} else {
    do { emit(try dispatchRequest(FileHandle.standardInput.readDataToEndOfFile())) }
    catch { emit(errorJSON(error)); exit(1) }
}

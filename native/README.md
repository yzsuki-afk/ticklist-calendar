# Apple Calendar EventKit bridge

## Build and safe verification

From the package root:

```sh
bash scripts/build-calendar-bridge.sh
python3 native/test_bridge.py
```

Requires macOS 13+, Xcode Command Line Tools/Swift. Builds for the current architecture (arm64 on the verified machine), linking Foundation, EventKit, AppKit; no package dependencies. App output: `native/build.nosync/TicklistCalendarBridge.app`; CLI: `Contents/MacOS/calendar-bridge`. `.nosync` separates generated output but this workspace's File Provider may ignore that suffix and continuously add FinderInfo to `.app` folders, breaking later strict signing validation. Build strips only the generated app root's FinderInfo before signing and also produces `native/build.nosync/TicklistCalendarBridge.app.zip` without extended attributes: use that signed archive for a later, explicitly approved installation to a nonsynced location. The workspace executable is runnable, but strict validation of the expanded synced app can regress after the build; that is an environment metadata limitation, not a changed executable. No installation, LaunchServices registration, authorization or calendar mutation happens during build/tests.

Bundle identifier: **com.ticklist.calendar-bridge**. Ad-hoc signature with explicit stable designated requirement `identifier "com.ticklist.calendar-bridge"`. Info.plist includes legacy calendar, full calendar access, and write-only usage descriptions. This is a local build, not notarized/Developer-ID-signed; moving/re-signing/replacing it can still require renewed macOS authorization. Keep bundle path and identity stable. Build verifies `codesign --verify --strict`.

## Transport

**Production: launch every noninteractive request via the same installed LaunchServices application identity used for authorization.** Directly spawning its executable from DSH can inherit DSH's responsible-process TCC attribution and return `notDetermined` despite successful app authorization. Stdin remains a legacy/debug transport, not a reliable way to test the app's authorization.

```sh
open -n -W '/absolute/installed/TicklistCalendarBridge.app' --args run \
  --request-file '/absolute/private/plugin-data/calendar-ipc/request-UUID.json' \
  --result-file '/absolute/private/plugin-data/calendar-ipc/result-UUID.json'
```

Host contract:

- Create the IPC directory inside plugin private data, owned by the current UID and **mode 0700**. Resolve its real POSIX path first (for example Node `realpath`); all parent components must be free of symlinks. `/var` aliases must be resolved to `/private/var`. Paths must be absolute, canonical (no `.`, `..`, repeated/trailing slash), with no NUL.
- Write one UTF-8 JSON request to an exclusive fresh **mode 0600** regular file, current UID owner, exactly one hard link, at most **4 MiB**. Close it before launching. Both request and result must be distinct files in that same directory. The result path **must not exist**, including a dangling symlink. Choose fresh unique names, never reuse stale output.
- The app checks directory/descriptor ownership and mode, rejects symlinks and nonregular request files, uses descriptor-relative file operations, and bounds the read even if a file grows. It initializes `NSApplication.shared` with accessory activation and runs the shared dispatcher after `applicationDidFinishLaunching`. `run` **never requests authorization**; JSON `authorize` always returns `app_launch_required` without prompting.
- Responses are the existing JSON schema plus newline, atomically published **mode 0600** using an exclusive hard link from a fully written/fsynced private temporary file. An existing result is never replaced. No stdout dependency. Consume the fresh result after launch completion even on a command error; `open` exit status alone is not the protocol result.
- Unsafe paths/directories, existing results or malformed CLI arguments exit 2 without writing a result. Request read/validation/dispatcher errors produce error JSON (exit 1). Output publication failure exits 74, possibly with no result. Diagnostics use stderr but LaunchServices need not expose them. Successful command exit is 0. The legacy stdin mode reads one JSON object through EOF and writes one JSON response on stdout using the same dispatcher.

No persistent server. Host must serialize calls, especially initialization/writes, and clean up request/result files afterward. Allow up to 120 seconds for apply marker recovery. Timeout or missing output is an ambiguous result, **not proof that writes did not occur**; reconcile before retrying mutations. Native tests do not install/register/launch through LaunchServices; production identity verification belongs to the installed Host integration.

Every failure is `{ "ok": false, "error": { "code": string, "message": string } }`. Native EventKit failures use `eventkit_error`; callers must not parse localized messages. Unknown fields in event operations are rejected; unsupported recurrence/alarms fields are never ignored.

## Requests (exact field names)

```ts
type ISO8601 = string; // date-time with Z or explicit offset; fractional seconds optional
// A one-day all-day event in Shanghai: 2026-10-24T00:00:00+08:00 -> 2026-10-25T00:00:00+08:00

type Request =
  | { command: 'status' }
  | { command: 'initialize'; sourceID: string }
  | { command: 'snapshot'; calendarID: string; start: ISO8601; end: ISO8601;
      trackedEventIDs?: string[] }
  | { command: 'apply'; calendarID: string; operations: Operation[] }
  | { command: 'apply'; initialize: true; sourceID: string; operations: Operation[] };

type Fields = {
  title?: string; // nonempty when supplied
  notes?: string | null;
  start?: ISO8601;
  end?: ISO8601;
  allDay?: boolean;
  timeZone?: string | null; // IANA identifier, e.g. Asia/Shanghai; null means floating
};
type Expected = {
  title: string; notes: string | null;
  start: ISO8601; end: ISO8601; allDay: boolean; timeZone: string | null;
  lastModified?: ISO8601 | null;
};
type Operation =
  | (Fields & { op: 'create'; taskId: string; title: string; start: ISO8601; end: ISO8601 })
  | (Fields & { op: 'update'; taskId: string; id: string; expected: Expected })
  | { op: 'delete'; taskId: string; id: string; expected: Expected }
  | { op: 'link'; taskId: string; id: string; expected?: Expected }; // exact calendarID required; no Fields allowed
```

All task/id/source/calendar identifiers must be nonempty strings. One operation per taskId per batch, at most 500 operations. Maximum 10,000 trackedEventIDs. Snapshot windows are positive and at most ten years; queries are split into three-year slices because EventKit truncates predicates beyond four years. Mutation dates must fall in 1900–2199. Each end must be later than start.

`status` only checks existing authorization. Before full access it does not construct an EventKit store, query sources/calendars, request permission, or create anything. Full-access status includes **only writable, non-subscribed CalDAV event calendars** and their sources. iCloud is represented by EventKit's CalDAV type; generic CalDAV is not mislabeled as iCloud. Local, Exchange, subscription and birthday sources are not returned or selected. EKSource exposes no writable flag, so a source is considered writable only if it has an existing writable event calendar.

`initialize` explicitly finds or creates a calendar named **日历清单** in the supplied CalDAV source. No default/local fallback. Multiple matching names cause `ambiguous_calendar`; caller must then choose an exact calendarID. Existing read-only matching calendars fail, not duplicate. Only initialize or apply with `initialize:true,sourceID` may create a calendar. An explicit apply initialization persists the calendar before its event batch; a later event failure can therefore leave an empty dedicated calendar. Prefer a separate initialize call and persist its returned ID.

`snapshot` requires an exact writable CalDAV calendar ID whose current title is 日历清单. It returns window events **plus each individually resolved tracked event**, even when moved outside the window. `missingTrackedEventIDs` contains only IDs that EventKit could not resolve at all, never IDs merely absent from the window. `outOfCalendarTrackedEventIDs` distinguishes events moved to another calendar: these events are not returned or modified. EventKit identifiers can change across server sync: clients should also match taskId markers before inferring deletion from a missing identifier. Other-calendar events must never be recreated/deleted automatically on that basis.

`apply` requires that exact same dedicated calendar identity/title/source and, except for explicit `link`, a matching taskId marker on existing events. Supplying an ID from another calendar fails `calendar_mismatch`; wrong/missing task marker fails `task_mismatch`. The bridge never moves events between calendars. Only explicitly provided event fields are changed on update; existing alarms, URL linkage, location, availability, attendee data and other metadata are not replaced. **All mutations of recurring events or detached occurrences fail `recurring_unsupported`.** No recurrence creation or editing is supported.

`link` explicitly adopts a phone-created/imported event: `{op:'link',id,taskId}` requires exact `calendarID` and the exact resolvable event ID in that managed calendar; it never initializes a calendar, recovers another event, or creates an event. An unmarked event is eligible **only when its URL is nil**. Linking changes only its URL to the task marker: title, notes, dates, time zone, alarms, location and all other event fields remain untouched. Any existing user URL or different/malformed task marker fails `task_mismatch` without overwriting it. An exact matching URL marker succeeds idempotently without save/commit; both paths return `{op:'link',taskId,event}`. Missing ID fails `event_not_found`; recurrence/detached events always fail. Another event carrying the requested marker fails `duplicate_marker`. Link accepts no field patches; follow it in a separate batch with update if needed. One operation per explicit event ID is enforced (`duplicate_event`), as is one operation per taskId across all kinds. The entire batch validates before the link URL is assigned or any save/remove is staged.

New events carry `event.url = ticklist-calendar://task/<URL-encoded-taskId>`. Missing/stale IDs and create retries recover by exact marker **only within the selected calendar**, scanning 1900–2199 in three-year slices once per batch. An already-created task returns `op:'recovered'` and its current event **without overwriting newer calendar edits**. Ambiguous markers fail `duplicate_marker`. An update with no event fails `event_not_found`. A delete with no event is successful with `alreadyMissing:true`. Delete retries cannot touch unrelated events. Keep calls serialized to avoid two simultaneous first-create or initialize races.

`update` and `delete` require `expected`, copied from the last snapshot's six semantic fields (title, notes, start, end, allDay, timeZone). `link` accepts the same precondition optionally; sync callers should always supply it. `create` rejects expected and keeps marker-recovery no-op behavior. Missing/malformed expected fails `invalid_request` (bad ISO timestamps fail `invalid_date`). Empty titles are accepted in expected because existing EventKit events can have them. Null notes compare equal to empty notes; ISO timestamps compare by instant, independent of offset/fraction spelling. Time zone compares exact identifier or null. If lastModified is present, its instant/null must also match; if omitted it is ignored. Unsupported expected keys are rejected. A changed semantic field fails `event_conflict` before mutating the fetched event; take a fresh snapshot and reconcile, never blindly retry the old operation. Missing delete targets still succeed idempotently with alreadyMissing:true after schema validation.

All operations are resolved/validated before staging save/remove calls, then committed together. Patch validation uses scratch events, leaving fetched events clean. Immediately before staging each existing target, the bridge re-fetches and refreshes it and repeats precondition, calendar, task marker/URL and recurrence checks. A disappearing/moved target or changed task marker at this second check fails `event_conflict`. The link URL eligibility check is also repeated even for an initially idempotent link. EventKit exposes no atomic compare-and-swap: edits not yet delivered to the local store, or arriving between the final refresh and commit, cannot be completely excluded. A failed batch resets the in-memory EventKit store; EventKit/iCloud synchronization is not a distributed transaction. Reconcile a snapshot and retry by marker after ambiguous failures. Never consider a timed-out apply proof that nothing was written.

New timed events default to the machine's local IANA time zone; updates preserve the existing time zone unless supplied. Null timeZone explicitly requests a floating event. All-day start/end must be midnight in the event time zone (or local zone when floating). End is **exclusive** in the bridge protocol. On macOS, setting a nonnil EventKit timeZone clears isAllDay; setting isAllDay restores floating timeZone=nil and exposes an inclusive 23:59:59 end. Production patch validates requested midnights, assigns dates while timed, then assigns isAllDay last. Serialization converts inclusive all-day ends back to exclusive local midnight; all-day output timeZone remains null (use localTimeZone). This is EventKit's floating-date representation, not a retained explicit IANA zone. Output ISO times are UTC instants; use allDay and timeZone (or localTimeZone for null) for display, not UTC date substrings.

## Response schema

```ts
type Event = {
  id: string; externalId: string | null; taskId: string | null;
  title: string; notes: string | null;
  start: ISO8601; end: ISO8601; allDay: boolean;
  timeZone: string | null; lastModified: ISO8601 | null; recurring: boolean;
  linkable: boolean; // URL is nil or a recognized task marker; link still validates exact marker
};
type Calendar = {
  id: string; title: string; sourceId: string; writable: true; managed: boolean;
};
type Source = { id: string; title: string; type: 'calDAV'; writable: true };
type Status = {
  ok: true;
  authorization: 'notDetermined' | 'restricted' | 'denied' | 'writeOnly' | 'fullAccess' | 'unknown';
  authorized: boolean; // true only for fullAccess, including legacy authorized
  bundleIdentifier: 'com.ticklist.calendar-bridge';
  managedCalendarName: '日历清单'; localTimeZone: string;
  sources: Source[]; calendars: Calendar[];
};
type InitializeResult = { ok: true; calendar: Calendar };
type SnapshotResult = {
  ok: true; calendar: Calendar; start: ISO8601; end: ISO8601;
  events: Event[]; missingTrackedEventIDs: string[]; outOfCalendarTrackedEventIDs: string[];
};
type ApplyResult = {
  ok: true; calendar: Calendar;
  results: (
    | { op: 'create' | 'update' | 'recovered' | 'link'; taskId: string; event: Event }
    | { op: 'delete'; taskId: string; deleted: true; alreadyMissing: boolean }
  )[];
};
```

Response `sourceId`/`taskId`/`externalId` intentionally have lowercase `d`; requests use `calendarID`, `sourceID`, `trackedEventIDs`. Results retain input operation ordering, except retry-recovered create uses `op:'recovered'`. Snapshot events are start-time sorted. `externalId` is returned for reconciliation but is not accepted as an event mutation identifier.

## Explicit authorization (the only permission-request path)

Do this **only in direct response to the user's authorize action**, not on page load, status, initial installation, or tests:

```sh
open -n -W '/absolute/path/to/native/build.nosync/TicklistCalendarBridge.app' --args authorize --status-file '/absolute/path/to/new-result.json'
```

Choose a fresh result path in a host-owned temporary directory; do not read an old result. `authorize` is an app-mode command, not stdin RPC. `{ "command": "authorize" }` on stdin always fails `app_launch_required` without requesting access. The app validates its bundle identity and absolute output path, starts `NSApplication`, and calls `requestFullAccessToEvents` (macOS 14+) or legacy requestAccess (macOS 13) **only after applicationDidFinishLaunching**. Its asynchronous completion dispatches to the live main queue, writes the result atomically to the status file, and terminates. There is no semaphore/main-thread blocking and no stdout pipe dependency on LaunchServices. Result is Status plus `granted:boolean`, optionally `authorizationError:string`. Denial still yields `ok:true,authorized:false`; always inspect authorization. A file write failure reports stderr and exits 74. The caller should handle timeout/cancel and missing output without repeatedly prompting.

Do not claim authorization success merely because `open` succeeded. After completion inspect the file and refresh status using the exact same installed bundle. If system policy denies/restricts access, guide the user to macOS Privacy & Security → Calendars; never reset TCC or request a different application's permissions automatically.

## Verification on this machine

Built with Xcode Command Line Tools on macOS 26.6.2, arm64. The rebuilt .nosync app and a fresh temporary extraction of its signed ZIP passed strict ad-hoc signature verification. All **23 nonprompting tests pass**. The unchanged build script succeeded without retry for this fix. Three new scratch-event tests invoke production patch (not just preconditions): creation/repair from timed midnights, preserving all-day mode during title/date updates, and invalid-midnight rejection/timed-event preservation. They assert raw isAllDay=true, exact start, native floating timeZone=nil/effective Asia/Shanghai, inclusive native end, and the intended exclusive midnight through production eventJSON. The old production patch failed both create/repair cases with isAllDay=false; setting the flag last alone failed the exact end assertion. Scratch events are never assigned a calendar, saved or committed; no calendar queries or permission APIs are used in those regressions.

The original protocol/precondition/link tests remain, including full expected-field conflicts, retry/URL/recurrence guards and metadata preservation validation. New file-mode tests execute the actual packaged binary with JSON authorize/invalid/unknown requests (never the interactive CLI authorize command), exercising AppKit launch dispatch, no stdout requirement, private atomic response permissions, exact 4 MiB acceptance and oversize rejection, malformed payloads, request permission rejection, symlink/hardlink/directory/FIFO rejection, canonical/absolute/same-parent constraints, private parent mode, existing/dangling-symlink result protection and malformed CLI arguments. No installation, LaunchServices registration, permission request, calendar creation or event mutation was performed by these native tests. They intentionally do not launch the app through `open` or read live events.

The user has separately authorized the installed app through LaunchServices: its authorization result reports full access and sources. A direct DSH-spawned executable can still report `notDetermined` due to macOS responsible-process attribution; that does **not** establish a missing app grant. The installed Host must use LaunchServices file mode for status/snapshot/initialize/apply, not request authorization again. Actual installed LaunchServices identity and authorized read verification are the Host integration's responsibility. Mutation round trips, live concurrency/metadata preservation and designated test-calendar writes remain deliberately untested in this native-only change.

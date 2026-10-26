#!/usr/bin/env python3
"""Read-only protocol checks. Never launch authorize or submit a calendar mutation."""
import json
import pathlib
import os
import stat
import subprocess
import tempfile
import unittest

BINARY = pathlib.Path(__file__).resolve().parent / "build.nosync/TicklistCalendarBridge.app/Contents/MacOS/calendar-bridge"


def request(value):
    process = subprocess.run([str(BINARY)], input=json.dumps(value), text=True,
                             capture_output=True, timeout=15)
    return process.returncode, json.loads(process.stdout)


class ReadOnlyBridgeTests(unittest.TestCase):
    def test_status_is_readonly(self):
        code, status = request({"command": "status"})
        self.assertEqual(code, 0)
        self.assertTrue(status["ok"])
        self.assertIn(status["authorization"], ["notDetermined", "restricted", "denied", "writeOnly", "fullAccess", "unknown"])
        self.assertEqual(status["bundleIdentifier"], "com.ticklist.calendar-bridge")
        self.assertEqual(status["managedCalendarName"], "日历清单")
        if not status["authorized"]:
            self.assertEqual(status["sources"], [])
            self.assertEqual(status["calendars"], [])
        self.assertTrue(all(s["type"] == "calDAV" and s["writable"] for s in status["sources"]))
        self.assertTrue(all(c["writable"] for c in status["calendars"]))
        _, again = request({"command": "status"})
        self.assertEqual(again["authorization"], status["authorization"])

    def test_stdin_authorize_cannot_prompt(self):
        code, result = request({"command": "authorize"})
        self.assertNotEqual(code, 0)
        self.assertEqual(result["error"]["code"], "app_launch_required")

    def test_unknown_command(self):
        code, result = request({"command": "not-a-command"})
        self.assertNotEqual(code, 0)
        self.assertEqual(result["error"]["code"], "unknown_command")

    def test_invalid_request(self):
        code, result = request({})
        self.assertNotEqual(code, 0)
        self.assertEqual(result["error"]["code"], "invalid_request")

    def test_snapshot_requires_authorization_without_prompt(self):
        _, status = request({"command": "status"})
        if status["authorized"]:
            self.skipTest("No need to read real events on an authorized machine")
        code, result = request({"command": "snapshot", "calendarID": "not-a-real-calendar",
                                "start": "2026-10-01T00:00:00+08:00", "end": "2026-11-01T00:00:00+08:00",
                                "trackedEventIDs": []})
        self.assertNotEqual(code, 0)
        self.assertEqual(result["error"]["code"], "authorization_required")
        _, after = request({"command": "status"})
        self.assertEqual(after["authorization"], status["authorization"])


class PureLinkValidationTests(unittest.TestCase):
    """Production helpers plus unsaved scratch events; no authorization or calendar IO."""

    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="ticklist-link-tests-")
        root = pathlib.Path(cls.temp.name)
        source = pathlib.Path(__file__).with_name("CalendarBridge.swift").read_text()
        helpers = source.split("// AppKit owns the main-thread run loop;", 1)[0]
        harness = r'''
let data = FileHandle.standardInput.readDataToEndOfFile()
do {
    let input = try JSONSerialization.jsonObject(with: data) as! [String: Any]
    if input["mode"] as? String == "url" {
        let task = try string(input, "taskId")
        let url = (input["url"] as? String).flatMap { URL(string: $0) }
        let write = try linkNeedsWrite(url, recurring: input["recurring"] as? Bool ?? false, task: task)
        emit(["ok": true, "write": write])
    } else if input["mode"] as? String == "patch" {
        // Unsaved, unassigned scratch events only: no access request or calendar queries.
        let store = EKEventStore()
        let event = EKEvent(eventStore: store)
        if let initial = input["initial"] as? [String: Any] {
            try patch(event, initial, creating: true)
        }
        try patch(event, input["operation"] as! [String: Any], creating: input["initial"] == nil)
        emit(["ok": true, "allDay": event.isAllDay,
              "start": iso.string(from: event.startDate), "end": eventJSON(event)["end"]!,
              "rawEnd": iso.string(from: event.endDate),
              "timeZone": event.timeZone?.identifier as Any? ?? NSNull(),
              "effectiveTimeZone": (event.timeZone ?? .current).identifier])
    } else if input["mode"] as? String == "expected" {
        let precondition = try EventPrecondition(input["expected"] as! [String: Any])
        try precondition.check(EventPrecondition(input["current"] as! [String: Any], strict: false))
        emit(["ok": true])
    } else {
        let ops = try validateOperations(input)
        emit(["ok": true, "count": ops.count])
    }
} catch { emit(errorJSON(error)); exit(1) }
'''
        swift = root / "main.swift"
        swift.write_text(helpers + harness)
        cls.binary = root / "link-validation"
        subprocess.run(["/usr/bin/xcrun", "swiftc", "-swift-version", "5",
                        "-framework", "Foundation", "-framework", "EventKit", "-framework", "AppKit",
                        str(swift), "-o", str(cls.binary)], check=True, capture_output=True, text=True)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def check(self, value, error=None):
        process = subprocess.run([str(self.binary)], input=json.dumps(value), text=True,
                                 capture_output=True, timeout=15)
        result = json.loads(process.stdout)
        if error:
            self.assertEqual(process.returncode, 1)
            self.assertEqual(result["error"]["code"], error)
        else:
            self.assertEqual(process.returncode, 0, result)
            self.assertTrue(result["ok"])
        return result

    def test_nil_url_and_exact_marker(self):
        self.assertTrue(self.check({"mode": "url", "taskId": "phone-task"})["write"])
        self.assertFalse(self.check({"mode": "url", "taskId": "phone-task",
                                     "url": "ticklist-calendar://task/phone-task"})["write"])

    def test_preserve_user_url_and_reject_wrong_marker(self):
        for url in ["https://example.com/meeting", "ticklist-calendar://task/other",
                    "ticklist-calendar://task/phone-task?user=1",
                    "ticklist-calendar://task/phone-task#note",
                    "ticklist-calendar://user@task/phone-task"]:
            with self.subTest(url=url):
                self.check({"mode": "url", "taskId": "phone-task", "url": url}, "task_mismatch")

    def test_recurrence_rejected_even_for_matching_marker(self):
        for url in [None, "ticklist-calendar://task/phone-task"]:
            self.check({"mode": "url", "taskId": "phone-task", "url": url,
                        "recurring": True}, "recurring_unsupported")

    def test_link_fields_and_exact_calendar_required(self):
        op = {"op": "link", "id": "phone-event", "taskId": "phone-task"}
        self.check({"calendarID": "managed", "operations": [op]})
        for field in ["title", "notes", "start", "end", "allDay", "timeZone", "url", "recurrence"]:
            with self.subTest(field=field):
                self.check({"calendarID": "managed", "operations": [dict(op, **{field: None})]},
                           "unsupported_field")
        self.check({"initialize": True, "sourceID": "source", "operations": [op]}, "invalid_request")
        for field in ["id", "taskId"]:
            self.check({"calendarID": "managed", "operations": [dict(op, **{field: ""})]}, "invalid_request")

    def test_full_batch_validation_and_uniqueness(self):
        op = {"op": "link", "id": "phone-event", "taskId": "phone-task"}
        self.check({"calendarID": "managed", "operations": [op, dict(op, id="other")]}, "duplicate_task")
        self.check({"calendarID": "managed", "operations": [op, dict(op, taskId="other")]}, "duplicate_event")
        self.check({"calendarID": "managed", "operations": [op, {"op": "unknown", "taskId": "other"}]},
                   "invalid_request")
        self.check({"calendarID": "managed", "operations": [op, {"op": "update", "id": "other",
                                                               "taskId": "phone-task"}]}, "duplicate_task")
        self.check({"calendarID": "managed", "operations": [op] * 501}, "invalid_request")


    def test_patch_all_day_create_and_repair_scratch_event(self):
        operation = {"title": "Scratch all-day", "start": "2026-10-24T00:00:00+08:00",
                     "end": "2026-10-25T00:00:00+08:00", "allDay": True,
                     "timeZone": "Asia/Shanghai"}
        for initial in [None, dict(operation, allDay=False)]:
            with self.subTest(initial=initial):
                result = self.check({"mode": "patch", "operation": operation, "initial": initial})
                self.assertIs(result["allDay"], True)
                self.assertEqual(result["start"], "2026-10-23T16:00:00.000Z")
                self.assertEqual(result["end"], "2026-10-24T16:00:00.000Z")
                self.assertIsNone(result["timeZone"])  # EventKit all-day events are floating.
                self.assertEqual(result["effectiveTimeZone"], "Asia/Shanghai")
                self.assertEqual(result["rawEnd"], "2026-10-24T15:59:59.000Z")

    def test_patch_all_day_updates_preserve_flag_and_exclusive_end(self):
        initial = {"title": "Scratch", "start": "2026-10-24T00:00:00+08:00",
                   "end": "2026-10-25T00:00:00+08:00", "allDay": True,
                   "timeZone": "Asia/Shanghai"}
        for operation in [{"title": "Renamed"}, {"end": "2026-10-26T00:00:00+08:00"}]:
            result = self.check({"mode": "patch", "initial": initial, "operation": operation})
            self.assertIs(result["allDay"], True)
            self.assertEqual(result["start"], "2026-10-23T16:00:00.000Z")
            self.assertEqual(result["end"], "2026-10-25T16:00:00.000Z" if "end" in operation
                             else "2026-10-24T16:00:00.000Z")

    def test_patch_all_day_midnight_guard_and_timed_events(self):
        operation = {"title": "Scratch", "start": "2026-10-24T01:00:00+08:00",
                     "end": "2026-10-25T00:00:00+08:00", "allDay": True,
                     "timeZone": "Asia/Shanghai"}
        self.check({"mode": "patch", "operation": operation}, "invalid_all_day")
        result = self.check({"mode": "patch", "operation": dict(operation, allDay=False)})
        self.assertIs(result["allDay"], False)
        self.assertEqual(result["start"], "2026-10-23T17:00:00.000Z")
        self.assertEqual(result["end"], "2026-10-24T16:00:00.000Z")
        self.assertEqual(result["timeZone"], "Asia/Shanghai")

    def event(self):
        return {"title": "Phone event", "notes": None, "start": "2026-10-24T08:00:00.000Z",
                "end": "2026-10-24T09:00:00.000Z", "allDay": False, "timeZone": "Asia/Shanghai"}

    def test_required_preconditions_and_create_exclusion(self):
        for kind in ["update", "delete"]:
            op = {"op": kind, "id": "event", "taskId": "task"}
            self.check({"operations": [op]}, "invalid_request")
            self.check({"operations": [dict(op, expected=None)]}, "invalid_request")
            self.check({"operations": [dict(op, expected=self.event())]})
            for key in self.event():
                partial = self.event(); del partial[key]
                self.check({"operations": [dict(op, expected=partial)]}, "invalid_request")
        self.check({"calendarID": "managed", "operations": [{"op": "link", "id": "event",
                    "taskId": "task", "expected": self.event()}]})
        self.check({"operations": [{"op": "create", "taskId": "task", "expected": self.event()}]},
                   "unsupported_field")

    def test_changed_semantic_fields_rejected(self):
        changes = {"title": "Phone edit", "notes": "new note", "start": "2026-10-24T08:01:00Z",
                   "end": "2026-10-24T09:01:00Z", "allDay": True, "timeZone": None}
        for key, value in changes.items():
            with self.subTest(field=key):
                self.check({"mode": "expected", "expected": self.event(),
                            "current": dict(self.event(), **{key: value})}, "event_conflict")

    def test_equivalent_instants_null_notes_and_preserved_metadata(self):
        current = dict(self.event(), notes="", start="2026-10-24T16:00:00+08:00",
                       end="2026-10-24T17:00:00+08:00", url="https://example.com/keep",
                       alarms=[{"relativeOffset": -600}], recurrence=None, location="Keep")
        self.check({"mode": "expected", "expected": self.event(), "current": current})
        current["lastModified"] = "2026-10-24T10:00:00Z"
        self.check({"mode": "expected", "expected": self.event(), "current": current})
        expected = dict(self.event(), lastModified="2026-10-24T18:00:00.000+08:00")
        self.check({"mode": "expected", "expected": expected, "current": current})
        for value in [None, "2026-10-24T10:00:01Z"]:
            self.check({"mode": "expected", "expected": dict(expected, lastModified=value),
                        "current": current}, "event_conflict")
        self.check({"mode": "expected", "expected": dict(self.event(), lastModified=None),
                    "current": dict(current, lastModified=None)})

    def test_malformed_preconditions_rejected(self):
        for key, value in [("allDay", 0), ("notes", 3), ("title", None), ("timeZone", 3),
                           ("lastModified", 3), ("unknown", "field")]:
            self.check({"operations": [{"op": "update", "id": "event", "taskId": "task",
                        "expected": dict(self.event(), **{key: value})}]}, "invalid_request")
        self.check({"operations": [{"op": "delete", "id": "event", "taskId": "task",
                    "expected": dict(self.event(), start="not-a-date")}]}, "invalid_date")


class FileTransportTests(unittest.TestCase):
    """Run packaged executable without LS installation; only invalid/authorize JSON.

    JSON authorize rejection is not the interactive CLI authorize command. These
    tests never request permission, construct an EventKit store or read calendars.
    LaunchServices/responsible-process attribution is an integration check for the lead.
    """
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="ticklist-ipc-tests-")
        self.root = pathlib.Path(self.temp.name).resolve()
        self.root.chmod(0o700)
        self.request = self.root / "request.json"
        self.result = self.root / "result.json"
        self.request.write_text('{"command":"authorize"}')
        self.request.chmod(0o600)

    def tearDown(self):
        self.temp.cleanup()

    def run_file(self, request=None, result=None):
        return subprocess.run([str(BINARY), "run", "--request-file", str(request or self.request),
                               "--result-file", str(result or self.result)],
                              capture_output=True, text=True, timeout=15)

    def response(self, error):
        process = self.run_file()
        self.assertEqual(process.returncode, 1, process.stderr)
        self.assertEqual(process.stdout, "")
        value = json.loads(self.result.read_text())
        self.assertEqual(value["error"]["code"], error)
        self.assertEqual(stat.S_IMODE(self.result.stat().st_mode), 0o600)
        self.assertEqual(self.result.stat().st_uid, os.getuid())
        self.assertEqual(self.result.stat().st_nlink, 1)
        self.assertFalse(list(self.root.glob(".response-*")))

    def test_file_json_authorize_cannot_prompt(self):
        self.response("app_launch_required")

    def test_dispatcher_invalid_unknown_and_malformed(self):
        for payload, error in [('{}', 'invalid_request'), ('[]', 'invalid_request'),
                               ('{"command":"unknown"}', 'unknown_command'),
                               ('{broken', 'eventkit_error')]:
            with self.subTest(payload=payload):
                self.request.write_text(payload)
                self.response(error)
                self.result.unlink()

    def test_size_limit(self):
        self.request.write_bytes(b' ' * (4 * 1024 * 1024 + 1))
        self.response("invalid_request")
        self.result.unlink()
        payload = b'{"command":"authorize"}'
        self.request.write_bytes(payload + b' ' * (4 * 1024 * 1024 - len(payload)))
        self.response("app_launch_required")

    def test_request_permissions_symlinks_hardlinks_and_types(self):
        for mode in [0o644, 0o666, 0o400, 0o1600]:
            with self.subTest(mode=oct(mode)):
                self.request.chmod(mode)
                self.response("invalid_transport")
                self.result.unlink()
        self.request.chmod(0o600)
        alias = self.root / "alias.json"
        alias.symlink_to(self.request)
        process = self.run_file(request=alias)
        self.assertEqual(process.returncode, 1)
        self.assertEqual(json.loads(self.result.read_text())["error"]["code"], "invalid_transport")
        self.result.unlink()
        alias.unlink()
        os.link(self.request, alias)
        self.response("invalid_transport")
        self.result.unlink()
        alias.unlink()
        self.request.unlink()
        self.request.mkdir(mode=0o600)
        self.response("invalid_transport")
        self.request.rmdir()
        self.result.unlink()
        os.mkfifo(self.request, 0o600)
        self.response("invalid_transport")

    def test_reject_unsafe_parent_paths_and_existing_results(self):
        for mode in [0o755, 0o770]:
            self.root.chmod(mode)
            self.assertEqual(self.run_file().returncode, 2)
            self.assertFalse(self.result.exists())
        self.root.chmod(0o700)
        self.assertEqual(self.run_file(request="relative.json").returncode, 2)
        self.assertEqual(self.run_file(result=self.root.parent / "other.json").returncode, 2)
        self.assertEqual(self.run_file(result=self.request).returncode, 2)
        self.assertEqual(self.run_file(request=str(self.root) + "/../" + self.root.name + "/request.json").returncode, 2)
        self.result.write_text("do not overwrite")
        self.assertEqual(self.run_file().returncode, 2)
        self.assertEqual(self.result.read_text(), "do not overwrite")
        self.result.unlink()
        self.result.symlink_to(self.request)
        self.assertEqual(self.run_file().returncode, 2)
        self.assertEqual(self.request.read_text(), '{"command":"authorize"}')

    def test_parent_symlink_and_cli_argument_validation(self):
        alias = self.root / "alias"
        private = self.root / "private"
        private.mkdir(mode=0o700)
        alias.symlink_to(private, target_is_directory=True)
        self.assertEqual(self.run_file(request=alias / "request", result=alias / "result").returncode, 2)
        for args in [["run"], ["run", "--request-file", str(self.request)],
                     ["run", "--wrong", str(self.request), "--result-file", str(self.result)]]:
            process = subprocess.run([str(BINARY), *args], capture_output=True, timeout=15)
            self.assertEqual(process.returncode, 2)
            self.assertFalse(self.result.exists())


if __name__ == "__main__":
    unittest.main()

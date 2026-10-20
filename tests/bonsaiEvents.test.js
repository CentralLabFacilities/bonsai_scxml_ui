import assert from "node:assert/strict";
import test from "node:test";
import { applyWebCommanderEvent, subscribeWebCommanderEvents } from "../src/utils/webCommander.js";

let sources;
let originalWindow;
class EventSourceFixture {
    constructor(url) { this.url = url; this.closed = false; sources.push(this); }
    close() { this.closed = true; }
    open() { this.onopen?.(); }
    message(value) { this.onmessage?.({ data: typeof value === "string" ? value : JSON.stringify(value) }); }
    fail() { this.onerror?.(); }
}

test.beforeEach(() => {
    sources = [];
    originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: { EventSource: EventSourceFixture } });
});
test.afterEach(() => {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else delete globalThis.window;
});

test("browser events subscribe to the same-origin streaming proxy and resolve before execution", async () => {
    const controller = new AbortController();
    const events = [];
    const errors = [];
    let connected = false;
    const subscription = subscribeWebCommanderEvents({ onEvent: (event) => events.push(event),
        onError: (error) => errors.push(error), signal: controller.signal }).then(() => { connected = true; });
    assert.equal(sources[0].url, "/api/bonsai/events");
    assert.equal(connected, false);
    sources[0].open();
    await Promise.resolve();
    assert.equal(connected, false, "HTTP readiness alone does not prove server-side subscription readiness");
    sources[0].message({ type: "snapshot", states: ["Work"], details: { status: "RUNNING" } });
    await subscription;
    assert.equal(connected, true);
    assert.deepEqual(events, [{ type: "snapshot", states: ["Work"], details: { status: "RUNNING" } }]);
    controller.abort();
    assert.equal(sources[0].closed, true);
    sources[0].message({ type: "terminal" });
    assert.equal(events.length, 1);
    assert.deepEqual(errors, []);
});

test("failed connections reject without starting a stream and clean up their source", async () => {
    const subscription = subscribeWebCommanderEvents({ onEvent() {}, onError() {} });
    const rejected = assert.rejects(subscription, /event stream disconnected/);
    sources[0].fail(); await rejected;
    assert.equal(sources[0].closed, true);
});

test("disconnection is reported after connection rather than silently losing runtime events", async () => {
    const errors = [];
    const subscription = subscribeWebCommanderEvents({ onEvent() {}, onError: (error) => errors.push(error) });
    sources[0].open(); sources[0].message({ type: "snapshot" }); await subscription;
    sources[0].fail();
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /event stream disconnected/);
    assert.equal(sources[0].closed, true);
});

test("aborting a pending connection rejects promptly and fences queued callbacks", async () => {
    const controller = new AbortController();
    const events = [];
    const subscription = subscribeWebCommanderEvents({ onEvent: (event) => events.push(event), onError() {}, signal: controller.signal });
    const source = sources[0];
    const stale = source.onmessage;
    const rejected = assert.rejects(subscription, { name: "AbortError" });
    controller.abort(); await rejected;
    source.open(); stale({ data: '{"type":"state_entered"}' });
    assert.equal(source.closed, true);
    assert.deepEqual(events, []);
    await assert.rejects(subscribeWebCommanderEvents({ onEvent() {}, onError() {}, signal: controller.signal }), { name: "AbortError" });
    assert.equal(sources.length, 1);
});

test("invalid JSON and missing event types report protocol errors without publishing a runtime update", async () => {
    const controller = new AbortController();
    const events = [];
    const errors = [];
    const subscription = subscribeWebCommanderEvents({ onEvent: (event) => events.push(event),
        onError: (error) => errors.push(error), signal: controller.signal });
    sources[0].open(); sources[0].message({ type: "snapshot" }); await subscription;
    events.length = 0;
    for (const data of ["not JSON", "null", "{}", '{"type":1}']) sources[0].message(data);
    assert.equal(errors.length, 4);
    assert.ok(errors.every((error) => /Could not read a Bonsai runtime event/.test(error.message)));
    assert.deepEqual(events, []);
    controller.abort();
});

test("snapshots update reported state/status/datamodel without touching editor data or menu metadata", () => {
    const previous = Object.freeze({ status: "INITIALIZED", currentStates: Object.freeze([]),
        stateIds: Object.freeze(["Work", "Done"]), transitions: Object.freeze(["Work.success"]) });
    const datamodel = { global: { count: 0, enabled: false, name: "", result: null }, child: { value: [1, 2] } };
    const event = Object.freeze({ type: "snapshot", timestamp: "2026-10-11T16:00:00Z",
        details: Object.freeze({ status: "RUNNING" }), states: Object.freeze(["Work", "Work"]), datamodel });
    const next = applyWebCommanderEvent(previous, event);
    assert.deepEqual(next.currentStates, ["Work"]);
    assert.equal(next.status, "RUNNING");
    assert.equal(next.datamodel, datamodel);
    assert.equal(next.stateIds, previous.stateIds);
    assert.equal(next.transitions, previous.transitions);
    assert.deepEqual(next.runtimeEvents, [event]);
    assert.deepEqual(previous.currentStates, []);
    assert.equal(previous.runtimeEvents, undefined);
    assert.equal(next.statusStale, false);
    assert.equal(next.detailsUnavailable, false);
});

test("every runtime event family retains its original payload and uses authoritative envelope fields", () => {
    let snapshot = applyWebCommanderEvent(null, { type: "snapshot", details: { status: "RUNNING" }, states: ["Work"] });
    for (const type of ["state_entered", "state_exited", "transition", "datamodel_assignment",
        "slot_written", "slot_cleared", "parameter_assignment", "send_requested", "new_backend_event"]) {
        const event = { type, details: { backendField: type, evaluatedValue: { count: 7 } },
            states: ["Done"], datamodel: { global: { count: 7 } } };
        snapshot = applyWebCommanderEvent(snapshot, event);
        assert.equal(snapshot.runtimeEvents.at(-1), event);
        assert.deepEqual(snapshot.currentStates, ["Done"]);
        assert.equal(snapshot.datamodel, event.datamodel);
        assert.equal(snapshot.lastTransition, undefined, "unverified details must not fabricate an executed edge");
        assert.equal(snapshot.runtimeParameterValues, undefined, "unverified details must not fabricate parameter bindings");
    }
    const send = { type: "send_requested", details: { event: "Work.success" } };
    const sent = applyWebCommanderEvent(snapshot, send);
    assert.equal(sent.currentStates, snapshot.currentStates, "requests are not proof of entering/exiting a state");
    assert.equal(sent.datamodel, snapshot.datamodel);
});

test("status events and lifecycle events never invent engine status enums", () => {
    const running = applyWebCommanderEvent(null, { type: "snapshot", details: { status: "RUNNING" }, states: ["Work"] });
    const paused = applyWebCommanderEvent(running, { type: "status", data: { value: "PAUSED" } });
    assert.equal(paused.status, "PAUSED");
    const stopped = applyWebCommanderEvent(paused, { type: "stopped", states: [] });
    assert.equal(stopped.status, "PAUSED", "control status is subsequently checked through /status");
    assert.deepEqual(stopped.currentStates, []);
    const terminal = applyWebCommanderEvent(stopped, { type: "terminal", details: { outcome: "success" } });
    assert.equal(terminal.status, "PAUSED");
});

test("event history is bounded to the most recent 100 records", () => {
    let snapshot;
    for (let index = 0; index < 125; index += 1) {
        snapshot = applyWebCommanderEvent(snapshot, { type: "send_requested", details: { index } });
    }
    assert.equal(snapshot.runtimeEvents.length, 100);
    assert.equal(snapshot.runtimeEventCount, 125);
    assert.equal(snapshot.runtimeEvents[0].details.index, 25);
    assert.equal(snapshot.runtimeEvents.at(-1).details.index, 124);
});

test("malformed reported states, datamodel and statuses cannot create a valid live snapshot", () => {
    for (const event of [null, {}, { type: "" }, { type: "snapshot", status: "RUNNING" },
        { type: "status", data: { value: "STOPPED" } }, { type: "state_entered", states: [1] },
        { type: "state_exited", states: "Work" }, { type: "datamodel_assignment", datamodel: null },
        { type: "datamodel_assignment", datamodel: [] }]) {
        assert.throws(() => applyWebCommanderEvent(null, event));
    }
});

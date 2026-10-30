import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { act, createElement, StrictMode, useLayoutEffect } from "react";
import { Window } from "happy-dom";
import { applyWebCommanderEvent } from "../src/utils/webCommander.js";
import { captureRuntimeSnapshot } from "../src/utils/runtimeSnapshots.js";
import { useRuntimeSnapshots } from "../src/hooks/editor/useRuntimeSnapshots.js";

// All 69 fixture records are the user's capture, not observations made by this test.
const suppliedTrace = readFileSync(new URL("./fixtures/bonsai-events.jsonl", import.meta.url), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line));
// The pre-run UI snapshot and additional edge cases below are synthetic inputs.
const initialSnapshot = { type: "snapshot", timestamp: "2026-10-11T15:46:34.000Z",
    details: { status: "INITIALIZED" }, states: [], datamodel: { global: { test_val: "1" } } };
const events = [initialSnapshot, ...suppliedTrace];
const visitOrder = ["slots.SlotIO#A", "slots.SlotIO#B", "CompareSlots#AB", "s1",
    "slots.SlotIO#s1", "slots.SlotIO#1#s1", "slots.SlotIO#2#s1", "s2#s1",
    "slots.SlotIO#s2#s1", "slots.SlotIO#1#s2#s1", "slots.SlotIO#2#s2#s1", "Nop#s2#s1",
    "Nop#s1", "CompareSlots#AB2", "CompareSlots#BC", "CompareSlots#CD", "CompareData"];
const entries = events.map((event, index) => ({ event, index })).filter(({ event }) => event.type === "state_entered");
const expectedConfigurations = [["slots.SlotIO#A"], ["slots.SlotIO#B"], ["CompareSlots#AB"], ["s1"],
    ["s1", "slots.SlotIO#s1"], ["s1", "slots.SlotIO#1#s1"], ["s1", "slots.SlotIO#2#s1"], ["s1", "s2#s1"],
    ["s1", "s2#s1", "slots.SlotIO#s2#s1"], ["s1", "s2#s1", "slots.SlotIO#1#s2#s1"],
    ["s1", "s2#s1", "slots.SlotIO#2#s2#s1"], ["s1", "s2#s1", "Nop#s2#s1"], ["s1", "Nop#s1"],
    ["CompareSlots#AB2"], ["CompareSlots#BC"], ["CompareSlots#CD"], ["CompareData"]];

function captureTrace() {
    let source;
    let frame;
    return events.map((event) => {
        const previousSource = source;
        source = applyWebCommanderEvent(source, event);
        frame = captureRuntimeSnapshot(frame, source, event,
            event.datamodel !== undefined || source.datamodel !== previousSource?.datamodel);
        return frame;
    });
}

const window = new Window({ url: "http://localhost/" });
const originals = new Map();
const workflow = Object.freeze({ id: "root", documentGeneration: 1, title: "Supplied Bonsai event trace",
    nodes: Object.freeze([]), fingerprint: "supplied-trace" });
const tabsSnapshot = Object.freeze([workflow]);
let createRoot;
let root;
let container;
let controller;
let source;
let timers;
let nextTimer;
let elapsed;
let networkCalls;

function Harness() {
    const result = useRuntimeSnapshots();
    useLayoutEffect(() => { controller = result; });
    return null;
}
const mount = async () => act(async () => root.render(createElement(StrictMode, null, createElement(Harness))));
const receive = (event) => {
    source = applyWebCommanderEvent(source, event);
    controller.recordExecutionUpdate({ workflow, tabsSnapshot, snapshot: source, runtimeEvent: event,
        following: !["stopped", "terminal"].includes(event.type) });
};
const record = async (trace = suppliedTrace) => act(async () => {
    controller.recordExecutionUpdate({ action: "record_start", workflow, tabsSnapshot, snapshot: null,
        following: false, followCamera: true });
    receive(initialSnapshot);
    trace.forEach(receive);
});
const advance = async (milliseconds) => act(async () => {
    elapsed += milliseconds;
    const due = [...timers.entries()].filter(([, timer]) => timer.dueAt <= elapsed);
    for (const [id, timer] of due) {
        timers.delete(id);
        timer.callback();
    }
});
const shown = () => controller.displayExecution?.snapshot.currentStates || [];

test.before(async () => {
    for (const [key, value] of Object.entries({ window, document: window.document,
        navigator: window.navigator, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
        fetch: (...args) => { networkCalls.push(args); throw new Error("Trace playback must not contact the live machine."); } })) {
        originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
        Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    ({ createRoot } = await import("react-dom/client"));
});
test.beforeEach(() => {
    controller = null; source = null; elapsed = 0; nextTimer = 0; networkCalls = []; timers = new Map();
    window.setTimeout = (callback, delay) => {
        const id = ++nextTimer;
        timers.set(id, { callback, delay, dueAt: elapsed + delay });
        return id;
    };
    window.clearTimeout = (id) => timers.delete(id);
    container = window.document.createElement("div"); window.document.body.append(container);
    root = createRoot(container);
});
test.afterEach(async () => {
    await act(async () => root.unmount());
    assert.equal(timers.size, 0, "owned display timers must be cancelled");
    assert.deepEqual(networkCalls, [], "recording, seeking and replay issue no REST polls or engine commands");
    container.remove();
    await window.happyDOM.cancelAsync();
});
test.after(async () => {
    await window.happyDOM.close();
    for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
    }
});

test("complete supplied protocol trace retains its 17 visits within the original 151ms burst", () => {
    assert.equal(suppliedTrace.length, 69);
    assert.ok(suppliedTrace.every((event) => Object.hasOwn(event, "data") && !Object.hasOwn(event, "details")
        && !Object.hasOwn(event, "states") && !Object.hasOwn(event, "datamodel")));
    assert.deepEqual(entries.map(({ event }) => event.data.state), visitOrder);
    assert.equal(Date.parse(entries.at(-1).event.timestamp) - Date.parse(entries[0].event.timestamp), 151);
    assert.deepEqual(suppliedTrace.filter((event) => event.type === "status").map((event) => event.data.value),
        ["LOADING", "INITIALIZED_BUT_WARNINGS", "RUNNING", "INITIALIZED_BUT_WARNINGS"]);
    assert.equal(suppliedTrace.at(-2).type, "stopped");
    assert.deepEqual(suppliedTrace.at(-2).data, {});
    assert.equal(suppliedTrace.at(-1).timestamp, "2026-10-11T15:47:02.892335168Z");
    assert.equal(suppliedTrace.filter((event) => event.type === "parameter").length, 5);
    assert.equal(suppliedTrace.some((event) => event.type === "parameter_assignment"), false);
});

test("root data reconstructs the active state Set, keeps containers, and never activates transition or send targets", () => {
    let snapshot = applyWebCommanderEvent(null, initialSnapshot);
    const active = new Set();
    const visited = [];
    assert.equal(snapshot.status, "INITIALIZED");
    assert.equal(snapshot.datamodel.global.test_val, "1");
    for (const event of suppliedTrace) {
        const previous = snapshot;
        snapshot = applyWebCommanderEvent(snapshot, event);
        if (event.type === "state_entered") { active.add(event.data.state); visited.push(event.data.state); }
        if (event.type === "state_exited") active.delete(event.data.state);
        if (event.type === "stopped") {
            active.clear();
            assert.equal(snapshot.status, previous.status, "stopped is not a backend status enum");
        }
        if (event.type === "status") assert.equal(snapshot.status, event.data.value);
        if (["transition", "send_requested"].includes(event.type)) {
            assert.deepEqual(snapshot.currentStates, previous.currentStates, "only a state_entered event activates its target");
        }
        assert.deepEqual(new Set(snapshot.currentStates), active, `${event.type} at ${event.timestamp}`);
        assert.equal(snapshot.currentStates.length, active.size, "state configuration is a Set, not an append-only visit list");
        assert.equal(snapshot.runtimeEvents.at(-1), event, "preserve the exact wire record and its expressions");
    }
    assert.deepEqual(visited, visitOrder);
    assert.equal(snapshot.status, "INITIALIZED_BUT_WARNINGS");
    assert.deepEqual(snapshot.currentStates, []);

    const frames = captureTrace();
    entries.forEach(({ index }, visit) => assert.deepEqual(frames[index].currentStates, expectedConfigurations[visit]));
    const leafExit = frames.find((frame) => frame.event.type === "state_exited" && frame.event.data.state === "slots.SlotIO#s1");
    assert.deepEqual(leafExit.currentStates, ["s1"], "exiting a leaf does not deactivate its container");
    const nestedExit = frames.find((frame) => frame.event.type === "state_exited" && frame.event.data.state === "slots.SlotIO#s2#s1");
    assert.deepEqual(nestedExit.currentStates, ["s1", "s2#s1"]);
});

test("duplicate entry is idempotent and suffixed identities do not invent unreported parent states", () => {
    let snapshot = applyWebCommanderEvent(null, initialSnapshot);
    const entered = { type: "state_entered", data: { state: "slots.SlotIO#s2#s1" } };
    snapshot = applyWebCommanderEvent(applyWebCommanderEvent(snapshot, entered), entered);
    assert.deepEqual(snapshot.currentStates, ["slots.SlotIO#s2#s1"]);
    for (const event of [{ type: "state_exited", data: { state: "NeverEntered" } },
        { type: "transition", data: { source: "slots.SlotIO#s2#s1", target: "NeverEntered", event: "SlotIO.success" } },
        { type: "send_requested", data: { target: "NeverEntered", event: "NeverEntered.success" } }]) {
        snapshot = applyWebCommanderEvent(snapshot, event);
        assert.deepEqual(snapshot.currentStates, ["slots.SlotIO#s2#s1"]);
    }
});

test("provided assignments retain literal strings, exact global locations, slot overwrite and real parameter metadata", () => {
    let snapshot = applyWebCommanderEvent(null, initialSnapshot);
    let firstSlotSnapshot;
    for (const event of suppliedTrace) {
        const previous = snapshot;
        snapshot = applyWebCommanderEvent(snapshot, event);
        if (event.type === "datamodel_assignment") {
            assert.equal(snapshot.datamodel.global[event.data.location], event.data.value);
            assert.notEqual(snapshot.datamodel, previous.datamodel, "assignment must not mutate earlier source snapshots");
            assert.equal(previous.datamodel.global.test_val, event.data.location === "test_val" ? "1" : "test_val - 1");
            assert.deepEqual(snapshot.runtimeEvents.at(-1).data, event.data);
        }
        if (event.type === "slot_written") {
            assert.deepEqual(snapshot.slotValues[event.data.slot], { value: event.data.value, dataType: "java.lang.String",
                timestamp: event.timestamp, cleared: false });
            if (!firstSlotSnapshot) firstSlotSnapshot = snapshot;
        }
        if (event.type === "parameter") {
            assert.deepEqual(snapshot.parameterValues[event.data.state][event.data.name], { value: event.data.value,
                expression: event.data.expression, source: null, timestamp: event.timestamp, state: event.data.state });
        }
    }
    assert.deepEqual(snapshot.datamodel.global, { test_val: "test_val - 1", test_val_s1: "test_val - 1", test_val_s2_s1: "test_val - 1" });
    assert.deepEqual(Object.keys(snapshot.slotValues).sort(), ["/A#test", "/B", "/C#s1", "/D#s2#s1"]);
    assert.equal(snapshot.slotValues["/A#test"].value, "intermediate");
    assert.equal(firstSlotSnapshot.slotValues["/A#test"].value, "1");
    assert.deepEqual(Object.keys(snapshot.parameterValues).sort(),
        suppliedTrace.filter((event) => event.type === "parameter").map((event) => event.data.state).sort());

    const base = applyWebCommanderEvent(null, { ...initialSnapshot,
        datamodel: { global: { test_val: "1", test_val_s1: "untouched" }, child: { sentinel: false } } });
    for (const value of ["test_val - 1", "", 0, false, null, { nested: ["raw", 1] }]) {
        const assignment = { type: "datamodel_assignment", data: { sourceState: "leaf#s2#s1", location: "test_val",
            expression: "'test_val - 1'", value } };
        const next = applyWebCommanderEvent(base, assignment);
        assert.deepEqual(next.datamodel, { global: { test_val: value, test_val_s1: "untouched" }, child: { sentinel: false } });
        assert.equal(next.runtimeEvents.at(-1).data.expression, "'test_val - 1'");
    }
    assert.equal(base.datamodel.global.test_val, "1");
});

test("pure capture preserves as-of-frame values and assignment timestamps through the complete trace", () => {
    const frames = captureTrace();
    const aEntry = frames[entries[0].index];
    const firstWrite = frames.find((frame) => frame.event.type === "slot_written" && frame.event.data.value === "1");
    const overwrite = frames.find((frame) => frame.event.type === "slot_written" && frame.event.data.value === "intermediate");
    const bAssignment = frames.find((frame) => frame.event.type === "datamodel_assignment" && frame.event.data.location === "test_val");
    assert.equal(aEntry.parameterValues?.["slots.SlotIO#A"], undefined, "entry precedes parameter evaluation");
    assert.equal(aEntry.slotValues?.["/A#test"], undefined, "entry precedes the slot write");
    assert.equal(aEntry.datamodel.global.test_val, "1");
    assert.equal(firstWrite.slotValues["/A#test"].value, "1");
    assert.equal(firstWrite.parameterValues["slots.SlotIO#A"]["#_WRITE"].expression, "@test_val");
    assert.equal(overwrite.slotValues["/A#test"].value, "intermediate");
    assert.equal(overwrite.parameterValues["slots.SlotIO#s1"]["#_WRITE"].value, "intermediate");
    assert.deepEqual(bAssignment.variableMeta[JSON.stringify(["global", "test_val"])],
        { timestamp: bAssignment.event.timestamp, changed: true });
    assert.deepEqual(frames[0].variableMeta[JSON.stringify(["global", "test_val"])],
        { timestamp: initialSnapshot.timestamp, changed: false });
    assert.equal(frames.at(-1).datamodelTimestamp,
        suppliedTrace.find((event) => event.type === "datamodel_assignment" && event.data.location === "test_val_s2_s1").timestamp);
    assert.equal(frames.at(-1).slotValues["/A#test"].value, "intermediate");
    assert.equal(frames.at(-1).parameterValues["slots.SlotIO#2#s2#s1"]["#_WRITE"].expression, "@test_val_s2_s1");
    assert.deepEqual(frames.at(-1).slotAssignments.map((event) => event.data),
        suppliedTrace.filter((event) => event.type === "slot_written").map((event) => event.data));
});

test("capture isolates mutable slot and parameter payloads, later overwrites, raw falsy values and slot clears", () => {
    const value = { items: [{ label: "received" }] };
    const slot = { type: "slot_written", timestamp: "2026-10-11T15:46:43.000Z",
        data: { slot: "/A#test", dataType: "fixture.Object", value } };
    const parameter = { type: "parameter", timestamp: "2026-10-11T15:46:43.001Z",
        data: { state: "slots.SlotIO#A", name: "#_WRITE", expression: "@test_val", source: null, value } };
    let snapshot = applyWebCommanderEvent(applyWebCommanderEvent(null, initialSnapshot), slot);
    const written = captureRuntimeSnapshot(null, snapshot, slot);
    snapshot = applyWebCommanderEvent(snapshot, parameter);
    const bound = captureRuntimeSnapshot(written, snapshot, parameter, false);
    value.items[0].label = "mutated after receipt";
    parameter.data.expression = "mutated expression";
    assert.deepEqual(written.slotValues["/A#test"].value, { items: [{ label: "received" }] });
    assert.deepEqual(bound.parameterValues["slots.SlotIO#A"]["#_WRITE"].value, { items: [{ label: "received" }] });
    assert.equal(bound.parameterValues["slots.SlotIO#A"]["#_WRITE"].expression, "@test_val");
    assert.equal(bound.event.data.expression, "@test_val");
    for (const raw of [false, 0, "", null]) {
        const nextSlot = { ...slot, data: { ...slot.data, value: raw } };
        const nextParameter = { ...parameter, data: { ...parameter.data, expression: "@test_val", value: raw } };
        snapshot = applyWebCommanderEvent(applyWebCommanderEvent(snapshot, nextSlot), nextParameter);
        const next = captureRuntimeSnapshot(bound, snapshot, nextParameter, false);
        assert.equal(next.slotValues["/A#test"].value, raw);
        assert.equal(next.parameterValues["slots.SlotIO#A"]["#_WRITE"].value, raw);
    }
    const clear = { type: "slot_cleared", timestamp: "2026-10-11T15:46:43.002Z", data: { slot: "/A#test" } };
    snapshot = applyWebCommanderEvent(snapshot, clear);
    const cleared = captureRuntimeSnapshot(bound, snapshot, clear, false);
    assert.equal(cleared.slotValues["/A#test"].cleared, true);
    assert.equal(Object.hasOwn(cleared.slotValues["/A#test"], "value"), false);
    assert.equal(cleared.slotValues["/A#test"].timestamp, clear.timestamp);
    assert.deepEqual(written.slotValues["/A#test"].value, { items: [{ label: "received" }] });
    assert.deepEqual(bound.parameterValues["slots.SlotIO#A"]["#_WRITE"].value, { items: [{ label: "received" }] });
    assert.equal(bound.slotValues["/A#test"].cleared, false);
});

test("one React batch synchronously caches INITIALIZED, RUNNING, every enter/exit and every assignment for seeking", async () => {
    await mount(); await record();
    assert.equal(controller.playback.stepCount, events.length, "no event may collapse into the final CompareData snapshot");
    assert.deepEqual(shown(), ["slots.SlotIO#A"]);
    assert.equal(controller.latestSnapshot.status, "INITIALIZED_BUT_WARNINGS");
    assert.equal(controller.latestSnapshot.slotValues["/A#test"].value, "intermediate");
    const expected = captureTrace();
    for (let index = 0; index < events.length; index += 1) {
        await act(async () => controller.seek(index));
        const selected = controller.selectedSnapshot;
        assert.equal(controller.playback.stepIndex, index);
        assert.equal(controller.playback.isPlaying, false);
        assert.equal(selected.timestamp, events[index].timestamp);
        assert.deepEqual(selected.event, expected[index].event);
        assert.deepEqual(selected.currentStates, expected[index].currentStates);
        assert.deepEqual(selected.datamodel, expected[index].datamodel);
        assert.deepEqual(selected.slotValues, expected[index].slotValues);
        assert.deepEqual(selected.parameterValues, expected[index].parameterValues);
        if (selected.event.type === "state_entered") {
            const visit = visitOrder.indexOf(selected.event.data.state);
            assert.deepEqual(shown(), expectedConfigurations[visit], `${selected.event.data.state} must be individually seekable`);
            assert.equal(controller.displayExecution.snapshot, selected, "canvas and selected values use the same historical frame");
        }
    }
    await act(async () => controller.seek(0));
    assert.equal(controller.selectedSnapshot.status, "INITIALIZED");
    await act(async () => controller.seek(events.findIndex((event) => event.type === "status" && event.data.value === "RUNNING")));
    assert.equal(controller.selectedSnapshot.status, "RUNNING");
    assert.deepEqual(controller.selectedSnapshot.currentStates, [], "RUNNING alone does not invent an active skill");
});

test("the real 151ms trace plays all 17 entered states at 800ms display pace even after stopped arrives in the same batch", async () => {
    await mount(); await record();
    assert.equal(controller.playback.engineStatus, "Stopped");
    assert.equal(controller.playback.isPlaying, true, "engine completion must not discard queued visits");
    const displayed = [{ state: controller.selectedSnapshot.event.data.state, time: elapsed }];
    const first = controller.selectedSnapshot;
    assert.equal([...timers.values()][0].delay, 800);
    await advance(799);
    assert.equal(controller.selectedSnapshot, first, "the graph must not race ahead of the display delay");
    await advance(1);
    displayed.push({ state: controller.selectedSnapshot.event.data.state, time: elapsed });
    for (let tick = 0; tick < events.length && controller.playback.isPlaying; tick += 1) {
        assert.equal(timers.size, 1, "there is one owned presentation timer, not a REST polling loop");
        assert.equal([...timers.values()][0].delay, 800);
        const before = controller.playback.stepIndex;
        await advance(800);
        assert.ok(controller.playback.stepIndex > before, "playback advances in arrival order");
        if (controller.selectedSnapshot.event.type === "state_entered") {
            displayed.push({ state: controller.selectedSnapshot.event.data.state, time: elapsed });
            assert.ok(shown().includes(controller.selectedSnapshot.event.data.state));
        }
    }
    assert.deepEqual(displayed.map(({ state }) => state), visitOrder);
    for (let index = 1; index < displayed.length; index += 1) {
        assert.equal(displayed[index].time - displayed[index - 1].time, 800, "exit/transition/assignment frames must not add phantom parent visits");
    }
    assert.equal(controller.playback.isPlaying, false);
    assert.equal(controller.playback.stepIndex, events.length - 1);
    assert.equal(controller.playback.stepCount, events.length);
    assert.equal(controller.displayExecution, null);
    assert.equal(timers.size, 0);
});

test("real root-data pause and stop boundaries retain replay and fence stale display timers without machine commands", async () => {
    await mount();
    const beforeExitB = suppliedTrace.findIndex((event) => event.type === "state_exited" && event.data.state === "slots.SlotIO#B");
    await record(suppliedTrace.slice(0, beforeExitB));
    const first = controller.selectedSnapshot;
    const latePauseTimer = [...timers.values()][0].callback;
    const pause = { type: "status", timestamp: "2026-10-11T15:46:42.124500000Z", data: { value: "PAUSED" } };
    await act(async () => receive(pause));
    const pausedCount = controller.playback.stepCount;
    assert.equal(controller.playback.engineStatus, "PAUSED");
    assert.equal(controller.playback.isPlaying, false);
    assert.equal(controller.hasRecording, true);
    assert.equal(timers.size, 0);
    await act(async () => latePauseTimer());
    assert.equal(controller.selectedSnapshot, first);
    await act(async () => controller.restart());
    assert.deepEqual(shown(), ["slots.SlotIO#A"]);
    await advance(800);
    assert.deepEqual(shown(), ["slots.SlotIO#B"]);
    assert.equal(controller.selectedSnapshot.slotValues["/A#test"].value, "1");
    const lateStopTimer = [...timers.values()][0].callback;
    await act(async () => {
        suppliedTrace.slice(-2).forEach(receive);
        controller.recordExecutionUpdate({ action: "stop", workflow: null, snapshot: null, following: false });
    });
    assert.equal(controller.playback.stepCount, pausedCount + 2);
    assert.equal(controller.hasRecording, true);
    assert.equal(controller.playback.isPlaying, false);
    assert.equal(controller.displayExecution, null);
    assert.equal(controller.latestSnapshot.status, "INITIALIZED_BUT_WARNINGS");
    assert.equal(timers.size, 0);
    await act(async () => lateStopTimer());
    assert.equal(controller.displayExecution, null);
    await act(async () => controller.restart());
    assert.deepEqual(shown(), ["slots.SlotIO#A"]);
    await advance(800);
    assert.deepEqual(shown(), ["slots.SlotIO#B"]);
    await act(async () => controller.seek(pausedCount - 1));
    assert.equal(controller.selectedSnapshot.status, "PAUSED");
    assert.equal(controller.selectedSnapshot.parameterValues["slots.SlotIO#B"]["#_WRITE"].expression, "@test_val");
    await act(async () => controller.goLive());
    assert.equal(controller.playback.isPlaying, false, "Live after Stop cannot restart the engine or its display");
    assert.equal(controller.displayExecution, null);
});

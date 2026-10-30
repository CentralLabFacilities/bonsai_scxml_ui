import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement, StrictMode, useLayoutEffect } from "react";
import { Window } from "happy-dom";
import { captureRuntimeSnapshot } from "../src/utils/runtimeSnapshots.js";
import { useRuntimeSnapshots } from "../src/hooks/editor/useRuntimeSnapshots.js";
import { useRuntimeValuesVisibility } from "../src/hooks/editor/useRuntimeValuesVisibility.js";

const window = new Window({ url: "http://localhost/" });
const originals = new Map();
const workflow = Object.freeze({ id: "root", documentGeneration: 1, title: "A recorded workflow",
    nodes: Object.freeze([]), fingerprint: "loaded-version" });
const tabsSnapshot = Object.freeze([workflow]);
let createRoot;
let root;
let container;
let controller;
let timers;
let allTimers;
let nextTimer;
let source;
let clock;
let limit;
let bytesLimit;

function Harness() {
    const result = useRuntimeSnapshots({ maxSnapshots: limit, maxCacheBytes: bytesLimit });
    const valuesVisibility = useRuntimeValuesVisibility();
    useLayoutEffect(() => { controller = { ...result, valuesVisibility,
        valuesOpen: valuesVisibility.isOpen && result.hasRecording && result.hasExecution,
        recordExecutionUpdate: (update) => { valuesVisibility.onExecutionUpdate(update); result.recordExecutionUpdate(update); } }; });
    return null;
}
const mount = async () => act(async () => root.render(createElement(StrictMode, null, createElement(Harness))));
const start = async () => act(async () => controller.recordExecutionUpdate({ action: "record_start", workflow,
    tabsSnapshot, snapshot: null, following: false, followCamera: true }));
const observe = (states, type = "state_entered", status = "RUNNING", datamodel, details = {}) => {
    const event = { type, timestamp: new Date(++clock).toISOString(), details,
        ...(states ? { states } : {}), ...(datamodel !== undefined ? { datamodel } : {}) };
    source = { ...source, status, currentStates: states || source.currentStates, checkedAt: clock,
        ...(datamodel !== undefined ? { datamodel } : {}) };
    controller.recordExecutionUpdate({ workflow, tabsSnapshot, snapshot: source, following: !["terminal", "stopped"].includes(type), runtimeEvent: event });
};
const tick = async () => act(async () => {
    const pending = [...timers.values()]; timers.clear();
    pending.forEach(({ callback }) => callback());
});
const shown = () => controller.displayExecution?.snapshot.currentStates || [];

test.before(async () => {
    for (const [key, value] of Object.entries({ window, document: window.document,
        navigator: window.navigator, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
        originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
        Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    ({ createRoot } = await import("react-dom/client"));
});
test.beforeEach(() => {
    limit = 20000; bytesLimit = 32 * 1024 * 1024; clock = 0; controller = null;
    timers = new Map(); allTimers = new Map(); nextTimer = 0;
    window.setTimeout = (callback, delay) => {
        const id = ++nextTimer; const entry = { callback, delay };
        timers.set(id, entry); allTimers.set(id, entry); return id;
    };
    window.clearTimeout = (id) => timers.delete(id);
    source = { status: "INITIALIZED", currentStates: [], checkedAt: 0 };
    container = window.document.createElement("div"); window.document.body.append(container);
    root = createRoot(container);
});
test.afterEach(async () => {
    await act(async () => root.unmount());
    assert.equal(timers.size, 0, "all owned pacing timers must be cancelled");
    container.remove();
    await window.happyDOM.cancelAsync();
});
test.after(async () => {
    await window.happyDOM.close();
    for (const [key, value] of originals) {
        if (value) Object.defineProperty(globalThis, key, value);
        else delete globalThis[key];
    }
});

test("rapid events are cached before React batching and each visited skill is displayed at the chosen pace", async () => {
    await mount(); await start();
    await act(async () => { observe(["A"]); observe(["B"]); observe(["C"]); });
    assert.equal(controller.playback.stepCount, 3);
    assert.deepEqual(shown(), ["A"], "batching must not replace A with the newest state C");
    assert.equal([...timers.values()][0].delay, 800);
    const timer = [...timers.keys()][0];
    await act(async () => observe(["D"]));
    assert.equal([...timers.keys()][0], timer, "incoming events must not debounce/starve playback");
    await tick(); assert.deepEqual(shown(), ["B"]);
    await tick(); assert.deepEqual(shown(), ["C"]);
    await tick(); assert.deepEqual(shown(), ["D"]);
    await tick();
    assert.equal(timers.size, 0, "idle live follow waits for an event rather than polling the renderer");
});

test("fast natural completion drains the cached skills even after the engine has ended", async () => {
    await mount(); await start();
    await act(async () => { observe(["A"]); observe(["B"]); observe([], "terminal"); });
    assert.equal(controller.playback.engineStatus, "Stopped");
    assert.deepEqual(shown(), ["A"]);
    assert.equal(controller.playback.isPlaying, true);
    await tick(); assert.deepEqual(shown(), ["B"]);
    await tick(); assert.equal(controller.displayExecution, null);
    assert.equal(controller.playback.isPlaying, false);
    assert.equal(controller.playback.stepIndex, 2);
    assert.equal(controller.playback.stepCount, 3);
});

test("engine pause and stop preserve the cache and replay never requires engine commands", async () => {
    await mount(); await start();
    await act(async () => { observe(["A"]); observe(["B"]); observe(["B"], "status", "PAUSED"); });
    assert.equal(controller.playback.isPlaying, false);
    assert.equal(controller.playback.stepCount, 3);
    await act(async () => controller.restart());
    assert.deepEqual(shown(), ["A"]);
    await tick(); assert.deepEqual(shown(), ["B"]);
    await act(async () => controller.recordExecutionUpdate({ workflow, snapshot: source, following: true, followCamera: false }));
    assert.equal(controller.playback.isPlaying, true, "preferences/status refresh must not pause historical playback again");
    await act(async () => controller.recordExecutionUpdate({ action: "stop", workflow: null, snapshot: null, following: false }));
    assert.equal(controller.displayExecution, null);
    assert.equal(controller.playback.stepCount, 3);
    assert.equal(controller.hasRecording, true);
    await act(async () => controller.restart());
    assert.deepEqual(shown(), ["A"]);
    await tick(); assert.deepEqual(shown(), ["B"]);
});

test("seeking pauses display, follows the selected values, and still captures new arrivals", async () => {
    await mount(); await start();
    await act(async () => {
        observe(["A"], "snapshot", "RUNNING", { global: { count: 1 } });
        observe(["B"], "snapshot", "RUNNING", { global: { count: 2 } });
    });
    await act(async () => controller.seek(0));
    const frame = controller.selectedSnapshot;
    assert.equal(controller.playback.isPlaying, false);
    assert.equal(frame.datamodel.global.count, 1);
    await act(async () => observe(["C"], "snapshot", "RUNNING", { global: { count: 3 } }));
    assert.equal(controller.selectedSnapshot, frame);
    assert.equal(controller.latestSnapshot.datamodel.global.count, 3);
    assert.equal(controller.playback.stepCount, 3);
    await act(async () => controller.goLive());
    assert.deepEqual(shown(), ["C"]);
    assert.equal(controller.selectedSnapshot.datamodel.global.count, 3);
    assert.equal(controller.playback.isPlaying, true);
});

test("same-state assignments are cached but do not delay the next distinct skill", async () => {
    await mount(); await start();
    await act(async () => {
        observe(["A"], "snapshot", "RUNNING", { global: { count: 0 } });
        for (let value = 1; value < 10; value += 1) observe(["A"], "datamodel_assignment", "RUNNING", { global: { count: value } });
        observe([], "state_exited");
        observe(["B"]);
    });
    assert.equal(controller.playback.stepCount, 12);
    await tick(); assert.deepEqual(shown(), ["B"]);
    assert.equal(controller.selectedSnapshot.datamodel.global.count, 9);
    await act(async () => controller.seek(4));
    assert.equal(controller.selectedSnapshot.datamodel.global.count, 4, "each assignment observation is still seekable");
});

test("exit and reentry of the same skill are a visible visit boundary", async () => {
    await mount(); await start();
    await act(async () => { observe(["A"]); observe([], "state_exited"); observe(["A"], "state_entered"); });
    assert.equal(controller.playback.stepIndex, 0);
    await tick(); assert.equal(controller.playback.stepIndex, 2);
});

test("hide preserves recordings and starting again gets a fresh session and fences late timers", async () => {
    await mount(); await start();
    await act(async () => { observe(["A"]); observe(["B"]); });
    const session = controller.displayExecution.session;
    const stale = [...timers.values()][0].callback;
    await act(async () => controller.hide());
    assert.equal(controller.displayExecution, null);
    assert.equal(controller.playback.loaded, false);
    assert.equal(controller.hasRecording, true);
    await act(async () => controller.restart());
    assert.equal(controller.displayExecution.session, session);
    await start();
    await act(async () => { observe(["New"]); stale(); });
    assert.notEqual(controller.displayExecution.session, session);
    assert.deepEqual(shown(), ["New"]);
    assert.equal(controller.playback.stepCount, 1);
});

test("resume returns to latest without erasing history, and no-op resume remains paused", async () => {
    await mount(); await start();
    await act(async () => { observe(["A"]); observe(["B"], "status", "PAUSED"); controller.seek(0); });
    await act(async () => controller.recordExecutionUpdate({ action: "record_resume", workflow, snapshot: source, following: true }));
    assert.deepEqual(shown(), ["B"]);
    assert.equal(controller.playback.stepCount, 2);
    await act(async () => controller.recordExecutionUpdate({ action: "resume", workflow, snapshot: source, following: true }));
    assert.equal(controller.playback.engineStatus, "PAUSED");
    assert.equal(controller.playback.isPlaying, false);
});

test("an initial paused subscription remains paused until local replay is explicitly requested", async () => {
    await mount();
    await act(async () => observe(["A"], "snapshot", "PAUSED", { global: { value: "reported" } }));
    assert.equal(controller.playback.stepCount, 1);
    assert.equal(controller.playback.engineStatus, "PAUSED");
    assert.equal(controller.playback.isPlaying, false);
    assert.equal(timers.size, 0);
    await act(async () => controller.restart());
    assert.equal(controller.playback.isPlaying, true);
});

test("Values availability requires a loaded execution and remains valid for paused/stopped recordings", async () => {
    await mount();
    assert.equal(controller.hasExecution, false);
    await start();
    await act(async () => observe([], "snapshot", "INITIALIZED", { global: { value: "initial" } }));
    assert.equal(controller.hasRecording, true);
    assert.equal(controller.hasExecution, false, "loading and initial snapshots must not expose a running-machine panel");
    await act(async () => observe(["A"], "state_entered", "RUNNING"));
    assert.equal(controller.hasExecution, true);
    await act(async () => observe(["A"], "status", "PAUSED"));
    assert.equal(controller.hasExecution, true);
    await act(async () => controller.recordExecutionUpdate({ action: "stop", workflow: null, snapshot: null, following: false }));
    assert.equal(controller.hasExecution, true, "the same recorded values remain inspectable after Stop");
    await act(async () => controller.recordExecutionUpdate({ action: "load", workflow: null, following: false }));
    assert.equal(controller.hasExecution, false);
});

test("Start automatically reveals Values when running, while closing Run stays closed through later events and acknowledgments", async () => {
    await mount(); await start();
    assert.equal(controller.valuesVisibility.isOpen, true, "Start requests the Values panel automatically");
    assert.equal(controller.valuesOpen, false, "it must wait until the loaded execution is running");
    await act(async () => observe(["A"], "state_entered", "RUNNING", { global: { value: "received" } }));
    assert.equal(controller.valuesOpen, true);
    await act(async () => controller.valuesVisibility.close());
    const before = controller.playback.stepCount;
    await act(async () => {
        observe(["B"], "state_entered", "RUNNING");
        controller.recordExecutionUpdate({ action: "start", workflow, snapshot: source, following: true });
    });
    assert.equal(controller.valuesOpen, false, "a late acknowledgment must not reopen Values after closing Run");
    assert.ok(controller.playback.stepCount > before, "closing Values/Run does not stop recording");
    await act(async () => controller.valuesVisibility.toggle());
    assert.equal(controller.valuesOpen, true);
    await act(async () => controller.recordExecutionUpdate({ action: "stop", workflow: null, snapshot: null, following: false }));
    assert.equal(controller.valuesOpen, true, "Stop keeps the cached values available while Run remains open");
    await act(async () => controller.valuesVisibility.close());
    assert.equal(controller.valuesOpen, false);
    await start();
    await act(async () => observe(["New"], "state_entered", "RUNNING"));
    assert.equal(controller.valuesOpen, true, "a new Start opens the new recording's values again");
});

test("load closes Values and Resume requests it again without repeated snapshot-driven reopening", async () => {
    await mount(); await start();
    await act(async () => observe(["A"], "state_entered", "RUNNING"));
    await act(async () => controller.valuesVisibility.close());
    await act(async () => controller.recordExecutionUpdate({ action: "record_resume", workflow, snapshot: source, following: true }));
    assert.equal(controller.valuesOpen, true);
    await act(async () => controller.valuesVisibility.close());
    await act(async () => controller.recordExecutionUpdate({ action: "resume", workflow, snapshot: source, following: true }));
    assert.equal(controller.valuesOpen, false);
    await act(async () => controller.recordExecutionUpdate({ action: "loading", workflow: null, following: false }));
    assert.equal(controller.valuesVisibility.isOpen, false);
    assert.equal(controller.valuesOpen, false);
});

test("offline/gap notifications do not stop independent historical replay", async () => {
    await mount(); await start();
    await act(async () => { observe(["A"]); observe(["B"]); controller.restart(); });
    await act(async () => controller.recordExecutionUpdate({ workflow, snapshot: null, following: false }));
    assert.equal(controller.playback.hasGap, true);
    assert.equal(controller.playback.isPlaying, true);
    await tick(); assert.deepEqual(shown(), ["B"]);
});

test("cached frames are independent of received mutable arrays/values and editor expressions", async () => {
    await mount(); await start();
    const states = ["A"];
    const datamodel = { global: { expression: "test_val - 1", result: { value: 0 }, empty: "", enabled: false, missing: null } };
    await act(async () => observe(states, "snapshot", "RUNNING", datamodel));
    states.push("Never received"); datamodel.global.result.value = 99;
    assert.deepEqual(shown(), ["A"]);
    assert.equal(controller.selectedSnapshot.datamodel.global.result.value, 0);
    assert.equal(controller.selectedSnapshot.datamodel.global.expression, "test_val - 1");
    assert.equal(controller.selectedSnapshot.datamodel.global.empty, "");
    assert.equal(controller.selectedSnapshot.datamodel.global.enabled, false);
    assert.equal(controller.selectedSnapshot.datamodel.global.missing, null);
});

test("cache limits are explicit and do not silently discard the beginning of a run", async () => {
    limit = 3;
    await mount(); await start();
    await act(async () => { observe(["A"]); observe(["B"]); observe(["C"]); observe(["D"]); });
    assert.equal(controller.playback.stepCount, 3);
    assert.equal(controller.playback.truncated, true);
    assert.equal(controller.latestSnapshot.currentStates[0], "D");
    await act(async () => controller.seek(0)); assert.deepEqual(shown(), ["A"]);
    await act(async () => controller.seek(999)); assert.deepEqual(shown(), ["C"]);
});

test("large reported values obey the cache memory budget while latest values remain available", async () => {
    bytesLimit = 4096;
    await mount(); await start();
    await act(async () => observe(["A"], "snapshot", "RUNNING", { global: { value: "small" } }));
    await act(async () => observe(["B"], "snapshot", "RUNNING", { global: { value: "x".repeat(5000) } }));
    assert.equal(controller.playback.stepCount, 1);
    assert.equal(controller.playback.truncated, true);
    assert.equal(controller.latestSnapshot.datamodel.global.value.length, 5000);
    await act(async () => controller.seek(0));
    assert.equal(controller.selectedSnapshot.datamodel.global.value, "small");
});

test("new loads clear old ownership, and speed changes reschedule only presentation", async () => {
    await mount(); await start();
    await act(async () => observe(["A"]));
    await act(async () => controller.setDelay(200));
    assert.equal([...timers.values()][0].delay, 200);
    await act(async () => controller.setDelay(-1));
    assert.equal(controller.playback.delay, 200);
    await act(async () => controller.recordExecutionUpdate({ action: "load", workflow: null, following: false }));
    assert.equal(controller.displayExecution, null);
    assert.equal(controller.hasRecording, false);
    assert.equal(timers.size, 0);
});

test("variable change times and slot details are captured as reported, without inferred bindings", () => {
    const first = captureRuntimeSnapshot(null, { status: "RUNNING", currentStates: ["A"], checkedAt: 0,
        datamodel: { global: { count: "0", "#_SLOTS": "[slots: null]" } } }, { type: "snapshot", timestamp: "first" });
    const changed = captureRuntimeSnapshot(first, { status: "RUNNING", currentStates: ["A"],
        datamodel: { global: { count: "1", "#_SLOTS": "[slots: null]" } } }, { type: "datamodel_assignment", timestamp: "second" });
    const key = JSON.stringify(["global", "count"]);
    assert.deepEqual(first.variableMeta[key], { timestamp: "first", changed: false });
    assert.deepEqual(changed.variableMeta[key], { timestamp: "second", changed: true });
    assert.equal(changed.variableMeta[JSON.stringify(["global", "#_SLOTS"])].timestamp, "first");
    const written = captureRuntimeSnapshot(changed, { status: "RUNNING", currentStates: ["A"] },
        { type: "slot_written", timestamp: "third", details: { opaqueBackendKey: { value: 0 } } }, false);
    const cleared = captureRuntimeSnapshot(written, { status: "RUNNING", currentStates: [] },
        { type: "slot_cleared", timestamp: "fourth", details: { opaqueBackendKey: null } }, false);
    assert.equal(cleared.datamodel, changed.datamodel, "omitted datamodel is not a clearing");
    assert.equal(cleared.datamodelTimestamp, "second");
    assert.deepEqual(cleared.slotAssignments.map((event) => event.type), ["slot_written", "slot_cleared"]);
    assert.deepEqual(cleared.slotAssignments[0].details, { opaqueBackendKey: { value: 0 } });
    assert.equal(cleared.runtimeSlotValue, undefined);
});

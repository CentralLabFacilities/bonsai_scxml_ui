import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement, StrictMode } from "react";
import { Window } from "happy-dom";

const window = new Window({ url: "http://localhost/" });
const document = window.document;
const originals = new Map();
let server;
let createRoot;
let RuntimeLogPlayer;
let RuntimeValuesPanel;
let root;
let container;
let opener;
let calls;
let callbacks;

const timestamp = "2026-10-11T16:00:00.000Z";
const logPlayback = (overrides = {}) => ({
    loaded: true, fileName: "run.log", stepCount: 3, stepIndex: 1,
    started: true, isPlaying: false, delay: 800,
    currentStep: { source: "Work", target: "Done", event: "Work.success", timestamp, resolved: true },
    ...overrides,
});
const eventPlayback = (overrides = {}) => ({
    kind: "events", loaded: true, fileName: "Recorded run", stepCount: 3, stepIndex: 1,
    started: true, isPlaying: false, delay: 800,
    currentStep: { states: ["Parallel", "Work#1"], timestamp, event: "state_entered" },
    engineStatus: "RUNNING", isLive: false, hasGap: false, truncated: false,
    ...overrides,
});
const render = async (Component, props) => act(async () => {
    root.render(createElement(StrictMode, null, createElement(Component, props)));
});
const renderPlayer = (runtimePlayback, props = {}) => render(RuntimeLogPlayer, { runtimePlayback, ...callbacks, ...props });
const player = (recorded = false) => document.querySelector(`[aria-label="${recorded ? "Recorded run playback" : "Runtime log playback"}"]`);
const valuesWindow = () => document.querySelector(".runtime-values-panel");
const button = (name, scope = document) => {
    const found = [...scope.querySelectorAll("button")].find((element) =>
        element.getAttribute("aria-label") === name || element.textContent.trim() === name || element.title === name);
    assert.ok(found, `Missing button: ${name}`);
    return found;
};
const click = async (name, scope) => act(async () => button(name, scope).click());
const changeRange = async (scope, value) => act(async () => {
    const input = scope.querySelector('input[type="range"]');
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, String(value));
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
});
const changeSpeed = async (scope, value) => act(async () => {
    const select = scope.querySelector("select");
    select.value = String(value);
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
});
const freeze = (value) => {
    if (value && typeof value === "object") {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    }
    return value;
};
const variableRow = (name, scope = "global") => {
    const found = [...valuesWindow().querySelectorAll(".runtime-values-variable")].find((row) =>
        row.querySelector("strong code").textContent === name
        && row.querySelector(".runtime-values-variable-heading > span code").textContent === scope);
    assert.ok(found, `Missing reported variable: ${scope}/${name}`);
    return found;
};

test.before(async () => {
    for (const [name, value] of Object.entries({
        window, document, navigator: window.navigator, HTMLElement: window.HTMLElement,
        HTMLInputElement: window.HTMLInputElement, Element: window.Element, Node: window.Node,
        IS_REACT_ACT_ENVIRONMENT: true,
    })) {
        originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    }
    ({ createRoot } = await import("react-dom/client"));
    const { createServer } = await import("vite");
    const { default: react } = await import("@vitejs/plugin-react");
    server = await createServer({ configFile: false, plugins: [react()], appType: "custom",
        server: { middlewareMode: true, hmr: false, ws: false, watch: { ignored: () => true } },
        optimizeDeps: { noDiscovery: true, include: [] } });
    [{ default: RuntimeLogPlayer }, { default: RuntimeValuesPanel }] = await Promise.all([
        server.ssrLoadModule("/src/components/inspector/RuntimeLogPlayer.jsx"),
        server.ssrLoadModule("/src/components/inspector/RuntimeValuesPanel.jsx"),
    ]);
});
test.beforeEach(() => {
    calls = [];
    callbacks = Object.fromEntries([
        ["onOpenRuntimeCommander", "run"], ["onLoadRuntimeLog", "load"],
        ["onRuntimePlayPause", "playPause"], ["onRuntimeRestart", "restart"],
        ["onRuntimePrevious", "previous"], ["onRuntimeNext", "next"],
        ["onRuntimeSeek", "seek"], ["onRuntimeClear", "clear"],
        ["onRuntimeDelayChange", "delay"], ["onRuntimeLive", "live"], ["onOpenRuntimeValues", "values"],
    ].map(([prop, label]) => [prop, (...args) => calls.push([label, ...args.filter((arg) => typeof arg !== "object")])]));
    container = document.createElement("div"); document.body.append(container);
    opener = document.createElement("button"); opener.textContent = "Open values"; document.body.append(opener);
    opener.focus(); root = createRoot(container);
});
test.afterEach(async () => {
    await act(async () => root.unmount());
    container.remove(); opener.remove();
    await window.happyDOM.cancelAsync();
});
test.after(async () => {
    await server?.close();
    await window.happyDOM.cancelAsync();
    for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
    }
});

test("default log launcher retains Run, file upload, and panel/drag visibility", async () => {
    await renderPlayer(undefined);
    assert.equal(player(), null);
    const input = container.querySelector('input[type="file"]');
    assert.equal(input.accept, ".log,.txt,text/plain");
    assert.equal(input.style.display, "none");
    let fileClicks = 0;
    input.click = () => { fileClicks += 1; };
    await click("Load log");
    assert.equal(fileClicks, 1);
    const file = new window.File(["original log text"], "trace.log", { type: "text/plain" });
    await act(async () => {
        Object.defineProperty(input, "files", { configurable: true, value: [file] });
        input.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    await click("Run");
    assert.deepEqual(calls, [["load", "original log text", "trace.log"], ["run"]]);
    assert.equal(input.value, "");
    await renderPlayer(undefined, { isRunPanelOpen: true });
    assert.equal(container.querySelector(".runtime-launch-controls").hidden, true);
    assert.equal(button("Run", container).getAttribute("aria-expanded"), "true");
    await renderPlayer(undefined, { isDraggingNode: true });
    assert.equal(container.querySelector(".runtime-launch-controls").hidden, true);
});

test("log trace overview, labels, speeds, and callbacks remain compatible", async () => {
    await renderPlayer(logPlayback({ started: false, currentStep: null, fileName: "", stepIndex: -1,
        unresolvedCount: 1, unresolvedSlotSampleCount: 2, unresolvedParameterSampleCount: 3 }));
    const region = player();
    assert.equal(region.className, "runtime-log-player");
    assert.equal(region.hidden, false);
    assert.equal(region.querySelector("strong").textContent, "Runtime log");
    assert.equal(region.querySelector(".runtime-log-file-info span").textContent,
        "Trace overview \u00b7 3 transitions \u00b7 1 unmatched \u00b7 2 slot values unmatched \u00b7 3 parameter values unmatched");
    assert.equal(region.querySelector(".runtime-log-trace-overview").textContent,
        "Executed route highlighted \u00b7 press Play to follow it step by step");
    const range = region.querySelector('input[type="range"]');
    assert.equal(range.getAttribute("aria-label"), "Runtime transition timeline");
    assert.equal(range.title, "Click or drag to jump to a transition");
    assert.equal(range.value, "0");
    assert.equal(button("Previous transition", region).disabled, true);
    assert.equal(button("Next transition", region).disabled, true);
    assert.equal(button("Play", region).disabled, false);
    assert.equal(region.querySelector(".runtime-recorded-text-button"), null);
    assert.ok(button("Load another runtime log", region));
    assert.deepEqual([...region.querySelectorAll("option")].map(({ value, textContent }) => [value, textContent]),
        [["1400", "0.5\u00d7"], ["800", "1\u00d7"], ["400", "2\u00d7"], ["200", "4\u00d7"]]);
    await changeRange(region, 2);
    await changeSpeed(region, 400);
    await click("Start from beginning", region);
    await click("Play", region);
    await click("Close runtime log", region);
    assert.deepEqual(calls, [["seek", 2], ["delay", 400], ["restart"], ["playPause"], ["clear"]]);
    await renderPlayer(logPlayback(), { isRunPanelOpen: true });
    assert.equal(player().hidden, true);
    await renderPlayer(logPlayback(), { isDraggingNode: true });
    assert.equal(player().hidden, true);
});

test("log current route, unmatched status, and transport boundaries stay unchanged", async () => {
    await renderPlayer(logPlayback({ currentStep: { ...logPlayback().currentStep, resolved: false }, isPlaying: true }));
    const region = player();
    assert.equal(region.querySelector(".runtime-log-route").textContent, "Work\u2192Done");
    assert.equal(region.querySelector(".runtime-log-route").title, "Work \u2192 Done");
    assert.equal(region.querySelector(".runtime-log-event-row code").textContent, "Work.success");
    assert.equal(region.querySelector(".runtime-log-unmatched").textContent, "not matched");
    assert.equal(button("Pause", region).textContent, "");
    assert.equal(button("Previous transition", region).disabled, false);
    assert.equal(button("Next transition", region).disabled, false);
    await renderPlayer(logPlayback({ stepIndex: 0 }));
    assert.equal(button("Previous transition", player()).disabled, true);
    await renderPlayer(logPlayback({ stepIndex: 2 }));
    assert.equal(button("Next transition", player()).disabled, true);
    await renderPlayer(logPlayback({ stepCount: 0, started: false, currentStep: null }));
    assert.match(player().textContent, /No transitions found/);
    assert.equal(button("Play", player()).disabled, true);
    assert.equal(button("Start from beginning", player()).disabled, true);
});

test("recorded playback uses reported states, separate engine status, and visualization actions", async () => {
    const playback = freeze(eventPlayback({ currentStep: { states: ["Parallel", "Work#1"], timestamp,
        event: "state_exited", source: "Do not invent a route", target: "Fabricated target" } }));
    await renderPlayer(playback);
    const region = player(true);
    assert.equal(region.hidden, false);
    assert.ok(region.classList.contains("runtime-snapshot-player"));
    assert.equal(region.classList.contains("runtime-log-player-embedded"), false);
    assert.equal(region.getAttribute("data-run-panel-open"), "false");
    assert.equal(container.querySelector('input[type="file"]'), null);
    assert.equal(region.querySelector(".runtime-log-file-button"), null);
    assert.equal(region.querySelector(".runtime-log-route"), null);
    assert.equal(region.querySelector(".runtime-log-unmatched"), null);
    assert.deepEqual([...region.querySelectorAll(".runtime-recorded-states code")].map((element) => element.textContent), ["Parallel", "Work#1"]);
    assert.equal(region.querySelector(".runtime-recorded-status strong").textContent, "RUNNING");
    assert.equal(region.querySelector(".runtime-log-event-row code").textContent, "state_exited");
    assert.equal(region.querySelector(".runtime-log-event-row").textContent, `Snapshot eventstate_exited${timestamp}`);
    assert.doesNotMatch(region.textContent, /transition|Fabricated|Do not invent|\u2192/);
    assert.match(region.textContent, /playback controls do not pause the machine/);
    assert.equal(region.querySelector('input[type="range"]').getAttribute("aria-label"), "Recorded snapshot timeline");
    await click("Previous recorded snapshot", region);
    await click("Next recorded snapshot", region);
    await click("Play visualization", region);
    await click("Start from first recorded snapshot", region);
    await click("Values", region);
    await click("Live", region);
    await changeRange(region, 0);
    await changeSpeed(region, 200);
    await click("Hide recorded playback", region);
    assert.deepEqual(calls, [["previous"], ["next"], ["playPause"], ["restart"], ["values"], ["live"], ["seek", 0], ["delay", 200], ["clear"]]);
    assert.equal(playback.engineStatus, "RUNNING");
});

test("recorded playback has one visible placement when Run is opened or closed", async () => {
    await renderPlayer(eventPlayback(), { isRunPanelOpen: true });
    assert.equal(player(true).hidden, true, "the floating card is hidden behind the embedded Run playback");
    await renderPlayer(eventPlayback(), { isRunPanelOpen: true, embedded: true });
    assert.equal(player(true).hidden, false);
    assert.ok(player(true).classList.contains("runtime-log-player-embedded"));
    await renderPlayer(eventPlayback());
    assert.equal(player(true).hidden, false);
    assert.equal(player(true).classList.contains("runtime-log-player-embedded"), false);
});

test("embedded Replay is a compact strip without duplicate workflow, engine status, event details, or close controls", async () => {
    await renderPlayer(eventPlayback({ isPlaying: true }), { isRunPanelOpen: true, embedded: true });
    const region = player(true);
    assert.ok(region.classList.contains("runtime-replay-compact"));
    assert.equal(region.querySelector(".runtime-log-player-header"), null);
    assert.equal(region.querySelector(".runtime-recorded-status"), null);
    assert.equal(region.querySelector(".runtime-log-current-step"), null);
    assert.equal(region.querySelector(".runtime-recorded-note"), null);
    assert.equal(region.querySelector(".runtime-log-close-button"), null);
    assert.match(region.querySelector(".runtime-log-timeline-labels").textContent, /Replay 2 \/ 3/);
    assert.equal(region.querySelector(".runtime-replay-current").textContent, "Parallel, Work#1");
    assert.ok(region.querySelector('[aria-label="Replay controls"]'));
    assert.equal(button("Pause visualization", region).textContent, "");
    await click("Pause visualization", region);
    await click("Next recorded snapshot", region);
    await changeRange(region, 0);
    assert.deepEqual(calls, [["playPause"], ["next"], ["seek", 0]]);
});

test("Values launcher reports the independent overlay state rather than switching inspector tabs", async () => {
    await renderPlayer(eventPlayback(), { runtimeValuesOpen: false });
    const values = button("Values", player(true));
    assert.equal(values.getAttribute("aria-controls"), "editor-values-panel");
    assert.equal(values.getAttribute("aria-expanded"), "false");
    await click("Values", player(true));
    assert.deepEqual(calls, [["values"]]);
    await renderPlayer(eventPlayback(), { runtimeValuesOpen: true });
    assert.equal(button("Values", player(true)).getAttribute("aria-expanded"), "true");
});

test("recorded controls respect snapshot availability, boundaries, and optional callbacks", async () => {
    for (const [stepCount, stepIndex, started, previousDisabled, nextDisabled] of [
        [0, -1, false, true, true], [3, -1, false, true, true],
        [3, 0, true, true, false], [3, 1, true, false, false], [3, 2, true, false, true],
    ]) {
        await renderPlayer(eventPlayback({ stepCount, stepIndex, started, currentStep: null, delay: undefined }));
        const region = player(true);
        assert.equal(button("Play visualization", region).disabled, stepCount === 0);
        assert.equal(button("Start from first recorded snapshot", region).disabled, stepCount === 0);
        assert.equal(button("Previous recorded snapshot", region).disabled, previousDisabled);
        assert.equal(button("Next recorded snapshot", region).disabled, nextDisabled);
        assert.equal(button("Values", region).disabled, stepCount === 0);
        assert.equal(button("Live", region).disabled, stepCount === 0);
        assert.equal(region.querySelector("select").value, "800");
    }
    await renderPlayer(eventPlayback({ isPlaying: true, engineStatus: "PAUSED", isLive: true }));
    assert.equal(button("Pause visualization", player(true)).disabled, false);
    assert.equal(button("Live", player(true)).getAttribute("aria-pressed"), "true");
    assert.match(player(true).textContent, /Following live snapshots/);
    await renderPlayer(eventPlayback(), { onRuntimeLive: undefined, onOpenRuntimeValues: undefined, isDraggingNode: true });
    assert.equal(player(true).hidden, true);
    assert.equal(button("Values", player(true)).disabled, true);
    assert.equal([...player(true).querySelectorAll("button")].some((element) => element.textContent === "Live"), false);
    await renderPlayer(eventPlayback({ loaded: false }));
    assert.equal(player(true), null);
    assert.equal(container.querySelector('input[type="file"]'), null);
    assert.equal(container.querySelector(".runtime-log-load-button"), null);
});

test("recorded playback warns for missing history and cache limits without guessing states", async () => {
    await renderPlayer(eventPlayback({ hasGap: true, truncated: true, engineStatus: "Stopped",
        currentStep: { states: [], timestamp, event: { type: "snapshot" } } }));
    const region = player(true);
    assert.match(region.querySelector('[role="note"]').textContent, /Recording gap: some snapshots may be missing/);
    assert.match(region.querySelector('[role="note"]').textContent, /Cache limit reached: later snapshots were not recorded/);
    assert.match(region.querySelector(".runtime-recorded-states").textContent, /No active states reported/);
    assert.equal(region.querySelector(".runtime-recorded-status strong").textContent, "Stopped");
    assert.equal(region.querySelector(".runtime-log-event-row code").textContent, "snapshot");
    await renderPlayer(eventPlayback());
    assert.equal(player(true).querySelector('[role="note"]'), null);
});

test("runtime values preserve JSON types, expressions, scope keys, and observed metadata", async () => {
    const values = { zero: 0, flag: false, none: null, empty: "", object: { nested: [false, 0, null, ""] },
        expression: "test_val - 1", numericString: "0", html: '<img src="x" onerror="mutate()">' };
    const snapshot = freeze({ datamodel: { global: values, 'scope"[,]': { 'name"[,]': "exact scoped value" } },
        variableMeta: { [JSON.stringify(["global", "zero"])]: { timestamp, changed: true },
            [JSON.stringify(["global", "flag"])]: { timestamp, changed: false },
            [JSON.stringify(['scope"[,]', 'name"[,]'])]: { timestamp, changed: true } },
        datamodelTimestamp: "2026-10-11T16:01:00.000Z", slotAssignments: [] });
    const original = JSON.stringify(snapshot);
    await render(RuntimeValuesPanel, { snapshot, stepIndex: 1, stepCount: 3 });
    assert.equal(valuesWindow().querySelector("h3").textContent, "Runtime values");
    assert.equal(valuesWindow().querySelector("header p").textContent, "Selected snapshot 2/3");
    for (const [name, value] of Object.entries(values)) {
        assert.equal(variableRow(name).querySelector("pre").textContent, JSON.stringify(value, null, 2));
    }
    assert.equal(variableRow("zero").querySelector("mark").textContent, "Changed");
    assert.equal(variableRow("flag").querySelector("mark"), null);
    assert.equal(variableRow("zero").querySelector(".runtime-values-timestamp").textContent, `Last observed change: ${timestamp}`);
    assert.equal(variableRow("none").querySelector(".runtime-values-timestamp").textContent, "First reported: Not reported");
    assert.equal(variableRow('name"[,]', 'scope"[,]').querySelector("mark").textContent, "Changed");
    assert.match(valuesWindow().textContent, /Datamodel last reported: 2026-10-11T16:01:00.000Z/);
    assert.equal(valuesWindow().querySelector("img, input, textarea, [contenteditable]"), null);
    assert.equal(JSON.stringify(snapshot), original);
});

test("#_SLOTS stays an explicit raw representation and other internal variables collapse", async () => {
    const snapshot = freeze({ datamodel: { global: { "#_SLOTS": "[slots: null]", "#_SESSIONID": "reported session", visible: false } } });
    await render(RuntimeValuesPanel, { snapshot, stepIndex: 0, stepCount: 1 });
    const slotRow = variableRow("#_SLOTS");
    assert.equal(slotRow.querySelector("pre").textContent, '"[slots: null]"');
    assert.equal(slotRow.closest("details"), null);
    assert.match(slotRow.closest("section").textContent, /backend-reported slot representation/);
    assert.match(slotRow.closest("section").textContent, /Slot contents not reported/);
    const internal = valuesWindow().querySelector(".runtime-values-internals");
    assert.equal(internal.open, false);
    assert.equal(internal.querySelector("summary").textContent, "Other internal variables (1)");
    assert.equal(variableRow("#_SESSIONID").closest("details"), internal);
    const structured = { opaque: { value: false, original: [0, null, ""] } };
    await render(RuntimeValuesPanel, { snapshot: freeze({ datamodel: { global: { "#_SLOTS": structured } } }) });
    assert.equal(variableRow("#_SLOTS").querySelector("pre").textContent, JSON.stringify(structured, null, 2));
    assert.doesNotMatch(valuesWindow().textContent, /Slot contents not reported/);
    await render(RuntimeValuesPanel, { snapshot: { datamodel: { global: { "#_SLOTS": null } } } });
    assert.equal(variableRow("#_SLOTS").querySelector("pre").textContent, "null");
    assert.match(valuesWindow().textContent, /Slot contents not reported/);
});

test("raw slot assignments preserve arrival order without schema inference or snapshot mutation", async () => {
    const newer = { type: "slot_cleared", timestamp: "2026-10-11T16:02:00Z", details: { opaque: [false, 0, null] }, extra: "untouched" };
    const older = { type: "slot_written", timestamp, details: { unknown: { data: "test_val - 1" } } };
    const snapshot = freeze({ slotAssignments: [newer, { type: "not_a_slot_assignment", timestamp, details: { ignored: true } }, older] });
    const original = JSON.stringify(snapshot);
    await render(RuntimeValuesPanel, { snapshot });
    const events = [...valuesWindow().querySelectorAll(".runtime-values-slot-event")];
    assert.deepEqual(events.map((event) => event.querySelector("pre").textContent), [older, newer].map((event) => JSON.stringify(event, null, 2)));
    assert.equal(events[0].open, true);
    assert.doesNotMatch(valuesWindow().textContent, /not_a_slot_assignment|Slot contents not reported/);
    assert.equal(JSON.stringify(snapshot), original);
});

test("inline inspector values keep modes read-only and delegate Escape to the drawer", async () => {
    let showLatest = false;
    const draw = () => root.render(createElement(StrictMode, null, createElement(RuntimeValuesPanel, {
        showLatest, snapshot: { datamodel: { global: { count: 0 } } }, stepIndex: 0, stepCount: 3,
        onShowLatest: () => { calls.push(["latest"]); showLatest = true; draw(); },
        onFollowSnapshot: () => { calls.push(["displayed"]); showLatest = false; draw(); },
    })));
    await act(async () => draw());
    assert.equal(document.activeElement, opener, "the inspector content must not steal focus from playback");
    assert.ok(container.contains(valuesWindow()), "values are inline, not a body portal");
    assert.ok(valuesWindow().classList.contains("details-panel"));
    assert.equal(valuesWindow().getAttribute("role"), "region");
    assert.ok(valuesWindow().hasAttribute("data-editor-shortcut-scope"));
    assert.equal(document.querySelector('dialog, [aria-modal="true"]'), null);
    assert.equal(button("Displayed snapshot", valuesWindow()).getAttribute("aria-pressed"), "true");
    await click("Latest reported", valuesWindow());
    assert.equal(valuesWindow().querySelector("header p").textContent, "Latest reported");
    assert.equal(button("Latest reported", valuesWindow()).getAttribute("aria-pressed"), "true");
    await click("Displayed snapshot", valuesWindow());
    assert.equal(valuesWindow().querySelector("header p").textContent, "Selected snapshot 1/3");
    const tab = new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    await act(async () => valuesWindow().dispatchEvent(tab));
    assert.equal(tab.defaultPrevented, false, "modeless window must not trap Tab");
    const escape = new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => valuesWindow().dispatchEvent(escape));
    assert.equal(escape.defaultPrevented, false, "the owning inspector handles drawer Escape and focus restoration");
    assert.deepEqual(calls, [["latest"], ["displayed"]]);
});

test("empty inspector values and absent callbacks remain read-only without focus side effects", async () => {
    await render(RuntimeValuesPanel, {});
    assert.match(valuesWindow().textContent, /No variables reported/);
    assert.match(valuesWindow().textContent, /Slot contents not reported/);
    assert.equal(button("Latest reported", valuesWindow()).disabled, true);
    assert.equal(button("Displayed snapshot", valuesWindow()).disabled, true);
    const graphButton = document.createElement("button"); graphButton.textContent = "Graph action"; container.append(graphButton);
    graphButton.focus();
    await render(RuntimeValuesPanel, { snapshot: { datamodel: { global: { received: 1 } } } });
    assert.equal(document.activeElement, graphButton);
});

test("current slot and parameter values use the verified event maps instead of opaque slot text", async () => {
    const snapshot = freeze({ datamodel: { global: { "#_SLOTS": "[slots: null]" } },
        slotValues: {
            "/A#test": { value: "intermediate", dataType: "java.lang.String", timestamp, cleared: false },
            "/empty": { value: "", timestamp, cleared: false },
            "/cleared": { timestamp, cleared: true },
        },
        parameterValues: { "slots.SlotIO#A": { "#_WRITE": { value: false, expression: "@test_val", source: null, timestamp } } } });
    await render(RuntimeValuesPanel, { snapshot });
    const slots = [...valuesWindow().querySelectorAll(".runtime-values-slot")];
    assert.deepEqual(slots.map((row) => row.querySelector("strong code").textContent), ["/A#test", "/empty", "/cleared"]);
    assert.equal(slots[0].querySelector("pre").textContent, '"intermediate"');
    assert.match(slots[0].textContent, /java.lang.String/);
    assert.equal(slots[1].querySelector("pre").textContent, '""');
    assert.equal(slots[2].querySelector("pre"), null);
    assert.match(slots[2].textContent, /No value \(cleared\)/);
    assert.doesNotMatch(valuesWindow().textContent, /\[slots: null\]|Slot contents not reported/);
    const parameter = valuesWindow().querySelector(".runtime-values-parameter");
    assert.match(parameter.textContent, /slots.SlotIO#A/);
    assert.match(parameter.textContent, /#_WRITE/);
    assert.equal(parameter.querySelector("pre").textContent, "false");
    assert.match(parameter.textContent, /@test_val/);
});

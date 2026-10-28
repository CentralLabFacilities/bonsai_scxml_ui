import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../App.css", import.meta.url), "utf8");
const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
const drawer = readFileSync(new URL("../components/inspector/RuntimeAssignmentsDrawer.jsx", import.meta.url), "utf8");

const cssRule = (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
    return match?.[1] || "";
};

test("Inspector and Run Assignments occupy the same width-controlled dock", () => {
    assert.match(cssRule(".app"), /var\(--right-dock-width/);
    assert.match(cssRule(".editor-side-panel-inspector"), /grid-column:\s*5/);
    assert.match(cssRule(".runtime-assignments-panel"), /grid-column:\s*5/);
    assert.match(app, /"--right-dock-width": runtimeAssignmentsOpen/);
    assert.match(app, /panels\.preferences\.inspectorWidth/);
    assert.doesNotMatch(app, /"--runtime-assignments-width"/);
});

test("both ledges stay attached to the right panel boundary without a collapsed rail", () => {
    assert.match(cssRule(".right-panel-ledges"), /right:\s*var\(--right-dock-width/);
    assert.match(cssRule(".right-panel-ledges"), /flex-direction:\s*column/);
    assert.match(app, /<EditorPanelLedge side="inspector" panels=\{panels\}/);
    assert.match(app, /<RuntimeAssignmentsLedge open=\{runtimeAssignmentsOpen\}/);
    assert.match(cssRule(".runtime-assignments-panel.closed"), /display:\s*none/);
    assert.doesNotMatch(drawer, /className="runtime-assignments-ledge"/);
    assert.match(cssRule(".editor-panel-resize-inspector::after"), /display:\s*none/);
});

test("Run Logs stays in the editor; narrow mode has no phantom Inspector-width track", () => {
    assert.match(app, /<RunLogPanel session=\{runLogSession\}/);
    assert.match(cssRule('.app[data-panel-mode="drawers"]'), /var\(--right-dock-width/);
    assert.match(cssRule('.app[data-panel-mode="drawers"] .runtime-assignments-panel'), /grid-column:\s*2/);
    assert.match(cssRule('.app[data-panel-mode="drawers"] .editor-side-panel-inspector'), /right:\s*0/);
});


test("Loading Results is isolated from Run Logs and uses the HTTP load response", () => {
    const commander = readFileSync(new URL("../components/overlays/RuntimeCommander.jsx", import.meta.url), "utf8");
    const hook = readFileSync(new URL("../hooks/editor/useRunLogSocket.js", import.meta.url), "utf8");
    assert.match(commander, /setLoadMessages\(result\.messages\)/);
    assert.doesNotMatch(commander, /onRegisterLoadDiagnostic|captureLoadDiagnosticsRef/);
    assert.doesNotMatch(app, /handleLoadDiagnosticLog|registerLoadDiagnosticHandler/);
    assert.doesNotMatch(hook, /onLoadDiagnostic|extractMissingSlotDefinitions/);
});

test("Run Assignments can shrink independently of the Inspector", () => {
    assert.match(app, /minAssignmentsWidth = Math\.min\(190/);
    assert.match(app, /className="editor-panel-resize editor-panel-resize-assignments"/);
    assert.match(app, /setRunAssignmentsWidth\(constrainAssignmentsWidth/);
    assert.match(app, /"--inspector-resize-width": panels\.isDocked && \(panels\.inspectorOpen \|\| assignmentsVisible\)/);
    assert.match(cssRule(".editor-panel-resize-assignments"), /grid-column:\s*4/);
});

test("Run Assignments uses compact MemorySlot values without descriptive subtitles or slot key", () => {
    assert.match(drawer, /<CurrentValues title="Global Variables" values=/);
    assert.match(drawer, /<CurrentValues title="Local Variables" values=/);
    assert.doesNotMatch(drawer, /Globally accessible ·|Locally accessible ·/);
    assert.doesNotMatch(drawer, /Values reconstructed from timestamped slot writes/);
    assert.doesNotMatch(drawer, /No historical observation/);
    assert.doesNotMatch(drawer, /entry\.key/);
    assert.match(drawer, /: replay \? "null"/);
    assert.match(drawer, /className="datamodel-compact-list"/);
});

test("Loading status lives in the badge rather than a redundant caption", () => {
    const commander = readFileSync(new URL("../components/overlays/RuntimeCommander.jsx", import.meta.url), "utf8");
    assert.match(commander, /runtimeBadgeStatus\(\{/);
    assert.match(commander, /loading: busyAction === "load"/);
    assert.doesNotMatch(commander, /setRuntimeNotice\("Loaded"\)/);
});


test("local runtime assignment changes use their declared or inferred type accent", () => {
    assert.match(drawer, /const local = change\.kind === "variable" && change\.scope === "local"/);
    assert.match(drawer, /valueType\(change\.value, change\.dataType \|\| declaredTypeByName\.get\(change\.name\)\)/);
    assert.match(drawer, /datamodel-type-accent-\$\{type\}/);
    assert.match(drawer, /declaredVariables=\{declaredVariables\}/);
    for (const [type, hex] of Object.entries({
        string: "38bdf8", boolean: "a855f7", integer: "14b8a6", double: "f59e0b", other: "64748b",
    })) {
        assert.match(cssRule(`.runtime-snapshot-change-row.local.datamodel-type-accent-${type}`),
            new RegExp(`border-left-color:\\s*#${hex}`, "i"));
    }
    assert.match(cssRule(".runtime-snapshot-change-row.slot"), /var\(--editor-slot-write/);
});

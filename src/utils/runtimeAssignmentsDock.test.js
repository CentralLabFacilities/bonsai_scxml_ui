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
    assert.match(app, /<RunLogPanel key=\{runLogSession\}/);
    assert.match(cssRule('.app[data-panel-mode="drawers"]'), /var\(--right-dock-width/);
    assert.match(cssRule('.app[data-panel-mode="drawers"] .runtime-assignments-panel'), /grid-column:\s*2/);
    assert.match(cssRule('.app[data-panel-mode="drawers"] .editor-side-panel-inspector'), /right:\s*0/);
});

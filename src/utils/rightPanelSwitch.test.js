import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolveRightPanelSwitch } from "./rightPanelSwitch.js";

const closed = { inspectorOpen: false, assignmentsOpen: false };
const inspector = { inspectorOpen: true, assignmentsOpen: false };
const run = { inspectorOpen: false, assignmentsOpen: true };

for (const [from, action, expected] of [
    [closed, "toggle-inspector", inspector],
    [inspector, "toggle-inspector", closed],
    [run, "toggle-inspector", inspector],
    [closed, "toggle-assignments", run],
    [run, "toggle-assignments", closed],
    [inspector, "toggle-assignments", run],
    [run, "open-inspector", inspector],
    [inspector, "open-assignments", run],
    [closed, "open-assignments", run],
    [run, "close-assignments", closed],
    [inspector, "close-assignments", inspector],
]) {
    test(`${action} from ${JSON.stringify(from)} keeps right panels exclusive`, () => {
        assert.deepEqual(resolveRightPanelSwitch(from, action), expected);
    });
}

test("every supported right-tab action preserves exclusivity", () => {
    for (const state of [closed, inspector, run, { inspectorOpen: true, assignmentsOpen: true }]) {
        for (const action of ["toggle-inspector", "toggle-assignments", "open-inspector", "open-assignments", "close-assignments"]) {
            const next = resolveRightPanelSwitch(state, action);
            assert.equal(next.inspectorOpen && next.assignmentsOpen, false);
        }
    }
});

test("all Inspector entry points and Run Assignments toggle use the coordinated controller", () => {
    const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
    const css = readFileSync(new URL("../App.css", import.meta.url), "utf8");
    assert.match(app, /if \(side === "inspector"\) switchRightPanel\("open-inspector"\)/);
    assert.match(app, /if \(side === "inspector"\) switchRightPanel\("toggle-inspector"\)/);
    assert.match(app, /switchRightPanel\("open-assignments"\)/);
    assert.match(app, /switchRightPanel\("toggle-assignments"\)/);
    assert.match(css, /\.right-panel-ledges\s*\{[^}]*--right-dock-width/s);
    assert.doesNotMatch(app, /runtimePanelFront/);
    assert.doesNotMatch(css, /data-runtime-front/);
});

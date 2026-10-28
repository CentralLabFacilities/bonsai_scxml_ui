import assert from "node:assert/strict";
import test from "node:test";
import { buildActiveValidationRequest, submachineActionDataModel } from "./editorValidation.js";

const sub = { id: "sub", type: "submachine", data: {
    label: "Search#2", fullSkillName: "Search#2", src: "${BEHAVIORS}/Search.xml",
    onEntry: [{ location: "childCount", expr: "@parentValue" }],
    localDataModel: [{ id: "oldChildVariable" }],
} };

test("Problems uses current opened child variables for submachine OnEntry", () => {
    const tabs = [{ id: "child", parentTabId: "root", sourcePath: sub.data.src,
        globalDataModel: [{ id: "#_STATE_PREFIX" }, { id: "_global" }, { id: "childCount" }] }];
    const request = buildActiveValidationRequest({ nodes: [sub], tabs, activeTabId: "root" });
    assert.deepEqual(request.nodeOverlays[0].localDataModel.map((x) => x.id), ["childCount"]);
    assert.equal(request.nodeOverlays[0].hasLocalDataModel, true);
});

test("Problems retains cached local variables without a matching child tab", () => {
    const request = buildActiveValidationRequest({ nodes: [sub], tabs: [], activeTabId: "root" });
    assert.deepEqual(request.nodeOverlays[0].localDataModel.map((x) => x.id), ["oldChildVariable"]);
});

test("two child tabs with ambiguous names must not override cached scope", () => {
    const tabs = ["a", "b"].map((id) => ({ id, parentTabId: "root", title: "Search#2",
        globalDataModel: [{ id: `${id}Count` }] }));
    assert.deepEqual(submachineActionDataModel(sub, tabs, "root"), sub.data.localDataModel);
});

test("ordinary skill validation does not invent a local datamodel", () => {
    const request = buildActiveValidationRequest({ nodes: [{ id: "skill", type: "custom", data: {} }] });
    assert.equal(request.nodeOverlays[0].hasLocalDataModel, false);
});

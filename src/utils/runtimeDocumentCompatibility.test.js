import test from "node:test";
import assert from "node:assert/strict";
import { sameRuntimeDocumentIgnoringPositions as sameDocument } from "./runtimeDocumentCompatibility.js";

const workflow = () => ({
    nodes: [
        { id: "skill-1", nodeType: "custom", parentId: null, label: "Wait#1",
          fullSkillName: "de.unibi.citec.clf.bonsai.skills.Wait#1",
          isInitial: true, events: [{ name: "Wait.success", target: "skill-2" }],
          x: 100, y: 200,
          editorPositions: [{ x: 100, y: 200, instanceId: "one", cloneType: null }] },
        { id: "skill-2", nodeType: "custom", parentId: null, label: "Wait#2",
          fullSkillName: "de.unibi.citec.clf.bonsai.skills.Wait#2",
          isInitial: false, events: [], x: 400, y: 200,
          editorPositions: [] },
    ],
    edges: [{ id: "edge-1", source: "skill-1", target: "skill-2", label: "Wait.success" }],
    dataModel: [{ id: "myVar", expression: "2" }],
    extraSlotDeclarations: [{ key: "Result", state: "Wait#1", xpath: "/result" }],
});
const serialized = (doc) => JSON.stringify(doc);

test("identical loaded and live documents remain compatible", () => {
    const original = serialized(workflow());
    assert.equal(sameDocument(original, original), true);
});

test("moving a skill after loading does not disable runtime camera focus", () => {
    const before = workflow();
    const after = structuredClone(before);
    after.nodes[0].x = -300;
    after.nodes[0].y = 900;
    after.nodes[0].editorPositions[0].x = -300;
    after.nodes[0].editorPositions[0].y = 900;
    assert.notEqual(serialized(before), serialized(after));
    assert.equal(sameDocument(serialized(before), serialized(after)), true);
});

test("semantic edits still invalidate the loaded runtime graph", () => {
    const original = workflow();
    const changes = [
        (w) => { w.nodes[0].id = "new-uuid"; },
        (w) => { w.nodes[0].label = "Wait#99"; },
        (w) => { w.nodes[0].fullSkillName = "Other#1"; },
        (w) => { w.nodes[0].parentId = "compound-1"; },
        (w) => { w.nodes[0].isInitial = false; },
        (w) => { w.nodes[0].events[0].target = "skill-1"; },
        (w) => { w.edges[0].target = "skill-1"; },
        (w) => { w.dataModel[0].expression = "3"; },
        (w) => { w.extraSlotDeclarations[0].xpath = "/other"; },
        (w) => { w.nodes[0].editorPositions[0].instanceId = "two"; },
    ];
    for (const change of changes) {
        const edited = structuredClone(original);
        change(edited);
        assert.equal(sameDocument(serialized(original), serialized(edited)), false,
            `semantic edit ${change.toString()} must invalidate`);
    }
});

test("unexpected fingerprints never crash and do not permit runtime following", () => {
    const before = serialized(workflow());
    assert.equal(sameDocument(before, "{not valid json"), false);
    assert.equal(sameDocument(before, "null"), false);
    assert.equal(sameDocument(null, before), false);
});

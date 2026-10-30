import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

let reconcileWorkflowInterface, collectWorkflowDependencyProblems, stripWorkflowInterfaceForHistory;
let buildRustEditorExportRequest, getWorkflowDocumentFingerprint;
let server;
test.before(async () => {
  server = await createServer({
    configFile: false,
    appType: "custom",
    server: { middlewareMode: true, hmr: false, ws: false, watch: { ignored: () => true } },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  ({ reconcileWorkflowInterface, collectWorkflowDependencyProblems, stripWorkflowInterfaceForHistory } =
    await server.ssrLoadModule("/src/utils/workflowInterface.js"));
  ({ buildRustEditorExportRequest, getWorkflowDocumentFingerprint } = await server.ssrLoadModule(
    "/src/utils/scxmlRustExport.js",
  ));
});
test.after(async () => server?.close());

const parent = () => ({
  id: "child",
  type: "submachine",
  position: { x: 10, y: 20 },
  data: {
    label: "Child",
    fullSkillName: "Child",
    src: "${ROOT}/child.scxml",
    isInitial: true,
    params: [{ key: "value", expr: "3" }],
    inSlots: [{ key: "input", path: "authored" }],
    events: [{ id: "old" }, { id: "unused" }],
    localDataModel: [{ id: "oldVariable", expr: "1" }],
    inheritedSlots: [{ path: "old-slot" }],
  },
});
const edges = [{ id: "exit", source: "child", sourceHandle: "old", target: "next", data: { cond: "@x > 1" } }];
const inspection = {
  path: "/child.scxml",
  fileVersion: "version-b",
  behaviorExitEvents: [],
  inheritedSlots: [],
  localDataModel: [],
};

test("removing the final exit keeps connected invalid handles synthetic and authored graph intact", () => {
  const node = parent();
  const updated = reconcileWorkflowInterface(node, inspection, { edges });
  assert.deepEqual(updated.data.events, [{ id: "old", editorImportedSynthetic: true, editorBoundarySynthetic: false }]);
  assert.deepEqual(updated.data.localDataModel, []);
  assert.deepEqual(updated.data.inheritedSlots, []);
  assert.equal(updated.data.src, node.data.src);
  assert.equal(updated.data.params, node.data.params);
  assert.equal(updated.data.inSlots, node.data.inSlots);
  assert.equal(edges[0].data.cond, "@x > 1");
  assert.equal(reconcileWorkflowInterface(updated, inspection, { edges }), updated);
});

test("new declarations and local variables use disk inspection in native and normalized forms", () => {
  const native = {
    ...inspection,
    behaviorExitEvents: ["done"],
    inheritedSlots: [{ key: "request", path: "shared" }],
    localDataModel: [{ id: "count", expression: "4" }],
  };
  const updated = reconcileWorkflowInterface(parent(), native, { edges });
  assert.equal(updated.data.events.find((event) => event.id === "done").editorImportedSynthetic, false);
  assert.deepEqual(updated.data.localDataModel, [{ id: "count", expr: "4" }]);
  assert.equal(updated.data.inheritedSlots[0].path, "shared");
  const { inheritedSlots, ...rest } = native;
  assert.deepEqual(
    reconcileWorkflowInterface(parent(), { ...rest, inheritedSlotDeclarations: inheritedSlots }, { edges }),
    updated,
  );
});

test("unreadable dependencies retain last facts with actionable node problems and recover", () => {
  const node = reconcileWorkflowInterface(parent(), inspection, { edges });
  const stale = reconcileWorkflowInterface(node, null, { state: "invalid", error: "Malformed SCXML" });
  assert.equal(stale.data.events, node.data.events);
  assert.equal(stale.data.localDataModel, node.data.localDataModel);
  const [problem] = collectWorkflowDependencyProblems([stale]);
  assert.equal(problem.nodeId, node.id);
  assert.match(problem.message, /Malformed SCXML/);
  assert.deepEqual(collectWorkflowDependencyProblems([reconcileWorkflowInterface(stale, inspection, { edges })]), []);
});

test("interface refresh cannot change parent serialized semantics, dirty fingerprint or history equality", () => {
  const node = parent();
  const graph = {
    nodes: [node],
    edges,
    manualSlots: [{ id: "imported", key: "shared", path: "shared", slotKind: "inheritSlot" }],
    globalDataModel: [],
  };
  const refreshed = { ...graph, nodes: [reconcileWorkflowInterface(node, inspection, { edges })] };
  assert.deepEqual(buildRustEditorExportRequest(refreshed), buildRustEditorExportRequest(graph));
  assert.equal(getWorkflowDocumentFingerprint(refreshed), getWorkflowDocumentFingerprint(graph));
  assert.deepEqual(stripWorkflowInterfaceForHistory(refreshed.nodes[0]), stripWorkflowInterfaceForHistory(node));
  const authored = {
    ...refreshed,
    nodes: [{ ...refreshed.nodes[0], data: { ...refreshed.nodes[0].data, params: [{ key: "value", expr: "9" }] } }],
  };
  assert.notEqual(getWorkflowDocumentFingerprint(authored), getWorkflowDocumentFingerprint(graph));
});

test("authored event transitions survive removal and restoration of their declared exit", () => {
  const node = parent();
  node.data.events = [{ id: "old", target: "next", cond: "@x", assignments: [{ location: "x", expr: "2" }] }];
  const stale = reconcileWorkflowInterface(node, inspection);
  assert.equal(stale.data.events[0].target, "next");
  assert.equal(stale.data.events[0].editorImportedSynthetic, true);
  const restored = reconcileWorkflowInterface(stale, { ...inspection, behaviorExitEvents: ["old"] });
  assert.equal(restored.data.events[0].editorImportedSynthetic, false);
  assert.deepEqual(stripWorkflowInterfaceForHistory(restored), stripWorkflowInterfaceForHistory(node));
});

test("explicit manual declarations persist without bindings or complete identities", () => {
  const graph = {
    nodes: [],
    edges: [],
    globalDataModel: [],
    manualSlots: [
      { id: "manual-path", path: "/resource" },
      { id: "manual-inherited", path: "/inherited", slotKind: "inheritSlot" },
      { key: "defaultslot", state: "*", path: "defaultslot" },
      { key: "unused", state: "Absent", path: "/unused" },
    ],
  };
  assert.deepEqual(buildRustEditorExportRequest(graph).extraSlotDeclarations, [
    { key: "", state: "", xpath: "/resource", inherited: false },
    { key: "", state: "", xpath: "/inherited", inherited: true },
    { key: "defaultslot", state: "*", xpath: "defaultslot", inherited: false },
    { key: "unused", state: "Absent", xpath: "/unused", inherited: false },
  ]);
  assert.notEqual(getWorkflowDocumentFingerprint(graph), getWorkflowDocumentFingerprint({ ...graph, manualSlots: [] }));
});

test("existing synthetic diagnostics and captured workflow datamodel survive child-open reconciliation", () => {
  const node = parent();
  const diagnostic = { id: "missing", editorBoundarySynthetic: true };
  node.data.events.push(diagnostic);
  const updated = reconcileWorkflowInterface(node, {
    ...inspection,
    workflow: {
      dataModel: [
        { id: "opened", expression: "3" },
        { id: "_global", expression: "1" },
      ],
    },
  });
  assert.equal(updated.data.events[0], diagnostic);
  assert.deepEqual(updated.data.localDataModel, [{ id: "opened", expr: "3" }]);
});

test("a freshly loaded parent recovers cached last-known interface facts while the dependency is stale", () => {
  const fresh = { ...parent(), data: { ...parent().data, events: [], inheritedSlots: [], localDataModel: [] } };
  const lastGood = {
    ...inspection,
    behaviorExitEvents: ["done"],
    inheritedSlots: [{ key: "input", path: "required" }],
    localDataModel: [{ id: "childValue", expression: "7" }],
  };
  const stale = reconcileWorkflowInterface(fresh, lastGood, { state: "invalid", error: "New child bytes are invalid" });
  assert.equal(stale.data.events[0].id, "done");
  assert.equal(stale.data.inheritedSlots[0].path, "required");
  assert.equal(stale.data.localDataModel[0].expr, "7");
  assert.equal(stale.data.dependencyInterface.fileVersion, "version-b");
  assert.equal(stale.data.dependencyInterface.state, "invalid");
  assert.equal(
    reconcileWorkflowInterface(stale, lastGood, { state: "invalid", error: "New child bytes are invalid" }),
    stale,
  );
  assert.equal(fresh.data.src, stale.data.src);
  assert.equal(fresh.data.params, stale.data.params);
});

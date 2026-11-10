import { collectInheritedSlotUsages } from "./editorGraph.js";
import { getLogicalEdgeSourceHandle, getLogicalEdgeSourceId } from "./transitionSemantics.js";
import { getLocalDataModelEntries } from "./editorScxml.js";

/** Apply disk-derived facts without changing authored bindings, source or edges. */
export function reconcileWorkflowInterface(
  node,
  inspection,
  { edges = [], state = "current", error = null, childNodes = null } = {},
) {
  if (node?.type !== "submachine" || !node.data?.src) return node;
  const previous = node.data;
  if (!inspection) {
    const dependencyInterface = {
      ...previous.dependencyInterface,
      state,
      error: String(error?.message || error || "The referenced workflow could not be inspected."),
    };
    if (JSON.stringify(previous.dependencyInterface) === JSON.stringify(dependencyInterface)) return node;
    return { ...node, data: { ...previous, dependencyInterface } };
  }

  const confirmed = new Set((inspection.behaviorExitEvents || []).map(String));
  const connected = new Set();
  for (const edge of edges) {
    if (getLogicalEdgeSourceId(edge) === node.id) connected.add(String(getLogicalEdgeSourceHandle(edge)));
    if (edge.source === node.id && edge.sourceHandle) connected.add(String(edge.sourceHandle));
    for (const source of edge.data?.boundaryOriginalSources || []) {
      if ((source.sourceId || source.nodeId || source.id) === node.id) {
        const handle = source.sourceHandle || source.handle;
        if (handle) connected.add(String(handle));
      }
    }
  }
  const byId = new Map((previous.events || []).map((event) => [String(event.id), event]));
  const events = [...confirmed].map((id) => ({
    ...byId.get(id),
    id,
    editorImportedSynthetic: false,
    editorBoundarySynthetic: false,
  }));
  for (const id of connected) {
    if (!confirmed.has(id))
      events.push({ ...byId.get(id), id, editorImportedSynthetic: true, editorBoundarySynthetic: false });
  }
  // Retain existing synthetic diagnostics and legacy event-owned transitions.
  for (const event of previous.events || []) {
    const id = String(event.id);
    if (confirmed.has(id) || connected.has(id)) continue;
    if (event.editorImportedSynthetic || event.editorBoundarySynthetic) {
      events.push(event);
    } else if (event.target) {
      events.push({ ...event, editorImportedSynthetic: true, editorBoundarySynthetic: false });
    }
  }
  // Access/type for inherited slot edges only exists in the projected child
  // (skill definitions are a server-side join). Without a fresh projection,
  // retain the last fully hydrated facts instead of clobbering them with the
  // access-less declarations fallback.
  const declarations = inspection.inheritedSlotDeclarations || inspection.inheritedSlots || [];
  const hydratedBefore = previous.dependencyInterface?.interfaceFileVersion != null;
  const inheritedSlots = Array.isArray(childNodes)
    ? collectInheritedSlotUsages(childNodes, declarations)
    : hydratedBefore
      ? previous.inheritedSlots
      : collectInheritedSlotUsages([], declarations);
  const localDataModel = getLocalDataModelEntries(
    inspection.workflow?.dataModel || inspection.localDataModel || [],
  ).map((entry) => ({
    id: entry.id,
    expr: entry.expr ?? entry.expression ?? "",
    ...(entry.typeName ? { type: entry.typeName } : {}),
  }));
  const dependencyInterface = {
    state,
    fileVersion: inspection.fileVersion ?? null,
    // Version whose projected child produced the current inheritedSlots.
    interfaceFileVersion: Array.isArray(childNodes)
      ? (inspection.fileVersion ?? null)
      : (previous.dependencyInterface?.interfaceFileVersion ?? null),
    path: inspection.path ?? null,
    error:
      state === "current" ? null : String(error?.message || error || "The referenced workflow could not be inspected."),
  };
  const patch = { events, inheritedSlots, localDataModel, dependencyInterface };
  if (Object.entries(patch).every(([key, value]) => JSON.stringify(previous[key]) === JSON.stringify(value)))
    return node;
  return { ...node, data: { ...previous, ...patch } };
}

export function collectWorkflowDependencyProblems(nodes = []) {
  return nodes
    .filter(
      (node) =>
        node.type === "submachine" &&
        node.data?.dependencyInterface?.state !== "current" &&
        node.data?.dependencyInterface?.state,
    )
    .map((node) => ({
      id: `dependency:${node.id}`,
      nodeId: node.id,
      severity: "error",
      title: "Stale behavior interface",
      message: `${node.data.src}: ${node.data.dependencyInterface.error || "The referenced workflow is unavailable."}`,
    }));
}

/** Exclude dependency snapshots from undo equality while retaining authored events. */
export function stripWorkflowInterfaceForHistory(node) {
  if (node?.type !== "submachine") return node;
  const data = { ...node.data };
  const events = data.events || [];
  delete data.inheritedSlots;
  delete data.localDataModel;
  delete data.dependencyInterface;
  return {
    ...node,
    data: {
      ...data,
      events: events
        .filter((event) => event.target)
        .map((event) => {
          const authored = { ...event };
          delete authored.editorImportedSynthetic;
          delete authored.editorBoundarySynthetic;
          return authored;
        }),
    },
  };
}

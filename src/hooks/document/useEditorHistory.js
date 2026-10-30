import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { isEditorShortcutBlocked } from "../interaction/useGlobalEditorShortcuts";
import { stripWorkflowInterfaceForHistory } from "../../utils/workflowInterface.js";

const cloneGraphValue = (value) => {
  if (Array.isArray(value)) return value.map(cloneGraphValue);
  if (value && typeof value === "object") {
    const clone = {};
    Object.entries(value).forEach(([key, entry]) => {
      clone[key] = cloneGraphValue(entry);
    });
    return clone;
  }
  return value;
};

const HISTORY_NODE_VOLATILE_KEYS = new Set(["selected", "dragging", "measured"]);
const HISTORY_EDGE_VOLATILE_KEYS = new Set(["selected"]);

const historyValueEqual = (a, b, ignoredKeys = null) => {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") {
    return false;
  }

  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (aIsArray !== bIsArray) return false;

  if (aIsArray) {
    if (a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) {
      if (!historyValueEqual(a[index], b[index])) return false;
    }
    return true;
  }

  const aKeys = Object.keys(a).filter((key) => !ignoredKeys?.has(key));
  const bKeys = Object.keys(b).filter((key) => !ignoredKeys?.has(key));
  if (aKeys.length !== bKeys.length) return false;

  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!historyValueEqual(a[key], b[key])) return false;
  }
  return true;
};

const sanitizeNodeForHistory = (node) => {
  const copy = cloneGraphValue(stripWorkflowInterfaceForHistory(node));
  HISTORY_NODE_VOLATILE_KEYS.forEach((key) => delete copy[key]);
  return copy;
};

const sanitizeEdgeForHistory = (edge) => {
  const copy = cloneGraphValue(edge);
  HISTORY_EDGE_VOLATILE_KEYS.forEach((key) => delete copy[key]);
  return copy;
};

const isUndoRedoEditableTarget = (target) => {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"], .monaco-editor, .cm-editor'),
  );
};

const collectionsEqualByIdentity = (a = [], b = []) => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
};

const snapshotsEqual = (a, b) => {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.nodes === b.nodes &&
    a.edges === b.edges &&
    a.slotNodes === b.slotNodes &&
    a.slotEdges === b.slotEdges &&
    a.manualSlots === b.manualSlots &&
    a.globalDataModel === b.globalDataModel
  );
};

export function useEditorHistory({
  activeTabId,
  activeDocumentGeneration,
  getActiveDocumentIdentity,
  activeMode,
  isDraggingNode,
  nodes,
  edges,
  slotNodes,
  slotEdges,
  manualSlots,
  globalDataModel,
  setNodes,
  setEdges,
  setSlotNodes,
  setSlotEdges,
  setManualSlots,
  setGlobalDataModel,
  setSelectedNodeId,
  setRightPanelTab,
  updateNodeInternals,
  syncRustDocument,
}) {
  const historyRef = useRef([]);
  const historyIndexRef = useRef(-1);
  const historyTimerRef = useRef(null);
  const owner = useMemo(
    () => ({ id: activeTabId, generation: activeDocumentGeneration }),
    [activeTabId, activeDocumentGeneration],
  );
  const historyOwnerRef = useRef(null);
  const historyEpochRef = useRef(0);
  const restoreFramesRef = useRef(new Set());
  const applyingHistoryRef = useRef(false);
  const liveHistoryStateRef = useRef(null);

  // History used to deep-clone the complete graph, JSON.stringify it, and
  // deep-clone it a second time for every commit. Large state machines pay
  // that cost even if only one node changed. These caches canonicalize the
  // history representation per node/edge and let snapshots structurally
  // share every unchanged object with previous entries. The snapshot objects
  // are detached clones and are never mutated; undo/redo clones only when a
  // snapshot is actually restored.
  const nodeHistoryCacheRef = useRef(new Map());
  const edgeHistoryCacheRef = useRef(new Map());
  const slotNodeHistoryCacheRef = useRef(new Map());
  const slotEdgeHistoryCacheRef = useRef(new Map());
  const manualSlotsHistoryCacheRef = useRef({ source: null, snapshot: [] });
  const dataModelHistoryCacheRef = useRef({ source: null, snapshot: [] });
  const lastCreatedSnapshotRef = useRef(null);

  useLayoutEffect(() => {
    liveHistoryStateRef.current = {
      nodes,
      edges,
      slotNodes,
      slotEdges,
      manualSlots,
      globalDataModel,
    };
  }, [nodes, edges, slotNodes, slotEdges, manualSlots, globalDataModel]);

  const resetSnapshotCaches = useCallback(() => {
    nodeHistoryCacheRef.current = new Map();
    edgeHistoryCacheRef.current = new Map();
    slotNodeHistoryCacheRef.current = new Map();
    slotEdgeHistoryCacheRef.current = new Map();
    manualSlotsHistoryCacheRef.current = { source: null, snapshot: [] };
    dataModelHistoryCacheRef.current = { source: null, snapshot: [] };
    lastCreatedSnapshotRef.current = null;
  }, []);

  // Ownership is the tab incarnation plus this activation's epoch, not a
  // fingerprint or native revision. A -> B -> A must reject callbacks from
  // the first A even when its tab incarnation happens to match again.
  const invalidateHistory = useCallback(() => {
    historyEpochRef.current += 1;
    historyOwnerRef.current = null;
    historyRef.current = [];
    historyIndexRef.current = -1;
    applyingHistoryRef.current = false;
    clearTimeout(historyTimerRef.current);
    historyTimerRef.current = null;
    for (const frame of restoreFramesRef.current) cancelAnimationFrame(frame);
    restoreFramesRef.current.clear();
    resetSnapshotCaches();
  }, [resetSnapshotCaches]);
  const ownsHistory = useCallback(
    (epoch = historyEpochRef.current) => {
      if (historyOwnerRef.current !== owner || historyEpochRef.current !== epoch) return false;
      const identity = getActiveDocumentIdentity();
      if (identity.id === owner.id && identity.documentGeneration === owner.generation) return true;
      // Replacement was published before its new graph committed. Invalidate
      // now, but seed nothing until the new graph's layout phase.
      invalidateHistory();
      return false;
    },
    [owner, getActiveDocumentIdentity, invalidateHistory],
  );
  useLayoutEffect(() => () => invalidateHistory(), [invalidateHistory]);

  const canonicalizeGraphCollection = useCallback(
    (sourceItems, cacheRef, sanitize, ignoredKeys, previousCollection) => {
      const cache = cacheRef.current;
      const seenIds = new Set();
      const canonicalItems = (sourceItems || []).map((item, index) => {
        const cacheKey = item?.id ?? `__index_${index}`;
        seenIds.add(cacheKey);
        const cached = cache.get(cacheKey);

        if (cached?.source === item) return cached.snapshot;

        if (
          cached &&
          historyValueEqual(
            sanitize === sanitizeNodeForHistory ? stripWorkflowInterfaceForHistory(cached.source) : cached.source,
            sanitize === sanitizeNodeForHistory ? stripWorkflowInterfaceForHistory(item) : item,
            ignoredKeys,
          )
        ) {
          // React Flow frequently replaces a node/edge object only to
          // change selection state. Keep the already-sanitized history
          // object in that case so selection/hover cannot create a new
          // history snapshot or duplicate large graph data.
          cached.source = item;
          return cached.snapshot;
        }

        const snapshot = sanitize(item);
        cache.set(cacheKey, { source: item, snapshot });
        return snapshot;
      });

      // Prevent deleted graph objects from being retained forever by the
      // canonicalization cache.
      for (const cacheKey of cache.keys()) {
        if (!seenIds.has(cacheKey)) cache.delete(cacheKey);
      }

      return collectionsEqualByIdentity(previousCollection, canonicalItems) ? previousCollection : canonicalItems;
    },
    [],
  );

  const canonicalizeValueCollection = useCallback((source, cacheRef) => {
    const normalizedSource = source || [];
    const cached = cacheRef.current;
    if (cached.source === normalizedSource) return cached.snapshot;

    if (cached.source && historyValueEqual(cached.source, normalizedSource)) {
      cached.source = normalizedSource;
      return cached.snapshot;
    }

    const snapshot = cloneGraphValue(normalizedSource);
    cacheRef.current = { source: normalizedSource, snapshot };
    return snapshot;
  }, []);

  const createHistorySnapshot = useCallback(() => {
    const current = liveHistoryStateRef.current || {};
    const previous = lastCreatedSnapshotRef.current || {};

    const snapshot = {
      nodes: canonicalizeGraphCollection(
        current.nodes || [],
        nodeHistoryCacheRef,
        sanitizeNodeForHistory,
        HISTORY_NODE_VOLATILE_KEYS,
        previous.nodes,
      ),
      edges: canonicalizeGraphCollection(
        current.edges || [],
        edgeHistoryCacheRef,
        sanitizeEdgeForHistory,
        HISTORY_EDGE_VOLATILE_KEYS,
        previous.edges,
      ),
      slotNodes: canonicalizeGraphCollection(
        current.slotNodes || [],
        slotNodeHistoryCacheRef,
        sanitizeNodeForHistory,
        HISTORY_NODE_VOLATILE_KEYS,
        previous.slotNodes,
      ),
      slotEdges: canonicalizeGraphCollection(
        current.slotEdges || [],
        slotEdgeHistoryCacheRef,
        sanitizeEdgeForHistory,
        HISTORY_EDGE_VOLATILE_KEYS,
        previous.slotEdges,
      ),
      manualSlots: canonicalizeValueCollection(current.manualSlots || [], manualSlotsHistoryCacheRef),
      globalDataModel: canonicalizeValueCollection(current.globalDataModel || [], dataModelHistoryCacheRef),
    };

    if (snapshotsEqual(previous, snapshot)) return previous;
    lastCreatedSnapshotRef.current = snapshot;
    return snapshot;
  }, [canonicalizeGraphCollection, canonicalizeValueCollection]);

  // Collapse all geometry churn to one dependency value while dragging.
  // The effect runs once when the drag starts and once again with the final
  // graph after drop, instead of once per pointer-driven node update.
  const historyNodesDependency = isDraggingNode ? null : nodes;
  const historyEdgesDependency = isDraggingNode ? null : edges;
  const historySlotNodesDependency = isDraggingNode ? null : slotNodes;
  const historySlotEdgesDependency = isDraggingNode ? null : slotEdges;
  const historyManualSlotsDependency = isDraggingNode ? null : manualSlots;
  const historyDataModelDependency = isDraggingNode ? null : globalDataModel;

  const commitHistorySnapshot = useCallback((snapshot) => {
    if (!snapshot) return false;
    const currentEntry = historyRef.current[historyIndexRef.current];
    if (snapshotsEqual(currentEntry?.snapshot, snapshot)) return false;

    const nextHistory = historyRef.current.slice(0, historyIndexRef.current + 1);
    // Snapshot data is already detached from live React state and uses
    // structural sharing. Do not clone it again here.
    nextHistory.push({ snapshot });
    if (nextHistory.length > 20) {
      nextHistory.splice(0, nextHistory.length - 20);
    }
    historyRef.current = nextHistory;
    historyIndexRef.current = nextHistory.length - 1;
    return true;
  }, []);

  useLayoutEffect(() => {
    const identity = getActiveDocumentIdentity();
    if (identity.id !== owner.id || identity.documentGeneration !== owner.generation) {
      invalidateHistory();
      return;
    }
    if (historyOwnerRef.current !== owner) {
      invalidateHistory();
      historyOwnerRef.current = owner;
      commitHistorySnapshot(createHistorySnapshot());
      return;
    }
    if (isDraggingNode) {
      if (historyTimerRef.current) {
        clearTimeout(historyTimerRef.current);
        historyTimerRef.current = null;
      }
      return;
    }

    if (applyingHistoryRef.current) {
      // All state setters used by a history restore are normally batched,
      // but React Flow can still emit one extra derived update. Only
      // consume the restore guard once the live graph has converged on
      // the history entry; otherwise that extra update gets recorded as
      // a new branch and destroys redo / traps Ctrl+Z on one step.
      const restoredSnapshot = createHistorySnapshot();
      const currentEntry = historyRef.current[historyIndexRef.current];
      if (snapshotsEqual(currentEntry?.snapshot, restoredSnapshot)) {
        applyingHistoryRef.current = false;
      }
      return;
    }

    if (historyRef.current.length === 0) {
      commitHistorySnapshot(createHistorySnapshot());
      return;
    }

    if (historyTimerRef.current) clearTimeout(historyTimerRef.current);
    const epoch = historyEpochRef.current;
    historyTimerRef.current = setTimeout(() => {
      if (!ownsHistory(epoch)) return;
      historyTimerRef.current = null;
      commitHistorySnapshot(createHistorySnapshot());
    }, 180);

    return () => {
      if (historyTimerRef.current) {
        clearTimeout(historyTimerRef.current);
        historyTimerRef.current = null;
      }
    };
  }, [
    owner,
    ownsHistory,
    getActiveDocumentIdentity,
    invalidateHistory,
    isDraggingNode,
    historyNodesDependency,
    historyEdgesDependency,
    historySlotNodesDependency,
    historySlotEdgesDependency,
    historyManualSlotsDependency,
    historyDataModelDependency,
    createHistorySnapshot,
    commitHistorySnapshot,
    resetSnapshotCaches,
  ]);

  const applyHistorySnapshot = useCallback(
    (snapshot) => {
      if (!snapshot || !ownsHistory()) return;
      const epoch = historyEpochRef.current;
      if (historyTimerRef.current) {
        clearTimeout(historyTimerRef.current);
        historyTimerRef.current = null;
      }
      applyingHistoryRef.current = true;

      // Restore the exact saved document. Geometry normalization here used
      // to mutate the snapshot during undo, which immediately created a new
      // history entry and made redo impossible.
      const restoredNodes = cloneGraphValue(snapshot.nodes || []).map((node) => ({
        ...node,
        selected: false,
      }));

      const restoredEdges = cloneGraphValue(snapshot.edges || []).map((edge) => ({
        ...edge,
        selected: false,
      }));
      const restoredSlotNodes = cloneGraphValue(snapshot.slotNodes || []).map((node) => ({
        ...node,
        selected: false,
      }));
      const restoredSlotEdges = cloneGraphValue(snapshot.slotEdges || []).map((edge) => ({
        ...edge,
        selected: false,
      }));
      const restoredManualSlots = cloneGraphValue(snapshot.manualSlots || []);
      const restoredGlobalDataModel = cloneGraphValue(snapshot.globalDataModel || []);

      const primeGraphCache = (cacheRef, liveItems, snapshotItems) => {
        cacheRef.current = new Map(
          (liveItems || []).map((item, index) => [
            item?.id ?? `__index_${index}`,
            {
              source: item,
              snapshot: snapshotItems?.[index],
            },
          ]),
        );
      };

      // Prime the structural-sharing caches with the historical objects so
      // the next effect recognizes the restored state by identity instead
      // of treating it as a fresh edit.
      primeGraphCache(nodeHistoryCacheRef, restoredNodes, snapshot.nodes || []);
      primeGraphCache(edgeHistoryCacheRef, restoredEdges, snapshot.edges || []);
      primeGraphCache(slotNodeHistoryCacheRef, restoredSlotNodes, snapshot.slotNodes || []);
      primeGraphCache(slotEdgeHistoryCacheRef, restoredSlotEdges, snapshot.slotEdges || []);
      manualSlotsHistoryCacheRef.current = {
        source: restoredManualSlots,
        snapshot: snapshot.manualSlots || [],
      };
      dataModelHistoryCacheRef.current = {
        source: restoredGlobalDataModel,
        snapshot: snapshot.globalDataModel || [],
      };
      lastCreatedSnapshotRef.current = snapshot;

      setNodes(restoredNodes);
      setEdges(restoredEdges);
      setSlotNodes(restoredSlotNodes);
      setSlotEdges(restoredSlotEdges);
      setManualSlots(restoredManualSlots);
      setGlobalDataModel(restoredGlobalDataModel);
      setSelectedNodeId(null);
      setRightPanelTab("datamodel");

      // Undo/redo restores the complete editor document atomically. Mirror
      // that exact snapshot into the Rust-owned semantic document instead of
      // leaving Rust at the revision that existed before the history jump.
      // Passing the restored values explicitly also avoids depending on a
      // later React render to refresh the bridge refs.
      void syncRustDocument?.({
        nodes: restoredNodes,
        edges: restoredEdges,
        manualSlots: restoredManualSlots,
        globalDataModel: restoredGlobalDataModel,
      }).catch((error) => {
        console.warn("Failed to synchronize Rust document after history restore.", error);
      });

      const frame = requestAnimationFrame(() => {
        restoreFramesRef.current.delete(frame);
        if (!ownsHistory(epoch)) return;
        restoredNodes.forEach((node) => updateNodeInternals(node.id));
      });
      restoreFramesRef.current.add(frame);
    },
    [
      ownsHistory,
      setNodes,
      setEdges,
      setSlotNodes,
      setSlotEdges,
      setManualSlots,
      setGlobalDataModel,
      setSelectedNodeId,
      setRightPanelTab,
      updateNodeInternals,
      syncRustDocument,
    ],
  );

  const flushPendingHistorySnapshot = useCallback(() => {
    if (!ownsHistory()) return false;
    // Only flush a snapshot when the normal debounced history writer still
    // has an edit waiting to be committed. Re-committing on every undo can
    // add the just-restored state back to the history and trap Ctrl+Z on a
    // single entry.
    if (!historyTimerRef.current) return false;

    clearTimeout(historyTimerRef.current);
    historyTimerRef.current = null;
    return commitHistorySnapshot(createHistorySnapshot());
  }, [commitHistorySnapshot, createHistorySnapshot, ownsHistory]);

  const undo = useCallback(() => {
    if (!ownsHistory()) return false;
    flushPendingHistorySnapshot();
    if (historyIndexRef.current <= 0) return false;
    historyIndexRef.current -= 1;
    applyHistorySnapshot(historyRef.current[historyIndexRef.current]?.snapshot);
    return true;
  }, [applyHistorySnapshot, flushPendingHistorySnapshot, ownsHistory]);

  const redo = useCallback(() => {
    if (!ownsHistory()) return false;
    if (historyIndexRef.current >= historyRef.current.length - 1) return false;
    historyIndexRef.current += 1;
    applyHistorySnapshot(historyRef.current[historyIndexRef.current]?.snapshot);
    return true;
  }, [applyHistorySnapshot, ownsHistory]);

  useEffect(() => {
    const handleUndoRedoShortcut = (event) => {
      if (event.defaultPrevented || isEditorShortcutBlocked(event)) return;
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (activeMode === "code") return;
      if (isUndoRedoEditableTarget(event.target)) return;

      const key = String(event.key || "").toLowerCase();
      let handled = false;
      if (key === "z") handled = event.shiftKey ? redo() : undo();
      else if (key === "y" && !event.shiftKey) handled = redo();
      if (!handled) return;
      event.preventDefault();
      event.stopPropagation();
    };

    window.addEventListener("keydown", handleUndoRedoShortcut, true);
    return () => window.removeEventListener("keydown", handleUndoRedoShortcut, true);
  }, [activeMode, undo, redo]);

  return { undo, redo };
}

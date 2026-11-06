import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { revalidateWorkflowSources } from "../../tauri-client.js";
import { reconcileWorkflowInterface } from "../../utils/workflowInterface.js";

const sourceKey = (src, currentFilePath) => JSON.stringify([src, currentFilePath || null]);
const tabSource = (tab) => tab.diskSource || { src: tab.filePath, currentFilePath: null };
const tabSourceKey = (tab) => sourceKey(tabSource(tab).src, tabSource(tab).currentFilePath);
const sameDocument = (tab, ticket) => tab && tab.id === ticket.id &&
    tab.documentGeneration === ticket.documentGeneration && tab.filePath === ticket.filePath &&
    tabSourceKey(tab) === tabSourceKey(ticket);

// One scheduler owns all file-backed tabs and the reachable disk dependency graph.
// Source contexts are retained even when destinations coincide: each resolver
// authorization must be rechecked after a mapping change or symlink retarget.
export function useExternalWorkflowChanges(options) {
    const latest = useRef(options);
    const getTabsSnapshot = options.getTabsSnapshot;
    const state = useRef({ alive: false, epoch: 0, running: false, pending: false,
        facts: new Map(), preparations: new Map(), signature: "" });
    const mappingKey = JSON.stringify(options.behaviorDirectories || []);
    useLayoutEffect(() => { latest.current = options; });

    const registrations = useCallback(() => {
        const result = new Map();
        const add = (src, currentFilePath = null) => {
            if (!src) return;
            const key = sourceKey(src, currentFilePath);
            if (!result.has(key)) result.set(key, { src, currentFilePath });
        };
        for (const tab of latest.current.getTabsSnapshot()) {
            if (tab.filePath) add(tabSource(tab).src, tabSource(tab).currentFilePath);
            for (const node of tab.nodes || [])
                if (node.type === "submachine") add(node.data?.src, tab.filePath);
        }
        const expanded = new Set();
        // Map iterators include newly appended entries. Canonical visited paths
        // bound cycles without losing the separate declaring-source contexts.
        for (const [key] of result) {
            const fact = state.current.facts.get(key);
            const inspection = fact?.inspection;
            if (!inspection || expanded.has(inspection.path)) continue;
            expanded.add(inspection.path);
            for (const child of inspection.workflow?.states || [])
                if (child.source) add(child.source, inspection.path);
        }
        return result;
    }, []);

    const reconcileParents = useCallback(() => {
        const context = latest.current;
        const facts = state.current.facts;
        for (const tab of context.getTabsSnapshot()) {
            const nodes = (tab.nodes || []).map((node) => {
                if (node.type !== "submachine" || !node.data?.src) return node;
                const fact = facts.get(sourceKey(node.data.src, tab.filePath));
                if (!fact) return node;
                const findError = (entry, visited = new Set()) => {
                    if (!entry || visited.has(entry.path)) return null;
                    visited.add(entry.path);
                    if (!["changed", "unchanged"].includes(entry.state)) return entry;
                    for (const child of entry.inspection?.workflow?.states || []) {
                        if (!child.source) continue;
                        const error = findError(facts.get(sourceKey(child.source, entry.path)), visited);
                        if (error) return error;
                    }
                    return null;
                };
                const failure = findError(fact);
                if (!failure && !fact.inspection) return node;
                return reconcileWorkflowInterface(node, fact.inspection, {
                    edges: tab.edges,
                    state: failure?.state || "current",
                    error: failure?.error || null,
                });
            });
            if (nodes.some((node, index) => node !== tab.nodes[index])) {
                // Read again inside the graph transaction; never publish a
                // captured parent graph over concurrent edits or source changes.
                context.updateTab(tab.id, (current) => {
                    if (!sameDocument(current, tab) || current.nodes !== tab.nodes) return null;
                    return { nodes };
                });
            }
        }
    }, []);

    const publishObservation = useCallback((tab, fact) => {
        const context = latest.current;
        context.updateTab(tab.id, (current) => {
            if (!sameDocument(current, tab)) return null;
            const version = fact.fileVersion ?? null;
            const externalFileState = ["changed", "unchanged"].includes(fact.state)
                ? (version === current.diskVersion ? "current" : "changed") : fact.state;
            const error = fact.error || null;
            const externalRequiresApproval = externalFileState !== "current" && Boolean(
                current.externalRequiresApproval || current.isModified ||
                current.hasPendingLocalInteraction || current.diskSavePending);
            if (current.observedDiskVersion === version && current.externalFileState === externalFileState &&
                (current.externalFileError || null) === error &&
                Boolean(current.externalRequiresApproval) === externalRequiresApproval) return null;
            return { observedDiskVersion: version, externalFileState, externalFileError: error, externalRequiresApproval };
        });
    }, []);

    const prepareReload = useCallback((tab, fact, approved = false) => {
        const owner = state.current;
        const context = latest.current;
        if (!fact.inspection || !fact.fileVersion || !sameDocument(context.getTabSnapshot(tab.id), tab))
            return Promise.resolve(false);
        const epoch = owner.epoch;
        const key = JSON.stringify([epoch, tab.id, tab.documentGeneration, tabSourceKey(tab), fact.fileVersion, tab.fingerprint]);
        if (owner.preparations.has(key)) return owner.preparations.get(key).promise;
        const inspection = fact.inspection;
        const operation = Promise.resolve().then(async () => {
            try {
                const prepared = await context.prepareImportedDocument({ inspection,
                    filePath: inspection.path, fileName: inspection.fileName || tab.fileName, background: true });
                const current = latest.current.getTabSnapshot(tab.id);
                const observed = owner.facts.get(tabSourceKey(tab));
                if (!owner.alive || epoch !== owner.epoch || !sameDocument(current, tab) ||
                    observed?.fileVersion !== fact.fileVersion || !["changed", "unchanged"].includes(observed.state) ||
                    current.observedDiskVersion !== fact.fileVersion || current.diskSavePending ||
                    current.diskVersion === fact.fileVersion) return false;
                if (current.fingerprint !== tab.fingerprint || current.hasPendingLocalInteraction ||
                    (!approved && (current.isModified || current.externalRequiresApproval))) {
                    latest.current.updateTab(tab.id, { externalFileState: "changed", externalRequiresApproval: true,
                        externalFileError: "Local edits changed while reload was preparing. Choose Reload from disk again to approve discarding the current edits." });
                    return false;
                }
                latest.current.replaceTabDocument(tab.id, prepared.document, {
                    filePath: inspection.path, fileName: inspection.fileName || tab.fileName,
                    title: (inspection.fileName || tab.fileName).replace(/\.(xml|scxml)$/i, ""),
                    diskVersion: fact.fileVersion, observedDiskVersion: fact.fileVersion,
                    externalFileState: "current", externalFileError: null, externalKeptVersion: null,
                    inheritedGlobalDataModel: current.inheritedGlobalDataModel,
                    selectedNodeId: null, viewport: current.viewport, preserveViewport: true,
                });
                latest.current.notify({ id: `workflow-reload-${tab.id}`, tone: "info", title: "Workflow reloaded from disk",
                    message: `${inspection.fileName || tab.fileName} reflects external changes.`, duration: 4000 });
                return true;
            } catch (error) {
                const current = latest.current.getTabSnapshot(tab.id);
                if (owner.alive && epoch === owner.epoch && sameDocument(current, tab) &&
                    current.observedDiskVersion === fact.fileVersion)
                    latest.current.updateTab(tab.id, { externalFileState: "invalid", externalRequiresApproval: true,
                        externalFileError: String(error?.message || error) });
                return false;
            }
        }).finally(() => owner.preparations.delete(key));
        owner.preparations.set(key, { tabId: tab.id, generation: tab.documentGeneration,
            source: tabSourceKey(tab), version: fact.fileVersion, fingerprint: tab.fingerprint, promise: operation });
        return operation;
    }, []);

    const requestRevalidation = useCallback(function requestPass() {
        const owner = state.current;
        if (!owner.alive || !latest.current.isDesktop) return Promise.resolve();
        if (owner.running) { owner.pending = true; return owner.batch; }
        owner.running = true;
        const epoch = owner.epoch;
        owner.batch = Promise.resolve().then(async () => {
            do {
                owner.pending = false;
                const checked = new Set();
                // Only walk reachable references, never every library entry.
                while (owner.alive && owner.epoch === epoch) {
                    const registered = registrations();
                    const requests = [...registered].filter(([key]) => !checked.has(key)).slice(0, 128);
                    if (!requests.length) break;
                    const startedTabs = new Map(latest.current.getTabsSnapshot().map((tab) => [tab.id, tab]));
                    const requestKeys = new Set(requests.map(([key]) => key));
                    const results = await revalidateWorkflowSources(requests.map(([key, request]) => ({
                        ...request, fileVersion: owner.facts.get(key)?.fileVersion || null,
                    })), latest.current.behaviorDirectories || []);
                    if (!owner.alive || owner.epoch !== epoch) return;
                    const live = registrations();
                    requests.forEach(([key], index) => {
                        checked.add(key);
                        if (!live.has(key)) return;
                        const result = results[index];
                        if (!result) return;
                        const prior = owner.facts.get(key);
                        owner.facts.set(key, { ...result,
                            path: result.path || result.inspection?.path || prior?.path,
                            inspection: result.inspection || prior?.inspection,
                        });
                    });
                    for (const tab of latest.current.getTabsSnapshot()) {
                        if (!tab.filePath) continue;
                        if (!requestKeys.has(tabSourceKey(tab))) continue;
                        const started = startedTabs.get(tab.id);
                        if (!sameDocument(tab, started || {}) || tab.diskVersion !== started.diskVersion) {
                            owner.pending = true;
                            continue;
                        }
                        const fact = owner.facts.get(tabSourceKey(tab));
                        if (!fact) continue;
                        publishObservation(tab, fact);
                        const current = latest.current.getTabSnapshot(tab.id);
                        if (["changed", "unchanged"].includes(fact.state) && fact.fileVersion !== current.diskVersion &&
                            !current.isModified && !current.hasPendingLocalInteraction &&
                            !current.diskSavePending && !current.externalRequiresApproval &&
                            current.externalKeptVersion !== fact.fileVersion)
                            void prepareReload(current, fact);
                    }
                    reconcileParents();
                }
                const live = registrations();
                for (const key of owner.facts.keys()) if (!live.has(key)) owner.facts.delete(key);
            } while (owner.pending && owner.alive && owner.epoch === epoch);
        }).catch((error) => {
            if (!owner.alive || owner.epoch !== epoch) return;
            for (const tab of latest.current.getTabsSnapshot()) if (tab.filePath)
                latest.current.updateTab(tab.id, { externalFileState: "unreadable", externalFileError: String(error?.message || error) });
        }).finally(() => {
            owner.running = false;
            if (owner.pending && owner.alive) void requestPass();
        });
        return owner.batch;
    }, [registrations, publishObservation, prepareReload, reconcileParents]);

    useEffect(() => {
        if (!options.isDesktop) return;
        const owner = state.current;
        owner.alive = true;
        owner.epoch += 1;
        owner.facts.clear();
        const checkVisible = () => {
            if (document.visibilityState !== "hidden") void requestRevalidation();
        };
        const timer = window.setInterval(checkVisible, 2000);
        window.addEventListener("focus", checkVisible);
        document.addEventListener("visibilitychange", checkVisible);
        checkVisible();
        return () => {
            owner.alive = false;
            owner.epoch += 1;
            owner.pending = false;
            owner.facts.clear();
            owner.preparations.clear();
            window.clearInterval(timer);
            window.removeEventListener("focus", checkVisible);
            document.removeEventListener("visibilitychange", checkVisible);
        };
    }, [options.isDesktop, mappingKey, requestRevalidation]);

    useLayoutEffect(() => {
        if (!options.isDesktop || !state.current.alive) return;
        const tabs = getTabsSnapshot();
        const liveTabs = new Map(tabs.map((tab) => [tab.id, tab]));
        for (const [key, work] of state.current.preparations) {
            const current = liveTabs.get(work.tabId);
            if (!current || current.documentGeneration !== work.generation ||
                tabSourceKey(current) !== work.source || current.fingerprint !== work.fingerprint ||
                current.observedDiskVersion !== work.version) state.current.preparations.delete(key);
        }
        const signature = JSON.stringify(tabs.map((tab) => [tab.id, tab.documentGeneration, tab.filePath, tabSourceKey(tab),
            (tab.nodes || []).filter((node) => node.type === "submachine").map((node) => [node.id, node.data?.src])]));
        if (signature !== state.current.signature) {
            state.current.signature = signature;
            void requestRevalidation();
        }
        reconcileParents();
    }, [options.isDesktop, options.tabs, options.activeFingerprint, getTabsSnapshot,
        requestRevalidation, reconcileParents]);

    const reloadExternalFile = useCallback(async () => {
        const tab = latest.current.getTabSnapshot(latest.current.activeTab?.id);
        if (!tab?.filePath || tab.diskSavePending || tab.hasPendingLocalInteraction) return false;
        // The button itself is explicit approval for this local checkpoint.
        // Never route it through the ordinary Save/Discard guard.
        await requestRevalidation();
        const current = latest.current.getTabSnapshot(tab.id);
        if (!sameDocument(current, tab) || current.fingerprint !== tab.fingerprint) return false;
        const fact = state.current.facts.get(tabSourceKey(tab));
        if (!fact || !["changed", "unchanged"].includes(fact.state)) return false;
        return prepareReload(current, fact, true);
    }, [requestRevalidation, prepareReload]);
    const keepLocalFile = useCallback(() => {
        const tab = latest.current.getTabSnapshot(latest.current.activeTab?.id);
        if (tab) latest.current.updateTab(tab.id, { externalKeptVersion: tab.observedDiskVersion, externalRequiresApproval: true });
    }, []);
    const saveExternalFileAs = useCallback(() => latest.current.saveAs(latest.current.activeTab?.id), []);
    const tab = options.activeTab;
    const externalNotice = options.isDesktop && tab?.filePath && tab.externalFileState && tab.externalFileState !== "current"
        ? { action: "external", title: `${tab.fileName || tab.title}: ${tab.externalFileState === "changed" ? "external changes" : tab.externalFileState}`,
            message: tab.externalFileError || "This file changed on disk. Local edits and history have been preserved.",
            guidance: "Reload from disk discards local edits. Keep local retains this conflict; ordinary Save cannot overwrite the changed file. Save As writes to a separately confirmed destination.",
            canReload: tab.externalFileState === "changed", keptLocal: tab.externalKeptVersion === tab.observedDiskVersion,
            canRetry: true, persistent: true, busy: Boolean(tab.diskSavePending) }
        : null;
    return { externalNotice, requestRevalidation, reloadExternalFile, keepLocalFile, saveExternalFileAs };
}

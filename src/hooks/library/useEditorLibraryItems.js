import { useCallback, useLayoutEffect, useRef } from "react";

import { reconcileWorkflowInterface } from "../../utils/workflowInterface.js";
import { getNodeId } from "../../utils/editorGeometry";
import {
    ensureSharedEditorInstanceIds,
    getSharedScxmlStateId,
    normalizeSharedScxmlStateIdentity,
} from "../../utils/editorScxml";
import { availableLibrarySkillName } from "../../utils/libraryInitialState.js";
import {
    inspectWorkflowForEditorSource,
    projectWorkflowInspectionForEditor,
    getWorkflowFileKey,
} from "../../utils/workflowLoader";

export function useEditorLibraryItems({
    nodes,
    getDocumentSnapshot,
    behaviorDirectories,
    fetchSkillData,
    hydrateSubMachineInheritedSlots,
    handleOpenSubMachine,
    switchTab,
    openTab,
    getTabsSnapshot,
    checkSlotConnection,
    beginStateMachineLoad,
    endStateMachineLoad,
    onExternalRevalidate,
}) {
    const mappingEpoch = useRef(0);
    const mappingKey = JSON.stringify(behaviorDirectories || []);
    useLayoutEffect(() => {
        mappingEpoch.current += 1;
        return () => { mappingEpoch.current += 1; };
    }, [mappingKey]);
    const handleOpenBehaviorFile = useCallback(
        async (behavior) => {
            if (!behavior?.source) return;
            const epoch = mappingEpoch.current;

            beginStateMachineLoad(
                behavior.name?.replace(/\.(xml|scxml)$/i, "") || "State machine"
            );
            await new Promise((resolve) =>
                window.requestAnimationFrame(() =>
                    window.requestAnimationFrame(resolve)
                )
            );

            try {
                if (epoch !== mappingEpoch.current) return;
                // behavior.source remains ${KEY}/... for SCXML portability.
                // Rust resolves and caches the referenced workflow for local access.
                const loaded = await inspectWorkflowForEditorSource({
                    src: behavior.source,
                    directories: behaviorDirectories,
                    currentFilePath: null,
                });
                if (epoch !== mappingEpoch.current) return;

                const tabId = `tab-behavior-${loaded.path || behavior.source}`;
                const fileKey = getWorkflowFileKey(loaded.path);
                const existingTab = fileKey ? getTabsSnapshot().find((tab) =>
                    getWorkflowFileKey(tab.filePath) === fileKey) : null;

                if (existingTab) {
                    switchTab(existingTab.id);
                    onExternalRevalidate?.();
                    return;
                }

                const parsed = await projectWorkflowInspectionForEditor(loaded, {
                    fetchSkillData,
                    getNodeId,
                });
                const parsedNodes = ensureSharedEditorInstanceIds(
                    (await hydrateSubMachineInheritedSlots(
                        parsed.nodes,
                        loaded.path,
                        parsed.edges
                    )).map(normalizeSharedScxmlStateIdentity)
                );
                if (epoch !== mappingEpoch.current) return;

                const newTabObj = {
                    id: tabId,
                    title:
                        behavior.name?.replace(/\.(xml|scxml)$/i, "") ||
                        loaded.fileName,
                    fileName: loaded.fileName,
                    fileHandle: null,
                    filePath: loaded.path,
                    sourcePath: behavior.source,
                    diskVersion: loaded.fileVersion,
                    diskSource: { src: behavior.source || loaded.path, currentFilePath: null },
                    observedDiskVersion: loaded.fileVersion,
                    externalFileState: "current",
                    nodes: parsedNodes,
                    edges: parsed.edges,
                    slotNodes: [],
                    slotEdges: [],
                    manualSlots: parsed.manualSlots || [],
                    parentTabId: null,
                    selectedNodeId: null,
                    viewport: null,
                    inheritedGlobalDataModel: [],
                    globalDataModel: parsed.globalDataModel,
                };

                openTab(newTabObj, {
                    fit: true,
                    fitOptions: { duration: 300 },
                });
                checkSlotConnection(
                    parsedNodes,
                    parsed.manualSlots || [],
                    parsed.editorSlotNodes || []
                );
            } catch (error) {
                console.error("Could not open behavior:", error);
                throw error;
            } finally {
                endStateMachineLoad();
            }
        },
        [
            behaviorDirectories,
            getTabsSnapshot,
            beginStateMachineLoad,
            endStateMachineLoad,
            fetchSkillData,
            hydrateSubMachineInheritedSlots,
            switchTab,
            openTab,
            checkSlotConnection,
            onExternalRevalidate,
        ]
    );

    const createBehaviorNode = useCallback(
        async (behavior, position) => {
            const baseName = String(behavior?.name || "Behavior").replace(
                /\.(xml|scxml)$/i,
                ""
            );

            let inspection = null;

            try {
                if (behavior?.source) {
                    inspection = await inspectWorkflowForEditorSource({
                        src: behavior.source,
                        directories: behaviorDirectories,
                        currentFilePath: null,
                    });
                }
            } catch (error) {
                throw new Error(`Could not inspect ${behavior?.source || baseName}: ${error?.message || error}`, { cause: error });
            }


            const node = {
                id: getNodeId(),
                position,
                type: "submachine",
                data: {
                    label: baseName,
                    fullSkillName: baseName,
                    src: behavior.source,
                    isInitial: false,
                    events: [],
                    onEntry: [],
                    onExit: [],
                    onOpenSubMachine: handleOpenSubMachine,
                },
            };
            return inspection ? reconcileWorkflowInterface(node, inspection) : node;
        },
        [behaviorDirectories, handleOpenSubMachine]
    );

    const createNode = useCallback(
        async (selectedSkill, nodeid, position) => {
            const data = await fetchSkillData(selectedSkill);
            if (!data) {
                throw new Error(`Could not load ${selectedSkill}. Check the Bonsai backend and try again.`);
            }
            const baseSkillLabel = selectedSkill.split(".").pop() || selectedSkill;
            const isFinalSkill =
                baseSkillLabel.toLowerCase() === "end" ||
                baseSkillLabel.toLowerCase() === "fatal";
            const exposesBuiltInEvents =
                selectedSkill.split(".").pop() !== "End" &&
                selectedSkill.split(".").pop() !== "Fatal";

            // A second skill inspection may finish after the first insertion
            // has committed, while `nodes` still belongs to the render that
            // started both requests. Read the synchronous document reference.
            // The final append additionally checks its *transaction* snapshot.
            const liveNodes = getDocumentSnapshot?.()?.nodes || nodes;
            const createNameForSkill = (fullSkillName) => availableLibrarySkillName(liveNodes, fullSkillName);

            let sharedEditorInstanceId;
            if (isFinalSkill) {
                const sharedStateId = selectedSkill.split("#")[0];
                const usedIds = new Set(
                    liveNodes
                        .filter((node) => {
                            const candidate = normalizeSharedScxmlStateIdentity(node);
                            return (
                                getSharedScxmlStateId(candidate) === sharedStateId
                            );
                        })
                        .map((node) =>
                            String(node.data?.editorInstanceId || "").trim()
                        )
                        .filter(Boolean)
                );

                let index = 1;
                while (usedIds.has(String(index))) index += 1;
                sharedEditorInstanceId = String(index);
            }

            return {
                id: nodeid,
                position,
                type: "custom",
                data: {
                    label: baseSkillLabel,
                    fullSkillName: isFinalSkill
                        ? selectedSkill.split("#")[0]
                        : createNameForSkill(selectedSkill),
                    ...(isFinalSkill
                        ? {
                            scxmlStateId: selectedSkill.split("#")[0],
                            editorInstanceId: sharedEditorInstanceId,
                        }
                        : {}),
                    description: data.description || "",
                    isInitial: false,
                    isFinal: isFinalSkill,
                    src: "",
                    onEntry: [],
                    onExit: [],
                    events: [
                        ...(data.events || []).map((event) => ({
                            id: event.event,
                            description: event.description || "",
                            selectedPackage: "",
                            selectedSkill: "",
                            target: null,
                            cond: "",
                            assignments: [],
                            assignLocation: "",
                            assignExpr: "",
                        })),
                        ...(exposesBuiltInEvents
                            ? [
                                {
                                    id: "fatal",
                                    selectedPackage: "",
                                    selectedSkill: "",
                                    target: null,
                                    cond: "",
                                    assignments: [],
                                    assignLocation: "",
                                    assignExpr: "",
                                },
                                {
                                    id: "*",
                                    selectedPackage: "",
                                    selectedSkill: "",
                                    target: null,
                                    cond: "",
                                    assignments: [],
                                    assignLocation: "",
                                    assignExpr: "",
                                },
                            ]
                            : []),
                    ],
                    sensors: data.sensors || [],
                    actuators: data.actuator || data.actuators || [],
                    inSlots: (data.inSlots || []).map((slot) => ({
                        key: slot.key,
                        type: slot.type,
                        description: slot.description || "",
                        path: "",
                        inherited: null,
                    })),
                    outSlots: (data.outSlots || []).map((slot) => ({
                        key: slot.key,
                        type: slot.type,
                        description: slot.description || "",
                        path: "",
                        inherited: null,
                    })),
                    params: (data.params || []).map((param) => ({
                        key: param.key,
                        type: param.type,
                        required: param.required,
                        default: param.default,
                        description: param.description || "",
                    })),
                },
            };
        },
        [fetchSkillData, nodes, getDocumentSnapshot]
    );

    return {
        handleOpenBehaviorFile,
        createBehaviorNode,
        createNode,
    };
}

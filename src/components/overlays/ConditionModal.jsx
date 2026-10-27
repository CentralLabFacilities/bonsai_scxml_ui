import { isValidScxmlEventDescriptor } from "../../utils/transitionEventValidation.js";
import { COMPARISON_PATTERN, toEditorConditionOperator, allowedConditionOperator, isEqualityOnlyConditionType } from "../../utils/conditionOperators.js";
import { getTransitionHighlightColor } from "../../utils/editorGraph.js";
import { prepareLiveTransitionCommit } from "../../utils/transitionLiveCommit.js";
import { hasTransitionScopeHierarchy, reconcileExternallyRemovedTransitions } from "../../utils/transitionDrawerSync.js";
import { appendPublishedGraphTransitions } from "../../utils/transitionDrawerLiveSync.js";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
    FiArrowRight,
    FiChevronDown,
    FiChevronUp,
    FiPlus,
    FiMove,
    FiTrash2,
    FiX,
    FiAlertTriangle,
} from "react-icons/fi";
import { groupTransitionsByScope, getShadowedTransitions } from "../../utils/transitionScopes.js";
import TypedValueEditor from "../inputs/TypedValueEditor";
import { getVariableType } from "../../utils/valueTypes";
import {
    validateAssignmentValue,
    validateConditionValue,
} from "../../utils/valueValidation.js";
import ExpressionVariableSuggestions from "../inputs/ExpressionVariableSuggestions.jsx";
import { InlineFeedback } from "../ui/index.js";
import {
    getExpressionAutocompleteAction,
    getMatchingExpressionVariables,
    insertExpressionVariable,
} from "../inputs/expressionAutocomplete.js";



function createTransitionId(prefix = "transition") {
    if (globalThis.crypto?.randomUUID) {
        return `${prefix}-${globalThis.crypto.randomUUID()}`;
    }

    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createAssignmentId(prefix = "assignment") {
    return createTransitionId(prefix);
}

function getTransitionAssignments(transition, variables) {
    const fallbackLocation = variables[0]?.id || "";
    const rawAssignments = Array.isArray(transition.assignments)
        ? transition.assignments
        : transition.assignLocation
            ? [
                {
                    location: transition.assignLocation,
                    expr: transition.assignExpr || "",
                },
            ]
            : [];

    return rawAssignments.map((assignment, index) => ({
        assignmentId:
            assignment.assignmentId ||
            assignment.id ||
            createAssignmentId(`existing-assignment-${index}`),
        location: assignment.location || fallbackLocation,
        expr: assignment.expr || "",
    }));
}

function parseCondition(condition) {
    const text = String(condition || "").trim();
    if (!text) return null;

    const match = text.match(COMPARISON_PATTERN);
    if (!match) {
        return {
            variable: "",
            operator: "==",
            value: text,
        };
    }

    return {
        variable: match[1],
        operator: toEditorConditionOperator(match[2]),
        value: match[3],
    };
}

function hydrateTransition(transition, index, variables, fallbackEvent = "") {
    const parsedCondition = parseCondition(transition.cond);
    const conditionVariable = parsedCondition?.variable || variables[0]?.id || "";

    return {
        transitionId:
            transition.transitionId ||
            transition.edgeId ||
            createTransitionId(`existing-${index}`),
        edgeId: transition.edgeId || null,
        scopeId: transition.scopeId || "",
        scopeLabel: transition.scopeLabel || "Current state",
        scopeDepth: Number(transition.scopeDepth || 0),
        event:
            transition.event ||
            transition.eventId ||
            transition.sourceHandle ||
            fallbackEvent ||
            "",
        target: transition.target || "",
        targetLabel: transition.targetLabel || transition.target || "",
        originalTarget: transition.originalTarget || transition.target || "",
        sourceNodeId: transition.sourceNodeId || null,
        sourceNodeName: transition.sourceNodeName || "",
        eventDisplayName:
            transition.eventDisplayName ||
            transition.displayEvent ||
            transition.event ||
            transition.eventId ||
            transition.sourceHandle ||
            fallbackEvent ||
            "",
        availableTargetIds: Array.isArray(transition.availableTargetIds)
            ? transition.availableTargetIds
            : null,
        rawCondition: transition.cond || "",

        conditionEnabled: Boolean(parsedCondition),
        conditionVariable,
        conditionOperator: parsedCondition?.operator || "==",
        conditionValue: parsedCondition?.value || "",

        assignments: getTransitionAssignments(transition, variables),
    };
}

/** Insert an item before or after a target while keeping transition identities stable. */
export function reorderTransitionItems(items, movingId, targetId, position = "before") {
    const sourceIndex = items.findIndex((item) => item.transitionId === movingId);
    const targetIndex = items.findIndex((item) => item.transitionId === targetId);
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return items;
    if (String(items[sourceIndex].scopeId || "") !== String(items[targetIndex].scopeId || "")) return items;
    const reordered = [...items];
    const [moving] = reordered.splice(sourceIndex, 1);
    const targetAfterRemoval = reordered.findIndex((item) => item.transitionId === targetId);
    reordered.splice(targetAfterRemoval + (position === "after" ? 1 : 0), 0, moving);
    if (reordered.every((item, index) => item === items[index])) return items;
    return reordered;
}

function getTargetDisplayName(targetId, availableTargets) {
    if (!targetId) return "";

    const target = availableTargets.find((option) => option.id === targetId);
    return target?.displayName || target?.label || targetId;
}

/** A mirrored path is informational, never a second editable SCXML edge. */
function SharedContainerExitCard({ exit }) {
    return (
        <div className="transition-order-card transition-shared-exit-card"
             key={`${exit.edgeId}:${exit.event}`}
             style={{
                 "--transition-accent": getTransitionHighlightColor(exit.event),
                 "--transition-accent-colorblind": getTransitionHighlightColor(exit.event, true),
             }}
             title={`Implicit shared exit from ${exit.originSourceName || "original skill"} (${exit.originSourceHandle || exit.event}). Edit the original transition.`}>
            <div className="transition-order-main">
                <div className="transition-order-title-row">
                    <span className="transition-event-name">{exit.event}</span>
                    <span className="transition-scope-type">↳ Shared</span>
                </div>
                <div className="transition-order-summary">
                    <span>{exit.cond || "No condition"}</span>
                    <FiArrowRight />
                    <span>{exit.targetLabel}</span>
                </div>
            </div>
        </div>
    );
}

function ConditionModal({
                            isOpen,
                            onClose,
                            onConfirm,
                            onAddParameter,
                            globalVariables = [],
                            graphEdges = [],
                            sourceEventName = "",
                            sourceNodeName,
                            candidateTransitions = [],
                            liveCandidateTransitions = null,
                            sharedContainerExits = [],
                            availableEvents = [],
                            availableTargets = [],
                            initialTransitionId = null,
                            initialFocusSection = null,
                            onHoverTransitionEdge,
                            initialTargetId = null,
                            targetOnlyMode = false,
                            containerEventMode = false,
                            defaultScope = null,
                            draftSessionKey = 0,
                        }) {
    const drawerRef = useRef(null);
    const newParameterIdRef = useRef(null);
    const newParameterValueRef = useRef(null);
    const [newParameterId, setNewParameterId] = useState("");
    const [newParameterValue, setNewParameterValue] = useState("");
    const [parameterError, setParameterError] = useState("");
    const committedTransitionsRef = useRef([]);
    const observedEdgeIdsRef = useRef(new Set());
    const lastGraphEdgeIdsRef = useRef(new Set());
    const usableVars = useMemo(
        () => (globalVariables || []).filter((variable) => String(variable.id || "").trim() !== "#_STATE_PREFIX"),
        [globalVariables]
    );

    const normalizedEvents = useMemo(() => {
        const seen = new Set();
        const result = [];

        (availableEvents || []).forEach((event) => {
            const eventId = typeof event === "string" ? event : event?.id;
            if (!isValidScxmlEventDescriptor(eventId) || seen.has(eventId)) return;
            seen.add(eventId);
            result.push({
                id: eventId,
                description: typeof event === "string" ? "" : event?.description || "",
            });
        });

        if (isValidScxmlEventDescriptor(sourceEventName) && !seen.has(sourceEventName)) {
            result.push({ id: sourceEventName, description: "" });
        }

        return result;
    }, [availableEvents, sourceEventName]);

    const [transitionsState, setTransitionsState] = useState([]);
    const scopeGroups = useMemo(() => groupTransitionsByScope(transitionsState), [transitionsState]);
    const orderedTransitions = useMemo(
        () => scopeGroups.flatMap((group) => group.items),
        [scopeGroups]
    );
    const showHierarchy = hasTransitionScopeHierarchy(scopeGroups);
    // Keep shared exits out of transitionsState: they have a different SCXML
    // owner and must not enter ordering, editing or commit operations.
    const sharedExitsByScope = useMemo(() => {
        const result = new Map();
        sharedContainerExits.forEach((exit) => {
            const scopeId = String(exit.scopeId || exit.scopeLabel);
            if (!result.has(scopeId)) result.set(scopeId, []);
            result.get(scopeId).push(exit);
        });
        return result;
    }, [sharedContainerExits]);
    const sharedOnlyScopes = useMemo(() => {
        const editableScopes = new Set(scopeGroups.map((scope) => String(scope.id)));
        return [...sharedExitsByScope.entries()]
            .filter(([id]) => !editableScopes.has(id))
            .map(([id, exits]) => ({ id, exits, label: exits[0].scopeLabel }));
    }, [scopeGroups, sharedExitsByScope]);
    const shadowedTransitions = useMemo(
        () => getShadowedTransitions(scopeGroups),
        [scopeGroups]
    );
    const [selectedTransitionId, setSelectedTransitionId] = useState("");
    const [newTransitionEvent, setNewTransitionEvent] = useState("");
    const [errorMessage, setErrorMessage] = useState("");

    const [targetQuery, setTargetQuery] = useState("");
    const [targetAutocompleteOpen, setTargetAutocompleteOpen] = useState(false);
    const [activeTargetSuggestionIndex, setActiveTargetSuggestionIndex] = useState(-1);
    const [openAssignmentExpressionId, setOpenAssignmentExpressionId] = useState(null);
    const [assignmentExpressionCaretPosition, setAssignmentExpressionCaretPosition] = useState(0);
    const [activeAssignmentExpressionSuggestionIndex, setActiveAssignmentExpressionSuggestionIndex] = useState(-1);
    const [assignmentExpressionErrors, setAssignmentExpressionErrors] = useState({});
    const assignmentExpressionInputRefs = useRef({});
    const conditionCardRef = useRef(null);
    const assignmentCardRef = useRef(null);
    const lastFocusRequestRef = useRef(null);
    const transitionListRef = useRef(null);
    const previousOrderPositionsRef = useRef(null);
    const draggedTransitionIdRef = useRef(null);
    const [draggedTransitionId, setDraggedTransitionId] = useState(null);
    const [dropIndicator, setDropIndicator] = useState(null);

    const captureOrderPositions = () => {
        const positions = new Map();
        transitionListRef.current?.querySelectorAll("[data-transition-id]").forEach((element) => {
            positions.set(element.dataset.transitionId, element.getBoundingClientRect().top);
        });
        previousOrderPositionsRef.current = positions;
    };

    // FLIP: animate from each card's former position to its new position.
    // Both the arrow buttons and drag-and-drop use this same animation.
    useLayoutEffect(() => {
        const previous = previousOrderPositionsRef.current;
        previousOrderPositionsRef.current = null;
        if (!previous || window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return;
        transitionListRef.current?.querySelectorAll("[data-transition-id]").forEach((element) => {
            const oldTop = previous.get(element.dataset.transitionId);
            if (oldTop === undefined) return;
            const offset = oldTop - element.getBoundingClientRect().top;
            if (Math.abs(offset) < 1) return;
            element.animate?.(
                [{ transform: `translateY(${offset}px)` }, { transform: "translateY(0)" }],
                { duration: 220, easing: "cubic-bezier(.2,.8,.2,1)" }
            );
        });
    }, [transitionsState]);

    const finishDraggingTransition = () => {
        onHoverTransitionEdge?.(null);
        draggedTransitionIdRef.current = null;
        setDraggedTransitionId(null);
        setDropIndicator(null);
    };

    useEffect(() => {
        if (!isOpen) return;

        const hydrated = candidateTransitions.map((transition, index) =>
            hydrateTransition(transition, index, usableVars, sourceEventName)
        );

        // Reopening or replacing the transition candidates starts a fresh modal draft.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setTransitionsState(hydrated);
        committedTransitionsRef.current = hydrated;
        const visible = new Set(graphEdges.map(edge => edge.id));
        lastGraphEdgeIdsRef.current = new Set(visible);
        observedEdgeIdsRef.current = new Set(hydrated.map(t => t.edgeId).filter(id => id && visible.has(id)));
        setErrorMessage("");
        setAssignmentExpressionErrors({});
        setNewParameterId("");
        setNewParameterValue("");
        setParameterError("");
        lastFocusRequestRef.current = null;

        let selectedId = initialTransitionId;

        if (!selectedId && initialTargetId) {
            selectedId = hydrated.find(
                (transition) =>
                    transition.target === initialTargetId &&
                    (!sourceEventName || transition.event === sourceEventName)
            )?.transitionId;
        }

        if (!selectedId || !hydrated.some((transition) => transition.transitionId === selectedId)) {
            selectedId = hydrated[0]?.transitionId || "";
        }

        setSelectedTransitionId(selectedId || "");
        setNewTransitionEvent(
            sourceEventName || normalizedEvents[0]?.id || ""
        );
    }, [
        // A draft is tied to a panel-open request. Do not rehydrate it when
        // parent graph updates reallocate candidate arrays or variable lists.
        isOpen,
        draftSessionKey,
    ]);

    // A connection drawn while this editor is already open is an independent
    // canonical edge. Append it immediately without restarting the draft
    // session (or losing unsaved conditions/assignments on existing rows).
    useEffect(() => {
        if (!isOpen || !Array.isArray(liveCandidateTransitions)) return;
        const liveIds = new Set(graphEdges.map(edge => edge.id));
        const previousIds = lastGraphEdgeIdsRef.current;
        const hydrated = liveCandidateTransitions.map((transition, index) =>
            hydrateTransition(transition, index, usableVars, sourceEventName)
        );
        const newCanonical = hydrated.filter(item =>
            item.edgeId && liveIds.has(item.edgeId) && !previousIds.has(item.edgeId)
        );
        if (newCanonical.length) {
            setTransitionsState(current => appendPublishedGraphTransitions(
                current, hydrated, previousIds, liveIds
            ));
            // These edges are now committed graph data and can be removed by
            // subsequent canvas deletion, even while the editor stays open.
            const known = new Set(committedTransitionsRef.current.map(item => item.edgeId));
            committedTransitionsRef.current = [
                ...committedTransitionsRef.current,
                ...newCanonical.filter(item => !known.has(item.edgeId)),
            ];
            newCanonical.forEach(item => observedEdgeIdsRef.current.add(item.edgeId));
        }
        lastGraphEdgeIdsRef.current = liveIds;
    }, [isOpen, graphEdges, liveCandidateTransitions]);

    // Canvas deletions must be reflected in the open panel. Track only edges
    // that really appeared in the graph; new, unpublished drafts are never
    // mistaken for deleted edges during the first commit render.
    useEffect(() => {
        if (!isOpen) return;
        const live = new Set(graphEdges.map(edge => edge.id));
        const observed = observedEdgeIdsRef.current;
        const { removed, committed } = reconcileExternallyRemovedTransitions(
            [], committedTransitionsRef.current, observed, live
        );
        if (removed.size) {
            committedTransitionsRef.current = committed;
            setTransitionsState(current => reconcileExternallyRemovedTransitions(
                current, [], observed, live
            ).draft);
            setSelectedTransitionId(previous => {
                // Keep an unpublished draft selected; it is not in the
                // committed array and must not be treated as deleted.
                const selected = transitionsState.find(item => item.transitionId === previous);
                if (selected && (!selected.edgeId || !removed.has(selected.edgeId))) return previous;
                return transitionsState.find(item => !item.edgeId || !removed.has(item.edgeId))?.transitionId || "";
            });
            setErrorMessage("");
        }
        // Newly published edges become eligible for external-removal tracking.
        graphEdges.forEach(edge => {
            if (committed.some(item => item.edgeId === edge.id)) observed.add(edge.id);
        });
        removed.forEach(id => observed.delete(id));
    }, [isOpen, graphEdges]);

    // Incomplete edits remain a local draft. Valid actions persist directly;
    // clicking elsewhere must not discard the draft or close the panel.

    const selectedTransition = transitionsState.find(
        (transition) => transition.transitionId === selectedTransitionId
    );

    useEffect(() => {
        if (!isOpen || !initialFocusSection || !selectedTransition ||
            selectedTransition.transitionId !== initialTransitionId) return;
        const focusKey = `${initialTransitionId}:${initialFocusSection}`;
        if (lastFocusRequestRef.current === focusKey) return;
        lastFocusRequestRef.current = focusKey;
        const card = initialFocusSection === "assignment"
            ? assignmentCardRef.current : conditionCardRef.current;
        card?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        if (initialFocusSection === "assignment") {
            const first = selectedTransition.assignments?.[0];
            const control = first && assignmentExpressionInputRefs.current[first.assignmentId];
            (control || card?.querySelector("button, input"))?.focus({ preventScroll: true });
        } else {
            card?.querySelector("input, button")?.focus({ preventScroll: true });
        }
    }, [isOpen, initialFocusSection, initialTransitionId, selectedTransition]);

    const editorVariables = usableVars;

    const selectedConditionVariable = selectedTransition
        ? editorVariables.find(
            (variable) => variable.id === selectedTransition.conditionVariable
        ) ||
        (selectedTransition.conditionVariable
            ? {
                id: selectedTransition.conditionVariable,
                expr: "",
            }
            : null)
        : null;

    const conditionVariableType = getVariableType(selectedConditionVariable);
    const conditionIsEqualityOnly = isEqualityOnlyConditionType(conditionVariableType);
    const hasSelectedTransition = Boolean(selectedTransition);
    const selectedTransitionTarget = selectedTransition?.target;
    const selectedAvailableTargetIds = selectedTransition?.availableTargetIds;

    useEffect(() => {
        if (!hasSelectedTransition) {
            // Clear the target draft when there is no selected transition.
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setTargetQuery("");
            return;
        }

        setTargetQuery(
            getTargetDisplayName(selectedTransitionTarget, availableTargets)
        );
        setTargetAutocompleteOpen(false);
        setActiveTargetSuggestionIndex(-1);
        setOpenAssignmentExpressionId(null);
        setActiveAssignmentExpressionSuggestionIndex(-1);
        setAssignmentExpressionErrors({});
    }, [selectedTransitionId, hasSelectedTransition, selectedTransitionTarget, availableTargets]);

    useEffect(() => {
        if (!selectedTransition || !conditionIsEqualityOnly) return;
        if (
            selectedTransition.conditionOperator !== "==" &&
            selectedTransition.conditionOperator !== "!="
        ) {
            // A variable type change can invalidate an existing comparison operator.
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setTransitionsState((current) =>
                current.map((transition) =>
                    transition.transitionId === selectedTransitionId
                        ? { ...transition, conditionOperator: "==" }
                        : transition
                )
            );
        }
    }, [
        conditionIsEqualityOnly,
        selectedTransition,
        selectedTransitionId,
    ]);

    // Reordering copies the transition array; the allowed-target IDs are never mutated.
    // eslint-disable-next-line react-hooks/preserve-manual-memoization
    const matchingTargets = useMemo(() => {
        const query = String(targetQuery || "").trim().toLowerCase();
        if (!query) return [];

        const allowedTargetIds =
            targetOnlyMode &&
            Array.isArray(selectedAvailableTargetIds)
                ? new Set(selectedAvailableTargetIds)
                : null;

        return (availableTargets || [])
            .filter(
                (target) =>
                    !allowedTargetIds || allowedTargetIds.has(target.id)
            )
            .filter((target) =>
                [
                    target.displayName,
                    target.label,
                    target.fullSkillName,
                    target.packageName,
                    target.id,
                ].some((value) =>
                    String(value || "").toLowerCase().includes(query)
                )
            )
            .sort((a, b) => {
                const aName = String(a.displayName || a.label || a.id).toLowerCase();
                const bName = String(b.displayName || b.label || b.id).toLowerCase();
                const aStarts = aName.startsWith(query) ? 0 : 1;
                const bStarts = bName.startsWith(query) ? 0 : 1;
                return aStarts - bStarts || aName.localeCompare(bName);
            })
            .slice(0, 8);
    }, [
        targetQuery,
        availableTargets,
        targetOnlyMode,
        // Unrelated assignment edits must not invalidate this existing target-options memo.
        // eslint-disable-next-line react-hooks/preserve-manual-memoization
        selectedAvailableTargetIds,
    ]);

    const visibleTargetSuggestionIndex =
        activeTargetSuggestionIndex >= matchingTargets.length
            ? matchingTargets.length > 0
                ? 0
                : -1
            : activeTargetSuggestionIndex;

    if (!isOpen) return null;

    const updateSelectedTransition = (changes) => {
        if (!selectedTransitionId) return;

        setTransitionsState((current) =>
            current.map((transition) =>
                transition.transitionId === selectedTransitionId
                    ? { ...transition, ...changes }
                    : transition
            )
        );
        setErrorMessage("");
    };

    const patchSelectedDraft = (changes) => transitionsState.map(transition =>
        transition.transitionId === selectedTransitionId
            ? { ...transition, ...changes }
            : transition
    );

    const commitCondition = (changes = {}) => {
        const conditionVariable = changes.conditionVariable !== undefined
            ? changes.conditionVariable : selectedTransition?.conditionVariable;
        const variable = editorVariables.find(item => item.id === conditionVariable);
        const next = patchSelectedDraft({
            ...changes,
            conditionOperator: allowedConditionOperator(
                getVariableType(variable),
                changes.conditionOperator || selectedTransition?.conditionOperator || "=="
            ),
        });
        setTransitionsState(next);
        if (selectedTransition?.target) handleSave(next, "condition");
    };

    const handleAddAssignment = () => {
        if (!selectedTransitionId) return;

        const assignment = {
            assignmentId: createAssignmentId("new-assignment"),
            location: editorVariables[0]?.id || "",
            expr: "",
        };

        setTransitionsState((current) =>
            current.map((transition) =>
                transition.transitionId === selectedTransitionId
                    ? {
                        ...transition,
                        assignments: [
                            ...(Array.isArray(transition.assignments)
                                ? transition.assignments
                                : []),
                            assignment,
                        ],
                    }
                    : transition
            )
        );
        setErrorMessage("");
    };

    const updateAssignment = (assignmentId, changes) => {
        if (!selectedTransitionId) return;

        setTransitionsState((current) =>
            current.map((transition) =>
                transition.transitionId === selectedTransitionId
                    ? {
                        ...transition,
                        assignments: (transition.assignments || []).map(
                            (assignment) =>
                                assignment.assignmentId === assignmentId
                                    ? { ...assignment, ...changes }
                                    : assignment
                        ),
                    }
                    : transition
            )
        );
        setAssignmentExpressionErrors((current) => ({
            ...current,
            [assignmentId]: "",
        }));
        setErrorMessage("");
    };

    const commitAssignment = (assignmentId, changes) => {
        if (!selectedTransitionId) return;
        const next = transitionsState.map(transition =>
            transition.transitionId === selectedTransitionId
                ? { ...transition, assignments: (transition.assignments || []).map(assignment =>
                    assignment.assignmentId === assignmentId ? { ...assignment, ...changes } : assignment) }
                : transition
        );
        setTransitionsState(next);
        if (selectedTransition?.target) handleSave(next, "assignment", selectedTransitionId, assignmentId);
    };

    const deleteAssignment = (assignmentId) => {
        if (!selectedTransitionId) return;
        const next = transitionsState.map(transition =>
            transition.transitionId === selectedTransitionId
                ? { ...transition, assignments: (transition.assignments || []).filter(
                    assignment => assignment.assignmentId !== assignmentId) }
                : transition
        );
        setTransitionsState(next);
        setOpenAssignmentExpressionId(current => current === assignmentId ? null : current);
        setActiveAssignmentExpressionSuggestionIndex(-1);
        setAssignmentExpressionErrors(current => {
            const updated = { ...current };
            delete updated[assignmentId];
            return updated;
        });
        setErrorMessage("");
        if (selectedTransition?.target) handleSave(next, "assignment-delete");
    };

    const updateAssignmentExpressionAutocomplete = (
        assignmentId,
        value,
        caretPosition
    ) => {
        const { context, matches } = getMatchingExpressionVariables(
            value,
            caretPosition,
            editorVariables,
            {
                targetVariable: editorVariables.find(variable =>
                    variable.id === selectedTransition?.assignments?.find(item =>
                        item.assignmentId === assignmentId)?.location),
                requireCompatibleType: true,
            }
        );

        setAssignmentExpressionCaretPosition(caretPosition);

        if (!context || matches.length === 0) {
            setOpenAssignmentExpressionId(null);
            setActiveAssignmentExpressionSuggestionIndex(-1);
            return;
        }

        setOpenAssignmentExpressionId(assignmentId);
        setActiveAssignmentExpressionSuggestionIndex(0);
    };

    const selectAssignmentExpressionSuggestion = (assignment, variable) => {
        if (!assignment?.assignmentId || !variable?.id) return;

        const value = String(assignment.expr || "");
        const insertion = insertExpressionVariable(
            value,
            assignmentExpressionCaretPosition,
            variable.id
        );

        if (!insertion) return;

        updateAssignment(assignment.assignmentId, { expr: insertion.value });
        setOpenAssignmentExpressionId(null);
        setActiveAssignmentExpressionSuggestionIndex(-1);

        requestAnimationFrame(() => {
            const input = assignmentExpressionInputRefs.current[
                assignment.assignmentId
                ];
            input?.focus();
            input?.setSelectionRange?.(insertion.caretPosition, insertion.caretPosition);
            setAssignmentExpressionCaretPosition(insertion.caretPosition);
        });
    };

    const handleAssignmentExpressionKeyDown = (
        event,
        assignment,
        matchingVariables
    ) => {
        const autocompleteOpen =
            openAssignmentExpressionId === assignment.assignmentId &&
            matchingVariables.length > 0;

        const action = getExpressionAutocompleteAction(
            event.key,
            autocompleteOpen,
            matchingVariables.length,
            activeAssignmentExpressionSuggestionIndex
        );

        if (action) {
            event.preventDefault();
            if (action.type === "navigate") {
                const key = event.key;
                setActiveAssignmentExpressionSuggestionIndex((current) =>
                    getExpressionAutocompleteAction(key, true, matchingVariables.length, current).index
                );
            } else if (action.type === "select") {
                selectAssignmentExpressionSuggestion(assignment, matchingVariables[action.index]);
            } else {
                setOpenAssignmentExpressionId(null);
                setActiveAssignmentExpressionSuggestionIndex(-1);
            }
            return;
        }

        if (event.key === "Enter") {
            event.preventDefault();

            const assignmentVariable = editorVariables.find(
                (variable) => variable.id === assignment.location
            );
            const result = validateAssignmentValue(
                assignment.expr,
                assignmentVariable,
                editorVariables,
                { allowEmpty: false }
            );

            setAssignmentExpressionErrors((current) => ({
                ...current,
                [assignment.assignmentId]: result.valid ? "" : result.error,
            }));

            if (result.valid) {
                setOpenAssignmentExpressionId(null);
                setActiveAssignmentExpressionSuggestionIndex(-1);
                if (selectedTransition?.target) handleSave(transitionsState, "assignment", selectedTransitionId, assignment.assignmentId);
                event.currentTarget.blur();
            }
        }
    };

    const handleMove = (transitionId, neighborId, event) => {
        event.stopPropagation();
        if (targetOnlyMode || !neighborId) return;
        onHoverTransitionEdge?.(null);
        captureOrderPositions();
        const movingIndex = transitionsState.findIndex(item => item.transitionId === transitionId);
        const neighborIndex = transitionsState.findIndex(item => item.transitionId === neighborId);
        const next = reorderTransitionItems(transitionsState, transitionId, neighborId,
            neighborIndex < movingIndex ? "before" : "after");
        setTransitionsState(next);
        if (next !== transitionsState) handleSave(next, "target");
    };

    const handleDragOverTransition = (event, targetId) => {
        if (targetOnlyMode || !draggedTransitionIdRef.current) return;
        const moving = transitionsState.find((item) => item.transitionId === draggedTransitionIdRef.current);
        const target = transitionsState.find((item) => item.transitionId === targetId);
        if (!moving || !target || moving.scopeId !== target.scopeId) {
            setDropIndicator(null);
            return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        const bounds = event.currentTarget.getBoundingClientRect();
        const position = event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
        setDropIndicator((previous) =>
            previous?.id === targetId && previous.position === position
                ? previous : { id: targetId, position }
        );
    };

    const handleDropTransition = (event, targetId) => {
        if (targetOnlyMode) return;
        event.preventDefault();
        event.stopPropagation();
        const movingId = draggedTransitionIdRef.current;
        const moving = transitionsState.find((item) => item.transitionId === movingId);
        const target = transitionsState.find((item) => item.transitionId === targetId);
        if (movingId && movingId !== targetId && moving?.scopeId === target?.scopeId) {
            captureOrderPositions();
            const next = reorderTransitionItems(transitionsState, movingId, targetId,
                dropIndicator?.id === targetId ? dropIndicator.position :
                    event.clientY < event.currentTarget.getBoundingClientRect().top +
                        event.currentTarget.getBoundingClientRect().height / 2 ? "before" : "after");
            setTransitionsState(next);
            if (next !== transitionsState) handleSave(next, "target");
        }
        finishDraggingTransition();
    };

    const handleAddTransition = (eventOverride = null) => {
        if (targetOnlyMode && !containerEventMode) return;

        const eventId = String((eventOverride ?? newTransitionEvent) || normalizedEvents[0]?.id || "").trim();
        if (!isValidScxmlEventDescriptor(eventId)) {
            setErrorMessage("Enter a valid SCXML event descriptor (e.g. Wait.success.* or success.*).");
            return;
        }

        const transitionId = createTransitionId("new");
        const newTransition = {
            transitionId,
            edgeId: `edge-${transitionId}`,
            scopeId: defaultScope?.id || "",
            scopeLabel: defaultScope?.label || sourceNodeName || "Current state",
            scopeDepth: defaultScope?.depth || 0,
            event: eventId,
            target: "",
            targetLabel: "",
            eventDisplayName: eventId,
            availableTargetIds: targetOnlyMode ? availableTargets.map(target => target.id) : null,
            conditionEnabled: false,
            conditionVariable: usableVars[0]?.id || "",
            conditionOperator: "==",
            conditionValue: "",
            assignments: [],
        };

        setTransitionsState((current) => [...current, newTransition]);
        setSelectedTransitionId(transitionId);
        setTargetQuery("");
        setErrorMessage("");
    };

    const handleDeleteTransition = (transitionId, event) => {
        event.stopPropagation();
        onHoverTransitionEdge?.(null);
        const index = transitionsState.findIndex(item => item.transitionId === transitionId);
        const next = transitionsState.filter(item => item.transitionId !== transitionId);
        if (selectedTransitionId === transitionId) {
            setSelectedTransitionId(next[Math.min(index, next.length - 1)]?.transitionId || "");
        }
        setTransitionsState(next);
        handleSave(next, "target");
    };

    const selectTarget = (target) => {
        if (!target) return;

        const patch = {
            target: target.id,
            targetLabel: target.displayName || target.label || target.id,
            scopeId: target.scopeId || defaultScope?.id || "",
            scopeLabel: target.scopeLabel || defaultScope?.label || sourceNodeName || "Current state",
            scopeDepth: target.scopeDepth || 0,
        };
        const next = patchSelectedDraft(patch);
        setTransitionsState(next);
        handleSave(next, "target");
        setTargetQuery(target.displayName || target.label || target.id);
        setTargetAutocompleteOpen(false);
        setActiveTargetSuggestionIndex(-1);
    };

    const handleTargetKeyDown = (event) => {
        if (
            targetAutocompleteOpen &&
            matchingTargets.length > 0 &&
            event.key === "ArrowDown"
        ) {
            event.preventDefault();
            setActiveTargetSuggestionIndex(
                visibleTargetSuggestionIndex < matchingTargets.length - 1
                    ? visibleTargetSuggestionIndex + 1
                    : 0
            );
            return;
        }

        if (
            targetAutocompleteOpen &&
            matchingTargets.length > 0 &&
            event.key === "ArrowUp"
        ) {
            event.preventDefault();
            setActiveTargetSuggestionIndex(
                visibleTargetSuggestionIndex > 0
                    ? visibleTargetSuggestionIndex - 1
                    : matchingTargets.length - 1
            );
            return;
        }

        if (event.key === "Escape") {
            setTargetAutocompleteOpen(false);
            setActiveTargetSuggestionIndex(-1);
            return;
        }

        if (event.key !== "Enter") return;
        event.preventDefault();

        if (
            targetAutocompleteOpen &&
            matchingTargets.length > 0 &&
            visibleTargetSuggestionIndex >= 0
        ) {
            selectTarget(matchingTargets[visibleTargetSuggestionIndex]);
        }
    };

    const createParameter = (event) => {
        event.preventDefault();
        const id = newParameterId.trim();
        const value = newParameterValue.trim();
        if (!id || /[\s<>"']/u.test(id) || id === "#_STATE_PREFIX") {
            setParameterError("Enter a valid, non-reserved parameter ID (no spaces or XML delimiters).");
            newParameterIdRef.current?.focus();
            return;
        }
        if (!value) {
            setParameterError("Enter an initial value.");
            newParameterValueRef.current?.focus();
            return;
        }
        if (globalVariables.some((parameter) => parameter.id === id)) {
            setParameterError(`Parameter ${id} already exists.`);
            newParameterIdRef.current?.focus();
            return;
        }
        if (typeof onAddParameter !== "function" || !onAddParameter(id, value)) {
            setParameterError("Could not create the parameter. Check its ID and try again.");
            return;
        }
        setNewParameterId("");
        setNewParameterValue("");
        setParameterError("");
        newParameterIdRef.current?.focus();
    };

    // Validate and commit an explicit user action, not each keystroke. A new
    // transition without a target remains local to the panel until completed.
    const handleSave = (draft = transitionsState, kind = "target", activeId = selectedTransitionId, assignmentId = null) => {
        setErrorMessage("");
        const prepared = prepareLiveTransitionCommit({
            draft,
            committed: committedTransitionsRef.current,
            variables: editorVariables,
            activeId,
            kind,
            assignmentId,
        });
        const preparedOrdered = groupTransitionsByScope(prepared).flatMap(group => group.items);

        if (targetOnlyMode) {
            const normalizedTransitions = [];

            for (let index = 0; index < prepared.length; index += 1) {
                const transition = prepared[index];

                if (!transition.target) {
                    setSelectedTransitionId(transition.transitionId);
                    setErrorMessage(
                        `Transition #${index + 1} needs a target.`
                    );
                    return;
                }

                if (containerEventMode && !isValidScxmlEventDescriptor(transition.event)) {
                    setSelectedTransitionId(transition.transitionId);
                    setErrorMessage("Enter a valid SCXML event descriptor; editor node IDs are not events.");
                    return;
                }
                normalizedTransitions.push({
                    transitionId: transition.transitionId,
                    edgeId: transition.edgeId,
                    sourceNodeId: transition.sourceNodeId,
                    sourceNodeName: transition.sourceNodeName,
                    event: transition.event,
                    eventDisplayName: transition.eventDisplayName,
                    originalTarget: transition.originalTarget,
                    target: transition.target,
                    targetLabel:
                        transition.targetLabel ||
                        getTargetDisplayName(
                            transition.target,
                            availableTargets
                        ),
                    cond: transition.rawCondition || "",
                    assignments: (transition.assignments || []).map(
                        (assignment) => ({
                            location: assignment.location,
                            expr: assignment.expr,
                        })
                    ),
                });
            }

            committedTransitionsRef.current = prepared;
            onConfirm({
                updatedTransitions: normalizedTransitions,
                newGlobalVars: [],
                keepOpen: true,
            });
            return;
        }

        const allVariables = editorVariables;

        const normalizedTransitions = [];

        for (let index = 0; index < preparedOrdered.length; index += 1) {
            const transition = preparedOrdered[index];

            if (transition.event && !isValidScxmlEventDescriptor(transition.event)) {
                setSelectedTransitionId(transition.transitionId);
                setErrorMessage("A transition must use an SCXML event descriptor, not an editor node ID.");
                return;
            }
            if (!transition.event) {
                setSelectedTransitionId(transition.transitionId);
                setErrorMessage(`Transition #${index + 1} needs an event.`);
                return;
            }

            if (!transition.target) {
                setSelectedTransitionId(transition.transitionId);
                setErrorMessage(
                    `Transition #${index + 1} needs a target in step 4.`
                );
                return;
            }

            let condition = "";

            if (transition.conditionEnabled) {
                const variableName = String(
                    transition.conditionVariable || ""
                ).trim();
                const variable = allVariables.find(
                    (candidate) => candidate.id === variableName
                );

                if (!variableName || !variable) {
                    setSelectedTransitionId(transition.transitionId);
                    setErrorMessage(
                        `Transition #${index + 1} needs a valid condition variable.`
                    );
                    return;
                }

                const variableType = getVariableType(variable);
                const conditionValue = validateConditionValue(
                    transition.conditionValue,
                    variable,
                    allVariables,
                    { allowEmpty: false }
                );

                if (!conditionValue.valid) {
                    setSelectedTransitionId(transition.transitionId);
                    setErrorMessage(
                        conditionValue.error ||
                        `Transition #${index + 1} has an invalid condition value.`
                    );
                    return;
                }

                const operator =
                    isEqualityOnlyConditionType(variableType) &&
                    transition.conditionOperator !== "==" &&
                    transition.conditionOperator !== "!="
                        ? "=="
                        : transition.conditionOperator;

                condition = `${variableName} ${operator} ${conditionValue.value}`;
            }

            const assignments = [];

            for (let assignmentIndex = 0; assignmentIndex < (transition.assignments || []).length; assignmentIndex += 1) {
                const assignment = transition.assignments[assignmentIndex];
                const assignLocation = String(assignment.location || "").trim();
                const assignmentVariable = allVariables.find(
                    (variable) => variable.id === assignLocation
                );

                if (!assignLocation || !assignmentVariable) {
                    setSelectedTransitionId(transition.transitionId);
                    setErrorMessage(
                        `Transition #${index + 1}, assignment #${assignmentIndex + 1} needs a valid variable.`
                    );
                    return;
                }

                const assignmentResult = validateAssignmentValue(
                    assignment.expr,
                    assignmentVariable,
                    allVariables,
                    { allowEmpty: false }
                );

                if (!assignmentResult.valid) {
                    setSelectedTransitionId(transition.transitionId);
                    setErrorMessage(
                        `Transition #${index + 1}, assignment #${assignmentIndex + 1}: ${assignmentResult.error}`
                    );
                    return;
                }

                assignments.push({
                    assignmentId: assignment.assignmentId,
                    location: assignLocation,
                    expr: assignmentResult.value,
                });
            }

            const firstAssignment = assignments[0] || null;

            normalizedTransitions.push({
                transitionId: transition.transitionId,
                edgeId: transition.edgeId,
                event: transition.event,
                target: transition.target,
                targetLabel:
                    transition.targetLabel ||
                    getTargetDisplayName(transition.target, availableTargets),
                cond: condition,
                assignments,
                // Legacy fields stay populated for older code paths.
                assignLocation: firstAssignment?.location || "",
                assignExpr: firstAssignment?.expr || "",
            });
        }

        committedTransitionsRef.current = prepared;
        onConfirm({
            updatedTransitions: normalizedTransitions,
            newGlobalVars: [],
            keepOpen: true,
        });
    };

    const selectedEventDescription = normalizedEvents.find(
        (event) => event.id === selectedTransition?.event
    )?.description;

    return (
        <div className="bottom-drawer-container">
            <div ref={drawerRef} className="bottom-drawer-content full-width">
                <div className="bottom-drawer-header">
                    <div className="transition-drawer-heading">
                        <span className="transition-drawer-title">
                            {targetOnlyMode ? (
                                <>{containerEventMode ? "Parallel event transitions" : "Outgoing transitions"}</>
                            ) : (
                                <>
                                    Transitions: <span>{sourceNodeName}</span>
                                </>
                            )}
                        </span>
                        <span className="transition-drawer-subtitle">
                            {targetOnlyMode
                                ? (containerEventMode
                                    ? "Use the emitted SCXML descriptor (Wait.success.* catches Wait events; success.* is a direct Parallel event)."
                                    : "Only transition targets can be reassigned.")
                                : "Child transitions are evaluated before parent transitions. Reorder within each scope."}
                        </span>
                    </div>
                    <button className="modal-close-button" onClick={onClose}>
                        <FiX />
                    </button>
                </div>

                {errorMessage && (
                    <InlineFeedback tone="danger" className="drawer-error-box">
                        {errorMessage}
                    </InlineFeedback>
                )}

                <div
                    className={`bottom-drawer-grid-layout transition-editor-grid ${
                        targetOnlyMode ? "transition-container-target-only" : ""
                    }`}
                >
                    <div className="step-card transition-list-step">
                        <div className="step-card-header">
                            <span className="step-number">1</span>
                            <span className="step-title">Transitions</span>
                        </div>

                        <div className="step-card-body transition-step-body">
                            <div ref={transitionListRef} className="transition-order-list">
                                {orderedTransitions.length > 0 ? (
                                    orderedTransitions.map((transition, index) => {
                                        const scope = scopeGroups.find((group) => group.id === (transition.scopeId || "unscoped"));
                                        const localIndex = scope?.items.findIndex((item) => item.transitionId === transition.transitionId) ?? index;
                                        const previousInScope = scope?.items[localIndex - 1];
                                        const nextInScope = scope?.items[localIndex + 1];
                                        const showScopeHeading = index === 0 || orderedTransitions[index - 1]?.scopeId !== transition.scopeId;
                                        const shadowedBy = shadowedTransitions.get(transition.transitionId);
                                        const isSelected =
                                            transition.transitionId === selectedTransitionId;
                                        const targetName =
                                            transition.targetLabel ||
                                            getTargetDisplayName(
                                                transition.target,
                                                availableTargets
                                            );

                                        return (
                                            <Fragment key={transition.transitionId}>
                                            {showScopeHeading && !targetOnlyMode && (
                                                <div className="transition-scope-heading">
                                                    <div className="transition-scope-title">
                                                        <span className="transition-scope-name">{scope?.label || sourceNodeName}</span>
                                                        {(showHierarchy || scope?.depth > 0) && <span className="transition-scope-type">
                                                            {scope?.depth === 0 ? "Local transitions" : "Parent scope"}
                                                        </span>}
                                                    </div>
                                                    {showHierarchy && <span className="transition-scope-order">
                                                        {scope?.depth === 0 ? "Evaluated first" : "Evaluated if no child transition matches"}
                                                    </span>}
                                                </div>
                                            )}
                                            <div
                                                data-transition-id={transition.transitionId}
                                                style={{
                                                    "--transition-accent": getTransitionHighlightColor(transition.event),
                                                    "--transition-accent-colorblind": getTransitionHighlightColor(transition.event, true),
                                                }}
                                                className={`transition-order-card ${
                                                    isSelected ? "selected" : ""
                                                } ${draggedTransitionId === transition.transitionId ? "dragging" : ""} ${
                                                    dropIndicator?.id === transition.transitionId
                                                        ? `drop-${dropIndicator.position}` : ""
                                                }`}
                                                onDragOver={(event) => handleDragOverTransition(event, transition.transitionId)}
                                                onDrop={(event) => handleDropTransition(event, transition.transitionId)}
                                                onClick={() =>
                                                    setSelectedTransitionId(
                                                        transition.transitionId
                                                    )
                                                }
                                                onMouseEnter={(event) => onHoverTransitionEdge?.(transition.edgeId || null, event)}
                                                onMouseLeave={(event) => onHoverTransitionEdge?.(null, event)}
                                            >
                                                <span
                                                    className="transition-drag-handle"
                                                    role="button"
                                                    tabIndex={targetOnlyMode ? -1 : 0}
                                                    draggable={!targetOnlyMode}
                                                    aria-label={`Drag to reorder transition ${localIndex + 1} within ${scope?.label || "scope"}`}
                                                    title={targetOnlyMode ? "Reordering is disabled" : "Reorder only within this SCXML scope"}
                                                    onClick={(event) => event.stopPropagation()}
                                                    onKeyDown={(event) => {
                                                        if (targetOnlyMode || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
                                                        event.preventDefault();
                                                        handleMove(transition.transitionId, event.key === "ArrowUp"
                                                            ? previousInScope?.transitionId : nextInScope?.transitionId, event);
                                                    }}
                                                    onDragStart={(event) => {
                                                        if (targetOnlyMode) { event.preventDefault(); return; }
                                                        onHoverTransitionEdge?.(null);
                                                        draggedTransitionIdRef.current = transition.transitionId;
                                                        setDraggedTransitionId(transition.transitionId);
                                                        event.dataTransfer.effectAllowed = "move";
                                                        event.dataTransfer.setData("text/plain", transition.transitionId);
                                                    }}
                                                    onDragEnd={finishDraggingTransition}
                                                ><FiMove aria-hidden="true" /></span>
                                                <div className="transition-order-main" title={
                                                    (transition.assignments || []).map((assignment) =>
                                                        `${assignment.location} = ${assignment.expr}`).join("\n") || undefined
                                                }>
                                                    <div className="transition-order-title-row">
                                                        <span className="transition-priority">
                                                            #{localIndex + 1}
                                                        </span>
                                                        {containerEventMode ? (
                                                            <input
                                                                className="text-field transition-event-name nodrag"
                                                                type="text"
                                                                aria-label="SCXML event descriptor"
                                                                value={transition.event}
                                                                onClick={(event) => event.stopPropagation()}
                                                                onChange={(event) => {
                                                                    const value = event.target.value;
                                                                    setTransitionsState(previous => previous.map(item =>
                                                                        item.transitionId === transition.transitionId
                                                                            ? { ...item, event: value, eventDisplayName: value }
                                                                            : item));
                                                                }}
                                                                onKeyDown={(event) => {
                                                                    if (event.key !== "Enter" || event.isComposing) return;
                                                                    event.preventDefault();
                                                                    if (isValidScxmlEventDescriptor(transition.event))
                                                                        handleSave(transitionsState, "target", transition.transitionId);
                                                                    else setErrorMessage("Enter a valid SCXML event descriptor.");
                                                                }}
                                                                onBlur={() => {
                                                                    if (isValidScxmlEventDescriptor(transition.event))
                                                                        handleSave(transitionsState, "target", transition.transitionId);
                                                                }}
                                                            />
                                                        ) : (
                                                            <span className="transition-event-name">
                                                                {transition.eventDisplayName || transition.event || "No event"}
                                                            </span>
                                                        )}
                                                    </div>

                                                    <div className="transition-order-summary">
                                                        <span>
                                                            {transition.conditionEnabled
                                                                ? transition.conditionVariable &&
                                                                transition.conditionValue
                                                                    ? `${transition.conditionVariable} ${transition.conditionOperator} ${transition.conditionValue}`
                                                                    : "Condition configured"
                                                                : "No condition"}
                                                        </span>
                                                        <FiArrowRight />
                                                        <span>
                                                            {targetName || "No target"}
                                                        </span>
                                                    </div>
                                                    {shadowedBy && (
                                                        <div className="transition-scope-warning" title="This event is already handled by an unconditional transition at a higher priority">
                                                            <FiAlertTriangle aria-hidden="true" />
                                                            Unreachable: unconditional transition in {shadowedBy.label} has priority
                                                        </div>
                                                    )}
                                                </div>

                                                <div
                                                    className="transition-order-actions"
                                                    onClick={(event) => event.stopPropagation()}
                                                >
                                                    <button
                                                        className="order-btn"
                                                        disabled={
                                                            targetOnlyMode || !previousInScope
                                                        }
                                                        onClick={(event) =>
                                                            handleMove(transition.transitionId, previousInScope?.transitionId, event)
                                                        }
                                                        title="Move up"
                                                    >
                                                        <FiChevronUp />
                                                    </button>
                                                    <button
                                                        className="order-btn"
                                                        disabled={
                                                            targetOnlyMode ||
                                                            !nextInScope
                                                        }
                                                        onClick={(event) =>
                                                            handleMove(transition.transitionId, nextInScope?.transitionId, event)
                                                        }
                                                        title="Move down"
                                                    >
                                                        <FiChevronDown />
                                                    </button>
                                                    <button
                                                        className="transition-delete-button"
                                                        disabled={targetOnlyMode && !containerEventMode}
                                                        onClick={(event) =>
                                                            handleDeleteTransition(
                                                                transition.transitionId,
                                                                event
                                                            )
                                                        }
                                                        title="Delete transition"
                                                    >
                                                        <FiTrash2 />
                                                    </button>
                                                </div>
                                            </div>
                                            {!targetOnlyMode && !nextInScope &&
                                                (sharedExitsByScope.get(String(transition.scopeId || "unscoped")) || [])
                                                    .map((exit) => <SharedContainerExitCard key={`${exit.edgeId}:${exit.event}`} exit={exit} />)}
                                            </Fragment>
                                        );
                                    })
                                ) : !sharedContainerExits.length ? (
                                    <div className="transition-empty-state">No transitions yet.</div>
                                ) : null}
                            </div>

                            {!targetOnlyMode && sharedOnlyScopes.map((scope) => (
                                <div className="transition-order-list" key={scope.id} aria-label={`${scope.label} parent scope`}>
                                    <div className="transition-scope-heading">
                                        <div className="transition-scope-title">
                                            <span className="transition-scope-name">{scope.label}</span>
                                            <span className="transition-scope-type">Parent scope</span>
                                        </div>
                                    </div>
                                    {scope.exits.map((exit) =>
                                        <SharedContainerExitCard key={`${exit.edgeId}:${exit.event}`} exit={exit} />
                                    )}
                                </div>
                            ))}

                            <div className="transition-add-row">
                                <input
                                    className="skill-select"
                                    type="text"
                                    list="scxml-transition-descriptors"
                                    aria-label="New SCXML event descriptor"
                                    placeholder={containerEventMode ? "Wait.success.* or success.*" : "Exit token or wildcard"}
                                    value={newTransitionEvent}
                                    disabled={targetOnlyMode && !containerEventMode}
                                    onChange={(event) => setNewTransitionEvent(event.target.value)}
                                    onKeyDown={(event) => {
                                        if (event.key === "Enter" && !event.isComposing) {
                                            event.preventDefault();
                                            handleAddTransition(event.currentTarget.value);
                                        }
                                    }}
                                />
                                <datalist id="scxml-transition-descriptors">
                                    {normalizedEvents.map((event) => <option key={event.id} value={event.id} />)}
                                </datalist>
                                <button
                                    className="filter-button transition-primary-button transition-add-button"
                                    type="button"
                                    disabled={targetOnlyMode && !containerEventMode}
                                    title={
                                        targetOnlyMode && !containerEventMode
                                            ? "Container exit events are fixed."
                                            : "Add transition"
                                    }
                                    onClick={() => handleAddTransition()}
                                >
                                    <FiPlus /> Add
                                </button>
                            </div>
                        </div>
                    </div>

                    <div className="transition-expression-column">
                    {!targetOnlyMode && (
                        <form className="transition-parameter-quick-add" onSubmit={createParameter}>
                            <span className="transition-parameter-quick-add-title">Add new parameter</span>
                            <div className="transition-parameter-quick-add-fields">
                                <label className="transition-compact-screenreader-label" htmlFor="transition-parameter-id">Parameter ID</label>
                                <input
                                    id="transition-parameter-id"
                                    ref={newParameterIdRef}
                                    className="slot-field-edit"
                                    value={newParameterId}
                                    placeholder="ID"
                                    aria-label="New parameter ID"
                                    autoComplete="off"
                                    onChange={(event) => {
                                        setNewParameterId(event.target.value);
                                        setParameterError("");
                                    }}
                                    onKeyDown={(event) => {
                                        if (event.key === "Enter" && !event.isComposing) {
                                            event.preventDefault();
                                            newParameterValueRef.current?.focus();
                                        }
                                    }}
                                />
                                <label className="transition-compact-screenreader-label" htmlFor="transition-parameter-value">Initial value</label>
                                <input
                                    id="transition-parameter-value"
                                    ref={newParameterValueRef}
                                    className="slot-field-edit"
                                    value={newParameterValue}
                                    placeholder="Initial value"
                                    aria-label="New parameter initial value"
                                    autoComplete="off"
                                    onChange={(event) => {
                                        setNewParameterValue(event.target.value);
                                        setParameterError("");
                                    }}
                                />
                                <button className="transition-secondary-button transition-primary-button transition-add-parameter-button" type="submit">
                                    <FiPlus /> Add
                                </button>
                            </div>
                            {parameterError && <span className="transition-parameter-error" role="alert">{parameterError}</span>}
                        </form>
                    )}
                    <div
                        ref={conditionCardRef}
                        className={`step-card ${
                            targetOnlyMode ? "transition-step-locked" : ""
                        }`}
                        inert={targetOnlyMode}
                    >
                        <div className="step-card-header">
                            <span className="step-number">2</span>
                            <span className="step-title">Condition</span>
                            {selectedTransition && !targetOnlyMode && (
                                <button
                                    className={`transition-secondary-button ${selectedTransition.conditionEnabled ? "transition-remove-condition-button" : "transition-primary-button transition-add-assignment-button"}`}
                                    type="button"
                                    onClick={() => selectedTransition.conditionEnabled
                                        ? commitCondition({ conditionEnabled: false })
                                        : updateSelectedTransition({ conditionEnabled: true })}
                                >
                                    {selectedTransition.conditionEnabled ? <><FiX /> Remove</> : <><FiPlus /> Add</>}
                                </button>
                            )}
                            {targetOnlyMode && (
                                <span className="transition-locked-label">
                                    Disabled
                                </span>
                            )}
                        </div>

                        <div className="step-card-body transition-step-body">
                            {selectedTransition ? (
                                <>
                                    {!selectedTransition.conditionEnabled && (
                                        <div className="transition-empty-state">No condition yet. Use + Add to create one.</div>
                                    )}
                                    {selectedTransition.conditionEnabled && (
                                        <>
                                            <div className="condition-expression-row transition-expression-builder">
                                                <div className="transition-expression-variable-control">
                                                    {conditionVariableType ? (
                                                        <span className={`datamodel-value-type-badge datamodel-value-type-${conditionVariableType.toLowerCase()}`}>
                                                            {conditionVariableType}
                                                        </span>
                                                    ) : (
                                                        <span className="datamodel-value-type-badge datamodel-value-type-unknown">Type</span>
                                                    )}
                                                    <label className="transition-compact-screenreader-label" htmlFor="transition-condition-variable">Condition variable</label>
                                                    <select
                                                        id="transition-condition-variable"
                                                        className="skill-select transition-variable-select"
                                                        aria-label="Condition variable"
                                                        value={selectedTransition.conditionVariable}
                                                        onChange={event => commitCondition({ conditionVariable: event.target.value })}
                                                    >
                                                        {selectedTransition.conditionVariable && !editorVariables.some(variable => variable.id === selectedTransition.conditionVariable) && (
                                                            <option value={selectedTransition.conditionVariable}>
                                                                {selectedTransition.conditionVariable} (unavailable)
                                                            </option>
                                                        )}
                                                        {editorVariables.map(variable => <option key={variable.id} value={variable.id}>{variable.id}</option>)}
                                                    </select>
                                                </div>

                                                <select
                                                    className="skill-select condition-expression-operator"
                                                    aria-label="Condition operator"
                                                    value={
                                                        selectedTransition.conditionOperator
                                                    }
                                                    onChange={(event) =>
                                                        commitCondition({
                                                            conditionOperator: event.target.value,
                                                        })
                                                    }
                                                >
                                                    {!conditionIsEqualityOnly && (
                                                        <option value=">">&gt;</option>
                                                    )}
                                                    {!conditionIsEqualityOnly && (
                                                        <option value="<">&lt;</option>
                                                    )}
                                                    <option value="==">==</option>
                                                    {!conditionIsEqualityOnly && (
                                                        <option value=">=">&gt;=</option>
                                                    )}
                                                    {!conditionIsEqualityOnly && (
                                                        <option value="<=">&lt;=</option>
                                                    )}
                                                    <option value="!=">!=</option>
                                                </select>

                                                <div className="condition-expression-value">
                                                    <TypedValueEditor
                                                        key={`${selectedTransition.transitionId}:${selectedTransition.conditionVariable}`}
                                                        value={
                                                            selectedTransition.conditionValue
                                                        }
                                                        expectedType={
                                                            conditionVariableType
                                                        }
                                                        variables={editorVariables}
                                                        allowEmpty={false}
                                                        placeholder={
                                                            conditionVariableType
                                                                ? `${conditionVariableType} value or @variable`
                                                                : "Value or @variable"
                                                        }
                                                        onDraftChange={(value) =>
                                                            updateSelectedTransition({
                                                                conditionValue: value,
                                                            })
                                                        }
                                                        onCommit={(value) =>
                                                            commitCondition({ conditionValue: value })
                                                        }
                                                    />
                                                </div>
                                            </div>
                                        </>
                                    )}
                                </>
                            ) : (
                                <div className="transition-empty-state">
                                    Select a transition in step 1.
                                </div>
                            )}
                        </div>
                    </div>

                    <div
                        ref={assignmentCardRef}
                        className={`step-card ${
                            targetOnlyMode ? "transition-step-locked" : ""
                        }`}
                        inert={targetOnlyMode}
                    >
                        <div className="step-card-header transition-assignment-header">
                            <span className="step-number">3</span>
                            <span className="step-title">Assignments</span>
                            {targetOnlyMode && (
                                <span className="transition-locked-label">
                                    Disabled
                                </span>
                            )}
                            {selectedTransition && (
                                <button
                                    className="transition-secondary-button transition-primary-button transition-add-assignment-button"
                                    type="button"
                                    onClick={handleAddAssignment}
                                >
                                    <FiPlus /> Add
                                </button>
                            )}
                        </div>

                        <div className="step-card-body transition-step-body">
                            {selectedTransition ? (
                                <>
                                    {(selectedTransition.assignments || []).length === 0 ? (
                                        <div className="transition-empty-state">
                                            No assignments yet. Use + Add to create one.
                                        </div>
                                    ) : (
                                        <div className="transition-assignment-list transition-expression-list">
                                            {(selectedTransition.assignments || []).map(
                                                (assignment, assignmentIndex) => {
                                                    const assignmentVariable =
                                                        editorVariables.find(
                                                            (variable) =>
                                                                variable.id === assignment.location
                                                        );
                                                    const assignmentVariableType =
                                                        getVariableType(assignmentVariable);
                                                    const matchingAssignmentExpressionVariables =
                                                        openAssignmentExpressionId ===
                                                        assignment.assignmentId
                                                            ? getMatchingExpressionVariables(
                                                                assignment.expr || "",
                                                                assignmentExpressionCaretPosition,
                                                                editorVariables,
                                                                { targetVariable: assignmentVariable, requireCompatibleType: true }
                                                            ).matches
                                                            : [];
                                                    const isAssignmentExpressionAutocompleteOpen =
                                                        openAssignmentExpressionId ===
                                                        assignment.assignmentId &&
                                                        matchingAssignmentExpressionVariables.length > 0;

                                                    return (
                                                        <div
                                                            className="transition-assignment-editor"
                                                            key={assignment.assignmentId}
                                                        >
                                                            <div className="transition-assignment-equation">
                                                                <div className="transition-assignment-variable-area">
                                                                    <label className="transition-field-caption transition-compact-screenreader-label" htmlFor={`assignment-location-${assignment.assignmentId}`}>Variable</label>
                                                                    <div className="transition-assignment-variable-controls">
                                                                        {assignmentVariableType ? (
                                                                            <span className={`datamodel-value-type-badge datamodel-value-type-${assignmentVariableType.toLowerCase()}`}>{assignmentVariableType}</span>
                                                                        ) : (
                                                                            <span className="datamodel-value-type-badge datamodel-value-type-unknown">Type</span>
                                                                        )}
                                                                        <select
                                                                            id={`assignment-location-${assignment.assignmentId}`}
                                                                            className="skill-select transition-assignment-location"
                                                                            value={assignment.location}
                                                                            onChange={(event) => commitAssignment(assignment.assignmentId, { location: event.target.value })}
                                                                        >
                                                                            {!assignment.location && <option value="">Select variable</option>}
                                                                            {editorVariables.map(variable => <option key={variable.id} value={variable.id}>{variable.id}</option>)}
                                                                        </select>

                                                                    </div>
                                                                </div>
                                                                <span className="transition-assignment-equals" aria-hidden="true">=</span>
                                                                <div className="transition-assignment-value-area">
                                                                    <label className="transition-field-caption transition-compact-screenreader-label" htmlFor={`assignment-value-${assignment.assignmentId}`}>Value / expression</label>
                                                                    <div className="typed-value-editor-row">
                                                                        <input
                                                                            id={`assignment-value-${assignment.assignmentId}`}
                                                                            key={`${selectedTransition.transitionId}:${assignment.assignmentId}:${assignment.location}`}
                                                                            ref={(element) => { assignmentExpressionInputRefs.current[assignment.assignmentId] = element; }}
                                                                            className="slot-field-edit"
                                                                            type="text"
                                                                            value={assignment.expr || ""}
                                                                            placeholder="e.g. @test_value + 1"
                                                                            autoComplete="off"
                                                                            spellCheck={false}
                                                                            onFocus={(event) => updateAssignmentExpressionAutocomplete(assignment.assignmentId, event.currentTarget.value, event.currentTarget.selectionStart ?? event.currentTarget.value.length)}
                                                                            onClick={(event) => updateAssignmentExpressionAutocomplete(assignment.assignmentId, event.currentTarget.value, event.currentTarget.selectionStart ?? event.currentTarget.value.length)}
                                                                            onChange={(event) => {
                                                                                const value = event.target.value;
                                                                                updateAssignment(assignment.assignmentId, { expr: value });
                                                                                updateAssignmentExpressionAutocomplete(assignment.assignmentId, value, event.target.selectionStart ?? value.length);
                                                                            }}
                                                                            onBlur={() => window.setTimeout(() => {
                                                                                setOpenAssignmentExpressionId(current => current === assignment.assignmentId ? null : current);
                                                                                setActiveAssignmentExpressionSuggestionIndex(-1);
                                                                            }, 120)}
                                                                            onKeyDown={(event) => handleAssignmentExpressionKeyDown(event, assignment, matchingAssignmentExpressionVariables)}
                                                                        />
                                                                        {isAssignmentExpressionAutocompleteOpen && (
                                                                            <ExpressionVariableSuggestions
                                                                                variables={matchingAssignmentExpressionVariables}
                                                                                activeIndex={activeAssignmentExpressionSuggestionIndex}
                                                                                onSelect={(variable) => selectAssignmentExpressionSuggestion(assignment, variable)}
                                                                                showTypes
                                                                                upwardAnchor={assignmentExpressionInputRefs.current[assignment.assignmentId]}
                                                                            />
                                                                        )}
                                                                    </div>
                                                                </div>
                                                                <button className="transition-assignment-delete-button" type="button"
                                                                    title={`Delete assignment #${assignmentIndex + 1}`}
                                                                    aria-label={`Delete assignment #${assignmentIndex + 1}`}
                                                                    onClick={() => deleteAssignment(assignment.assignmentId)}>
                                                                    <FiTrash2 />
                                                                </button>
                                                            </div>
                                                            {assignmentExpressionErrors[
                                                                assignment.assignmentId
                                                                ] && (
                                                                <div
                                                                    style={{
                                                                        color: "#ef4444",
                                                                        fontSize: "12px",
                                                                        marginTop: "6px",
                                                                        lineHeight: 1.35,
                                                                    }}
                                                                >
                                                                    {assignmentExpressionErrors[
                                                                        assignment.assignmentId
                                                                        ]}
                                                                </div>
                                                            )}
                                                        </div>
                                                    );
                                                }
                                            )}
                                        </div>
                                    )}
                                </>
                            ) : (
                                <div className="transition-empty-state">
                                    Select a transition in step 1.
                                </div>
                            )}
                        </div>
                    </div>

                    </div>

                    <div className="step-card">
                        <div className="step-card-header">
                            <span className="step-number">4</span>
                            <span className="step-title">Target</span>
                        </div>

                        <div className="step-card-body transition-step-body">
                            {selectedTransition ? (
                                <>
                                    <div className="transition-target-autocomplete">
                                        <input
                                            className="slot-field-edit transition-target-input"
                                            type="text"
                                            value={targetQuery}
                                            placeholder="Type a target node..."
                                            autoComplete="off"
                                            onChange={(event) => {
                                                const next = event.target.value;
                                                setTargetQuery(next);
                                                setTargetAutocompleteOpen(
                                                    next.trim().length > 0
                                                );
                                                setActiveTargetSuggestionIndex(
                                                    next.trim().length > 0 ? 0 : -1
                                                );
                                            }}
                                            onFocus={() => {
                                                if (
                                                    targetQuery.trim() &&
                                                    matchingTargets.length > 0
                                                ) {
                                                    setTargetAutocompleteOpen(true);
                                                    setActiveTargetSuggestionIndex(0);
                                                }
                                            }}
                                            onBlur={() =>
                                                window.setTimeout(() => {
                                                    setTargetAutocompleteOpen(false);
                                                    setActiveTargetSuggestionIndex(-1);
                                                }, 120)
                                            }
                                            onKeyDown={handleTargetKeyDown}
                                        />

                                        {targetAutocompleteOpen &&
                                            matchingTargets.length > 0 && (
                                                <div className="transition-target-suggestions">
                                                    {matchingTargets.map(
                                                        (target, index) => (
                                                            <button
                                                                type="button"
                                                                key={target.id}
                                                                className={`transition-target-suggestion ${
                                                                    index ===
                                                                    visibleTargetSuggestionIndex
                                                                        ? "active"
                                                                        : ""
                                                                }`}
                                                                onMouseDown={(event) => {
                                                                    event.preventDefault();
                                                                    selectTarget(target);
                                                                }}
                                                            >
                                                                <span className="transition-target-suggestion-name">
                                                                    {target.displayName ||
                                                                        target.label ||
                                                                        target.id}
                                                                </span>
                                                                <span className="transition-target-suggestion-path">
                                                                    {target.packageName
                                                                        ? `${target.packageName}.${
                                                                            target.skillName ||
                                                                            target.label ||
                                                                            ""
                                                                        }`
                                                                        : target.fullSkillName ||
                                                                        target.id}
                                                                </span>
                                                            </button>
                                                        )
                                                    )}
                                                </div>
                                            )}
                                    </div>

                                    {selectedTransition.target ? (
                                        <div className="transition-selected-target">
                                            <FiArrowRight />
                                            <span>
                                                {getTargetDisplayName(
                                                    selectedTransition.target,
                                                    availableTargets
                                                )}
                                            </span>
                                        </div>
                                    ) : (
                                        <div className="transition-help-text">
                                            Start typing and choose a target from the
                                            autocomplete results.
                                        </div>
                                    )}

                                    {selectedEventDescription && (
                                        <div className="transition-help-text">
                                            Event: {selectedEventDescription}
                                        </div>
                                    )}
                                </>
                            ) : (
                                <div className="transition-empty-state">
                                    Select a transition in step 1.
                                </div>
                            )}
                        </div>
                    </div>
                </div>

            </div>
        </div>
    );
}

export default ConditionModal;

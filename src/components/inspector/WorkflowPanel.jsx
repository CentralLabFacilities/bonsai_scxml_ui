import { useMemo, useRef, useState } from "react";
import { FaPlus } from "react-icons/fa6";
import { FiX } from "react-icons/fi";
import { inferLiteralValueType } from "../../utils/valueTypes";

function getDatamodelType(parameter) {
    return inferLiteralValueType(parameter?.expr).toLowerCase();
}

const isVisibleDataParameter = (parameter) =>
    String(parameter?.id || "").trim() !== "#_STATE_PREFIX";

function WorkflowPanel({
                           globalDataModel,
                           inheritedGlobalDataModel = [],
                           descendantGlobalDataModel = [],
                           newParamId,
                           setNewParamId,
                           newParamExpr,
                           setNewParamExpr,
                           onUpdateGlobalParam,
                           onAddParameter,
                           onDeleteParameter,
                       }) {
    const [createGlobal, setCreateGlobal] = useState(false);
    const newVariableIdRef = useRef(null);

    const inheritedGlobalIds = useMemo(
        () =>
            new Set(
                (inheritedGlobalDataModel || []).map(
                    (parameter) => parameter.id
                )
            ),
        [inheritedGlobalDataModel]
    );

    const { globalParameters, localParameters } = useMemo(() => {
        const withOriginalIndex = (globalDataModel || [])
            .map((parameter, index) => ({
                parameter,
                index,
            }))
            .filter(({ parameter }) => isVisibleDataParameter(parameter));

        return {
            globalParameters: withOriginalIndex.filter(({ parameter }) =>
                String(parameter.id || "").startsWith("_")
            ),
            localParameters: withOriginalIndex.filter(
                ({ parameter }) =>
                    !String(parameter.id || "").startsWith("_")
            ),
        };
    }, [globalDataModel]);

    const rawParameterId = newParamId.trim();

    // In Bonsai, a leading underscore defines global scope. A local ID that
    // starts with '_' is invalid rather than silently becoming global.
    const localIdHasGlobalPrefix = !createGlobal && rawParameterId.startsWith("_");

    const normalizedParameterId = rawParameterId
        ? createGlobal
            ? `_${rawParameterId.replace(/^_+/, "")}`
            : rawParameterId
        : "";

    const parameterNameAlreadyExists = (globalDataModel || []).some(
        (parameter) => parameter.id === normalizedParameterId
    );

    const newParameterOverwrittenByParent =
        normalizedParameterId.startsWith("_") &&
        inheritedGlobalIds.has(normalizedParameterId);

    const handleAddParameter = () => {
        if (!normalizedParameterId || localIdHasGlobalPrefix || parameterNameAlreadyExists) {
            return false;
        }

        if (onAddParameter(normalizedParameterId, newParamExpr) === false) {
            return false;
        }
        setCreateGlobal(false);
        return true;
    };

    const handleNewParameterKeyDown = (event) => {
        if (event.key !== "Enter" || event.isComposing) return;

        event.preventDefault();
        event.stopPropagation();
        if (handleAddParameter()) {
            // Both ID and Value can submit; keep keyboard entry ready for the next variable.
            newVariableIdRef.current?.focus();
        }
    };

    const renderOwnParameters = (
        parameters,
        emptyText,
        isGlobalSection = false
    ) => {
        if (parameters.length === 0) {
            return <div className="datamodel-empty">{emptyText}</div>;
        }

        return (
            <div className="datamodel-compact-list">
                {parameters.map(({ parameter, index }) => {
                    const overwrittenByParent =
                        isGlobalSection &&
                        inheritedGlobalIds.has(parameter.id);

                    return (
                        <div
                            className={`datamodel-compact-row datamodel-type-accent datamodel-type-accent-${getDatamodelType(parameter)} ${
                                overwrittenByParent
                                    ? "datamodel-overwritten-parameter"
                                    : ""
                            }`}
                            key={`${parameter.id}-${index}`}
                        >
                            <div className="datamodel-compact-id-cell">
                                <div
                                    className="datamodel-compact-id"
                                    title={parameter.id}
                                >
                                    {parameter.id}
                                </div>

                                <span
                                    className={`datamodel-value-type-badge datamodel-value-type-${getDatamodelType(parameter)}`}
                                >
                                    {inferLiteralValueType(parameter.expr)}
                                </span>
                            </div>

                            <input
                                className="datamodel-compact-value-input"
                                type="text"
                                value={parameter.expr ?? ""}
                                onChange={(event) =>
                                    onUpdateGlobalParam(
                                        index,
                                        event.target.value,
                                        false
                                    )
                                }
                                onBlur={(event) =>
                                    onUpdateGlobalParam(
                                        index,
                                        event.target.value,
                                        true
                                    )
                                }
                                onKeyDown={(event) => {
                                    if (event.key === "Enter") {
                                        event.preventDefault();
                                        event.currentTarget.blur();
                                    }
                                }}
                            />

                            <button
                                type="button"
                                className="datamodel-delete-button"
                                onClick={() => onDeleteParameter(index)}
                                title={`Delete ${parameter.id}`}
                                aria-label={`Delete ${parameter.id}`}
                            >
                                <FiX />
                            </button>

                            {overwrittenByParent && (
                                <div className="datamodel-row-message datamodel-overwrite-error">
                                    Overwritten by parent state machine
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        );
    };

    const renderSourcedGlobals = () => {
        const visibleInheritedGlobalDataModel =
            inheritedGlobalDataModel.filter(isVisibleDataParameter);
        const visibleDescendantGlobalDataModel =
            descendantGlobalDataModel.filter(isVisibleDataParameter);
        const hasInherited = visibleInheritedGlobalDataModel.length > 0;
        const hasDescendants = visibleDescendantGlobalDataModel.length > 0;

        if (!hasInherited && !hasDescendants) {
            return null;
        }

        return (
            <div className="datamodel-parameter-section datamodel-sourced-section">
                <div className="datamodel-section-header">
                    <h3>Sourced Global Variables</h3>
                </div>

                {hasInherited && (
                    <div className="datamodel-inherited-list">
                        {visibleInheritedGlobalDataModel.map(
                            (parameter, index) => (
                                <div
                                    className={`slot-text-field datamodel-inherited-parameter datamodel-type-accent datamodel-type-accent-${getDatamodelType(parameter)}`}
                                    key={`inherited-${parameter.id}-${index}`}
                                >
                                    <div className="datamodel-parameter-header">
                                        <div className="datamodel-sourced-id-group">
                                            <h4>{parameter.id}</h4>
                                            <span
                                                className={`datamodel-value-type-badge datamodel-value-type-${getDatamodelType(parameter)}`}
                                            >
                                                {inferLiteralValueType(parameter.expr)}
                                            </span>
                                        </div>

                                        <span className="datamodel-parent-badge">
                                            {parameter.inheritedFrom ||
                                                "Parent state machine"}
                                        </span>
                                    </div>

                                    <div className="datamodel-inherited-value">
                                        {parameter.expr ?? ""}
                                    </div>
                                </div>
                            )
                        )}
                    </div>
                )}

                {hasDescendants && (
                    <div className="datamodel-descendant-section">
                        <div className="datamodel-subsection-label">
                            From sub-state machines
                        </div>

                        <div className="datamodel-inherited-list">
                            {visibleDescendantGlobalDataModel.map(
                                (parameter, index) => (
                                    <div
                                        className={`slot-text-field datamodel-descendant-parameter datamodel-type-accent datamodel-type-accent-${getDatamodelType(parameter)}`}
                                        key={`descendant-${parameter.sourceTabId || "sub"}-${parameter.id}-${index}`}
                                    >
                                        <div className="datamodel-parameter-header">
                                            <div className="datamodel-sourced-id-group">
                                                <h4>{parameter.id}</h4>
                                                <span
                                                    className={`datamodel-value-type-badge datamodel-value-type-${getDatamodelType(parameter)}`}
                                                >
                                                    {inferLiteralValueType(parameter.expr)}
                                                </span>
                                            </div>

                                            <span className="datamodel-child-badge">
                                                {parameter.definedIn ||
                                                    "Sub-state machine"}
                                            </span>
                                        </div>

                                        <div className="datamodel-inherited-value">
                                            {parameter.expr ?? ""}
                                        </div>
                                    </div>
                                )
                            )}
                        </div>
                    </div>
                )}
            </div>
        );
    };

    return (
        <aside className="workflow-panel">
            <div className="gobal-container">
                <div className="addparam-container datamodel-add-compact">
                    <div className="datamodel-add-topline">
                        <h4>New variable</h4>
                        <div className="datamodel-scope-switch" role="group" aria-label="Variable scope">
                            <button
                                type="button"
                                className={`datamodel-scope-option ${!createGlobal ? "active" : ""}`}
                                aria-pressed={!createGlobal}
                                onClick={() => setCreateGlobal(false)}
                            >
                                Local
                            </button>
                            <button
                                type="button"
                                className={`datamodel-scope-option ${createGlobal ? "active" : ""}`}
                                aria-pressed={createGlobal}
                                onClick={() => setCreateGlobal(true)}
                            >
                                Global
                            </button>
                        </div>
                    </div>

                    <div className="datamodel-add-fields">
                        <label className="datamodel-add-field">
                            <span>Variable ID</span>
                            <input
                                ref={newVariableIdRef}
                                className="slot-field-edit"
                                type="text"
                                placeholder="e.g. counter"
                                value={newParamId}
                                onChange={(event) => setNewParamId(event.target.value)}
                                onKeyDown={handleNewParameterKeyDown}
                                aria-invalid={localIdHasGlobalPrefix || parameterNameAlreadyExists}
                            />
                        </label>
                        <label className="datamodel-add-field">
                            <span>Initial expression</span>
                            <input
                                className="slot-field-edit"
                                type="text"
                                placeholder="e.g. 0"
                                value={newParamExpr}
                                onChange={(event) => setNewParamExpr(event.target.value)}
                                onKeyDown={handleNewParameterKeyDown}
                            />
                        </label>
                    </div>

                    <div className="datamodel-add-footer">
                        <div className="datamodel-add-feedback" aria-live="polite">
                            {localIdHasGlobalPrefix ? (
                                <span className="datamodel-name-error">
                                    IDs beginning with _ are global. Select Global or remove _.
                                </span>
                            ) : parameterNameAlreadyExists && normalizedParameterId ? (
                                <span className="datamodel-name-error">
                                    Variable <strong>{normalizedParameterId}</strong> already exists.
                                </span>
                            ) : newParameterOverwrittenByParent ? (
                                <span className="datamodel-overwrite-error">
                                    Overwritten by parent state machine
                                </span>
                            ) : createGlobal ? (
                                <span className="datamodel-name-preview">
                                    {normalizedParameterId ? (
                                        <>Stored as <strong title={normalizedParameterId}>{normalizedParameterId}</strong></>
                                    ) : (
                                        <>Global IDs start with _</>
                                    )}
                                </span>
                            ) : (
                                <span className="datamodel-name-preview">Locally accessible</span>
                            )}
                        </div>
                        <button
                            type="button"
                            className="datamodel-add-button"
                            onClick={() => {
                                if (handleAddParameter()) newVariableIdRef.current?.focus();
                            }}
                            disabled={!normalizedParameterId || localIdHasGlobalPrefix || parameterNameAlreadyExists}
                            title="Add variable"
                        >
                            <FaPlus aria-hidden="true" />
                            Add
                        </button>
                    </div>
                </div>

                {renderSourcedGlobals()}

                <div className="datamodel-parameter-section">
                    <div className="datamodel-section-header">
                        <h3>Global Variables</h3>
                        <span className="datamodel-section-hint">
                            Globally accessible
                        </span>
                    </div>

                    {renderOwnParameters(
                        globalParameters,
                        "No global variables defined in this state machine.",
                        true
                    )}
                </div>

                <div className="datamodel-parameter-section">
                    <div className="datamodel-section-header">
                        <h3>Local Variables</h3>
                        <span className="datamodel-section-hint">
                            locally accessible
                        </span>
                    </div>

                    {renderOwnParameters(
                        localParameters,
                        "No local variables."
                    )}
                </div>
            </div>
        </aside>
    );
}

export default WorkflowPanel;

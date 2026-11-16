const normalizeName = (value) => String(value || "").trim();

const fileStem = (value) =>
  normalizeName(value)
    .split(/[\\/]/)
    .pop()
    ?.replace(/\.(xml|scxml)$/i, "") || "";

const findChildSegment = (tab, tabById) => {
  if (!tab?.parentTabId) return "";
  const parent = tabById.get(tab.parentTabId);
  const childSource = normalizeName(tab.sourcePath);
  const childTitle = normalizeName(tab.title);
  const childFileStem = fileStem(tab.fileName || tab.sourcePath);

  const parentSubMachine = (parent?.nodes || []).find((node) => {
    if (node.type !== "submachine") return false;
    const src = normalizeName(node.data?.src);
    const label = normalizeName(node.data?.label || node.data?.fullSkillName);
    return (
      (childSource && src === childSource) ||
      (childTitle && label === childTitle) ||
      (childFileStem && fileStem(src) === childFileStem)
    );
  });

  return normalizeName(
    parentSubMachine?.data?.label || parentSubMachine?.data?.fullSkillName || tab.title || childFileStem,
  );
};

/**
 * Build replay contexts for every state-machine tab that is already open.
 * The runtime suffix order is inner -> outer, e.g. s2 inside s1 becomes
 * `#s2#s1` for states/slots and `_s2_s1` for datamodel ids.
 */
export const buildRuntimeReplayContexts = (tabs = [], activeTabId = null, liveState = {}) => {
  const effectiveTabs = (tabs || []).map((tab) =>
    tab.id === activeTabId
      ? {
          ...tab,
          nodes: liveState.nodes ?? tab.nodes ?? [],
          edges: liveState.edges ?? tab.edges ?? [],
          slotNodes: liveState.slotNodes ?? tab.slotNodes ?? [],
          slotEdges: liveState.slotEdges ?? tab.slotEdges ?? [],
          globalDataModel: liveState.globalDataModel ?? tab.globalDataModel ?? [],
        }
      : tab,
  );
  const tabById = new Map(effectiveTabs.map((tab) => [tab.id, tab]));
  const suffixCache = new Map();

  const suffixPartsForTab = (tab) => {
    if (!tab?.parentTabId) return [];
    if (suffixCache.has(tab.id)) return suffixCache.get(tab.id);
    const parent = tabById.get(tab.parentTabId);
    const ownSegment = findChildSegment(tab, tabById);
    const result = [...(ownSegment ? [ownSegment] : []), ...suffixPartsForTab(parent)];
    suffixCache.set(tab.id, result);
    return result;
  };

  return effectiveTabs.map((tab) => ({
    tabId: tab.id,
    parentTabId: tab.parentTabId || null,
    title: tab.title || tab.fileName || tab.id,
    suffixParts: suffixPartsForTab(tab),
    nodes: tab.nodes || [],
    edges: tab.edges || [],
    slotNodes: tab.slotNodes || [],
    slotEdges: tab.slotEdges || [],
    globalDataModel: tab.globalDataModel || [],
  }));
};

/** Display an SCXML runtime state without mistaking its invoking sub-SM suffix
 * for a skill-instance suffix (#1, #2, ...). Match only suffixes proven by the
 * loaded runtime context, never strip arbitrary trailing #segments. */
export const runtimeSnapshotStateLabel = (stateId, invocationSuffixes = []) => {
  const full = normalizeName(stateId);
  const matching = (invocationSuffixes || [])
    .filter((context) =>
      context?.suffix && full.length > context.suffix.length && full.endsWith(context.suffix),
    )
    .sort((a, b) => b.suffix.length - a.suffix.length)[0];
  const skillId = matching ? full.slice(0, -matching.suffix.length) : full;
  return {
    name: (skillId.split(".").pop() || "State").replace(/#1$/, ""),
    subMachines: matching?.names || [],
  };
};

/** Runtime IDs keep invocation suffixes for identity and lookups. Only their
 * presentation may replace a suffix with context badges. Match complete,
 * proven invocation suffixes (longest first), never arbitrary trailing text. */
const contextualRuntimeLabel = (value, invocationSuffixes = [], suffixForContext) => {
  const full = normalizeName(value);
  const matching = (invocationSuffixes || [])
    .map((context) => ({ ...context, displaySuffix: suffixForContext(context?.suffix || "") }))
    .filter(({ displaySuffix }) => displaySuffix && full.length > displaySuffix.length && full.endsWith(displaySuffix))
    .sort((a, b) => b.displaySuffix.length - a.displaySuffix.length)[0];
  return {
    name: matching ? full.slice(0, -matching.displaySuffix.length) : full,
    subMachines: matching?.names || [],
  };
};

/** SCXML datamodel variables use `_child_parent` invocation suffixes. */
export const runtimeVariableContextLabel = (name, invocationSuffixes = []) =>
  contextualRuntimeLabel(name, invocationSuffixes, (suffix) => suffix.replace(/#/g, "_"));

/** Memory paths use `#child#parent` invocation suffixes. */
export const runtimeSlotContextLabel = (path, invocationSuffixes = []) =>
  contextualRuntimeLabel(path, invocationSuffixes, (suffix) => suffix);

/** Reject variables from another invocation in the run-level inspector.
 * A child runtime can qualify its datamodel name with `_child` or report an
 * unqualified name under a `state#child` scope/source. Neither is a root-local
 * variable merely because the currently selected editor tab is the root. */
export function isChildInvocationVariable(name, owner, source, invocationSuffixes = []) {
  const values = [name, owner, source].map((value) => String(value || ""));
  return (invocationSuffixes || []).some(({ suffix }) => {
    if (!suffix) return false;
    const variableSuffix = suffix.replace(/#/g, "_");
    return values.some((value) =>
      (value.length > variableSuffix.length && value.endsWith(variableSuffix)) ||
      (value.length > suffix.length && value.endsWith(suffix))
    );
  });
}

/** The invocation that owns a snapshot is determined by its exact runtime
 * state ID, not the currently open editor tab (which may be a child tab while
 * the selected snapshot belongs to the parent). */
const invocationOfRuntimeId = (state, invocationSuffixes = [], variableName = false) => {
  const id = normalizeName(state);
  const matching = (invocationSuffixes || [])
    .map(({ suffix }) => ({
      suffix: String(suffix || ""),
      ending: variableName ? String(suffix || "").replace(/#/g, "_") : String(suffix || ""),
    }))
    .filter(({ ending }) => ending && id.length > ending.length && id.endsWith(ending))
    .sort((a, b) => b.ending.length - a.ending.length)[0];
  return matching?.suffix || "";
};

/** Assignment events are *changes*, not the persistent variable list.
 * Display a child skill's onentry/onexit writes in that child's snapshot,
 * without leaking them into a parent snapshot when state names are identical.
 * Unqualified/global assignments are already assigned to a snapshot by their
 * SCXML sequence and should not be discarded merely for lacking a root-file
 * datamodel declaration. */
export function assignmentBelongsToRuntimeSnapshot(change, frame, invocationSuffixes = []) {
  if (change?.kind !== "variable") return true;
  const snapshotState = frame?.type === "transition"
    ? frame?.transition?.source || frame?.state || frame?.transition?.target
    : frame?.state || frame?.transition?.source;
  const expected = invocationOfRuntimeId(snapshotState, invocationSuffixes);
  const source = normalizeName(change.source);
  const owner = normalizeName(change.owner);
  const name = normalizeName(change.name);
  // A state-qualified source is the strongest evidence of who performed the
  // assignment. Scope and invocation-qualified variable names are fallbacks.
  // An exact source-state match takes priority over a variable name that
  // happens to end in a child invocation's spelling.
  if (source && source === snapshotState) return true;
  const sourceContext = invocationOfRuntimeId(source, invocationSuffixes);
  const ownerContext = invocationOfRuntimeId(owner, invocationSuffixes);
  const nameContext = invocationOfRuntimeId(name, invocationSuffixes, true);
  const observedContext = sourceContext || ownerContext || nameContext;
  return !observedContext || observedContext === expected;
}

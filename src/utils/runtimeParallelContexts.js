/** SCXML source-transformation-aware view metadata. Runtime state names are
 * associated with exact invocation suffixes, never display labels across tabs.
 */
export function ancestorContainers(context, nodeId) {
  const result = [];
  const visited = new Set();
  let current = context;
  let id = nodeId;
  while (current && id) {
    const byId = current.document.byId;
    let node = byId.get(id);
    while (node?.parentId && !visited.has(`${current.suffix}:${node.parentId}`)) {
      visited.add(`${current.suffix}:${node.parentId}`);
      node = byId.get(node.parentId);
      if (!node) break;
      if (["parallel", "parallelLane", "compound"].includes(node.type)) {
        result.push({ node, context: current });
      }
    }
    id = current.wrapper?.id;
    current = current.parent;
  }
  return result;
}

export const parallelKey = ({ node, context }) => `${context.document.tab.id}:${context.suffix}:${node.id}`;

/** All enclosing Parallels, outermost last. A nested Parallel must not hide
 * its parent's active lane from the camera or the runtime overview. */
function enclosingParallels(context, nodeId) {
  const self = context.document.byId.get(nodeId);
  const ancestors = ancestorContainers(context, nodeId);
  const parents = self?.type === "parallel" ? [{ node: self, context }] : [];
  return [...parents, ...ancestors.filter(({ node }) => node.type === "parallel")].map((parallel) => {
    const lane = ancestors.find(({ node, context: owner }) =>
      node.type === "parallelLane" && owner === parallel.context && node.parentId === parallel.node.id,
    );
    return { ...parallel, lane: lane?.node || null, key: parallelKey(parallel) };
  });
}

export function parallelOf(context, nodeId) {
  return enclosingParallels(context, nodeId)[0] || null;
}

export function getActiveParallelViews(model, activeStates, options = {}) {
  if (!model) return [];
  const exitingStates = options.exitingStates || [];
  const completedStates = new Set(options.completedStates || []);
  const exitedParallelKeys = new Set(options.exitedParallelKeys || []);
  const current = new Set(activeStates || []);
  const views = new Map();
  // Include recently exited states ONLY for a proven transition leaving the
  // enclosing Parallel; a normal within-lane transition is not cancellation.
  for (const state of [...new Set([...current, ...exitingStates])]) {
    const matches = model.states.get(state) || model.containerStates?.get(state) || [];
    if (matches.length !== 1) continue;
    const { context, group } = matches[0];
    for (const parallel of enclosingParallels(context, group.id)) {
      if (!current.has(state) && !exitedParallelKeys.has(parallel.key)) continue;
      if (!views.has(parallel.key))
        views.set(parallel.key, { ...parallel, lanes: new Map(), exiting: exitedParallelKeys.has(parallel.key) });
      const view = views.get(parallel.key);
      if (group.id === parallel.node.id) continue;
      const laneId = parallel.lane?.id || "";
      const lane = view.lanes.get(laneId) || {
        id: laneId,
        name: parallel.lane?.data?.label || "Lane",
        states: [],
        previouslyActive: [],
        finished: false,
        status: "pending",
      };
      const final =
        completedStates.has(state) ||
        String(group.identity || "")
          .split("#")[0]
          .split(".")
          .at(-1)
          .toLowerCase() === "end";
      if (current.has(state)) lane.states.push(state);
      else lane.previouslyActive.push(state);
      if (final) lane.finished = true;
      view.lanes.set(laneId, lane);
    }
  }
  // Preserve completed lanes while their sibling lanes are still running.
  // A previously completed Parallel must not reappear simply because its
  // final state's name remains in the accumulated completion history.
  for (const state of completedStates) {
    const matches = model.states.get(state) || model.containerStates?.get(state) || [];
    if (matches.length !== 1) continue;
    for (const parallel of enclosingParallels(matches[0].context, matches[0].group.id)) {
      const view = views.get(parallel.key);
      if (!view || !parallel.lane) continue;
      const lane = view.lanes.get(parallel.lane.id) || {
        id: parallel.lane.id,
        name: parallel.lane.data?.label || "Lane",
        states: [],
        previouslyActive: [],
        finished: false,
        status: "pending",
      };
      lane.finished = true;
      view.lanes.set(lane.id, lane);
    }
  }
  return [...views.values()].map((view) => {
    // Display the complete lane list, including lanes not entered yet.
    for (const node of view.context.document.containers || []) {
      if (node.type === "parallelLane" && node.parentId === view.node.id && !view.lanes.has(node.id)) {
        view.lanes.set(node.id, {
          id: node.id,
          name: node.data?.label || "Lane",
          states: [],
          previouslyActive: [],
          finished: false,
          status: "pending",
        });
      }
    }
    const lanes = [...view.lanes.values()].map((lane) => ({
      ...lane,
      status: lane.finished
        ? "completed"
        : lane.states.length
          ? "active"
          : view.exiting && lane.previouslyActive.length
            ? "exited"
            : "pending",
    }));
    return { ...view, lanes };
  });
}

/** Choose one stable camera owner. Concurrent sibling activity must not change
 * the whole-Parallel key, nor the selected lane's camera target. The caller
 * resolves runtime state IDs against its loaded, invocation-qualified model. */
export function parallelCameraPlan(views, selection, tabId, resolveStateIds) {
  const visible = (views || []).filter(
    (view) => !view.exiting && view.context.document.tab.id === tabId,
  ).sort((a, b) => {
    const depth = (view) => {
      let ancestor = view.context;
      let n = 0;
      while (ancestor.parent) { n += 1; ancestor = ancestor.parent; }
      return n + ancestorContainers(view.context, view.node.id).length;
    };
    return depth(a) - depth(b);
  });
  // The selected lane might be executing in a sub-SM tab. In that case
  // project just its states into the current document; never follow siblings.
  const selectedView = (views || []).find((view) => !view.exiting && view.key === selection?.parallelKey);
  const selectedLane = selectedView?.lanes.find((item) => item.id === selection?.laneId);
  // Once the chosen lane finishes, show its enclosing Parallel rather than
  // automatically chasing an unrelated still-active sibling lane.
  if (selectedLane?.finished && !selectedLane.states.length) {
    return {
      view: selectedView,
      lane: null,
      cameraIds: selectedView.context.document.tab.id === tabId ? [selectedView.node.id] : [],
      key: `parallel:${selectedView.key}:selected-lane-completed:${tabId}`,
    };
  }
  if (selectedLane && selectedView.context.document.tab.id !== tabId) {
    const states = [...new Set(selectedLane.states || [])].sort();
    const ids = [...new Set(states.flatMap((state) => resolveStateIds(state) || []))];
    return {
      view: selectedView,
      lane: selectedLane,
      cameraIds: ids,
      key: `lane:${selectedView.key}:${selectedLane.id}:${tabId}:${states.join("|")}`,
    };
  }
  const view = visible.find((item) => item.key === selection?.parallelKey) || visible[0];
  if (!view) {
    // The user manually opened another document while the parent Parallel is
    // active. Keep this tab stationary rather than following sibling events.
    const elsewhere = (views || []).find((item) => !item.exiting);
    return elsewhere ? {
      view: elsewhere,
      lane: null,
      cameraIds: [],
      key: `parallel:${elsewhere.key}:other-tab:${tabId}`,
    } : null;
  }
  const lane = selection?.parallelKey === view.key
    ? view.lanes.find((item) => item.id === selection?.laneId)
    : null;
  if (!lane) {
    return {
      view,
      lane: null,
      cameraIds: [view.node.id],
      key: `parallel:${view.key}`,
    };
  }
  const stateIds = [...new Set(lane.states || [])].sort();
  const cameraIds = [...new Set(stateIds.flatMap((state) => resolveStateIds(state) || []))];
  return {
    view,
    lane,
    cameraIds: cameraIds.length ? cameraIds : [lane.id || view.node.id],
    key: `lane:${view.key}:${lane.id}:${tabId}:${stateIds.join("|")}`,
  };
}

/** A brief empty active-state set between callbacks is not proof that a
 * Parallel exited. Keep the last camera owner until a verified exit or a
 * state outside the Parallel takes over. */
export function retainParallelCameraPlan(current, previous, exitingKeys, activeStates, model, status) {
  if (current) return current;
  if (!previous || status !== "RUNNING" || (exitingKeys || []).includes(previous.view.key)) return null;
  if (!(activeStates || []).length) return previous;
  let hasUnresolved = false;
  const stillInside = activeStates.some((state) => {
    const matches = model?.states.get(state) || model?.containerStates?.get(state) || [];
    if (matches.length !== 1) {
      // A child tab may not be compiled yet. Do not release the Parallel
      // lock merely because an invocation-qualified state is unresolved.
      hasUnresolved = true;
      return false;
    }
    return enclosingParallels(matches[0].context, matches[0].group.id)
      .some((parallel) => parallel.key === previous.view.key);
  });
  return stillInside || hasUnresolved ? previous : null;
}

/** Check the actual source/target hierarchy. Only a transition with a source
 * inside a Parallel and a target outside it cancels sibling lanes. */
export function getExitedParallelKeys(model, transitions = []) {
  if (!model) return [];
  const result = new Set();
  for (const edge of transitions || []) {
    const sources = model.states.get(edge.source) || model.containerStates?.get(edge.source) || [];
    const targets = model.states.get(edge.target) || model.containerStates?.get(edge.target) || [];
    if (sources.length !== 1 || targets.length !== 1) continue;
    const sourceParallels = enclosingParallels(sources[0].context, sources[0].group.id);
    const targetKeys = new Set(enclosingParallels(targets[0].context, targets[0].group.id).map((view) => view.key));
    for (const from of sourceParallels) if (!targetKeys.has(from.key)) result.add(from.key);
  }
  return [...result];
}

/** The earliest entered invocation wins; other parallel lanes remain tracked
 * without stealing navigation. 'states' MUST be in WebSocket entry order. */
export function firstActiveSubMachine(model, states, parallelKeyFilter = null) {
  if (!model) return null;
  for (const state of states || []) {
    const wrappers = model.wrappers.filter(
      (wrapper) => state.length > wrapper.suffix.length && state.endsWith(wrapper.suffix),
    );
    wrappers.sort((a, b) => a.suffix.length - b.suffix.length);
    for (const wrapper of wrappers) {
      const parallel = parallelOf(wrapper.context, wrapper.group.id);
      if (parallelKeyFilter && parallel?.key !== parallelKeyFilter) continue;
      return { wrapper, parallel };
    }
  }
  return null;
}

/** Only a proven ROOT final state may stop the whole engine. A terminal
 * emitted by a final node inside a Parallel lane must not stop its siblings.
 */
export function isRootTerminalState(workflow, state) {
  const full = String(state || "").trim();
  if (!full || !workflow?.nodes) return false;
  const identity = (value) => {
    const text = String(value || "").trim();
    const index = text.indexOf("#");
    const name = index < 0 ? text : text.slice(0, index);
    return `${name.split(".").at(-1)}${index < 0 ? "" : text.slice(index)}`;
  };
  const matches = workflow.nodes.filter((node) => {
    const name = String(node.data?.fullSkillName || node.data?.label || "");
    const base = name.split("#")[0].split(".").at(-1).toLowerCase();
    const final = node.data?.isFinal || ["end", "fatal"].includes(base);
    return (
      node.type === "custom" &&
      final &&
      [node.data?.scxmlStateId, node.data?.fullSkillName, node.data?.label].some(
        (value) => identity(value) === identity(full),
      )
    );
  });
  return matches.length === 1 && !matches[0].parentId;
}

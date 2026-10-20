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

export function parallelOf(context, nodeId) {
    const self = context.document.byId.get(nodeId);
    if (self?.type === "parallel") return { node: self, context, lane: null,
        key: parallelKey({ node: self, context }) };
    const ancestors = ancestorContainers(context, nodeId);
    const parallel = ancestors.find(({ node }) => node.type === "parallel");
    if (!parallel) return null;
    const lane = ancestors.find(({ node, context: ctx }) => node.type === "parallelLane" && ctx === parallel.context);
    return { ...parallel, lane: lane?.node || null, key: parallelKey(parallel) };
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
        const parallel = parallelOf(context, group.id);
        if (!parallel || (!current.has(state) && !exitedParallelKeys.has(parallel.key))) continue;
        if (!views.has(parallel.key)) views.set(parallel.key, { ...parallel, lanes: new Map(), exiting: exitedParallelKeys.has(parallel.key) });
        const view = views.get(parallel.key);
        // Structural Parallel entry is not itself a lane.
        if (group.id === parallel.node.id) continue;
        const laneId = parallel.lane?.id || "";
        const lane = view.lanes.get(laneId) || { id: laneId, name: parallel.lane?.data?.label || "Lane",
            states: [], previouslyActive: [], finished: false, status: "pending" };
        const final = completedStates.has(state) ||
            String(group.identity || "").split("#")[0].split(".").at(-1).toLowerCase() === "end";
        if (current.has(state)) lane.states.push(state);
        else lane.previouslyActive.push(state);
        if (final) lane.finished = true;
        view.lanes.set(laneId, lane);
    }
    // Preserve completed lanes while their sibling lanes are still running.
    // A previously completed Parallel must not reappear simply because its
    // final state's name remains in the accumulated completion history.
    for (const state of completedStates) {
        const matches = model.states.get(state) || model.containerStates?.get(state) || [];
        if (matches.length !== 1) continue;
        const parallel = parallelOf(matches[0].context, matches[0].group.id);
        const view = parallel && views.get(parallel.key);
        if (!view || !parallel.lane) continue;
        const lane = view.lanes.get(parallel.lane.id) || { id: parallel.lane.id,
            name: parallel.lane.data?.label || "Lane", states: [], previouslyActive: [], finished: false, status: "pending" };
        lane.finished = true;
        view.lanes.set(lane.id, lane);
    }
    return [...views.values()].map((view) => {
        // Display the complete lane list, including lanes not entered yet.
        for (const node of view.context.document.containers || []) {
            if (node.type === "parallelLane" && node.parentId === view.node.id && !view.lanes.has(node.id)) {
                view.lanes.set(node.id, { id: node.id, name: node.data?.label || "Lane",
                    states: [], previouslyActive: [], finished: false, status: "pending" });
            }
        }
        const lanes = [...view.lanes.values()].map((lane) => ({ ...lane,
            status: lane.finished ? "completed" : lane.states.length ? "active"
                : view.exiting && lane.previouslyActive.length ? "exited" : "pending" }));
        return { ...view, lanes };
    });
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
        const from = parallelOf(sources[0].context, sources[0].group.id);
        const to = parallelOf(targets[0].context, targets[0].group.id);
        if (from && to?.key !== from.key) result.add(from.key);
    }
    return [...result];
}

/** The earliest entered invocation wins; other parallel lanes remain tracked
 * without stealing navigation. 'states' MUST be in WebSocket entry order. */
export function firstActiveSubMachine(model, states, parallelKeyFilter = null) {
    if (!model) return null;
    for (const state of states || []) {
        const wrappers = model.wrappers.filter((wrapper) =>
            state.length > wrapper.suffix.length && state.endsWith(wrapper.suffix));
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
        return node.type === "custom" && final &&
            [node.data?.scxmlStateId, node.data?.fullSkillName, node.data?.label]
                .some((value) => identity(value) === identity(full));
    });
    return matches.length === 1 && !matches[0].parentId;
}

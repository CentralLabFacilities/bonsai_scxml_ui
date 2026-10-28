/**
 * Prevent identical skill classes from handling one another's events in
 * simultaneously active regions of the same SCXML parallel.
 *
 * Names such as Wait#1 and Wait#2 identify different state instances, NOT
 * different event producers: both emit Wait.success. Never compare labels or
 * instance numbers. Nested compounds do not establish separate regions.
 */
export const getParallelSkillType = (node) => {
    if (node?.type !== "custom" || node.data?.isSkillClone ||
        node.data?.isStateClone || node.data?.isFinal || node.data?.isBehaviorExit) {
        return "";
    }
    const name = String(node.data?.fullSkillName || "").trim();
    if (!name) return "";
    const withoutInstance = name.replace(/#\d+$/, "");
    const nameWithoutPrefix = withoutInstance.split(".skills.").pop();
    if (/^(end|fatal)$/i.test(nameWithoutPrefix)) return "";
    return nameWithoutPrefix;
};

/** Return all conflicting skill pairs, one per parallel + class + lane pair. */
export const findParallelLaneSkillConflicts = (nodes = [], { focusNodeIds = null } = {}) => {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const owners = new Map();
    const conflicts = [];
    const seen = new Set();

    for (const node of nodes) {
        const skillType = getParallelSkillType(node);
        if (!skillType) continue;
        let parentId = node.parentId;
        const visited = new Set();
        while (parentId && !visited.has(parentId)) {
            visited.add(parentId);
            const parent = byId.get(parentId);
            if (!parent) break;
            if (parent.type === "parallelLane") {
                const parallel = byId.get(parent.parentId);
                if (parallel?.type === "parallel") {
                    const key = `${parallel.id}\0${skillType}`;
                    const existing = owners.get(key) || new Map();
                    for (const [otherLaneId, otherNode] of existing) {
                        if (otherLaneId === parent.id) continue;
                        if (focusNodeIds && !focusNodeIds.has(node.id) && !focusNodeIds.has(otherNode.id)) continue;
                        const identity = `${key}\0${[otherLaneId, parent.id].sort().join("\0")}`;
                        if (seen.has(identity)) continue;
                        seen.add(identity);
                        conflicts.push({
                            parallelId: parallel.id,
                            parallelName: parallel.data?.label || parallel.id,
                            skillType,
                            firstNodeId: otherNode.id,
                            secondNodeId: node.id,
                            firstLaneId: otherLaneId,
                            secondLaneId: parent.id,
                            firstLaneName: byId.get(otherLaneId)?.data?.label || otherLaneId,
                            secondLaneName: parent.data?.label || parent.id,
                        });
                    }
                    if (!existing.has(parent.id)) existing.set(parent.id, node);
                    owners.set(key, existing);
                }
            }
            parentId = parent.parentId;
        }
    }
    return conflicts;
};

export const describeParallelLaneSkillConflict = () => "Skill already present in another Lane";

export const collectParallelLaneSkillProblems = (nodes = []) =>
    findParallelLaneSkillConflicts(nodes).map((conflict) => ({
        id: `parallel-skill-conflict-${conflict.parallelId}-${conflict.skillType}-${conflict.firstLaneId}-${conflict.secondLaneId}`,
        severity: "error",
        category: "Parallel",
        title: "Same skill type in different parallel lanes",
        message: describeParallelLaneSkillConflict(conflict),
        nodeId: conflict.secondNodeId,
        detailTab: "allgemein",
        mode: "event",
        focusNodeIds: [conflict.firstNodeId, conflict.secondNodeId],
    }));

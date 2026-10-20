import { rebuildBoundaryTransitions } from "./boundaryTransitions.js";

// Node insertion changes which skills a container-level SCXML event can
// originate from. Rebuild the affected boundary projection in the SAME graph
// transaction as insertion; a later drag/resize must not be required to reveal
// shared exits. Ordinary root/compound drops avoid this expensive rebuild.
export function insertNodeWithParallelBoundarySync(nodes, edges, insertNodes, insertedNodeId) {
    const nextNodes = insertNodes(nodes);
    const byId = new Map(nextNodes.map((node) => [node.id, node]));
    let current = byId.get(insertedNodeId);
    const visited = new Set();
    let insideParallel = false;
    while (current?.parentId && !visited.has(current.parentId)) {
        visited.add(current.parentId);
        current = byId.get(current.parentId);
        if (current?.type === "parallel") {
            insideParallel = true;
            break;
        }
    }
    if (!insideParallel) return { nodes: nextNodes };
    const projected = rebuildBoundaryTransitions(nextNodes, edges);
    return { nodes: projected.nodes, edges: projected.edges };
}

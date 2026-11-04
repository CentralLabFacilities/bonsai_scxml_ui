import { useLayoutEffect, useRef } from "react";
import { getViewportForBounds, useReactFlow, useStoreApi } from "@xyflow/react";

const sameViewport = (a, b) => a.x === b.x && a.y === b.y && a.zoom === b.zoom;

// A keyed Flow can initially render the provider's outgoing transform. Keep its
// graph measurable but hidden until this mount's actual pan/zoom owns the camera.
export default function CanvasViewportPlacement({
    placement, nodes, ownerRef, beginPlacement, completePlacement, releasePlacement, getActiveDocumentIdentity,
}) {
    const store = useStoreApi();
    const instance = useReactFlow();
    const anchorRef = useRef(null);
    const latest = useRef({ nodes, instance });
    const checkRef = useRef(null);
    useLayoutEffect(() => {
        latest.current = { nodes, instance };
        checkRef.current?.();
    }, [nodes, instance]);

    useLayoutEffect(() => {
        const element = anchorRef.current?.closest(".react-flow");
        if (!element) return undefined;
        element.dataset.viewportReady = "false";
        let owner = null;
        let panZoom = null;
        let policy = null;
        let applying = false;
        let settled = false;
        let cancelled = false;
        let failedPanZoom = null;
        const owned = () => !cancelled && getActiveDocumentIdentity() === placement.identity &&
            store.getState().panZoom === panZoom && store.getState().domNode === element;

        const check = () => {
            const state = store.getState();
            if (cancelled || settled || getActiveDocumentIdentity() !== placement.identity ||
                !state.panZoom || state.domNode !== element || state.panZoom === failedPanZoom) return;
            if (owner && panZoom !== state.panZoom) {
                releasePlacement(placement.identity, owner);
                owner = null;
                applying = false;
            }
            if (applying) return;
            if (!owner) {
                panZoom = state.panZoom;
                owner = latest.current.instance;
                policy = beginPlacement(placement.identity, owner);
                if (!policy) {
                    cancelled = true;
                    return;
                }
                ownerRef.current = { identity: placement.identity, instance: owner };
            }
            if (!owned()) return;
            let viewport = policy.viewport || (policy.fitOptions ? null : panZoom.getViewport());
            if (!viewport) {
                // Fence measurements by the incoming collection, not a previous
                // document's nodesInitialized boolean (IDs may be reused).
                const expected = latest.current.nodes;
                const width = element.offsetWidth;
                const height = element.offsetHeight;
                if (state.nodes !== expected || width <= 0 || height <= 0 ||
                    state.width !== width || state.height !== height) return;
                const options = policy.fitOptions || {};
                const scope = options.nodes && new Set(options.nodes.map((node) => node.id));
                const fitNodes = [];
                for (const node of expected) {
                    const internal = state.nodeLookup.get(node.id);
                    if (!internal || internal.internals.userNode !== node) return;
                    if (!node.hidden && (!internal.internals.handleBounds ||
                        !internal.measured?.width || !internal.measured?.height)) return;
                    if ((!node.hidden || options.includeHiddenNodes) && (!scope || scope.has(node.id))) {
                        fitNodes.push(internal);
                    }
                }
                viewport = fitNodes.length
                    ? getViewportForBounds(owner.getNodesBounds(fitNodes), state.width, state.height,
                        options.minZoom ?? state.minZoom, options.maxZoom ?? state.maxZoom,
                        options.padding ?? 0.2)
                    : panZoom.getViewport();
            }
            const placingPanZoom = panZoom;
            const placingOwner = owner;
            const expectedNodes = latest.current.nodes;
            const fitting = !policy.viewport && policy.fitOptions;
            applying = true;
            void owner.setViewport(viewport, { duration: 0 }).then((applied) => {
                if (cancelled) return;
                if (placingPanZoom !== panZoom || placingOwner !== owner) return;
                if (placingPanZoom !== store.getState().panZoom) {
                    applying = false;
                    check();
                    return;
                }
                if (!owned()) return;
                if (!applied) {
                    // Retry on a real pan/zoom initialization transition only.
                    failedPanZoom = panZoom;
                    applying = false;
                    return;
                }
                if (fitting && (latest.current.nodes !== expectedNodes ||
                    store.getState().width !== state.width || store.getState().height !== state.height ||
                    element.offsetWidth !== state.width || element.offsetHeight !== state.height)) {
                    applying = false;
                    check();
                    return;
                }
                const actual = panZoom.getViewport();
                if (!sameViewport(actual, viewport)) return;
                // ZoomPane can publish panZoom before installing its transform
                // callback. Publish that verified transform in this case too.
                const [x, y, zoom] = store.getState().transform;
                if (!sameViewport(actual, { x, y, zoom })) {
                    store.setState({ transform: [actual.x, actual.y, actual.zoom] });
                }
                if (!completePlacement(placement.identity, owner, actual)) return;
                settled = true;
                element.dataset.viewportReady = "true";
            });
        };
        checkRef.current = check;
        const unsubscribe = store.subscribe(check);
        check();
        return () => {
            cancelled = true;
            checkRef.current = null;
            unsubscribe();
            // Interrupt a running explicit navigation on the old pan/zoom, not
            // the shared provider's potentially already-replaced instance.
            if (panZoom) void panZoom.setViewport(panZoom.getViewport(), { duration: 0 });
            if (owner) releasePlacement(placement.identity, owner);
            if (ownerRef.current?.instance === owner) ownerRef.current = null;
            element.dataset.viewportReady = "false";
        };
    }, [placement, store, ownerRef, beginPlacement, completePlacement, releasePlacement, getActiveDocumentIdentity]);
    return <span ref={anchorRef} hidden />;
}

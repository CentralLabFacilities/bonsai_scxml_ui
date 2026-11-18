/**
 * Inspector and Run Assignments occupy the same conceptual right-side dock.
 * Their visibility is mutually exclusive; closing one does not implicitly
 * open the other. This reducer has no side effects and is easy to regression-test.
 */
export function resolveRightPanelSwitch({ inspectorOpen = false, assignmentsOpen = false }, action) {
  switch (action) {
    case "open-inspector":
      return { inspectorOpen: true, assignmentsOpen: false };
    case "toggle-inspector":
      return { inspectorOpen: !inspectorOpen, assignmentsOpen: false };
    case "open-assignments":
      return { inspectorOpen: false, assignmentsOpen: true };
    case "toggle-assignments":
      return { inspectorOpen: false, assignmentsOpen: !assignmentsOpen };
    case "close-assignments":
      return { inspectorOpen, assignmentsOpen: false };
    default:
      return { inspectorOpen, assignmentsOpen };
  }
}

/**
 * Run Assignments owns the shared right-hand dock whenever it is visible.
 * Keep this derived ownership separate from the persisted Inspector preference:
 * a stale/concurrent Inspector-open update must not display two panels.
 */
export function resolveVisibleRightPanel({ inspectorOpen = false, assignmentsOpen = false, assignmentsAvailable = false }) {
  const assignmentsVisible = Boolean(assignmentsOpen && assignmentsAvailable);
  return {
    inspectorVisible: Boolean(inspectorOpen && !assignmentsVisible),
    assignmentsVisible,
  };
}

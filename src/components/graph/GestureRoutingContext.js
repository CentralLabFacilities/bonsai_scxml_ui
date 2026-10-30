import { createContext } from "react";

// A presentation-only switch. It never changes semantic edge arrays/ids.
// During an interaction it avoids A* route work for all displayed edges;
// the SmartEdgeProvider stays mounted and receives the final geometry on drop.
export const GestureRoutingContext = createContext(false);

import { distanceMeters } from "./geo";
import { edgeEndCoord, edgeStartCoord } from "./graph";
import { getRoadProfile } from "./roadProfiles";
import { DiagnosticTransition, DirectedEdge, RoadGraph, TerminalBug } from "./types";

export interface RouteResult {
    routeEdgeIds: string[];
    terminalBug: TerminalBug | null;
}

interface HeapItem {
    edgeId: string;
    f: number;
    g: number;
}

class MinHeap {
    private items: HeapItem[] = [];

    get size(): number {
        return this.items.length;
    }

    push(item: HeapItem): void {
        this.items.push(item);
        this.bubbleUp(this.items.length - 1);
    }

    pop(): HeapItem | undefined {
        if (this.items.length === 0) return undefined;
        const top = this.items[0];
        const last = this.items.pop()!;
        if (this.items.length > 0) {
            this.items[0] = last;
            this.sinkDown(0);
        }
        return top;
    }

    private bubbleUp(idx: number): void {
        while (idx > 0) {
            const parent = (idx - 1) >> 1;
            if (this.items[parent].f <= this.items[idx].f) break;
            const tmp = this.items[parent];
            this.items[parent] = this.items[idx];
            this.items[idx] = tmp;
            idx = parent;
        }
    }

    private sinkDown(idx: number): void {
        const n = this.items.length;
        while (true) {
            const left = idx * 2 + 1;
            const right = left + 1;
            let smallest = idx;
            if (left < n && this.items[left].f < this.items[smallest].f) smallest = left;
            if (right < n && this.items[right].f < this.items[smallest].f) smallest = right;
            if (smallest === idx) break;
            const tmp = this.items[smallest];
            this.items[smallest] = this.items[idx];
            this.items[idx] = tmp;
            idx = smallest;
        }
    }
}

const MAX_HEURISTIC_SPEED_MPS = 56; // ~201.6 km/h admissible upper bound for unrestricted freeways

export function hasEnabledOutgoingTurn(graph: RoadGraph, edgeId: string): boolean {
    const transitions = graph.outgoing.get(edgeId);
    if (!transitions) return false;
    for (const t of transitions) {
        if (!t.isLegal) continue;
        const target = graph.edges.get(t.toEdgeId);
        if (target && !target.isClosed && target.isDrivableDirection) {
            return true;
        }
    }
    return false;
}

function edgeTravelCost(edge: DirectedEdge, occupancy: Map<string, number>): number {
    const occ = occupancy.get(edge.id) ?? 0;
    const ratio = edge.maxCapacity > 0 ? Math.min(2, occ / edge.maxCapacity) : 0;
    const congestionMultiplier = 1 + 2.5 * ratio * ratio;
    const effectiveRoadType = edge.routingRoadType ?? edge.roadType;
    const importanceFactor = getRoadProfile(effectiveRoadType).routingFactor;
    return (
        (edge.lengthMeters / Math.max(edge.speedMps, 2)) *
        importanceFactor *
        congestionMultiplier
    );
}

function reconstructPath(
    cameFromEdge: Map<string, string>,
    endEdgeId: string
): string[] {
    const path: string[] = [endEdgeId];
    let cur = endEdgeId;
    while (cameFromEdge.has(cur)) {
        cur = cameFromEdge.get(cur)!;
        path.push(cur);
    }
    path.reverse();
    return path;
}

function buildTerminalBugMessage(
    fromEdge: DirectedEdge,
    toEdge: DirectedEdge,
    transition: DiagnosticTransition
): TerminalBug {
    const [endLon, endLat] = edgeEndCoord(fromEdge);
    switch (transition.bugKind) {
        case "DISCONNECTED_NODE": {
            const gap = transition.gapMeters != null ? ` (${transition.gapMeters.toFixed(1)}m gap)` : "";
            return {
                kind: "DISCONNECTED_NODE",
                nodeId: transition.viaNodeId,
                segmentId: fromEdge.segmentId,
                targetSegmentId: toEdge.segmentId,
                lon: endLon,
                lat: endLat,
                message: `Disconnected node${gap} between ${fromEdge.streetName} and ${toEdge.streetName}`,
            };
        }
        case "ROAD_CLOSURE":
            return {
                kind: "ROAD_CLOSURE",
                nodeId: transition.viaNodeId,
                segmentId: toEdge.segmentId,
                targetSegmentId: fromEdge.segmentId,
                lon: endLon,
                lat: endLat,
                message: `Road closure on ${toEdge.streetName} blocks route from ${fromEdge.streetName}`,
            };
        case "DEAD_END":
            return {
                kind: "DEAD_END",
                nodeId: transition.viaNodeId,
                segmentId: fromEdge.segmentId,
                targetSegmentId: toEdge.segmentId,
                lon: endLon,
                lat: endLat,
                message: `One-way trap / dead end at ${fromEdge.streetName} -> ${toEdge.streetName}`,
            };
        case "DISALLOWED_TURN":
        default:
            return {
                kind: "DISALLOWED_TURN",
                nodeId: transition.viaNodeId,
                segmentId: fromEdge.segmentId,
                targetSegmentId: toEdge.segmentId,
                lon: endLon,
                lat: endLat,
                message: `Disallowed turn from ${fromEdge.streetName} onto ${toEdge.streetName}`,
            };
    }
}

function runAStar(
    graph: RoadGraph,
    startEdgeId: string,
    destEdgeId: string,
    occupancy: Map<string, number>,
    allowDiagnostic: boolean
): {
    found: boolean;
    cameFromEdge: Map<string, string>;
    cameFromTransition: Map<string, DiagnosticTransition>;
    gScore: Map<string, number>;
} {
    const destEdge = graph.edges.get(destEdgeId)!;
    const [destLon, destLat] = edgeStartCoord(destEdge);

    const open = new MinHeap();
    const gScore = new Map<string, number>();
    const cameFromEdge = new Map<string, string>();
    const cameFromTransition = new Map<string, DiagnosticTransition>();
    const closed = new Set<string>();

    const startEdge = graph.edges.get(startEdgeId)!;
    const [startLon, startLat] = edgeEndCoord(startEdge);
    const startH = distanceMeters(startLon, startLat, destLon, destLat) / MAX_HEURISTIC_SPEED_MPS;

    gScore.set(startEdgeId, 0);
    open.push({ edgeId: startEdgeId, f: startH, g: 0 });

    while (open.size > 0) {
        const current = open.pop()!;
        if (closed.has(current.edgeId)) continue;
        if (current.edgeId === destEdgeId) {
            return { found: true, cameFromEdge, cameFromTransition, gScore };
        }
        closed.add(current.edgeId);

        const transitions = graph.outgoing.get(current.edgeId);
        if (!transitions) continue;

        for (const t of transitions) {
            if (!allowDiagnostic && !t.isLegal) continue;
            const nextEdge = graph.edges.get(t.toEdgeId);
            if (!nextEdge || !nextEdge.isDrivableDirection) continue;
            if (!allowDiagnostic && nextEdge.isClosed) continue;
            if (closed.has(nextEdge.id)) continue;

            const stepCost =
                (nextEdge.id === destEdgeId ? 0 : edgeTravelCost(nextEdge, occupancy)) +
                (t.isLegal ? 0 : t.penaltySeconds);
            const tentativeG = current.g + stepCost;
            const prevG = gScore.get(nextEdge.id);
            if (prevG !== undefined && tentativeG >= prevG) continue;

            gScore.set(nextEdge.id, tentativeG);
            cameFromEdge.set(nextEdge.id, current.edgeId);
            cameFromTransition.set(nextEdge.id, t);

            const [nLon, nLat] = edgeEndCoord(nextEdge);
            const h = distanceMeters(nLon, nLat, destLon, destLat) / MAX_HEURISTIC_SPEED_MPS;
            open.push({ edgeId: nextEdge.id, f: tentativeG + h, g: tentativeG });
        }
    }

    return { found: false, cameFromEdge, cameFromTransition, gScore };
}

export function findRoute(
    graph: RoadGraph,
    startEdgeId: string,
    destEdgeId: string,
    occupancy: Map<string, number>
): RouteResult | null {
    const startEdge = graph.edges.get(startEdgeId);
    const destEdge = graph.edges.get(destEdgeId);
    if (!startEdge || !destEdge || startEdge.isClosed) return null;

    if (startEdgeId === destEdgeId) {
        return { routeEdgeIds: [startEdgeId], terminalBug: null };
    }

    // Pass 1: strictly legal routing
    const legalSearch = runAStar(graph, startEdgeId, destEdgeId, occupancy, false);
    if (legalSearch.found) {
        return {
            routeEdgeIds: reconstructPath(legalSearch.cameFromEdge, destEdgeId),
            terminalBug: null,
        };
    }

    // If targeting the outward edge of a dead-end branch, route to its reachable inward twin
    if (!destEdge.isClosed) {
        const oppositeDestId = `${destEdge.segmentId}:${destEdge.isForward ? "R" : "F"}`;
        if (graph.deadEndBranchEdgeIds.has(oppositeDestId) && legalSearch.gScore.has(oppositeDestId)) {
            return {
                routeEdgeIds: reconstructPath(legalSearch.cameFromEdge, oppositeDestId),
                terminalBug: null,
            };
        }
    }

    // If already heading into a dead-end branch, end the route cleanly at its terminus
    if (graph.deadEndBranchEdgeIds.has(startEdgeId)) {
        const [destLon, destLat] = edgeStartCoord(destEdge);
        let bestDeadEndId = startEdgeId;
        let bestDeadEndDist = Infinity;
        for (const reachableEdgeId of legalSearch.gScore.keys()) {
            const edge = graph.edges.get(reachableEdgeId);
            if (!edge || !edge.isDeadEnd) continue;
            const [ex, ey] = edgeEndCoord(edge);
            const d = distanceMeters(ex, ey, destLon, destLat);
            if (d < bestDeadEndDist) {
                bestDeadEndDist = d;
                bestDeadEndId = reachableEdgeId;
            }
        }
        return {
            routeEdgeIds: reconstructPath(legalSearch.cameFromEdge, bestDeadEndId),
            terminalBug: null,
        };
    }

    // Only treat unreachability as a chaos bug if destination is isolated from all entries
    // OR startEdge is trapped in a sink with no legal exit to a continuing/border/destination road.
    const destIsIsolatedBug = !graph.legallyReachableDestIds.has(destEdgeId);
    const startIsTrappedInSink = !graph.canExitCorridorIds.has(startEdgeId);
    if (!destIsIsolatedBug && !startIsTrappedInSink) {
        return null;
    }

    // Pass 2: diagnostic routing across turn restrictions, closures, or <=22m phantom gaps
    const diagSearch = runAStar(graph, startEdgeId, destEdgeId, occupancy, true);
    if (diagSearch.found) {
        const fullPath = reconstructPath(diagSearch.cameFromEdge, destEdgeId);
        // Truncate right before the first illegal transition so Wazers never cheat a restriction/closure/gap
        for (let i = 1; i < fullPath.length; i++) {
            const toId = fullPath[i];
            const trans = diagSearch.cameFromTransition.get(toId);
            if (trans && !trans.isLegal) {
                const fromEdge = graph.edges.get(fullPath[i - 1])!;
                const toEdge = graph.edges.get(toId)!;
                // A segment with an enabled legal outgoing turn is NOT a dead end
                if (trans.bugKind === "DEAD_END" && hasEnabledOutgoingTurn(graph, fromEdge.id)) {
                    continue;
                }
                return {
                    routeEdgeIds: fullPath.slice(0, i),
                    terminalBug: buildTerminalBugMessage(fromEdge, toEdge, trans),
                };
            }
        }
    }

    // Pass 3: completely disconnected island (>22m apart) or sink trap — route legally ONLY to a
    // blocked terminal edge (never flag a continuing road or map-border exit as a dead end).
    const [destLon, destLat] = edgeStartCoord(destEdge);
    let bestEdgeId: string | null = null;
    let bestDist = Infinity;

    for (const reachableEdgeId of legalSearch.gScore.keys()) {
        const edge = graph.edges.get(reachableEdgeId);
        if (!edge || edge.isMapBorderExit || edge.isDeadEnd) continue;
        if (hasEnabledOutgoingTurn(graph, reachableEdgeId)) continue;
        const [ex, ey] = edgeEndCoord(edge);
        const d = distanceMeters(ex, ey, destLon, destLat);
        if (d < bestDist) {
            bestDist = d;
            bestEdgeId = reachableEdgeId;
        }
    }

    if (!bestEdgeId) {
        return null;
    }

    const bestEdge = graph.edges.get(bestEdgeId)!;
    const [endLon, endLat] = edgeEndCoord(bestEdge);
    const outgoingAtBest = graph.outgoing.get(bestEdgeId) ?? [];
    const illegalCandidate = outgoingAtBest.find((t) => !t.isLegal);

    if (!startIsTrappedInSink && !illegalCandidate) {
        return null;
    }

    let terminalBug: TerminalBug;
    if (illegalCandidate) {
        const target = graph.edges.get(illegalCandidate.toEdgeId);
        terminalBug = target
            ? buildTerminalBugMessage(bestEdge, target, illegalCandidate)
            : {
                  kind: illegalCandidate.bugKind ?? "DEAD_END",
                  nodeId: bestEdge.toNodeId,
                  segmentId: bestEdge.segmentId,
                  lon: endLon,
                  lat: endLat,
                  message: `Routing blocked at end of ${bestEdge.streetName}`,
              };
    } else {
        terminalBug = {
            kind: "DEAD_END",
            nodeId: bestEdge.toNodeId,
            segmentId: bestEdge.segmentId,
            lon: endLon,
            lat: endLat,
            message: `No enabled exit out of ${bestEdge.streetName}`,
        };
    }

    return {
        routeEdgeIds: reconstructPath(legalSearch.cameFromEdge, bestEdgeId),
        terminalBug,
    };
}

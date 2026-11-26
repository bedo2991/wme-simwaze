import { edgeEndCoord } from "./graph";
import { getRoadProfile } from "./roadProfiles";
import { DiagnosticTransition, DirectedEdge, RoadGraph, TerminalBug } from "./types";

export interface RouteResult {
    routeEdgeIds: string[];
    terminalBug: TerminalBug | null;
}

class TypedMinHeap {
    private edgeIndices: Int32Array;
    private fScores: Float64Array;
    private gScores: Float64Array;
    private len = 0;

    constructor(initialCap = 256) {
        this.edgeIndices = new Int32Array(initialCap);
        this.fScores = new Float64Array(initialCap);
        this.gScores = new Float64Array(initialCap);
    }

    get size(): number {
        return this.len;
    }

    clear(): void {
        this.len = 0;
    }

    private grow(): void {
        const nextCap = this.edgeIndices.length * 2;
        const nextIdx = new Int32Array(nextCap);
        const nextF = new Float64Array(nextCap);
        const nextG = new Float64Array(nextCap);
        nextIdx.set(this.edgeIndices);
        nextF.set(this.fScores);
        nextG.set(this.gScores);
        this.edgeIndices = nextIdx;
        this.fScores = nextF;
        this.gScores = nextG;
    }

    push(edgeIdx: number, f: number, g: number): void {
        if (this.len >= this.edgeIndices.length) {
            this.grow();
        }
        let idx = this.len++;
        this.edgeIndices[idx] = edgeIdx;
        this.fScores[idx] = f;
        this.gScores[idx] = g;

        while (idx > 0) {
            const parent = (idx - 1) >> 1;
            if (this.fScores[parent] <= f) break;
            this.edgeIndices[idx] = this.edgeIndices[parent];
            this.fScores[idx] = this.fScores[parent];
            this.gScores[idx] = this.gScores[parent];
            idx = parent;
        }
        this.edgeIndices[idx] = edgeIdx;
        this.fScores[idx] = f;
        this.gScores[idx] = g;
    }

    popEdgeIdx(): number {
        return this.lastPoppedEdgeIdx;
    }

    popG(): number {
        return this.lastPoppedG;
    }

    private lastPoppedEdgeIdx = -1;
    private lastPoppedG = 0;

    pop(): boolean {
        if (this.len === 0) return false;
        this.lastPoppedEdgeIdx = this.edgeIndices[0];
        this.lastPoppedG = this.gScores[0];
        const last = --this.len;
        if (last > 0) {
            const tailIdx = this.edgeIndices[last];
            const tailF = this.fScores[last];
            const tailG = this.gScores[last];
            let idx = 0;
            const half = last >> 1;
            while (idx < half) {
                let best = (idx << 1) + 1;
                const right = best + 1;
                if (right < last && this.fScores[right] < this.fScores[best]) {
                    best = right;
                }
                if (tailF <= this.fScores[best]) break;
                this.edgeIndices[idx] = this.edgeIndices[best];
                this.fScores[idx] = this.fScores[best];
                this.gScores[idx] = this.gScores[best];
                idx = best;
            }
            this.edgeIndices[idx] = tailIdx;
            this.fScores[idx] = tailF;
            this.gScores[idx] = tailG;
        }
        return true;
    }
}

class AStarWorkspace {
    private cap = 0;
    public gScore = new Float64Array(0);
    public gStamp = new Uint32Array(0);
    public closedStamp = new Uint32Array(0);
    public cameFromIdx = new Int32Array(0);
    public cameFromTrans: Array<DiagnosticTransition | undefined> = [];
    public reachedIndices: number[] = [];
    public heap = new TypedMinHeap(256);
    public gen = 1;

    public prepare(edgeCount: number): number {
        if (edgeCount > this.cap) {
            let nextCap = Math.max(256, this.cap || 256);
            while (nextCap < edgeCount) nextCap *= 2;
            this.cap = nextCap;
            this.gScore = new Float64Array(nextCap);
            this.gStamp = new Uint32Array(nextCap);
            this.closedStamp = new Uint32Array(nextCap);
            this.cameFromIdx = new Int32Array(nextCap);
            this.cameFromTrans = new Array(nextCap);
            this.gen = 1;
        } else {
            this.gen = (this.gen + 1) >>> 0;
            if (this.gen === 0) {
                this.gStamp.fill(0);
                this.closedStamp.fill(0);
                this.gen = 1;
            }
        }
        this.reachedIndices.length = 0;
        this.heap.clear();
        return this.gen;
    }

    public hasReached(edgeIdx: number): boolean {
        return this.gStamp[edgeIdx] === this.gen;
    }

    public reconstructPath(edgeList: readonly DirectedEdge[], endIdx: number): string[] {
        const path: string[] = [edgeList[endIdx].id];
        let cur = endIdx;
        while (this.cameFromIdx[cur] >= 0) {
            cur = this.cameFromIdx[cur];
            path.push(edgeList[cur].id);
        }
        path.reverse();
        return path;
    }
}

const LEGAL_WORKSPACE = new AStarWorkspace();
const DIAG_WORKSPACE = new AStarWorkspace();

const MAX_HEURISTIC_SPEED_MPS = 56; // ~201.6 km/h admissible upper bound for unrestricted freeways

export function hasEnabledOutgoingTurn(graph: RoadGraph, edgeId: string): boolean {
    const transitions = graph.outgoing.get(edgeId);
    if (!transitions) return false;
    for (const t of transitions) {
        if (!t.isLegal) continue;
        const target = graph.edgeList[t.toEdgeIndex];
        if (target && !target.isClosed && target.isDrivableDirection) {
            return true;
        }
    }
    return false;
}

function edgeTravelCost(edge: DirectedEdge, occupancy: ReadonlyMap<string, number>): number {
    const occ = occupancy.get(edge.id) ?? 0;
    const ratio = edge.maxCapacity > 0 ? Math.min(2, occ / edge.maxCapacity) : 0;
    const congestionMultiplier = 1 + 2.5 * ratio * ratio;
    const effectiveRoadType = edge.routingRoadType ?? edge.roadType;
    const importanceFactor = getRoadProfile(effectiveRoadType).routingFactor;
    return (
        (edge.lengthMeters / Math.max(edge.speedMps, 2)) *
        importanceFactor *
        (edge.restrictionPenaltyFactor ?? 1) *
        congestionMultiplier
    );
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
    ws: AStarWorkspace,
    graph: RoadGraph,
    startEdge: DirectedEdge,
    destEdge: DirectedEdge,
    occupancy: ReadonlyMap<string, number>,
    allowDiagnostic: boolean
): boolean {
    const edgeList = graph.edgeList;
    const gen = ws.prepare(edgeList.length);
    const gScore = ws.gScore;
    const gStamp = ws.gStamp;
    const closedStamp = ws.closedStamp;
    const cameFromIdx = ws.cameFromIdx;
    const cameFromTrans = ws.cameFromTrans;
    const reached = ws.reachedIndices;
    const heap = ws.heap;

    const startIdx = startEdge.index;
    const destIdx = destEdge.index;
    const destX = destEdge.startXMeters;
    const destY = destEdge.startYMeters;

    const startH =
        Math.hypot(startEdge.endXMeters - destX, startEdge.endYMeters - destY) /
        MAX_HEURISTIC_SPEED_MPS;

    gStamp[startIdx] = gen;
    gScore[startIdx] = 0;
    cameFromIdx[startIdx] = -1;
    cameFromTrans[startIdx] = undefined;
    reached.push(startIdx);
    heap.push(startIdx, startH, 0);

    while (heap.pop()) {
        const curIdx = heap.popEdgeIdx();
        if (closedStamp[curIdx] === gen) continue;
        if (curIdx === destIdx) {
            return true;
        }
        closedStamp[curIdx] = gen;

        const curEdge = edgeList[curIdx];
        const transitions = graph.outgoing.get(curEdge.id);
        if (!transitions) continue;

        const curG = heap.popG();

        for (let ti = 0; ti < transitions.length; ti++) {
            const t = transitions[ti];
            if (!allowDiagnostic && !t.isLegal) continue;
            const nextIdx = t.toEdgeIndex;
            if (closedStamp[nextIdx] === gen) continue;

            const nextEdge = edgeList[nextIdx];
            if (!nextEdge || !nextEdge.isDrivableDirection) continue;
            if (!allowDiagnostic && nextEdge.isClosed) continue;

            const stepCost =
                (nextIdx === destIdx ? 0 : edgeTravelCost(nextEdge, occupancy)) +
                (t.isLegal ? 0 : t.penaltySeconds);
            const tentativeG = curG + stepCost;

            if (gStamp[nextIdx] === gen) {
                if (tentativeG >= gScore[nextIdx]) continue;
            } else {
                gStamp[nextIdx] = gen;
                reached.push(nextIdx);
            }

            gScore[nextIdx] = tentativeG;
            cameFromIdx[nextIdx] = curIdx;
            cameFromTrans[nextIdx] = t;

            const h =
                Math.hypot(nextEdge.endXMeters - destX, nextEdge.endYMeters - destY) /
                MAX_HEURISTIC_SPEED_MPS;
            heap.push(nextIdx, tentativeG + h, tentativeG);
        }
    }

    return false;
}

export function findRoute(
    graph: RoadGraph,
    startEdgeId: string,
    destEdgeId: string,
    occupancy: ReadonlyMap<string, number>
): RouteResult | null {
    const startEdge = graph.edges.get(startEdgeId);
    const destEdge = graph.edges.get(destEdgeId);
    if (!startEdge || !destEdge || startEdge.isClosed) return null;

    if (startEdgeId === destEdgeId) {
        return { routeEdgeIds: [startEdgeId], terminalBug: null };
    }

    const edgeList = graph.edgeList;

    // Pass 1: strictly legal routing
    const legalFound = runAStar(LEGAL_WORKSPACE, graph, startEdge, destEdge, occupancy, false);
    if (legalFound) {
        return {
            routeEdgeIds: LEGAL_WORKSPACE.reconstructPath(edgeList, destEdge.index),
            terminalBug: null,
        };
    }

    // If targeting the outward edge of a dead-end branch, route to its reachable inward twin
    if (!destEdge.isClosed) {
        const oppositeDestId = `${destEdge.segmentId}:${destEdge.isForward ? "R" : "F"}`;
        const oppositeDest = graph.edges.get(oppositeDestId);
        if (
            oppositeDest &&
            graph.deadEndBranchEdgeIds.has(oppositeDestId) &&
            LEGAL_WORKSPACE.hasReached(oppositeDest.index)
        ) {
            return {
                routeEdgeIds: LEGAL_WORKSPACE.reconstructPath(edgeList, oppositeDest.index),
                terminalBug: null,
            };
        }
    }

    // If already heading into a dead-end branch, end the route cleanly at its terminus
    if (graph.deadEndBranchEdgeIds.has(startEdgeId)) {
        const destX = destEdge.startXMeters;
        const destY = destEdge.startYMeters;
        let bestDeadEndIdx = startEdge.index;
        let bestDeadEndDistSq = Infinity;
        for (const rIdx of LEGAL_WORKSPACE.reachedIndices) {
            const edge = edgeList[rIdx];
            if (!edge || !edge.isDeadEnd) continue;
            const dx = edge.endXMeters - destX;
            const dy = edge.endYMeters - destY;
            const dSq = dx * dx + dy * dy;
            if (dSq < bestDeadEndDistSq) {
                bestDeadEndDistSq = dSq;
                bestDeadEndIdx = rIdx;
            }
        }
        return {
            routeEdgeIds: LEGAL_WORKSPACE.reconstructPath(edgeList, bestDeadEndIdx),
            terminalBug: null,
        };
    }

    const destIsIsolatedBug = !graph.legallyReachableDestIds.has(destEdgeId);
    const startIsTrappedInSink = !graph.canExitCorridorIds.has(startEdgeId);
    if (!destIsIsolatedBug && !startIsTrappedInSink) {
        return null;
    }

    // Pass 2: diagnostic routing across turn restrictions, closures, or <=12m phantom gaps
    const diagFound = runAStar(DIAG_WORKSPACE, graph, startEdge, destEdge, occupancy, true);
    if (diagFound) {
        const fullIndices: number[] = [destEdge.index];
        let cur = destEdge.index;
        while (DIAG_WORKSPACE.cameFromIdx[cur] >= 0) {
            cur = DIAG_WORKSPACE.cameFromIdx[cur];
            fullIndices.push(cur);
        }
        fullIndices.reverse();

        for (let i = 1; i < fullIndices.length; i++) {
            const toIdx = fullIndices[i];
            const trans = DIAG_WORKSPACE.cameFromTrans[toIdx];
            if (trans && !trans.isLegal) {
                const fromEdge = edgeList[fullIndices[i - 1]];
                const toEdge = edgeList[toIdx];
                if (trans.bugKind === "DEAD_END" && hasEnabledOutgoingTurn(graph, fromEdge.id)) {
                    continue;
                }
                if (
                    trans.bugKind !== "DISCONNECTED_NODE" &&
                    hasEnabledOutgoingTurn(graph, fromEdge.id) &&
                    graph.canExitCorridorIds.has(fromEdge.id)
                ) {
                    return null;
                }
                const truncatedIds = new Array<string>(i);
                for (let k = 0; k < i; k++) {
                    truncatedIds[k] = edgeList[fullIndices[k]].id;
                }
                return {
                    routeEdgeIds: truncatedIds,
                    terminalBug: buildTerminalBugMessage(fromEdge, toEdge, trans),
                };
            }
        }
    }

    // Pass 3: completely disconnected island or sink trap — route legally ONLY to a blocked terminal edge
    const destX = destEdge.startXMeters;
    const destY = destEdge.startYMeters;
    let bestEdgeIdx = -1;
    let bestDistSq = Infinity;

    for (const rIdx of LEGAL_WORKSPACE.reachedIndices) {
        const edge = edgeList[rIdx];
        if (!edge || edge.isMapBorderExit || edge.isDeadEnd) continue;
        if (hasEnabledOutgoingTurn(graph, edge.id)) continue;
        const dx = edge.endXMeters - destX;
        const dy = edge.endYMeters - destY;
        const dSq = dx * dx + dy * dy;
        if (dSq < bestDistSq) {
            bestDistSq = dSq;
            bestEdgeIdx = rIdx;
        }
    }

    if (bestEdgeIdx < 0) {
        return null;
    }

    const bestEdge = edgeList[bestEdgeIdx];
    const [endLon, endLat] = edgeEndCoord(bestEdge);
    const outgoingAtBest = graph.outgoing.get(bestEdge.id) ?? [];
    const illegalCandidate = outgoingAtBest.find((t) => !t.isLegal);

    if (!startIsTrappedInSink && !illegalCandidate) {
        return null;
    }

    let terminalBug: TerminalBug;
    if (illegalCandidate) {
        const target = edgeList[illegalCandidate.toEdgeIndex];
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
        routeEdgeIds: LEGAL_WORKSPACE.reconstructPath(edgeList, bestEdgeIdx),
        terminalBug,
    };
}

import type { Segment, Turn } from "wme-sdk-typings";
import { DRIVABLE_ROAD_TYPES } from "../roadProfiles";
import { EvalDateTime, isTurnBlockedAt } from "../timeEval";
import { DiagnosticTransition, DirectedEdge, GraphNode } from "../types";

export function turnKey(
    fromSegId: number,
    fromFwd: boolean,
    toSegId: number,
    toFwd: boolean
): string {
    return `${fromSegId}:${fromFwd ? 1 : 0}->${toSegId}:${toFwd ? 1 : 0}`;
}

export function computeTurnDeflectionDeg(
    inEdge: DirectedEdge,
    outEdge: DirectedEdge,
    cosLatOverride?: number
): number {
    const aLen = inEdge.coords.length;
    const bLen = outEdge.coords.length;
    if (aLen < 2 || bLen < 2) return 0;

    const aPrev = inEdge.coords[aLen - 2];
    const aEnd = inEdge.coords[aLen - 1];
    const bStart = outEdge.coords[0];
    const bNext = outEdge.coords[1];

    const cosLat =
        cosLatOverride !== undefined
            ? cosLatOverride
            : Math.max(0.1, Math.cos((aEnd[1] * Math.PI) / 180));
    const ax = (aEnd[0] - aPrev[0]) * cosLat;
    const ay = aEnd[1] - aPrev[1];
    const bx = (bNext[0] - bStart[0]) * cosLat;
    const by = bNext[1] - bStart[1];

    const magA = Math.hypot(ax, ay);
    const magB = Math.hypot(bx, by);
    if (magA < 1e-10 || magB < 1e-10) return 0;

    const dot = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (magA * magB)));
    return (Math.acos(dot) * 180) / Math.PI;
}

export interface BuildTransitionsParams {
    edges: Map<string, DirectedEdge>;
    nodes: Map<number, GraphNode>;
    outgoing: Map<string, DiagnosticTransition[]>;
    edgesEnteringNode: Map<number, DirectedEdge[]>;
    edgesLeavingNode: Map<number, DirectedEdge[]>;
    segById: Map<number, Segment>;
    roundaboutNodeIds: Set<number>;
    directTurnsByKey: Map<string, Turn>;
    pathTurns: Turn[];
    closedTurns: Set<string>;
    fallbackTurnAllowed?: Map<string, boolean>;
    evalDt: EvalDateTime;
    cosLat: number;
}

export function buildNodeTransitions(params: BuildTransitionsParams): void {
    const {
        edges,
        nodes,
        outgoing,
        edgesEnteringNode,
        edgesLeavingNode,
        segById,
        roundaboutNodeIds,
        directTurnsByKey,
        pathTurns,
        closedTurns,
        fallbackTurnAllowed,
        evalDt,
        cosLat,
    } = params;

    // Decompose multi-segment PathTurns / JunctionBoxTurns into directed step permissions
    const pathTurnAllowedSteps = new Set<string>();
    const edgesWithAllowedPathTurn = new Set<string>();
    const edgesWithDisallowedPathTurn = new Set<string>();

    for (const pt of pathTurns) {
        const firstEdgeId = `${pt.fromSegmentId}:${pt.fromSegmentFwd ? "F" : "R"}`;
        const lastEdgeId = `${pt.toSegmentId}:${pt.toSegmentFwd ? "F" : "R"}`;
        const firstEdge = edges.get(firstEdgeId);
        const lastEdge = edges.get(lastEdgeId);
        if (!firstEdge || !lastEdge) continue;

        const chain: string[] = [firstEdgeId];
        let prevEdge: DirectedEdge | undefined = firstEdge;
        let chainValid = true;

        for (const midSegId of pt.segmentPath) {
            if (!prevEdge || prevEdge.toNodeId == null) {
                chainValid = false;
                break;
            }
            const midSeg = segById.get(midSegId);
            if (!midSeg) {
                chainValid = false;
                break;
            }
            let midEdgeId: string | null = null;
            if (midSeg.fromNodeId === prevEdge.toNodeId && edges.has(`${midSegId}:F`)) {
                midEdgeId = `${midSegId}:F`;
            } else if (midSeg.toNodeId === prevEdge.toNodeId && edges.has(`${midSegId}:R`)) {
                midEdgeId = `${midSegId}:R`;
            }
            if (!midEdgeId) {
                chainValid = false;
                break;
            }
            chain.push(midEdgeId);
            prevEdge = edges.get(midEdgeId);
        }

        if (!chainValid || !prevEdge || prevEdge.toNodeId !== lastEdge.fromNodeId) {
            continue;
        }
        chain.push(lastEdgeId);

        const allowed = pt.isAllowed && !isTurnBlockedAt(pt, evalDt);
        if (allowed) {
            edgesWithAllowedPathTurn.add(firstEdgeId);
            for (let i = 0; i < chain.length - 1; i++) {
                pathTurnAllowedSteps.add(`${chain[i]}->${chain[i + 1]}`);
            }
        } else {
            edgesWithDisallowedPathTurn.add(firstEdgeId);
        }
    }

    // Build node transitions (both legal and diagnostic illegal transitions)
    for (const [nodeId, incomingEdges] of edgesEnteringNode) {
        const outgoingEdges = edgesLeavingNode.get(nodeId) ?? [];
        const nodeObj = nodes.get(nodeId);
        const isRoundaboutNode = roundaboutNodeIds.has(nodeId);

        for (const inEdge of incomingEdges) {
            const transitions = outgoing.get(inEdge.id)!;

            for (const outEdge of outgoingEdges) {
                const isSelfUTurn = inEdge.segmentId === outEdge.segmentId;
                const k = turnKey(
                    inEdge.segmentId,
                    inEdge.isForward,
                    outEdge.segmentId,
                    outEdge.isForward
                );
                const turnRecord = directTurnsByKey.get(k);

                if (isSelfUTurn && !(turnRecord?.isUTurn && turnRecord.isAllowed)) {
                    continue;
                }

                const deflectionDeg = computeTurnDeflectionDeg(inEdge, outEdge, cosLat);
                const hasTurnClosure = closedTurns.has(`${inEdge.segmentId}->${outEdge.segmentId}`);
                const hasTurnRestriction = turnRecord ? isTurnBlockedAt(turnRecord, evalDt) : false;

                if (outEdge.isClosed || hasTurnClosure) {
                    transitions.push({
                        toEdgeId: outEdge.id,
                        toEdgeIndex: outEdge.index,
                        isLegal: false,
                        bugKind: "ROAD_CLOSURE",
                        penaltySeconds: 45_000,
                        viaNodeId: nodeId,
                        turnDeflectionDeg: deflectionDeg,
                    });
                    continue;
                }

                let turnAllowed: boolean;
                if (pathTurnAllowedSteps.has(`${inEdge.id}->${outEdge.id}`)) {
                    turnAllowed = true;
                } else if (isRoundaboutNode || inEdge.junctionId != null || outEdge.junctionId != null) {
                    if (
                        inEdge.junctionId == null &&
                        outEdge.junctionId != null &&
                        edgesWithDisallowedPathTurn.has(inEdge.id) &&
                        !edgesWithAllowedPathTurn.has(inEdge.id)
                    ) {
                        turnAllowed = false;
                    } else if (
                        turnRecord &&
                        !edgesWithAllowedPathTurn.has(inEdge.id) &&
                        pathTurnAllowedSteps.size === 0
                    ) {
                        turnAllowed = turnRecord.isAllowed && !hasTurnRestriction;
                    } else {
                        turnAllowed = !isSelfUTurn;
                    }
                } else if (turnRecord) {
                    turnAllowed = turnRecord.isAllowed && !hasTurnRestriction;
                } else if (fallbackTurnAllowed?.has(k)) {
                    turnAllowed = fallbackTurnAllowed.get(k) === true;
                } else {
                    turnAllowed = !isSelfUTurn;
                }

                if (turnAllowed) {
                    transitions.push({
                        toEdgeId: outEdge.id,
                        toEdgeIndex: outEdge.index,
                        isLegal: true,
                        penaltySeconds: 0,
                        viaNodeId: nodeId,
                        turnDeflectionDeg: deflectionDeg,
                    });
                } else {
                    transitions.push({
                        toEdgeId: outEdge.id,
                        toEdgeIndex: outEdge.index,
                        isLegal: false,
                        bugKind: "DISALLOWED_TURN",
                        penaltySeconds: 40_000,
                        viaNodeId: nodeId,
                        turnDeflectionDeg: deflectionDeg,
                    });
                }
            }

            const hasAnyLegalExit = transitions.some((t) => t.isLegal);
            if (hasAnyLegalExit) {
                for (let idx = transitions.length - 1; idx >= 0; idx--) {
                    const tr = transitions[idx];
                    if (tr.isLegal || tr.bugKind !== "DISALLOWED_TURN") continue;
                    const target = edges.get(tr.toEdgeId);
                    if (!target) continue;
                    const isFlareHairpin =
                        inEdge.fromNodeId != null &&
                        roundaboutNodeIds.has(inEdge.fromNodeId) &&
                        target.toNodeId != null &&
                        roundaboutNodeIds.has(target.toNodeId);
                    if (isFlareHairpin || tr.turnDeflectionDeg >= 135) {
                        transitions.splice(idx, 1);
                    }
                }
            } else if (nodeObj && nodeObj.connectedSegmentIds.length > 1) {
                for (const connSegId of nodeObj.connectedSegmentIds) {
                    if (connSegId === inEdge.segmentId) continue;
                    const connSeg = segById.get(connSegId);
                    if (!connSeg || !DRIVABLE_ROAD_TYPES.has(connSeg.roadType) || !connSeg.isDrivable) {
                        continue;
                    }
                    const wrongWayEdgeId =
                        connSeg.toNodeId === nodeId ? `${connSeg.id}:F` : `${connSeg.id}:R`;
                    const wrongWayEdge = edges.get(wrongWayEdgeId);
                    if (
                        wrongWayEdge &&
                        !transitions.some((t) => t.toEdgeId === wrongWayEdge.id)
                    ) {
                        transitions.push({
                            toEdgeId: wrongWayEdge.id,
                            toEdgeIndex: wrongWayEdge.index,
                            isLegal: false,
                            bugKind: "DEAD_END",
                            penaltySeconds: 60_000,
                            viaNodeId: nodeId,
                            turnDeflectionDeg: computeTurnDeflectionDeg(
                                inEdge,
                                wrongWayEdge,
                                cosLat
                            ),
                        });
                    }
                }
            }
        }
    }
}

import type { Segment } from "wme-sdk-typings";
import { pointToSegmentDistanceMeters } from "../geo";
import { getRoadProfile } from "../roadProfiles";
import { DiagnosticTransition, DirectedEdge } from "../types";
import { computeTurnDeflectionDeg } from "./transitions";

const DISCONNECTED_MAX_GAP_M = 12;
const DISCONNECTED_MIN_GAP_M = 0.05;
const GRID_CELL_DEG = 0.0003; // ~25-33m grid cells

function segmentIntersectsBox(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    minX: number,
    minY: number,
    maxX: number,
    maxY: number
): boolean {
    const dx = bx - ax;
    const dy = by - ay;
    let t0 = 0;
    let t1 = 1;
    const checks: Array<[number, number]> = [
        [-dx, ax - minX],
        [dx, maxX - ax],
        [-dy, ay - minY],
        [dy, maxY - ay],
    ];
    for (const [p, q] of checks) {
        if (Math.abs(p) < 1e-12) {
            if (q < 0) return false;
        } else {
            const r = q / p;
            if (p < 0) {
                if (r > t1) return false;
                if (r > t0) t0 = r;
            } else {
                if (r < t0) return false;
                if (r < t1) t1 = r;
            }
        }
    }
    return t0 <= t1;
}

function edgeIntersectsExpandedViewport(
    edge: DirectedEdge,
    bbox: [number, number, number, number]
): boolean {
    const [west, south, east, north] = bbox;
    const padLon = Math.max(0.0025, (east - west) * 0.25);
    const padLat = Math.max(0.0025, (north - south) * 0.25);
    const minX = west - padLon;
    const minY = south - padLat;
    const maxX = east + padLon;
    const maxY = north + padLat;

    const coords = edge.coords;
    for (let i = 0; i < coords.length; i++) {
        const [x, y] = coords[i];
        if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
            return true;
        }
        if (i > 0) {
            const [px, py] = coords[i - 1];
            if (segmentIntersectsBox(px, py, x, y, minX, minY, maxX, maxY)) {
                return true;
            }
        }
    }
    return false;
}

function buildCumulativeWeights(
    edgeIds: string[],
    edges: Map<string, DirectedEdge>,
    selector: (e: DirectedEdge) => number
): number[] {
    const cum: number[] = new Array(edgeIds.length);
    let total = 0;
    for (let i = 0; i < edgeIds.length; i++) {
        const edge = edges.get(edgeIds[i]);
        total += edge ? selector(edge) : 0;
        cum[i] = total;
    }
    return cum;
}

function edgeStartPt(edge: DirectedEdge): [number, number] {
    return edge.coords[0] ?? [0, 0];
}

function edgeEndPt(edge: DirectedEdge): [number, number] {
    return edge.coords[edge.coords.length - 1] ?? [0, 0];
}

export interface TopologyAnalysisParams {
    edges: Map<string, DirectedEdge>;
    edgeList: DirectedEdge[];
    outgoing: Map<string, DiagnosticTransition[]>;
    drivableSegments: Segment[];
    segById: Map<number, Segment>;
    normCoordsBySegId: Map<number, [number, number][]>;
    viewportBBox: [number, number, number, number] | null;
    isAtMapBorder: (nodeId: number | null, pt: [number, number]) => boolean;
    cosLat: number;
}

export interface TopologyAnalysisResult {
    spawnEdgeIds: string[];
    spawnCumulativeWeights: number[];
    destEdgeIds: string[];
    destCumulativeWeights: number[];
    legallyReachableDestIds: Set<string>;
    canExitCorridorIds: Set<string>;
    deadEndBranchEdgeIds: Set<string>;
}

export function analyzeGraphTopology(params: TopologyAnalysisParams): TopologyAnalysisResult {
    const {
        edges,
        edgeList,
        outgoing,
        drivableSegments,
        segById,
        normCoordsBySegId,
        viewportBBox,
        isAtMapBorder,
        cosLat,
    } = params;

    // 1. Index drivable connections per node and compute undirected connected components
    const drivableSegIdsByNode = new Map<number, number[]>();
    const addDrivableNodeSeg = (nodeId: number | null, segId: number) => {
        if (nodeId == null) return;
        let list = drivableSegIdsByNode.get(nodeId);
        if (!list) {
            list = [];
            drivableSegIdsByNode.set(nodeId, list);
        }
        if (!list.includes(segId)) {
            list.push(segId);
        }
    };
    for (const seg of drivableSegments) {
        addDrivableNodeSeg(seg.fromNodeId, seg.id);
        if (seg.toNodeId !== seg.fromNodeId) {
            addDrivableNodeSeg(seg.toNodeId, seg.id);
        }
    }

    const isDrivableLeafEndpoint = (nodeId: number | null, pt: [number, number]): boolean => {
        if (isAtMapBorder(nodeId, pt)) return false;
        if (nodeId == null) return true;
        return (drivableSegIdsByNode.get(nodeId)?.length ?? 0) <= 1;
    };

    const componentBySegId = new Map<number, number>();
    const componentSegCount = new Map<number, number>();
    const componentTouchesBorder = new Map<number, boolean>();
    const componentHasHighway = new Map<number, boolean>();
    let nextCompId = 1;
    let maxComponentSegCount = 0;

    for (const startSeg of drivableSegments) {
        if (componentBySegId.has(startSeg.id)) continue;
        const cid = nextCompId++;
        const queue: Segment[] = [startSeg];
        componentBySegId.set(startSeg.id, cid);
        let count = 0;
        let touchesBorder = false;
        let hasHighway = false;

        for (let qi = 0; qi < queue.length; qi++) {
            const s = queue[qi];
            count++;
            if (getRoadProfile(s.roadType).isHighwaySpawn) {
                hasHighway = true;
            }
            const sc = normCoordsBySegId.get(s.id) ?? s.geometry.coordinates;
            const startPt: [number, number] = [sc[0][0], sc[0][1]];
            const endPt: [number, number] = [sc[sc.length - 1][0], sc[sc.length - 1][1]];
            if (isAtMapBorder(s.fromNodeId, startPt) || isAtMapBorder(s.toNodeId, endPt)) {
                touchesBorder = true;
            }
            for (const nid of [s.fromNodeId, s.toNodeId]) {
                if (nid == null) continue;
                for (const adjId of drivableSegIdsByNode.get(nid) ?? []) {
                    if (componentBySegId.has(adjId)) continue;
                    const adjSeg = segById.get(adjId);
                    if (!adjSeg) continue;
                    componentBySegId.set(adjId, cid);
                    queue.push(adjSeg);
                }
            }
        }

        componentSegCount.set(cid, count);
        componentTouchesBorder.set(cid, touchesBorder);
        componentHasHighway.set(cid, hasHighway);
        if (count > maxComponentSegCount) maxComponentSegCount = count;
    }

    const anyBorderOrHighway = Array.from(componentSegCount.keys()).some(
        (cid) => componentTouchesBorder.get(cid) || componentHasHighway.get(cid)
    );
    const isAnchoredComponent = (cid: number): boolean => {
        const count = componentSegCount.get(cid) ?? 0;
        if (componentTouchesBorder.get(cid)) return true;
        if (count < 2) return false;
        if (anyBorderOrHighway) {
            return Boolean(componentHasHighway.get(cid)) || count === maxComponentSegCount;
        }
        return count === maxComponentSegCount;
    };

    const getOppositeOpenEdge = (edge: DirectedEdge): DirectedEdge | undefined => {
        const opp = edges.get(`${edge.segmentId}:${edge.isForward ? "R" : "F"}`);
        return opp && !opp.isClosed && opp.isDrivableDirection ? opp : undefined;
    };

    const hasLegalOut = (edgeId: string): boolean => {
        const list = outgoing.get(edgeId) ?? [];
        return list.some((t) => {
            if (!t.isLegal) return false;
            const target = edges.get(t.toEdgeId);
            return Boolean(target && !target.isClosed && target.isDrivableDirection);
        });
    };

    // 2. Classify map-border exits and connected two-way dead-end roads before phantom-gap detection
    for (const edge of edgeList) {
        if (edge.isClosed || !edge.isDrivableDirection) continue;
        if (!hasLegalOut(edge.id)) {
            if (isAtMapBorder(edge.toNodeId, edgeEndPt(edge))) {
                edge.isMapBorderExit = true;
                if (getRoadProfile(edge.roadType).isHighwaySpawn) {
                    edge.destWeight = Math.max(edge.destWeight, 2.0);
                }
            } else if (
                isDrivableLeafEndpoint(edge.toNodeId, edgeEndPt(edge)) &&
                Boolean(getOppositeOpenEdge(edge)) &&
                isAnchoredComponent(componentBySegId.get(edge.segmentId) ?? -1)
            ) {
                edge.isDeadEnd = true;
                edge.spawnWeight = 0;
            }
        }
    }

    // 3. Spatial hash to detect Disconnected Nodes ("phantom gaps") within 12m
    const cellKey = (lon: number, lat: number): string => {
        const cx = Math.floor(lon / GRID_CELL_DEG);
        const cy = Math.floor(lat / GRID_CELL_DEG);
        return `${cx},${cy}`;
    };

    interface PolyRef {
        segment: Segment;
        ax: number;
        ay: number;
        bx: number;
        by: number;
    }
    const grid = new Map<string, PolyRef[]>();
    for (const seg of drivableSegments) {
        const coords = normCoordsBySegId.get(seg.id) ?? seg.geometry.coordinates;
        for (let i = 0; i < coords.length - 1; i++) {
            const [ax, ay] = coords[i];
            const [bx, by] = coords[i + 1];
            const minCx = Math.floor(Math.min(ax, bx) / GRID_CELL_DEG) - 1;
            const maxCx = Math.floor(Math.max(ax, bx) / GRID_CELL_DEG) + 1;
            const minCy = Math.floor(Math.min(ay, by) / GRID_CELL_DEG) - 1;
            const maxCy = Math.floor(Math.max(ay, by) / GRID_CELL_DEG) + 1;
            const ref: PolyRef = { segment: seg, ax, ay, bx, by };
            for (let cx = minCx; cx <= maxCx; cx++) {
                for (let cy = minCy; cy <= maxCy; cy++) {
                    const k = `${cx},${cy}`;
                    let bucket = grid.get(k);
                    if (!bucket) {
                        bucket = [];
                        grid.set(k, bucket);
                    }
                    bucket.push(ref);
                }
            }
        }
    }

    const addPhantomGap = (fromEdge: DirectedEdge, toEdge: DirectedEdge, gapMeters: number) => {
        if (fromEdge.isDeadEnd || fromEdge.isMapBorderExit) return;
        const list = outgoing.get(fromEdge.id);
        if (!list) return;
        if (list.some((t) => t.toEdgeId === toEdge.id)) return;
        list.push({
            toEdgeId: toEdge.id,
            toEdgeIndex: toEdge.index,
            isLegal: false,
            bugKind: "DISCONNECTED_NODE",
            penaltySeconds: 35_000 + gapMeters * 100,
            viaNodeId: fromEdge.toNodeId,
            gapMeters,
            turnDeflectionDeg: computeTurnDeflectionDeg(fromEdge, toEdge, cosLat),
        });
    };

    for (const seg of drivableSegments) {
        const coords = normCoordsBySegId.get(seg.id) ?? seg.geometry.coordinates;
        const endpoints: Array<{
            lon: number;
            lat: number;
            nodeId: number | null;
            isEndB: boolean;
        }> = [
            { lon: coords[0][0], lat: coords[0][1], nodeId: seg.fromNodeId, isEndB: false },
            {
                lon: coords[coords.length - 1][0],
                lat: coords[coords.length - 1][1],
                nodeId: seg.toNodeId,
                isEndB: true,
            },
        ];

        for (const ep of endpoints) {
            if (!isDrivableLeafEndpoint(ep.nodeId, [ep.lon, ep.lat])) continue;

            const arrivingEdge = edges.get(`${seg.id}:${ep.isEndB ? "F" : "R"}`);
            const departingEdge = edges.get(`${seg.id}:${ep.isEndB ? "R" : "F"}`);
            if (arrivingEdge?.isDeadEnd) continue;

            const bucket = grid.get(cellKey(ep.lon, ep.lat));
            if (!bucket) continue;

            const segCompId = componentBySegId.get(seg.id);
            const bestBySeg = new Map<number, number>();
            for (const ref of bucket) {
                if (ref.segment.id === seg.id) continue;
                if (segCompId != null && componentBySegId.get(ref.segment.id) === segCompId) {
                    continue;
                }
                if (
                    ep.nodeId != null &&
                    (ref.segment.fromNodeId === ep.nodeId || ref.segment.toNodeId === ep.nodeId)
                ) {
                    continue;
                }
                const { distMeters } = pointToSegmentDistanceMeters(
                    ep.lon,
                    ep.lat,
                    ref.ax,
                    ref.ay,
                    ref.bx,
                    ref.by,
                    cosLat
                );
                if (distMeters >= DISCONNECTED_MIN_GAP_M && distMeters <= DISCONNECTED_MAX_GAP_M) {
                    const prev = bestBySeg.get(ref.segment.id);
                    if (prev === undefined || distMeters < prev) {
                        bestBySeg.set(ref.segment.id, distMeters);
                    }
                }
            }

            for (const [otherSegId, gapMeters] of bestBySeg) {
                const otherFwd = edges.get(`${otherSegId}:F`);
                const otherRev = edges.get(`${otherSegId}:R`);

                if (arrivingEdge) {
                    if (otherFwd) addPhantomGap(arrivingEdge, otherFwd, gapMeters);
                    if (otherRev) addPhantomGap(arrivingEdge, otherRev, gapMeters);
                }
                if (departingEdge) {
                    if (otherFwd) addPhantomGap(otherFwd, departingEdge, gapMeters);
                    if (otherRev) addPhantomGap(otherRev, departingEdge, gapMeters);
                }
            }
        }
    }

    for (const edge of edgeList) {
        if (edge.isClosed || !edge.isDrivableDirection) continue;
        if ((outgoing.get(edge.id)?.length ?? 0) === 0 && !edge.isMapBorderExit) {
            edge.spawnWeight = 0;
            if (
                isDrivableLeafEndpoint(edge.toNodeId, edgeEndPt(edge)) &&
                Boolean(getOppositeOpenEdge(edge))
            ) {
                edge.isDeadEnd = true;
            }
        }
    }

    const allOpenEdges = edgeList.filter((e) => !e.isClosed && e.isDrivableDirection);

    // 4. Reverse Kahn's peel from dead-end leaf edges + outward dead-end branch pruning
    const incomingLegal = new Map<string, string[]>();
    const outLegalCount = new Map<string, number>();
    for (const e of allOpenEdges) {
        let outCnt = 0;
        for (const t of outgoing.get(e.id) ?? []) {
            if (!t.isLegal) continue;
            const toEdge = edgeList[t.toEdgeIndex];
            if (!toEdge || toEdge.isClosed || !toEdge.isDrivableDirection) continue;
            outCnt++;
            let inc = incomingLegal.get(toEdge.id);
            if (!inc) {
                inc = [];
                incomingLegal.set(toEdge.id, inc);
            }
            inc.push(e.id);
        }
        outLegalCount.set(e.id, outCnt);
    }

    const deadEndBranchEdgeIds = new Set<string>();
    const peelQueue: string[] = [];
    for (const e of allOpenEdges) {
        if (e.isDeadEnd) {
            deadEndBranchEdgeIds.add(e.id);
            peelQueue.push(e.id);
        }
    }
    for (let qi = 0; qi < peelQueue.length; qi++) {
        const cur = peelQueue[qi];
        for (const prevId of incomingLegal.get(cur) ?? []) {
            const rem = (outLegalCount.get(prevId) ?? 0) - 1;
            outLegalCount.set(prevId, rem);
            const prevEdge = edges.get(prevId);
            if (
                rem === 0 &&
                prevEdge &&
                !prevEdge.isMapBorderExit &&
                !deadEndBranchEdgeIds.has(prevId)
            ) {
                deadEndBranchEdgeIds.add(prevId);
                peelQueue.push(prevId);
            }
        }
    }

    const outwardDeadEndOnly = new Set<string>();
    const outQueue: string[] = [];
    for (const e of allOpenEdges) {
        if (isAtMapBorder(e.fromNodeId, edgeStartPt(e))) continue;
        if ((incomingLegal.get(e.id)?.length ?? 0) !== 0) continue;
        const rawOpp = edges.get(`${e.segmentId}:${e.isForward ? "R" : "F"}`);
        if (
            rawOpp &&
            rawOpp.isClosed &&
            isDrivableLeafEndpoint(e.fromNodeId, edgeStartPt(e))
        ) {
            outwardDeadEndOnly.add(e.id);
            outQueue.push(e.id);
            continue;
        }
        const opp = getOppositeOpenEdge(e);
        if (
            opp &&
            deadEndBranchEdgeIds.has(opp.id) &&
            (incomingLegal.get(opp.id)?.length ?? 0) > 0
        ) {
            outwardDeadEndOnly.add(e.id);
            outQueue.push(e.id);
        }
    }
    for (let qi = 0; qi < outQueue.length; qi++) {
        const cur = outQueue[qi];
        for (const t of outgoing.get(cur) ?? []) {
            if (!t.isLegal) continue;
            const nextEdge = edgeList[t.toEdgeIndex];
            if (
                !nextEdge ||
                nextEdge.isClosed ||
                !nextEdge.isDrivableDirection ||
                outwardDeadEndOnly.has(nextEdge.id) ||
                isAtMapBorder(nextEdge.fromNodeId, edgeStartPt(nextEdge))
            ) {
                continue;
            }
            const inc = incomingLegal.get(nextEdge.id) ?? [];
            const opp = getOppositeOpenEdge(nextEdge);
            if (
                inc.length > 0 &&
                inc.every((id) => outwardDeadEndOnly.has(id)) &&
                opp &&
                deadEndBranchEdgeIds.has(opp.id) &&
                (incomingLegal.get(opp.id) ?? []).some((id) => !outwardDeadEndOnly.has(id))
            ) {
                outwardDeadEndOnly.add(nextEdge.id);
                outQueue.push(nextEdge.id);
            }
        }
    }
    for (const id of outwardDeadEndOnly) {
        const edge = edges.get(id);
        if (edge) edge.destWeight = 0;
    }

    // 5. Build spawn and destination weighted pools
    const allSpawnable = allOpenEdges.filter((e) => e.spawnWeight > 0);
    const nearViewportSpawns = viewportBBox
        ? allSpawnable.filter((e) => edgeIntersectsExpandedViewport(e, viewportBBox))
        : allSpawnable;
    const spawnCandidates = nearViewportSpawns.length > 0 ? nearViewportSpawns : allSpawnable;

    const spawnEdgeIds = spawnCandidates.map((e) => e.id);
    const spawnCumulativeWeights = buildCumulativeWeights(
        spawnEdgeIds,
        edges,
        (e) => e.spawnWeight
    );

    const allDestable = allOpenEdges.filter((e) => e.destWeight > 0);
    const nearViewportDests = viewportBBox
        ? allDestable.filter((e) => edgeIntersectsExpandedViewport(e, viewportBBox))
        : allDestable;
    const destCandidates = nearViewportDests.length > 0 ? nearViewportDests : allDestable;
    const destEdgeIds = destCandidates.map((e) => e.id);
    const destCumulativeWeights = buildCumulativeWeights(destEdgeIds, edges, (e) => e.destWeight);

    // 6. Forward & reverse reachability sets
    const legallyReachableDestIds = new Set<string>();
    const fwdQueue: string[] = [];
    for (const e of allOpenEdges) {
        if (isAtMapBorder(e.fromNodeId, edgeStartPt(e))) {
            legallyReachableDestIds.add(e.id);
            fwdQueue.push(e.id);
        }
    }
    for (const e of spawnCandidates) {
        if (getRoadProfile(e.roadType).isHighwaySpawn && !legallyReachableDestIds.has(e.id)) {
            legallyReachableDestIds.add(e.id);
            fwdQueue.push(e.id);
        }
    }
    if (fwdQueue.length === 0) {
        for (const e of spawnCandidates) {
            if (
                isAnchoredComponent(componentBySegId.get(e.segmentId) ?? -1) &&
                !legallyReachableDestIds.has(e.id)
            ) {
                legallyReachableDestIds.add(e.id);
                fwdQueue.push(e.id);
            }
        }
    }
    if (fwdQueue.length === 0) {
        for (const id of spawnEdgeIds) {
            if (!legallyReachableDestIds.has(id)) {
                legallyReachableDestIds.add(id);
                fwdQueue.push(id);
            }
        }
    }
    for (let qi = 0; qi < fwdQueue.length; qi++) {
        const cur = fwdQueue[qi];
        for (const t of outgoing.get(cur) ?? []) {
            if (!t.isLegal || legallyReachableDestIds.has(t.toEdgeId)) continue;
            const next = edgeList[t.toEdgeIndex];
            if (!next || next.isClosed || !next.isDrivableDirection) continue;
            legallyReachableDestIds.add(t.toEdgeId);
            fwdQueue.push(t.toEdgeId);
        }
    }

    const canExitCorridorIds = new Set<string>();
    const revQueue: string[] = [];
    for (const e of allOpenEdges) {
        const isExitOrHealthyDest =
            e.isMapBorderExit ||
            e.isDeadEnd ||
            (hasLegalOut(e.id) && e.destWeight > 0);
        if (isExitOrHealthyDest) {
            canExitCorridorIds.add(e.id);
            revQueue.push(e.id);
        }
    }
    for (let qi = 0; qi < revQueue.length; qi++) {
        const cur = revQueue[qi];
        for (const prevId of incomingLegal.get(cur) ?? []) {
            if (!canExitCorridorIds.has(prevId)) {
                canExitCorridorIds.add(prevId);
                revQueue.push(prevId);
            }
        }
    }

    return {
        spawnEdgeIds,
        spawnCumulativeWeights,
        destEdgeIds,
        destCumulativeWeights,
        legallyReachableDestIds,
        canExitCorridorIds,
        deadEndBranchEdgeIds,
    };
}

import {
    AsyncWmeSDK,
    Node as WmeNode,
    PermanentHazard,
    RoadClosure,
    Segment,
    Street,
    Turn,
    TurnClosure,
} from "wme-sdk-typings";
import {
    computeCumulativeLengths,
    DEG_TO_RAD,
    distanceMeters,
    METERS_PER_DEG_LAT,
} from "./geo";
import {
    buildEdgeSpeedZones,
    buildHazardSpatialIndex,
    computeSegmentCurvatures,
} from "./graph/speedZones";
import { analyzeGraphTopology } from "./graph/topology";
import {
    buildNodeTransitions,
    computeTurnDeflectionDeg,
    turnKey,
} from "./graph/transitions";
import {
    computeEdgeCapacity,
    DRIVABLE_ROAD_TYPES,
    getRoadProfile,
    resolveEdgeLanes,
    WME_ROAD_TYPE,
} from "./roadProfiles";
import {
    evaluateSegmentDirectionRestriction,
    isClosureActiveAt,
    resolveEvalDateTime,
} from "./timeEval";
import {
    describeBugKind,
    DiagnosticTransition,
    DirectedEdge,
    GraphNode,
    RoadGraph,
} from "./types";

export { computeTurnDeflectionDeg, describeBugKind };

export interface RawGraphInput {
    segments: Segment[];
    nodes: WmeNode[];
    turns: Turn[];
    roadClosures: RoadClosure[];
    turnClosures: TurnClosure[];
    streets: Street[];
    isLeftHandTraffic: boolean;
    isImperial: boolean;
    fallbackTurnAllowed?: Map<string, boolean>;
    viewportBBox?: [number, number, number, number] | null;
    permanentHazards?: PermanentHazard[];
    evalTimestamp?: string | null;
    nowMs?: number;
}

const MPH_TO_KMH = 1.609344;
const MAX_FALLBACK_TURN_CACHE_SIZE = 12_000;
const FALLBACK_TURN_CACHE = new Map<string, boolean>();

export function invalidateFallbackTurnCache(): void {
    FALLBACK_TURN_CACHE.clear();
}

export function getSegmentAllowedDirections(seg: Segment): {
    fwdAllowed: boolean;
    revAllowed: boolean;
    isDirectionless: boolean;
} {
    if (seg.isTwoWay || (seg.isAtoB && seg.isBtoA)) {
        return { fwdAllowed: true, revAllowed: true, isDirectionless: false };
    }
    if (seg.isAtoB) {
        return { fwdAllowed: true, revAllowed: false, isDirectionless: false };
    }
    if (seg.isBtoA) {
        return { fwdAllowed: false, revAllowed: true, isDirectionless: false };
    }
    const noDir = Boolean(seg.allowNoDirection);
    return { fwdAllowed: noDir, revAllowed: noDir, isDirectionless: true };
}

function computeUnrestrictedFreewaySpeedKmh(segId: number, isForward: boolean): number {
    const hash =
        (Math.imul(Math.abs(segId) + 1, 2654435761) ^ (isForward ? 0x9e3779b9 : 0x517cc1b7)) >>> 0;
    return 130 + (hash % 61); // 130..190 km/h
}

async function safeSdkArray<T>(fn: () => Promise<T[]> | T[], label: string): Promise<T[]> {
    try {
        const res = await fn();
        return Array.isArray(res) ? res : [];
    } catch (err) {
        console.debug(`SimWaze: ${label} threw, falling back to []:`, err);
        return [];
    }
}

async function safeSdkValue<T>(fn: () => Promise<T> | T, fallback: T, label: string): Promise<T> {
    try {
        return await fn();
    } catch (err) {
        console.debug(`SimWaze: ${label} threw, using fallback:`, err);
        return fallback;
    }
}

export async function fetchRawGraphData(
    wmeSDK: AsyncWmeSDK,
    evalTimestamp: string | null = null
): Promise<RawGraphInput> {
    const [
        segments,
        nodes,
        turns,
        roadClosures,
        turnClosures,
        streets,
        topCountry,
        userSettings,
        mapExtent,
        permanentHazards,
    ] = await Promise.all([
        wmeSDK.DataModel.Segments.getAll(),
        wmeSDK.DataModel.Nodes.getAll(),
        safeSdkArray(() => wmeSDK.DataModel.Turns.getAll(), "Turns.getAll"),
        safeSdkArray(() => wmeSDK.DataModel.RoadClosures.getAll(), "RoadClosures.getAll"),
        safeSdkArray(() => wmeSDK.DataModel.TurnClosures.getAll(), "TurnClosures.getAll"),
        safeSdkArray(() => wmeSDK.DataModel.Streets.getAll(), "Streets.getAll"),
        safeSdkValue(() => wmeSDK.DataModel.Countries.getTopCountry(), null, "Countries.getTopCountry"),
        safeSdkValue(() => wmeSDK.Settings.getUserSettings(), null, "Settings.getUserSettings"),
        safeSdkValue(() => wmeSDK.Map.getMapExtent(), null, "Map.getMapExtent"),
        safeSdkArray(() => wmeSDK.DataModel.PermanentHazards.getAll(), "PermanentHazards.getAll"),
    ]);

    const turnLookup = new Set<string>();
    for (const t of turns) {
        if (!t.isPathTurn && !t.isJunctionBoxTurn && t.segmentPath.length === 0) {
            turnLookup.add(turnKey(t.fromSegmentId, t.fromSegmentFwd, t.toSegmentId, t.toSegmentFwd));
        }
    }

    const segById = new Map<number, Segment>();
    for (const seg of segments) {
        segById.set(seg.id, seg);
    }

    if (FALLBACK_TURN_CACHE.size > MAX_FALLBACK_TURN_CACHE_SIZE) {
        FALLBACK_TURN_CACHE.clear();
    }

    const fallbackTurnAllowed = new Map<string, boolean>();
    const missingChecks: Array<{
        key: string;
        cacheKey: string;
        fromSegmentId: number;
        nodeId: number;
        toSegmentId: number;
    }> = [];

    for (const node of nodes) {
        const segIds = node.connectedSegmentIds;
        if (segIds.length < 2) continue;

        const isRoundaboutNode = segIds.some((id: number) => segById.get(id)?.junctionId != null);
        if (isRoundaboutNode) continue;

        for (const fromId of segIds) {
            const fromSeg = segById.get(fromId);
            if (!fromSeg || !DRIVABLE_ROAD_TYPES.has(fromSeg.roadType)) continue;
            if (fromSeg.fromNodeId === fromSeg.toNodeId) continue;
            const fromDirs = getSegmentAllowedDirections(fromSeg);
            const arriveDirs: boolean[] = [];
            if (fromSeg.toNodeId === node.id && fromDirs.fwdAllowed) arriveDirs.push(true);
            if (fromSeg.fromNodeId === node.id && fromDirs.revAllowed) arriveDirs.push(false);
            if (arriveDirs.length === 0) continue;

            for (const toId of segIds) {
                if (fromId === toId) continue;
                const toSeg = segById.get(toId);
                if (!toSeg || !DRIVABLE_ROAD_TYPES.has(toSeg.roadType)) continue;
                if (toSeg.fromNodeId === toSeg.toNodeId) continue;
                const toDirs = getSegmentAllowedDirections(toSeg);
                const departDirs: boolean[] = [];
                if (toSeg.fromNodeId === node.id && toDirs.fwdAllowed) departDirs.push(true);
                if (toSeg.toNodeId === node.id && toDirs.revAllowed) departDirs.push(false);
                if (departDirs.length === 0) continue;

                for (const fromFwd of arriveDirs) {
                    for (const toFwd of departDirs) {
                        const k = turnKey(fromId, fromFwd, toId, toFwd);
                        if (turnLookup.has(k)) continue;
                        const ck = `${node.id}|${k}`;
                        const cached = FALLBACK_TURN_CACHE.get(ck);
                        if (cached !== undefined) {
                            fallbackTurnAllowed.set(k, cached);
                        } else if (missingChecks.length < 1500) {
                            missingChecks.push({
                                key: k,
                                cacheKey: ck,
                                fromSegmentId: fromId,
                                nodeId: node.id,
                                toSegmentId: toId,
                            });
                        }
                    }
                }
            }
        }
    }

    if (missingChecks.length > 0) {
        await Promise.all(
            missingChecks.map(async (chk) => {
                try {
                    const allowed = await wmeSDK.DataModel.Turns.isTurnAllowed({
                        fromSegmentId: chk.fromSegmentId,
                        nodeId: chk.nodeId,
                        toSegmentId: chk.toSegmentId,
                    });
                    FALLBACK_TURN_CACHE.set(chk.cacheKey, allowed);
                    fallbackTurnAllowed.set(chk.key, allowed);
                } catch {
                    // Ignore unloaded/virtual node check errors
                }
            })
        );
    }

    const viewportBBox: [number, number, number, number] | null =
        mapExtent && mapExtent.length >= 4
            ? [mapExtent[0], mapExtent[1], mapExtent[2], mapExtent[3]]
            : null;

    return {
        segments,
        nodes,
        turns,
        roadClosures,
        turnClosures,
        streets,
        isLeftHandTraffic: Boolean(topCountry?.isLeftHandTraffic),
        isImperial: Boolean(userSettings?.isImperial),
        fallbackTurnAllowed,
        viewportBBox,
        permanentHazards,
        evalTimestamp,
    };
}

export async function buildRoadGraphFromSDK(
    wmeSDK: AsyncWmeSDK,
    evalTimestamp: string | null = null
): Promise<RoadGraph> {
    const raw = await fetchRawGraphData(wmeSDK, evalTimestamp);
    return buildRoadGraphFromRawData(raw);
}

export function buildRoadGraphFromRawData(raw: RawGraphInput): RoadGraph {
    const edges = new Map<string, DirectedEdge>();
    const edgeList: DirectedEdge[] = [];
    const nodes = new Map<number, GraphNode>();
    const outgoing = new Map<string, DiagnosticTransition[]>();

    const streetNameById = new Map<number, string>();
    for (const st of raw.streets) {
        if (st.name) {
            streetNameById.set(st.id, st.name);
        }
    }

    const evalDt = resolveEvalDateTime(raw.evalTimestamp, raw.nowMs);

    // Index active road closures by directed edge ID for the selected timestamp
    const closedEdges = new Set<string>();
    const segmentsWithClosureRecords = new Set<number>();
    for (const rc of raw.roadClosures) {
        segmentsWithClosureRecords.add(rc.segmentId);
        if (!isClosureActiveAt(rc, evalDt)) continue;
        closedEdges.add(`${rc.segmentId}:${rc.isForward ? "F" : "R"}`);
    }

    // Index active turn closures by "fromSegId->toSegId" for the selected timestamp
    const closedTurns = new Set<string>();
    for (const tc of raw.turnClosures) {
        segmentsWithClosureRecords.add(tc.fromSegmentId);
        segmentsWithClosureRecords.add(tc.toSegmentId);
        if (!isClosureActiveAt(tc, evalDt)) continue;
        closedTurns.add(`${tc.fromSegmentId}->${tc.toSegmentId}`);
    }

    const directTurnsByKey = new Map<string, Turn>();
    const pathTurns: Turn[] = [];
    for (const t of raw.turns) {
        if (!t.isPathTurn && !t.isJunctionBoxTurn && t.segmentPath.length === 0) {
            directTurnsByKey.set(
                turnKey(t.fromSegmentId, t.fromSegmentFwd, t.toSegmentId, t.toSegmentFwd),
                t
            );
        } else {
            pathTurns.push(t);
        }
    }

    let minLon = Infinity;
    let minLat = Infinity;
    let maxLon = -Infinity;
    let maxLat = -Infinity;

    const loadedSegIds = new Set<number>();
    const roundaboutNodeIds = new Set<number>();
    const segById = new Map<number, Segment>();

    for (const seg of raw.segments) {
        loadedSegIds.add(seg.id);
        segById.set(seg.id, seg);
        if (seg.junctionId != null) {
            if (seg.fromNodeId != null) roundaboutNodeIds.add(seg.fromNodeId);
            if (seg.toNodeId != null) roundaboutNodeIds.add(seg.toNodeId);
        }
        for (const pt of seg.geometry.coordinates) {
            if (pt[0] < minLon) minLon = pt[0];
            if (pt[1] < minLat) minLat = pt[1];
            if (pt[0] > maxLon) maxLon = pt[0];
            if (pt[1] > maxLat) maxLat = pt[1];
        }
    }

    const bounds: [number, number, number, number] | null =
        Number.isFinite(minLon) && Number.isFinite(maxLon)
            ? [minLon, minLat, maxLon, maxLat]
            : null;

    const refLon = bounds ? (bounds[0] + bounds[2]) * 0.5 : 0;
    const refLat = bounds ? (bounds[1] + bounds[3]) * 0.5 : 0;
    const cosLat = Math.max(0.1, Math.cos(refLat * DEG_TO_RAD));
    const metersPerDegLon = METERS_PER_DEG_LAT * cosLat;

    for (const n of raw.nodes) {
        let totalLanes = 0;
        for (const segId of n.connectedSegmentIds) {
            const s = segById.get(segId);
            if (!s) continue;
            const p = getRoadProfile(s.roadType);
            totalLanes += resolveEdgeLanes(s, true, p);
        }
        nodes.set(n.id, {
            id: n.id,
            lon: n.geometry.coordinates[0],
            lat: n.geometry.coordinates[1],
            connectedSegmentIds: n.connectedSegmentIds,
            lanesCapacity: Math.max(2, totalLanes),
        });
    }

    const lonSpan = bounds ? Math.max(1e-5, bounds[2] - bounds[0]) : 1;
    const latSpan = bounds ? Math.max(1e-5, bounds[3] - bounds[1]) : 1;
    const isBoundaryNode = (nodeId: number | null, fallbackPt: [number, number]): boolean => {
        if (nodeId === null) return true;
        const node = nodes.get(nodeId);
        if (node && node.connectedSegmentIds.length <= 1) return true;
        if (!bounds || !node) return false;
        const marginLon = lonSpan * 0.12;
        const marginLat = latSpan * 0.12;
        const ptLon = node ? node.lon : fallbackPt[0];
        const ptLat = node ? node.lat : fallbackPt[1];
        return (
            ptLon <= bounds[0] + marginLon ||
            ptLon >= bounds[2] - marginLon ||
            ptLat <= bounds[1] + marginLat ||
            ptLat >= bounds[3] - marginLat
        );
    };

    const borderLonMargin = 18 / metersPerDegLon;
    const borderLatMargin = 18 / METERS_PER_DEG_LAT;
    const isAtMapBorder = (nodeId: number | null, pt: [number, number]): boolean => {
        if (nodeId != null) {
            const node = nodes.get(nodeId);
            if (node && node.connectedSegmentIds.some((id) => !loadedSegIds.has(id))) {
                return true;
            }
        }
        if (raw.viewportBBox && raw.viewportBBox.length >= 4) {
            const [west, south, east, north] = raw.viewportBBox;
            if (
                pt[0] <= west + borderLonMargin ||
                pt[0] >= east - borderLonMargin ||
                pt[1] <= south + borderLatMargin ||
                pt[1] >= north - borderLatMargin
            ) {
                return true;
            }
        }
        return false;
    };

    // Pre-index Permanent Hazards once before constructing directed edges
    const hazardIndex = buildHazardSpatialIndex(raw.permanentHazards ?? [], cosLat);

    const edgesLeavingNode = new Map<number, DirectedEdge[]>();
    const edgesEnteringNode = new Map<number, DirectedEdge[]>();
    const drivableSegments: Segment[] = [];
    const normCoordsBySegId = new Map<number, [number, number][]>();

    for (const seg of raw.segments) {
        if (!DRIVABLE_ROAD_TYPES.has(seg.roadType) || !seg.isDrivable) continue;
        const rawCoords = seg.geometry.coordinates;
        if (!rawCoords || rawCoords.length < 2) continue;
        drivableSegments.push(seg);

        let segMinLon = Infinity;
        let segMinLat = Infinity;
        let segMaxLon = -Infinity;
        let segMaxLat = -Infinity;
        const coords: [number, number][] = new Array(rawCoords.length);
        for (let i = 0; i < rawCoords.length; i++) {
            const lon = rawCoords[i][0];
            const lat = rawCoords[i][1];
            coords[i] = [lon, lat];
            if (lon < segMinLon) segMinLon = lon;
            if (lat < segMinLat) segMinLat = lat;
            if (lon > segMaxLon) segMaxLon = lon;
            if (lat > segMaxLat) segMaxLat = lat;
        }
        const segBBox: [number, number, number, number] = [
            segMinLon,
            segMinLat,
            segMaxLon,
            segMaxLat,
        ];

        // Ensure A->B geometry physically starts at fromNodeId and ends at toNodeId
        if (seg.fromNodeId != null && seg.toNodeId != null && seg.fromNodeId !== seg.toNodeId) {
            const fromNode = nodes.get(seg.fromNodeId);
            const toNode = nodes.get(seg.toNodeId);
            if (fromNode && toNode) {
                const startPt = coords[0];
                const endPt = coords[coords.length - 1];
                const dStartFrom = distanceMeters(
                    startPt[0],
                    startPt[1],
                    fromNode.lon,
                    fromNode.lat,
                    cosLat
                );
                const dStartTo = distanceMeters(
                    startPt[0],
                    startPt[1],
                    toNode.lon,
                    toNode.lat,
                    cosLat
                );
                const dEndFrom = distanceMeters(
                    endPt[0],
                    endPt[1],
                    fromNode.lon,
                    fromNode.lat,
                    cosLat
                );
                const dEndTo = distanceMeters(
                    endPt[0],
                    endPt[1],
                    toNode.lon,
                    toNode.lat,
                    cosLat
                );
                if (dStartTo + 1 < dStartFrom && dEndFrom + 1 < dEndTo) {
                    coords.reverse();
                }
            }
        }
        normCoordsBySegId.set(seg.id, coords);

        const { cumLengths: fwdCumLengths, totalLength } = computeCumulativeLengths(coords, cosLat);
        const lengthMeters = totalLength > 0.1 ? totalLength : Math.max(seg.length || 1, 1);

        const { fwdAllowed, revAllowed, isDirectionless } = getSegmentAllowedDirections(seg);
        const isTwoWay = fwdAllowed && revAllowed;

        // Precompute curvature samples once per segment (shared between F and R)
        const curvatures =
            fwdAllowed || revAllowed
                ? computeSegmentCurvatures(seg, coords, fwdCumLengths, totalLength, cosLat)
                : [];

        const profile = getRoadProfile(seg.roadType);
        const streetName =
            (seg.primaryStreetId != null ? streetNameById.get(seg.primaryStreetId) : undefined) ??
            `${profile.label} #${seg.id}`;

        const createDirectedEdge = (isForward: boolean, canDrive: boolean): DirectedEdge | null => {
            if (!canDrive) return null;
            const id = `${seg.id}:${isForward ? "F" : "R"}`;

            let edgeCoords: [number, number][];
            let cumLengths: number[];
            if (isForward) {
                edgeCoords = coords;
                cumLengths = fwdCumLengths;
            } else {
                const n = coords.length;
                edgeCoords = new Array(n);
                cumLengths = new Array(n);
                for (let i = 0; i < n; i++) {
                    edgeCoords[i] = coords[n - 1 - i];
                    cumLengths[i] = Math.max(0, totalLength - fwdCumLengths[n - 1 - i]);
                }
            }

            const rawLimit = isForward ? seg.fwdSpeedLimit : seg.revSpeedLimit;
            const isFreeway =
                seg.roadType === WME_ROAD_TYPE.FREEWAY ||
                seg.routingRoadType === WME_ROAD_TYPE.FREEWAY;
            const hasExplicitLimit = rawLimit != null && rawLimit > 0 && rawLimit < 1000;
            const hasUnrestrictedSpeed = isFreeway && !hasExplicitLimit;
            let speedKmh = hasExplicitLimit
                ? raw.isImperial
                    ? rawLimit * MPH_TO_KMH
                    : rawLimit
                : hasUnrestrictedSpeed
                  ? computeUnrestrictedFreewaySpeedKmh(seg.id, isForward)
                  : profile.defaultSpeedKmh;
            speedKmh = Math.max(10, Math.min(220, speedKmh));
            const speedMps = speedKmh / 3.6;

            const lanes = resolveEdgeLanes(seg, isForward, profile);
            const maxCapacity = computeEdgeCapacity(lengthMeters, lanes, profile);

            const hasExplicitClosure =
                closedEdges.has(id) ||
                (!evalDt.isCustom && seg.hasClosures && !segmentsWithClosureRecords.has(seg.id));
            const restrictionEffect = evaluateSegmentDirectionRestriction(seg, isForward, evalDt);
            const isBlockedRestriction = restrictionEffect === "BLOCKED";
            const restrictionPenaltyFactor = restrictionEffect === "DISCOURAGED" ? 4.0 : 1.0;
            const isClosed = hasExplicitClosure || isBlockedRestriction;

            const fromNodeId = isForward ? seg.fromNodeId : seg.toNodeId;
            const toNodeId = isForward ? seg.toNodeId : seg.fromNodeId;

            const isRoundaboutRing = seg.junctionId != null;
            const isShortRoundaboutFlare =
                !seg.isTwoWay &&
                lengthMeters <= 85 &&
                ((fromNodeId != null && roundaboutNodeIds.has(fromNodeId)) ||
                    (toNodeId != null && roundaboutNodeIds.has(toNodeId)));

            let spawnWeight =
                isRoundaboutRing || isShortRoundaboutFlare || isDirectionless
                    ? 0
                    : profile.spawnWeight;
            if (
                spawnWeight > 0 &&
                (isAtMapBorder(fromNodeId, edgeCoords[0]) || isBoundaryNode(fromNodeId, edgeCoords[0]))
            ) {
                spawnWeight *= profile.isHighwaySpawn ? 2.5 : 1.6;
            }
            if (isClosed) {
                spawnWeight = 0;
            }

            const destWeight =
                isClosed || isRoundaboutRing || isShortRoundaboutFlare ? 0 : profile.destWeight;

            const { speedZones, bumpDists, tollDists } = buildEdgeSpeedZones(
                seg,
                isForward,
                edgeCoords,
                cumLengths,
                totalLength,
                lengthMeters,
                speedMps,
                raw.isImperial,
                curvatures,
                segBBox,
                hazardIndex,
                cosLat
            );

            const firstPt = edgeCoords[0];
            const lastPt = edgeCoords[edgeCoords.length - 1];
            const index = edgeList.length;

            const edge: DirectedEdge = {
                index,
                id,
                segmentId: seg.id,
                isForward,
                isTwoWay,
                fromNodeId,
                toNodeId,
                junctionId: seg.junctionId ?? null,
                roadType: seg.roadType,
                routingRoadType: seg.routingRoadType,
                streetId: seg.primaryStreetId,
                streetName,
                coords: edgeCoords,
                cumLengths,
                lengthMeters,
                startXMeters: (firstPt[0] - refLon) * metersPerDegLon,
                startYMeters: (firstPt[1] - refLat) * METERS_PER_DEG_LAT,
                endXMeters: (lastPt[0] - refLon) * metersPerDegLon,
                endYMeters: (lastPt[1] - refLat) * METERS_PER_DEG_LAT,
                speedKmh,
                speedMps,
                hasUnrestrictedSpeed,
                lanes,
                maxCapacity,
                spawnWeight,
                destWeight,
                isClosed,
                isDrivableDirection: true,
                isMapBorderExit: false,
                isDeadEnd: false,
                restrictionPenaltyFactor,
                speedZones,
                bumpDists,
                tollDists,
            };

            edgeList.push(edge);
            edges.set(id, edge);
            outgoing.set(id, []);
            if (fromNodeId != null) {
                let list = edgesLeavingNode.get(fromNodeId);
                if (!list) {
                    list = [];
                    edgesLeavingNode.set(fromNodeId, list);
                }
                list.push(edge);
            }
            if (toNodeId != null) {
                let list = edgesEnteringNode.get(toNodeId);
                if (!list) {
                    list = [];
                    edgesEnteringNode.set(toNodeId, list);
                }
                list.push(edge);
            }
            return edge;
        };

        createDirectedEdge(true, fwdAllowed);
        createDirectedEdge(false, revAllowed);
    }

    // Build legal & diagnostic node transitions (including roundabout PathTurns)
    buildNodeTransitions({
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
        fallbackTurnAllowed: raw.fallbackTurnAllowed,
        evalDt,
        cosLat,
    });

    // Analyze connected components, dead-end branches, phantom gaps, and reachability
    const topology = analyzeGraphTopology({
        edges,
        edgeList,
        outgoing,
        drivableSegments,
        segById,
        normCoordsBySegId,
        viewportBBox: raw.viewportBBox ?? null,
        isAtMapBorder,
        cosLat,
    });

    return {
        edges,
        edgeList,
        nodes,
        outgoing,
        spawnEdgeIds: topology.spawnEdgeIds,
        spawnCumulativeWeights: topology.spawnCumulativeWeights,
        destEdgeIds: topology.destEdgeIds,
        destCumulativeWeights: topology.destCumulativeWeights,
        legallyReachableDestIds: topology.legallyReachableDestIds,
        canExitCorridorIds: topology.canExitCorridorIds,
        deadEndBranchEdgeIds: topology.deadEndBranchEdgeIds,
        isLeftHandTraffic: raw.isLeftHandTraffic,
        isImperial: raw.isImperial,
        cosLat,
        bounds,
        viewportBBox: raw.viewportBBox ?? null,
    };
}

export function pickWeightedEdgeId(
    edgeIds: string[],
    cumWeights: number[],
    rng: () => number = Math.random
): string | null {
    if (edgeIds.length === 0 || cumWeights.length === 0) return null;
    const total = cumWeights[cumWeights.length - 1];
    if (total <= 0) {
        return edgeIds[Math.floor(rng() * edgeIds.length)] ?? null;
    }
    const target = rng() * total;
    let lo = 0;
    let hi = cumWeights.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cumWeights[mid] >= target) {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    return edgeIds[lo] ?? null;
}

export function edgeEndCoord(edge: DirectedEdge): [number, number] {
    return edge.coords[edge.coords.length - 1] ?? [0, 0];
}

export function edgeStartCoord(edge: DirectedEdge): [number, number] {
    return edge.coords[0] ?? [0, 0];
}

export function edgeMidCoord(edge: DirectedEdge): [number, number] {
    if (edge.coords.length === 0) return [0, 0];
    const mid = edge.coords[Math.floor(edge.coords.length / 2)];
    return mid ?? edge.coords[0];
}

export function edgeDistanceMeters(a: DirectedEdge, b: DirectedEdge): number {
    return Math.hypot(a.startXMeters - b.startXMeters, a.startYMeters - b.startYMeters);
}

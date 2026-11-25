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
    distanceMeters,
    pointToSegmentDistanceMeters,
    samplePolylineAt,
} from "./geo";
import {
    computeEdgeCapacity,
    DRIVABLE_ROAD_TYPES,
    getRoadProfile,
    resolveEdgeLanes,
    WME_ROAD_TYPE,
} from "./roadProfiles";
import {
    BugKind,
    DiagnosticTransition,
    DirectedEdge,
    GraphNode,
    RoadGraph,
    SpeedZone,
} from "./types";

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
}

const MPH_TO_KMH = 1.609344;
const DISCONNECTED_MAX_GAP_M = 12;
const DISCONNECTED_MIN_GAP_M = 0.05;
const GRID_CELL_DEG = 0.0003; // ~25-33m grid cells

function isClosureActive(status: string): boolean {
    return status === "ACTIVE" || status === "UNVERIFIED" || status === "UNKNOWN";
}

function isSegmentDirectionBlockedByRestriction(segment: Segment, isForward: boolean): boolean {
    if (!segment.restrictions || segment.restrictions.length === 0) return false;
    for (const r of segment.restrictions) {
        if (r.isExpired) continue;
        if (r.defaultType !== "BLOCKED") continue;
        if (r.laneScope && r.laneScope !== "WHOLE_SEGMENT" && r.laneScope !== "NONE") continue;
        const dirMatch =
            r.direction === "BOTH" ||
            r.direction === null ||
            (isForward && r.direction === "FWD") ||
            (!isForward && r.direction === "REV");
        if (!dirMatch) continue;

        const freeRules = r.vehicleRules?.FREE;
        const privateAllowed =
            Array.isArray(freeRules) &&
            freeRules.some(
                (vr) =>
                    vr.minPassengers === 0 &&
                    !vr.licensePlateRule &&
                    vr.subscriptions.length === 0 &&
                    (vr.vehicleTypes.length === 0 || vr.vehicleTypes.includes("PRIVATE"))
            );
        if (!privateAllowed) {
            return true;
        }
    }
    return false;
}

function isTurnBlockedByRestriction(turn: Turn): boolean {
    if (!turn.restrictions || turn.restrictions.length === 0) return false;
    for (const r of turn.restrictions) {
        if (r.isExpired) continue;
        if (r.defaultType !== "BLOCKED") continue;
        const freeRules = r.vehicleRules?.FREE;
        const privateAllowed =
            Array.isArray(freeRules) &&
            freeRules.some(
                (vr) =>
                    vr.minPassengers === 0 &&
                    !vr.licensePlateRule &&
                    vr.subscriptions.length === 0 &&
                    (vr.vehicleTypes.length === 0 || vr.vehicleTypes.includes("PRIVATE"))
            );
        if (!privateAllowed) {
            return true;
        }
    }
    return false;
}

function turnKey(fromSegId: number, fromFwd: boolean, toSegId: number, toFwd: boolean): string {
    return `${fromSegId}:${fromFwd ? 1 : 0}->${toSegId}:${toFwd ? 1 : 0}`;
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

export function computeTurnDeflectionDeg(inEdge: DirectedEdge, outEdge: DirectedEdge): number {
    const aLen = inEdge.coords.length;
    const bLen = outEdge.coords.length;
    if (aLen < 2 || bLen < 2) return 0;

    const aPrev = inEdge.coords[aLen - 2];
    const aEnd = inEdge.coords[aLen - 1];
    const bStart = outEdge.coords[0];
    const bNext = outEdge.coords[1];

    const cosLat = Math.max(0.1, Math.cos((aEnd[1] * Math.PI) / 180));
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

function projectPointOntoPolylineDist(
    lon: number,
    lat: number,
    coords: [number, number][],
    cumLengths: number[]
): { minDistMeters: number; alongDist: number } {
    let bestPerp = Infinity;
    let bestAlong = 0;
    for (let i = 0; i < coords.length - 1; i++) {
        const res = pointToSegmentDistanceMeters(
            lon,
            lat,
            coords[i][0],
            coords[i][1],
            coords[i + 1][0],
            coords[i + 1][1]
        );
        if (res.distMeters < bestPerp) {
            bestPerp = res.distMeters;
            const segLen = cumLengths[i + 1] - cumLengths[i];
            bestAlong = cumLengths[i] + segLen * res.t;
        }
    }
    return { minDistMeters: bestPerp, alongDist: bestAlong };
}

function computeUnrestrictedFreewaySpeedKmh(segId: number, isForward: boolean): number {
    const hash =
        (Math.imul(Math.abs(segId) + 1, 2654435761) ^ (isForward ? 0x9e3779b9 : 0x517cc1b7)) >>> 0;
    return 130 + (hash % 61); // 130..190 km/h
}

function buildEdgeSpeedZones(
    seg: Segment,
    isForward: boolean,
    edgeCoords: [number, number][],
    cumLengths: number[],
    lengthMeters: number,
    baseSpeedMps: number,
    isImperial: boolean,
    hazards: PermanentHazard[]
): SpeedZone[] {
    const zones: SpeedZone[] = [];
    const isFreeway =
        seg.roadType === WME_ROAD_TYPE.FREEWAY || seg.routingRoadType === WME_ROAD_TYPE.FREEWAY;

    // 1. Roundabout ring comfort speed cap
    if (seg.junctionId != null) {
        zones.push({
            startDist: 0,
            endDist: lengthMeters,
            maxSpeedMps: Math.min(baseSpeedMps, 10.5), // ~38 km/h inside roundabouts
            preventSpeeding: true,
        });
    }

    // 2. Road geometry curvature zones along polyline vertices
    if (edgeCoords.length >= 3) {
        const lookDist = isFreeway ? 45 : 18;
        const minCurveDeg = isFreeway ? 16 : 12;
        const lateralAccel = isFreeway ? 4.6 : 3.4;
        for (let i = 1; i < edgeCoords.length - 1; i++) {
            const vDist = cumLengths[i];
            const prevSample = samplePolylineAt(edgeCoords, cumLengths, Math.max(0, vDist - lookDist));
            const currPt = edgeCoords[i];
            const nextSample = samplePolylineAt(
                edgeCoords,
                cumLengths,
                Math.min(lengthMeters, vDist + lookDist)
            );

            const cosLat = Math.max(0.1, Math.cos((currPt[1] * Math.PI) / 180));
            const v1x = (currPt[0] - prevSample.lon) * cosLat;
            const v1y = currPt[1] - prevSample.lat;
            const v2x = (nextSample.lon - currPt[0]) * cosLat;
            const v2y = nextSample.lat - currPt[1];

            const m1 = Math.hypot(v1x, v1y);
            const m2 = Math.hypot(v2x, v2y);
            if (m1 < 1e-9 || m2 < 1e-9) continue;

            const dot = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (m1 * m2)));
            const angleRad = Math.acos(dot);
            const angleDeg = (angleRad * 180) / Math.PI;
            if (angleDeg < minCurveDeg) continue;

            const arcSpan =
                Math.min(lengthMeters, vDist + lookDist) - Math.max(0, vDist - lookDist);
            const radius = Math.max(4, arcSpan / Math.max(0.15, angleRad));
            const curveSpeedMps = Math.max(3.8, Math.sqrt(lateralAccel * radius));
            if (curveSpeedMps < baseSpeedMps * 0.95) {
                zones.push({
                    startDist: Math.max(0, vDist - 10),
                    endDist: Math.min(lengthMeters, vDist + 10),
                    maxSpeedMps: curveSpeedMps,
                    preventSpeeding: true,
                });
            }
        }
    }

    // 3. Segment speed camera attribute
    const hasSegCamera = isForward
        ? seg.flagAttributes?.fwdSpeedCamera
        : seg.flagAttributes?.revSpeedCamera;
    if (hasSegCamera) {
        zones.push({
            startDist: 0,
            endDist: lengthMeters,
            maxSpeedMps: baseSpeedMps * 0.98,
            preventSpeeding: true,
        });
    }

    // 4. WME Permanent Hazards (speed bumps, toll booths, stop signs, lights, school zones, cameras, etc.)
    for (const h of hazards) {
        if (h.direction === "FWD" && !isForward) continue;
        if (h.direction === "REV" && isForward) continue;

        if (
            h.type === "SCHOOL_ZONE" &&
            Array.isArray(h.excludedRoadTypes) &&
            h.excludedRoadTypes.includes(seg.roadType)
        ) {
            continue;
        }

        const matchesSegment = h.segmentId != null && h.segmentId === seg.id;
        if (h.segmentId != null && !matchesSegment && h.type !== "SCHOOL_ZONE") {
            continue;
        }

        let spanStart = 0;
        let spanEnd = lengthMeters;
        let matched = matchesSegment;

        if (h.geometry.type === "Point") {
            const [hlon, hlat] = h.geometry.coordinates;
            const proj = projectPointOntoPolylineDist(hlon, hlat, edgeCoords, cumLengths);
            if (!matched && proj.minDistMeters <= 12) {
                matched = true;
            }
            if (matched) {
                const pad = h.type === "CAMERA" ? 30 : h.type === "TRAFFIC_LIGHT" ? 14 : 10;
                spanStart = Math.max(0, proj.alongDist - pad);
                spanEnd = Math.min(lengthMeters, proj.alongDist + pad);
            }
        } else if (h.geometry.type === "Polygon") {
            const ring = h.geometry.coordinates[0] ?? [];
            let minAlong = Infinity;
            let maxAlong = -Infinity;
            let bestPerp = Infinity;
            for (const pt of ring) {
                const proj = projectPointOntoPolylineDist(pt[0], pt[1], edgeCoords, cumLengths);
                if (proj.minDistMeters < bestPerp) bestPerp = proj.minDistMeters;
                if (proj.minDistMeters <= 30) {
                    if (proj.alongDist < minAlong) minAlong = proj.alongDist;
                    if (proj.alongDist > maxAlong) maxAlong = proj.alongDist;
                }
            }
            if (matched || bestPerp <= 25) {
                matched = true;
                if (Number.isFinite(minAlong) && Number.isFinite(maxAlong)) {
                    spanStart = Math.max(0, minAlong - 8);
                    spanEnd = Math.min(lengthMeters, maxAlong + 8);
                }
            }
        }

        if (!matched) continue;

        let maxSpeedMps = baseSpeedMps * 0.72;
        switch (h.type) {
            case "SPEED_BUMP":
            case "TOPES":
                maxSpeedMps = Math.min(baseSpeedMps, 5.0); // ~18 km/h
                break;
            case "TOLL_BOOTH":
                maxSpeedMps = Math.min(baseSpeedMps, 5.5); // ~20 km/h
                break;
            case "SIGN":
                maxSpeedMps = h.subTypes?.includes("STOP_SIGN")
                    ? Math.min(baseSpeedMps, 3.2) // ~11.5 km/h slow roll/stop
                    : Math.min(baseSpeedMps, baseSpeedMps * 0.78);
                break;
            case "TRAFFIC_LIGHT":
                maxSpeedMps = baseSpeedMps * 0.72;
                break;
            case "RAILROAD_CROSSING":
            case "RAISED_CROSSWALK":
            case "HIGHWAY_CROSSWALK":
                maxSpeedMps = Math.min(baseSpeedMps, 7.5); // ~27 km/h
                break;
            case "SCHOOL_ZONE": {
                const rawSchoolLimit = h.speedLimit;
                const kmh =
                    rawSchoolLimit != null && rawSchoolLimit > 0
                        ? isImperial
                            ? rawSchoolLimit * MPH_TO_KMH
                            : rawSchoolLimit
                        : 30;
                maxSpeedMps = Math.min(baseSpeedMps, Math.max(15, kmh) / 3.6);
                break;
            }
            case "CAMERA":
                maxSpeedMps = baseSpeedMps * 0.97;
                break;
            default:
                // DANGEROUS_CURVE, DANGEROUS_INTERSECTION, DANGEROUS_MERGE, NARROW_BRIDGE, LANE_ENDING, SHOULDER_ENDING
                maxSpeedMps = baseSpeedMps * 0.68;
                break;
        }

        zones.push({
            startDist: spanStart,
            endDist: spanEnd,
            maxSpeedMps,
            preventSpeeding: true,
        });
    }

    return zones;
}

export async function fetchRawGraphData(wmeSDK: AsyncWmeSDK): Promise<RawGraphInput> {
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
        wmeSDK.DataModel.Turns.getAll(),
        wmeSDK.DataModel.RoadClosures.getAll(),
        wmeSDK.DataModel.TurnClosures.getAll(),
        wmeSDK.DataModel.Streets.getAll(),
        wmeSDK.DataModel.Countries.getTopCountry(),
        wmeSDK.Settings.getUserSettings(),
        wmeSDK.Map.getMapExtent().catch(() => null),
        wmeSDK.DataModel.PermanentHazards.getAll().catch(() => [] as PermanentHazard[]),
    ]);

    const turnLookup = new Set<string>();
    for (const t of turns) {
        if (!t.isPathTurn && !t.isJunctionBoxTurn && t.segmentPath.length === 0) {
            turnLookup.add(turnKey(t.fromSegmentId, t.fromSegmentFwd, t.toSegmentId, t.toSegmentFwd));
        }
    }

    // Query missing geometric turn pairs via SDK Turns.isTurnAllowed as a fallback (excluding roundabouts)
    const segById = new Map<number, Segment>();
    for (const seg of segments) {
        segById.set(seg.id, seg);
    }

    const fallbackTurnAllowed = new Map<string, boolean>();
    const missingChecks: Array<{
        key: string;
        fromSegmentId: number;
        nodeId: number;
        toSegmentId: number;
    }> = [];

    for (const node of nodes) {
        const segIds = node.connectedSegmentIds;
        if (segIds.length < 2) continue;

        // Roundabout nodes use multi-segment PathTurns; single-node isTurnAllowed returns false there
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
                        if (!turnLookup.has(k) && missingChecks.length < 1500) {
                            missingChecks.push({
                                key: k,
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
    };
}

export async function buildRoadGraphFromSDK(wmeSDK: AsyncWmeSDK): Promise<RoadGraph> {
    const raw = await fetchRawGraphData(wmeSDK);
    return buildRoadGraphFromRawData(raw);
}

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

export function buildRoadGraphFromRawData(raw: RawGraphInput): RoadGraph {
    const edges = new Map<string, DirectedEdge>();
    const nodes = new Map<number, GraphNode>();
    const outgoing = new Map<string, DiagnosticTransition[]>();

    const streetNameById = new Map<number, string>();
    for (const st of raw.streets) {
        if (st.name) {
            streetNameById.set(st.id, st.name);
        }
    }

    // Index active road closures by directed edge ID
    const closedEdges = new Set<string>();
    const segmentWithDirectionalClosure = new Set<number>();
    for (const rc of raw.roadClosures) {
        if (!isClosureActive(rc.status)) continue;
        closedEdges.add(`${rc.segmentId}:${rc.isForward ? "F" : "R"}`);
        segmentWithDirectionalClosure.add(rc.segmentId);
    }

    // Index active turn closures by "fromSegId->toSegId"
    const closedTurns = new Set<string>();
    for (const tc of raw.turnClosures) {
        if (!isClosureActive(tc.status)) continue;
        closedTurns.add(`${tc.fromSegmentId}->${tc.toSegmentId}`);
    }

    // Separate direct single-node turns from multi-segment path turns (e.g. roundabouts / junction boxes)
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

    // Index nodes, bounds, loaded segments, and roundabout nodes
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

    // Helper: check if node is near the outer viewport boundary or degree 1
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

    const isAtMapBorder = (nodeId: number | null, pt: [number, number]): boolean => {
        if (nodeId != null) {
            const node = nodes.get(nodeId);
            if (node && node.connectedSegmentIds.some((id) => !loadedSegIds.has(id))) {
                return true;
            }
        }
        if (raw.viewportBBox && raw.viewportBBox.length >= 4) {
            const [west, south, east, north] = raw.viewportBBox;
            if (pt[0] <= west || pt[0] >= east || pt[1] <= south || pt[1] >= north) {
                return true;
            }
            if (
                distanceMeters(pt[0], pt[1], west, pt[1]) <= 18 ||
                distanceMeters(pt[0], pt[1], east, pt[1]) <= 18 ||
                distanceMeters(pt[0], pt[1], pt[0], south) <= 18 ||
                distanceMeters(pt[0], pt[1], pt[0], north) <= 18
            ) {
                return true;
            }
        }
        return false;
    };

    // Build directed edges for drivable segments
    const edgesLeavingNode = new Map<number, DirectedEdge[]>();
    const edgesEnteringNode = new Map<number, DirectedEdge[]>();
    const drivableSegments: Segment[] = [];
    const normCoordsBySegId = new Map<number, [number, number][]>();

    for (const seg of raw.segments) {
        if (!DRIVABLE_ROAD_TYPES.has(seg.roadType) || !seg.isDrivable) continue;
        const rawCoords = seg.geometry.coordinates;
        if (!rawCoords || rawCoords.length < 2) continue;
        drivableSegments.push(seg);

        const coords: [number, number][] = rawCoords.map((c) => [c[0], c[1]]);
        // Ensure A->B geometry physically starts at fromNodeId and ends at toNodeId
        if (seg.fromNodeId != null && seg.toNodeId != null && seg.fromNodeId !== seg.toNodeId) {
            const fromNode = nodes.get(seg.fromNodeId);
            const toNode = nodes.get(seg.toNodeId);
            if (fromNode && toNode) {
                const startPt = coords[0];
                const endPt = coords[coords.length - 1];
                const dStartFrom = distanceMeters(startPt[0], startPt[1], fromNode.lon, fromNode.lat);
                const dStartTo = distanceMeters(startPt[0], startPt[1], toNode.lon, toNode.lat);
                const dEndFrom = distanceMeters(endPt[0], endPt[1], fromNode.lon, fromNode.lat);
                const dEndTo = distanceMeters(endPt[0], endPt[1], toNode.lon, toNode.lat);
                if (dStartTo + 1 < dStartFrom && dEndFrom + 1 < dEndTo) {
                    coords.reverse();
                }
            }
        }
        normCoordsBySegId.set(seg.id, coords);
        const revCoords: [number, number][] = [...coords].reverse();
        const profile = getRoadProfile(seg.roadType);
        const streetName =
            (seg.primaryStreetId != null ? streetNameById.get(seg.primaryStreetId) : undefined) ??
            `${profile.label} #${seg.id}`;

        const { fwdAllowed, revAllowed, isDirectionless } = getSegmentAllowedDirections(seg);

        const createDirectedEdge = (isForward: boolean, canDrive: boolean): DirectedEdge | null => {
            if (!canDrive) return null;
            const id = `${seg.id}:${isForward ? "F" : "R"}`;
            const edgeCoords = isForward ? coords : revCoords;
            const { cumLengths, totalLength } = computeCumulativeLengths(edgeCoords);
            const lengthMeters = Math.max(totalLength, seg.length || 1, 1);

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
                (seg.hasClosures && !segmentWithDirectionalClosure.has(seg.id));
            const isBlockedRestriction = isSegmentDirectionBlockedByRestriction(seg, isForward);
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

            const speedZones = buildEdgeSpeedZones(
                seg,
                isForward,
                edgeCoords,
                cumLengths,
                lengthMeters,
                speedMps,
                raw.isImperial,
                raw.permanentHazards ?? []
            );

            const edge: DirectedEdge = {
                id,
                segmentId: seg.id,
                isForward,
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
                speedZones,
            };

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

        const allowed = pt.isAllowed && !isTurnBlockedByRestriction(pt);
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
                // Skip immediate U-turn unless explicitly allowed by a Turn record
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

                const hasTurnClosure = closedTurns.has(`${inEdge.segmentId}->${outEdge.segmentId}`);
                const hasTurnRestriction = turnRecord ? isTurnBlockedByRestriction(turnRecord) : false;

                if (outEdge.isClosed || hasTurnClosure) {
                    transitions.push({
                        toEdgeId: outEdge.id,
                        isLegal: false,
                        bugKind: "ROAD_CLOSURE",
                        penaltySeconds: 45_000,
                        viaNodeId: nodeId,
                    });
                    continue;
                }

                let turnAllowed: boolean;
                if (pathTurnAllowedSteps.has(`${inEdge.id}->${outEdge.id}`)) {
                    turnAllowed = true;
                } else if (isRoundaboutNode || inEdge.junctionId != null || outEdge.junctionId != null) {
                    // Roundabout entry / ring / exit connections follow PathTurns and segment directionality.
                    // Only block entry if PathTurns exist from inEdge and ALL of them are disallowed.
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
                } else if (raw.fallbackTurnAllowed?.has(k)) {
                    turnAllowed = raw.fallbackTurnAllowed.get(k) === true;
                } else {
                    // Without a Turn record, assume non-U-turns are allowed unless explicitly disallowed
                    turnAllowed = !isSelfUTurn;
                }

                if (turnAllowed) {
                    transitions.push({
                        toEdgeId: outEdge.id,
                        isLegal: true,
                        penaltySeconds: 0,
                        viaNodeId: nodeId,
                    });
                } else {
                    transitions.push({
                        toEdgeId: outEdge.id,
                        isLegal: false,
                        bugKind: "DISALLOWED_TURN",
                        penaltySeconds: 40_000,
                        viaNodeId: nodeId,
                    });
                }
            }

            const hasAnyLegalExit = transitions.some((t) => t.isLegal);
            if (hasAnyLegalExit) {
                // When the road continues legally, suppress intentional acute hairpin restrictions
                // (e.g., roundabout exit flare <-> entrance flare V-turns or divided highway U-turns)
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
                    if (isFlareHairpin || computeTurnDeflectionDeg(inEdge, target) >= 135) {
                        transitions.splice(idx, 1);
                    }
                }
            } else if (nodeObj && nodeObj.connectedSegmentIds.length > 1) {
                // Only flag wrong-way DEAD_END when there is NO enabled turn out of inEdge
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
                            isLegal: false,
                            bugKind: "DEAD_END",
                            penaltySeconds: 60_000,
                            viaNodeId: nodeId,
                        });
                    }
                }
            }
        }
    }

    // Index drivable connections per node and compute undirected connected components
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

    // Classify map-border exits and connected two-way dead-end roads before phantom-gap detection
    for (const edge of edges.values()) {
        if (edge.isClosed || !edge.isDrivableDirection) continue;
        if (!hasLegalOut(edge.id)) {
            if (isAtMapBorder(edge.toNodeId, edgeEndCoord(edge))) {
                edge.isMapBorderExit = true;
                if (getRoadProfile(edge.roadType).isHighwaySpawn) {
                    edge.destWeight = Math.max(edge.destWeight, 2.0);
                }
            } else if (
                isDrivableLeafEndpoint(edge.toNodeId, edgeEndCoord(edge)) &&
                Boolean(getOppositeOpenEdge(edge)) &&
                isAnchoredComponent(componentBySegId.get(edge.segmentId) ?? -1)
            ) {
                edge.isDeadEnd = true;
                edge.spawnWeight = 0;
            }
        }
    }

    // Spatial hash to detect Disconnected Nodes ("phantom gaps") within 12m
    const cellKey = (lon: number, lat: number): string => {
        const cx = Math.floor(lon / GRID_CELL_DEG);
        const cy = Math.floor(lat / GRID_CELL_DEG);
        return `${cx},${cy}`;
    };

    // Index all drivable segment polyline sub-segments in the spatial grid
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
            isLegal: false,
            bugKind: "DISCONNECTED_NODE",
            penaltySeconds: 35_000 + gapMeters * 100,
            viaNodeId: fromEdge.toNodeId,
            gapMeters,
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

            // Connect the dangling endpoint with nearby segments in both directions for chaos diagnostics
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
                // Skip if they already share this node
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
                    ref.by
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

    for (const edge of edges.values()) {
        if (edge.isClosed || !edge.isDrivableDirection) continue;
        if ((outgoing.get(edge.id)?.length ?? 0) === 0 && !edge.isMapBorderExit) {
            edge.spawnWeight = 0;
            if (
                isDrivableLeafEndpoint(edge.toNodeId, edgeEndCoord(edge)) &&
                Boolean(getOppositeOpenEdge(edge))
            ) {
                edge.isDeadEnd = true;
            }
        }
    }

    const allOpenEdges = Array.from(edges.values()).filter((e) => !e.isClosed && e.isDrivableDirection);

    // Index incoming legal transitions and outgoing legal counts across open edges
    const incomingLegal = new Map<string, string[]>();
    const outLegalCount = new Map<string, number>();
    for (const e of allOpenEdges) {
        let outCnt = 0;
        for (const t of outgoing.get(e.id) ?? []) {
            if (!t.isLegal) continue;
            const toEdge = edges.get(t.toEdgeId);
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

    // Reverse Kahn's peel from dead-end leaf edges to identify all inward dead-end branch edges
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

    // Suppress destWeight on outward-only dead-end branch twins so destinations favor reachable inward edges
    const outwardDeadEndOnly = new Set<string>();
    const outQueue: string[] = [];
    for (const e of allOpenEdges) {
        if (isAtMapBorder(e.fromNodeId, edgeStartCoord(e))) continue;
        if ((incomingLegal.get(e.id)?.length ?? 0) !== 0) continue;
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
            const nextEdge = edges.get(t.toEdgeId);
            if (
                !nextEdge ||
                nextEdge.isClosed ||
                !nextEdge.isDrivableDirection ||
                outwardDeadEndOnly.has(nextEdge.id) ||
                isAtMapBorder(nextEdge.fromNodeId, edgeStartCoord(nextEdge))
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

    // Build spawn and destination weighted pools (prioritizing segments intersecting expanded viewport)
    const allSpawnable = allOpenEdges.filter((e) => e.spawnWeight > 0);
    const nearViewportSpawns = raw.viewportBBox
        ? allSpawnable.filter((e) => edgeIntersectsExpandedViewport(e, raw.viewportBBox!))
        : allSpawnable;
    const spawnCandidates = nearViewportSpawns.length > 0 ? nearViewportSpawns : allSpawnable;

    const spawnEdgeIds = spawnCandidates.map((e) => e.id);
    const spawnCumulativeWeights = buildCumulativeWeights(
        spawnEdgeIds,
        edges,
        (e) => e.spawnWeight
    );

    const allDestable = allOpenEdges.filter((e) => e.destWeight > 0);
    const nearViewportDests = raw.viewportBBox
        ? allDestable.filter((e) => edgeIntersectsExpandedViewport(e, raw.viewportBBox!))
        : allDestable;
    const destCandidates = nearViewportDests.length > 0 ? nearViewportDests : allDestable;
    const destEdgeIds = destCandidates.map((e) => e.id);
    const destCumulativeWeights = buildCumulativeWeights(destEdgeIds, edges, (e) => e.destWeight);

    // Forward reachability anchored to map-border entries and highways (or anchored components on street-only maps)
    const legallyReachableDestIds = new Set<string>();
    const fwdQueue: string[] = [];
    for (const e of allOpenEdges) {
        if (isAtMapBorder(e.fromNodeId, edgeStartCoord(e))) {
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
            const next = edges.get(t.toEdgeId);
            if (!next || next.isClosed || !next.isDrivableDirection) continue;
            legallyReachableDestIds.add(t.toEdgeId);
            fwdQueue.push(t.toEdgeId);
        }
    }

    // Reverse reachability to valid corridor exits / continuing destinations
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
        edges,
        nodes,
        outgoing,
        spawnEdgeIds,
        spawnCumulativeWeights,
        destEdgeIds,
        destCumulativeWeights,
        legallyReachableDestIds,
        canExitCorridorIds,
        deadEndBranchEdgeIds,
        isLeftHandTraffic: raw.isLeftHandTraffic,
        isImperial: raw.isImperial,
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

export function describeBugKind(kind: BugKind): string {
    switch (kind) {
        case "DISCONNECTED_NODE":
            return "Disconnected Node";
        case "DISALLOWED_TURN":
            return "Impossible Turn Restriction";
        case "ROAD_CLOSURE":
            return "Road Closure";
        case "DEAD_END":
            return "Dead End / One-Way Trap";
        case "CAPACITY_BOTTLENECK":
            return "Road Capacity Bottleneck";
    }
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
    const [ax, ay] = edgeStartCoord(a);
    const [bx, by] = edgeStartCoord(b);
    return distanceMeters(ax, ay, bx, by);
}

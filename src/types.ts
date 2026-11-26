export interface SimSettings {
    enabled: boolean;
    paused: boolean;
    soundEnabled: boolean;
    screensaverMode: boolean;
    screensaverIdleSeconds: number;
    maxWazers: number;
    simSpeed: number;
    patienceSeconds: number;
    showHeatmap: boolean;
    showRoutesOnHover: boolean;
    showBugBadges: boolean;
    evalTimestamp: string | null;
}

export const MIN_SIM_ZOOM = 16;

export const DEFAULT_SIM_SETTINGS: SimSettings = {
    enabled: true,
    paused: false,
    soundEnabled: false,
    screensaverMode: false,
    screensaverIdleSeconds: 30,
    maxWazers: 42,
    simSpeed: 1.5,
    patienceSeconds: 10,
    showHeatmap: true,
    showRoutesOnHover: true,
    showBugBadges: true,
    evalTimestamp: null,
};

export type BugKind =
    | "DISCONNECTED_NODE"
    | "DISALLOWED_TURN"
    | "ROAD_CLOSURE"
    | "DEAD_END"
    | "CAPACITY_BOTTLENECK";

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

export function bugShortLabel(kind: BugKind): string {
    switch (kind) {
        case "DISCONNECTED_NODE":
            return "Disconnected Node";
        case "DISALLOWED_TURN":
            return "Turn Blocked";
        case "ROAD_CLOSURE":
            return "Road Closure";
        case "DEAD_END":
            return "Dead End";
        case "CAPACITY_BOTTLENECK":
            return "Bottleneck";
    }
}

export interface SpeedZone {
    startDist: number;
    endDist: number;
    maxSpeedMps: number;
    preventSpeeding: boolean;
}

export interface DirectedEdge {
    index: number;
    id: string;
    segmentId: number;
    isForward: boolean;
    isTwoWay: boolean;
    fromNodeId: number | null;
    toNodeId: number | null;
    junctionId: number | null;
    roadType: number;
    routingRoadType: number | null;
    streetId: number | null;
    streetName: string;
    coords: [number, number][];
    cumLengths: number[];
    lengthMeters: number;
    startXMeters: number;
    startYMeters: number;
    endXMeters: number;
    endYMeters: number;
    speedKmh: number;
    speedMps: number;
    hasUnrestrictedSpeed: boolean;
    lanes: number;
    maxCapacity: number;
    spawnWeight: number;
    destWeight: number;
    isClosed: boolean;
    isDrivableDirection: boolean;
    isMapBorderExit: boolean;
    isDeadEnd: boolean;
    restrictionPenaltyFactor: number;
    speedZones: SpeedZone[];
}

export interface DiagnosticTransition {
    toEdgeId: string;
    toEdgeIndex: number;
    isLegal: boolean;
    bugKind?: BugKind;
    penaltySeconds: number;
    viaNodeId: number | null;
    gapMeters?: number;
    turnDeflectionDeg: number;
}

export interface GraphNode {
    id: number;
    lon: number;
    lat: number;
    connectedSegmentIds: number[];
    lanesCapacity: number;
}

export interface RoadGraph {
    edges: Map<string, DirectedEdge>;
    edgeList: DirectedEdge[];
    nodes: Map<number, GraphNode>;
    outgoing: Map<string, DiagnosticTransition[]>;
    spawnEdgeIds: string[];
    spawnCumulativeWeights: number[];
    destEdgeIds: string[];
    destCumulativeWeights: number[];
    legallyReachableDestIds: Set<string>;
    canExitCorridorIds: Set<string>;
    deadEndBranchEdgeIds: Set<string>;
    isLeftHandTraffic: boolean;
    isImperial: boolean;
    cosLat: number;
    bounds: [number, number, number, number] | null;
    viewportBBox: [number, number, number, number] | null;
}

export interface TerminalBug {
    kind: BugKind;
    nodeId: number | null;
    segmentId: number;
    targetSegmentId?: number;
    lon: number;
    lat: number;
    message: string;
}

export type WazerState = "CRUISING" | "QUEUED" | "HONKING" | "ON_FIRE" | "ARRIVED";

export interface WazerAgent {
    id: number;
    moodIndex: number;
    edgeId: string;
    distOnEdge: number;
    laneIndex: number;
    lateralOffset: number;
    lon: number;
    lat: number;
    bearingScreenRad: number;
    speedMps: number;
    cruiseTrait: number;
    openRoadSeconds: number;
    facingLeft: boolean;
    routeEdgeIds: string[];
    routeIndex: number;
    destStreetName: string;
    destEdgeId: string;
    terminalBug: TerminalBug | null;
    stuckSeconds: number;
    state: WazerState;
    honkCooldown: number;
    hornBubbleTimer: number;
    hornText: string;
    rerouteCooldown: number;
}

export interface ChaosHotspot {
    id: string;
    kind: BugKind;
    segmentId: number;
    nodeId: number | null;
    lon: number;
    lat: number;
    stuckCount: number;
    honkingCount: number;
    burningCount: number;
    description: string;
}

export type ParticleKind = "SMOKE" | "FIRE" | "RING" | "ARRIVE";

export interface Particle {
    xLon: number;
    yLat: number;
    vxPx: number;
    vyPx: number;
    age: number;
    maxAge: number;
    size: number;
    kind: ParticleKind;
}

export interface SimStats {
    activeWazers: number;
    cruisingCount: number;
    queuedCount: number;
    honkingCount: number;
    burningCount: number;
    arrivedCount: number;
    hotspotCount: number;
    edgeCount: number;
}

export interface HoverInfo {
    kind: "WAZER" | "HOTSPOT";
    screenX: number;
    screenY: number;
    wazer?: WazerAgent;
    hotspot?: ChaosHotspot;
}

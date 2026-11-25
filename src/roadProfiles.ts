import type { Segment } from "wme-sdk-typings";

export const WME_ROAD_TYPE = {
    STREET: 1,
    PRIMARY_STREET: 2,
    FREEWAY: 3,
    RAMP: 4,
    MAJOR_HIGHWAY: 6,
    MINOR_HIGHWAY: 7,
    OFF_ROAD: 8,
    FERRY: 15,
    PRIVATE_ROAD: 17,
    PARKING_LOT_ROAD: 20,
    ALLEY: 22,
} as const;

export interface RoadProfile {
    roadType: number;
    label: string;
    color: string;
    defaultSpeedKmh: number;
    defaultLanes: number;
    spawnWeight: number;
    destWeight: number;
    routingFactor: number;
    capPerLanePer100m: number;
    minCap: number;
    isHighwaySpawn: boolean;
}

export const ROAD_PROFILES: Readonly<Record<number, RoadProfile>> = {
    [WME_ROAD_TYPE.FREEWAY]: {
        roadType: WME_ROAD_TYPE.FREEWAY,
        label: "Freeway",
        color: "#c158d9",
        defaultSpeedKmh: 130,
        defaultLanes: 3,
        spawnWeight: 10.0,
        destWeight: 0.4,
        routingFactor: 1.0,
        capPerLanePer100m: 4.8,
        minCap: 6,
        isHighwaySpawn: true,
    },
    [WME_ROAD_TYPE.MAJOR_HIGHWAY]: {
        roadType: WME_ROAD_TYPE.MAJOR_HIGHWAY,
        label: "Major Highway",
        color: "#eb5e55",
        defaultSpeedKmh: 90,
        defaultLanes: 2,
        spawnWeight: 7.5,
        destWeight: 1.0,
        routingFactor: 1.15,
        capPerLanePer100m: 4.2,
        minCap: 4,
        isHighwaySpawn: true,
    },
    [WME_ROAD_TYPE.MINOR_HIGHWAY]: {
        roadType: WME_ROAD_TYPE.MINOR_HIGHWAY,
        label: "Minor Highway",
        color: "#f59e0b",
        defaultSpeedKmh: 75,
        defaultLanes: 2,
        spawnWeight: 5.0,
        destWeight: 2.0,
        routingFactor: 1.32,
        capPerLanePer100m: 3.8,
        minCap: 3,
        isHighwaySpawn: true,
    },
    [WME_ROAD_TYPE.RAMP]: {
        roadType: WME_ROAD_TYPE.RAMP,
        label: "Ramp",
        color: "#38bdf8",
        defaultSpeedKmh: 65,
        defaultLanes: 1,
        spawnWeight: 2.0,
        destWeight: 0.2,
        routingFactor: 1.22,
        capPerLanePer100m: 3.2,
        minCap: 2,
        isHighwaySpawn: true,
    },
    [WME_ROAD_TYPE.PRIMARY_STREET]: {
        roadType: WME_ROAD_TYPE.PRIMARY_STREET,
        label: "Primary Street",
        color: "#eab308",
        defaultSpeedKmh: 50,
        defaultLanes: 2,
        spawnWeight: 3.0,
        destWeight: 5.5,
        routingFactor: 1.55,
        capPerLanePer100m: 3.2,
        minCap: 3,
        isHighwaySpawn: false,
    },
    [WME_ROAD_TYPE.STREET]: {
        roadType: WME_ROAD_TYPE.STREET,
        label: "Street",
        color: "#94a3b8",
        defaultSpeedKmh: 40,
        defaultLanes: 1,
        spawnWeight: 1.0,
        destWeight: 10.0,
        routingFactor: 1.95,
        capPerLanePer100m: 2.6,
        minCap: 2,
        isHighwaySpawn: false,
    },
    [WME_ROAD_TYPE.PRIVATE_ROAD]: {
        roadType: WME_ROAD_TYPE.PRIVATE_ROAD,
        label: "Private Road",
        color: "#cbd5e1",
        defaultSpeedKmh: 20,
        defaultLanes: 1,
        spawnWeight: 0.15,
        destWeight: 4.0,
        routingFactor: 3.4,
        capPerLanePer100m: 1.8,
        minCap: 1,
        isHighwaySpawn: false,
    },
    [WME_ROAD_TYPE.PARKING_LOT_ROAD]: {
        roadType: WME_ROAD_TYPE.PARKING_LOT_ROAD,
        label: "Parking Lot Road",
        color: "#9ca3af",
        defaultSpeedKmh: 15,
        defaultLanes: 1,
        spawnWeight: 0.08,
        destWeight: 5.0,
        routingFactor: 4.5,
        capPerLanePer100m: 1.8,
        minCap: 1,
        isHighwaySpawn: false,
    },
    [WME_ROAD_TYPE.ALLEY]: {
        roadType: WME_ROAD_TYPE.ALLEY,
        label: "Alley",
        color: "#64748b",
        defaultSpeedKmh: 20,
        defaultLanes: 1,
        spawnWeight: 0.25,
        destWeight: 3.0,
        routingFactor: 2.6,
        capPerLanePer100m: 1.4,
        minCap: 1,
        isHighwaySpawn: false,
    },
    [WME_ROAD_TYPE.OFF_ROAD]: {
        roadType: WME_ROAD_TYPE.OFF_ROAD,
        label: "Off-Road",
        color: "#a16207",
        defaultSpeedKmh: 20,
        defaultLanes: 1,
        spawnWeight: 0.12,
        destWeight: 1.0,
        routingFactor: 3.8,
        capPerLanePer100m: 1.5,
        minCap: 1,
        isHighwaySpawn: false,
    },
    [WME_ROAD_TYPE.FERRY]: {
        roadType: WME_ROAD_TYPE.FERRY,
        label: "Ferry",
        color: "#0284c7",
        defaultSpeedKmh: 25,
        defaultLanes: 1,
        spawnWeight: 0.15,
        destWeight: 1.0,
        routingFactor: 2.3,
        capPerLanePer100m: 1.5,
        minCap: 1,
        isHighwaySpawn: false,
    },
};

const FALLBACK_PROFILE: RoadProfile = {
    roadType: WME_ROAD_TYPE.STREET,
    label: "Road",
    color: "#94a3b8",
    defaultSpeedKmh: 40,
    defaultLanes: 1,
    spawnWeight: 0.5,
    destWeight: 3.0,
    routingFactor: 2.0,
    capPerLanePer100m: 2.2,
    minCap: 2,
    isHighwaySpawn: false,
};

export const DRIVABLE_ROAD_TYPES: ReadonlySet<number> = new Set(Object.keys(ROAD_PROFILES).map(Number));

export function getRoadProfile(roadType: number): RoadProfile {
    return ROAD_PROFILES[roadType] ?? FALLBACK_PROFILE;
}

export function resolveEdgeLanes(segment: Segment, isForward: boolean, profile: RoadProfile): number {
    const infoLanes = isForward
        ? segment.fromLanesInfo?.numberOfLanes
        : segment.toLanesInfo?.numberOfLanes;
    const nodeLanes = isForward ? segment.fromNodeLanesCount : segment.toNodeLanesCount;
    const raw =
        infoLanes && infoLanes > 0
            ? infoLanes
            : nodeLanes && nodeLanes > 0
              ? nodeLanes
              : profile.defaultLanes;
    return Math.max(1, Math.min(6, Math.round(raw)));
}

export function computeEdgeCapacity(lengthMeters: number, lanes: number, profile: RoadProfile): number {
    const effectiveLen = Math.max(lengthMeters, 18);
    return Math.max(
        profile.minCap,
        Math.ceil((effectiveLen / 100) * lanes * profile.capPerLanePer100m)
    );
}

export const ROAD_LEGEND_ITEMS: readonly RoadProfile[] = [
    ROAD_PROFILES[WME_ROAD_TYPE.FREEWAY],
    ROAD_PROFILES[WME_ROAD_TYPE.MAJOR_HIGHWAY],
    ROAD_PROFILES[WME_ROAD_TYPE.MINOR_HIGHWAY],
    ROAD_PROFILES[WME_ROAD_TYPE.PRIMARY_STREET],
    ROAD_PROFILES[WME_ROAD_TYPE.STREET],
    ROAD_PROFILES[WME_ROAD_TYPE.ALLEY],
    ROAD_PROFILES[WME_ROAD_TYPE.PRIVATE_ROAD],
    ROAD_PROFILES[WME_ROAD_TYPE.PARKING_LOT_ROAD],
];

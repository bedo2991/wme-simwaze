import type { PermanentHazard, Segment } from "wme-sdk-typings";
import {
    METERS_PER_DEG_LAT,
    pointToSegmentDistanceMeters,
    samplePolylineAt,
} from "../geo";
import { WME_ROAD_TYPE } from "../roadProfiles";
import { SpeedZone } from "../types";

const MPH_TO_KMH = 1.609344;
const VERTICAL_BUMP_HAZARD_TYPES = new Set<string>(["SPEED_BUMP", "TOPES", "RAISED_CROSSWALK"]);

export interface CurvatureSample {
    fwdVertexDist: number;
    curveSpeedMps: number;
}

export interface SpatialHazardEntry {
    hazard: PermanentHazard;
    minLon: number;
    minLat: number;
    maxLon: number;
    maxLat: number;
}

export interface HazardSpatialIndex {
    bySegmentId: Map<number, PermanentHazard[]>;
    spatialEntries: SpatialHazardEntry[];
}

export function buildHazardSpatialIndex(
    hazards: readonly PermanentHazard[],
    cosLat: number
): HazardSpatialIndex {
    const bySegmentId = new Map<number, PermanentHazard[]>();
    const spatialEntries: SpatialHazardEntry[] = [];
    if (hazards.length === 0) {
        return { bySegmentId, spatialEntries };
    }

    const padLon = 35 / (METERS_PER_DEG_LAT * Math.max(0.1, cosLat));
    const padLat = 35 / METERS_PER_DEG_LAT;

    for (const h of hazards) {
        if (h.segmentId != null && h.type !== "SCHOOL_ZONE") {
            let bucket = bySegmentId.get(h.segmentId);
            if (!bucket) {
                bucket = [];
                bySegmentId.set(h.segmentId, bucket);
            }
            bucket.push(h);
            continue;
        }

        let minLon = Infinity;
        let minLat = Infinity;
        let maxLon = -Infinity;
        let maxLat = -Infinity;

        if (h.geometry.type === "Point") {
            const [lon, lat] = h.geometry.coordinates;
            minLon = lon - padLon;
            maxLon = lon + padLon;
            minLat = lat - padLat;
            maxLat = lat + padLat;
        } else if (h.geometry.type === "Polygon") {
            const ring = h.geometry.coordinates[0] ?? [];
            for (const pt of ring) {
                if (pt[0] < minLon) minLon = pt[0];
                if (pt[1] < minLat) minLat = pt[1];
                if (pt[0] > maxLon) maxLon = pt[0];
                if (pt[1] > maxLat) maxLat = pt[1];
            }
            if (Number.isFinite(minLon)) {
                minLon -= padLon;
                maxLon += padLon;
                minLat -= padLat;
                maxLat += padLat;
            }
        }

        spatialEntries.push({
            hazard: h,
            minLon,
            minLat,
            maxLon,
            maxLat,
        });
    }

    return { bySegmentId, spatialEntries };
}

export function computeSegmentCurvatures(
    seg: Segment,
    fwdCoords: [number, number][],
    fwdCumLengths: number[],
    lengthMeters: number,
    cosLat: number
): CurvatureSample[] {
    const samples: CurvatureSample[] = [];
    if (fwdCoords.length < 3) return samples;

    const isFreeway =
        seg.roadType === WME_ROAD_TYPE.FREEWAY || seg.routingRoadType === WME_ROAD_TYPE.FREEWAY;
    const lookDist = isFreeway ? 45 : 18;
    const minCurveDeg = isFreeway ? 16 : 12;
    const lateralAccel = isFreeway ? 4.6 : 3.4;

    for (let i = 1; i < fwdCoords.length - 1; i++) {
        const vDist = fwdCumLengths[i];
        const minSpan = Math.max(0, vDist - lookDist);
        const maxSpan = Math.min(lengthMeters, vDist + lookDist);
        const prevSample = samplePolylineAt(fwdCoords, fwdCumLengths, minSpan);
        const currPt = fwdCoords[i];
        const nextSample = samplePolylineAt(fwdCoords, fwdCumLengths, maxSpan);

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

        const arcSpan = maxSpan - minSpan;
        const radius = Math.max(4, arcSpan / Math.max(0.15, angleRad));
        const curveSpeedMps = Math.max(3.8, Math.sqrt(lateralAccel * radius));
        samples.push({ fwdVertexDist: vDist, curveSpeedMps });
    }

    return samples;
}

function projectPointOntoPolylineDist(
    lon: number,
    lat: number,
    coords: [number, number][],
    cumLengths: number[],
    cosLat: number
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
            coords[i + 1][1],
            cosLat
        );
        if (res.distMeters < bestPerp) {
            bestPerp = res.distMeters;
            const segLen = cumLengths[i + 1] - cumLengths[i];
            bestAlong = cumLengths[i] + segLen * res.t;
        }
    }
    return { minDistMeters: bestPerp, alongDist: bestAlong };
}

function appendHazardZoneIfMatched(
    zones: SpeedZone[],
    bumpDists: number[],
    h: PermanentHazard,
    seg: Segment,
    isForward: boolean,
    edgeCoords: [number, number][],
    cumLengths: number[],
    lengthMeters: number,
    baseSpeedMps: number,
    isImperial: boolean,
    cosLat: number
): void {
    if (h.direction === "FWD" && !isForward) return;
    if (h.direction === "REV" && isForward) return;

    if (
        h.type === "SCHOOL_ZONE" &&
        Array.isArray(h.excludedRoadTypes) &&
        h.excludedRoadTypes.includes(seg.roadType)
    ) {
        return;
    }

    const matchesSegment = h.segmentId != null && h.segmentId === seg.id;
    if (h.segmentId != null && !matchesSegment && h.type !== "SCHOOL_ZONE") {
        return;
    }

    let spanStart = 0;
    let spanEnd = lengthMeters;
    let centerDist = lengthMeters * 0.5;
    let matched = matchesSegment;

    if (h.geometry.type === "Point") {
        const [hlon, hlat] = h.geometry.coordinates;
        const proj = projectPointOntoPolylineDist(hlon, hlat, edgeCoords, cumLengths, cosLat);
        if (!matched && proj.minDistMeters <= 12) {
            matched = true;
        }
        if (matched) {
            const pad = h.type === "CAMERA" ? 30 : h.type === "TRAFFIC_LIGHT" ? 14 : 10;
            spanStart = Math.max(0, proj.alongDist - pad);
            spanEnd = Math.min(lengthMeters, proj.alongDist + pad);
            centerDist = Math.max(0, Math.min(lengthMeters, proj.alongDist));
        }
    } else if (h.geometry.type === "Polygon") {
        const ring = h.geometry.coordinates[0] ?? [];
        let minAlong = Infinity;
        let maxAlong = -Infinity;
        let bestPerp = Infinity;
        for (const pt of ring) {
            const proj = projectPointOntoPolylineDist(pt[0], pt[1], edgeCoords, cumLengths, cosLat);
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
                centerDist = Math.max(0, Math.min(lengthMeters, (minAlong + maxAlong) * 0.5));
            }
        }
    }

    if (!matched) return;

    if (VERTICAL_BUMP_HAZARD_TYPES.has(h.type)) {
        bumpDists.push(centerDist);
    }

    let maxSpeedMps = baseSpeedMps * 0.72;
    switch (h.type) {
        case "SPEED_BUMP":
        case "TOPES":
            maxSpeedMps = Math.min(baseSpeedMps, 5.0);
            break;
        case "TOLL_BOOTH":
            maxSpeedMps = Math.min(baseSpeedMps, 5.5);
            break;
        case "SIGN":
            maxSpeedMps = h.subTypes?.includes("STOP_SIGN")
                ? Math.min(baseSpeedMps, 3.2)
                : Math.min(baseSpeedMps, baseSpeedMps * 0.78);
            break;
        case "TRAFFIC_LIGHT":
            maxSpeedMps = baseSpeedMps * 0.72;
            break;
        case "RAILROAD_CROSSING":
        case "RAISED_CROSSWALK":
        case "HIGHWAY_CROSSWALK":
            maxSpeedMps = Math.min(baseSpeedMps, 7.5);
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

export function buildEdgeSpeedZones(
    seg: Segment,
    isForward: boolean,
    edgeCoords: [number, number][],
    cumLengths: number[],
    totalPolylineLen: number,
    lengthMeters: number,
    baseSpeedMps: number,
    isImperial: boolean,
    curvatures: readonly CurvatureSample[],
    segBBox: [number, number, number, number],
    hazardIndex: HazardSpatialIndex,
    cosLat: number
): { speedZones: SpeedZone[]; bumpDists: number[] } {
    const zones: SpeedZone[] = [];
    const bumpDists: number[] = [];

    // 1. Roundabout ring comfort speed cap
    if (seg.junctionId != null) {
        zones.push({
            startDist: 0,
            endDist: lengthMeters,
            maxSpeedMps: Math.min(baseSpeedMps, 10.5),
            preventSpeeding: true,
        });
    }

    // 2. Precomputed road geometry curvature zones
    for (const c of curvatures) {
        if (c.curveSpeedMps >= baseSpeedMps * 0.95) continue;
        const vDist = isForward
            ? c.fwdVertexDist
            : Math.max(0, totalPolylineLen - c.fwdVertexDist);
        zones.push({
            startDist: Math.max(0, vDist - 10),
            endDist: Math.min(lengthMeters, vDist + 10),
            maxSpeedMps: c.curveSpeedMps,
            preventSpeeding: true,
        });
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

    // 4a. Direct segment-linked Permanent Hazards (O(1) lookup)
    const directHazards = hazardIndex.bySegmentId.get(seg.id);
    if (directHazards) {
        for (const h of directHazards) {
            appendHazardZoneIfMatched(
                zones,
                bumpDists,
                h,
                seg,
                isForward,
                edgeCoords,
                cumLengths,
                lengthMeters,
                baseSpeedMps,
                isImperial,
                cosLat
            );
        }
    }

    // 4b. Unattached & polygon Permanent Hazards filtered by precomputed bounding box
    const [sMinLon, sMinLat, sMaxLon, sMaxLat] = segBBox;
    for (const entry of hazardIndex.spatialEntries) {
        const h = entry.hazard;
        const bboxOverlaps =
            sMaxLon >= entry.minLon &&
            sMinLon <= entry.maxLon &&
            sMaxLat >= entry.minLat &&
            sMinLat <= entry.maxLat;
        if (!bboxOverlaps && h.segmentId !== seg.id) {
            continue;
        }
        appendHazardZoneIfMatched(
            zones,
            bumpDists,
            h,
            seg,
            isForward,
            edgeCoords,
            cumLengths,
            lengthMeters,
            baseSpeedMps,
            isImperial,
            cosLat
        );
    }

    if (bumpDists.length > 1) {
        bumpDists.sort((a, b) => a - b);
    }

    return { speedZones: zones, bumpDists };
}

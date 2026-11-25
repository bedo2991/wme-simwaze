import { SimAudioEngine } from "./audio";
import { distanceMeters, sampleEdgePosition, samplePolylineAt } from "./geo";
import {
    computeTurnDeflectionDeg,
    describeBugKind,
    edgeDistanceMeters,
    edgeEndCoord,
    pickWeightedEdgeId,
} from "./graph";
import { WME_ROAD_TYPE } from "./roadProfiles";
import { findRoute } from "./router";
import {
    ChaosHotspot,
    DirectedEdge,
    Particle,
    RoadGraph,
    SimSettings,
    SimStats,
    WazerAgent,
} from "./types";

const MIN_GAP_METERS = 8.5;
const TIME_HEADWAY_SEC = 0.75;
const STOP_LINE_METERS = 3.0;
const ARRIVAL_RADIUS_METERS = 4.0;
const MAX_PARTICLES = 450;
const HOTSPOT_CLUSTER_RADIUS_M = 38;
const MAX_BURNING_PER_JAM = 18;

const HORN_WORDS = ["BEEP!", "HONK!", "MEEP!", "?!#"] as const;

function isPointNearViewport(
    lon: number,
    lat: number,
    bbox: [number, number, number, number],
    marginDeg = 0.0004
): boolean {
    return (
        lon >= bbox[0] - marginDeg &&
        lon <= bbox[2] + marginDeg &&
        lat >= bbox[1] - marginDeg &&
        lat <= bbox[3] + marginDeg
    );
}

function computeViewportEntryDist(
    edge: DirectedEdge,
    bbox: [number, number, number, number] | null
): number {
    const fallback = Math.min(2, edge.lengthMeters * 0.1);
    if (!bbox || edge.coords.length < 2) return fallback;
    if (isPointNearViewport(edge.coords[0][0], edge.coords[0][1], bbox, 0)) {
        return fallback;
    }
    const step = 20;
    for (let d = step; d < edge.lengthMeters - 30; d += step) {
        const sample = samplePolylineAt(edge.coords, edge.cumLengths, d);
        if (isPointNearViewport(sample.lon, sample.lat, bbox, 0)) {
            return Math.max(2, d - 15);
        }
    }
    return fallback;
}

function computePersonalAutobahnMps(cruiseTrait: number): number {
    const traitNorm = Math.max(0, Math.min(1, (cruiseTrait - 1.04) / 0.14));
    return (130 + traitNorm * 60) / 3.6; // 130..190 km/h
}

export class TrafficSimulator {
    private graph: RoadGraph | null = null;
    private settings: SimSettings;
    private wazers: WazerAgent[] = [];
    private particles: Particle[] = [];
    private hotspots: ChaosHotspot[] = [];
    private edgeOccupancy = new Map<string, number>();
    private nodeCooldowns = new Map<number, number>();

    private nextWazerId = 1;
    private arrivedCount = 0;
    private spawnAccumulator = 0;
    private hotspotTimer = 0;
    private moodCount: number;
    private audio: SimAudioEngine | null;
    private rng: () => number;

    constructor(
        settings: SimSettings,
        options?: {
            audio?: SimAudioEngine | null;
            moodCount?: number;
            rng?: () => number;
        }
    ) {
        this.settings = { ...settings };
        this.audio = options?.audio ?? null;
        this.moodCount = Math.max(1, options?.moodCount ?? 16);
        this.rng = options?.rng ?? Math.random;
    }

    public updateSettings(next: SimSettings): void {
        const wasEnabled = this.settings.enabled;
        this.settings = { ...next };
        if (wasEnabled && !next.enabled) {
            this.reset();
        }
    }

    public getGraph(): RoadGraph | null {
        return this.graph;
    }

    public getWazers(): readonly WazerAgent[] {
        return this.wazers;
    }

    public getParticles(): readonly Particle[] {
        return this.particles;
    }

    public getHotspots(): readonly ChaosHotspot[] {
        return this.hotspots;
    }

    public getEdgeOccupancy(): ReadonlyMap<string, number> {
        return this.edgeOccupancy;
    }

    public getStats(): SimStats {
        let cruisingCount = 0;
        let queuedCount = 0;
        let honkingCount = 0;
        let burningCount = 0;
        for (const w of this.wazers) {
            switch (w.state) {
                case "CRUISING":
                    cruisingCount++;
                    break;
                case "QUEUED":
                    queuedCount++;
                    break;
                case "HONKING":
                    honkingCount++;
                    break;
                case "ON_FIRE":
                    burningCount++;
                    break;
                default:
                    break;
            }
        }
        return {
            activeWazers: this.wazers.length,
            cruisingCount,
            queuedCount,
            honkingCount,
            burningCount,
            arrivedCount: this.arrivedCount,
            hotspotCount: this.hotspots.length,
            edgeCount: this.graph?.edges.size ?? 0,
        };
    }

    public reset(): void {
        this.wazers = [];
        this.particles = [];
        this.hotspots = [];
        this.edgeOccupancy.clear();
        this.nodeCooldowns.clear();
        this.spawnAccumulator = 0;
    }

    public setGraph(newGraph: RoadGraph): void {
        this.graph = newGraph;
        this.edgeOccupancy.clear();
        this.nodeCooldowns.clear();

        const surviving: WazerAgent[] = [];
        for (const w of this.wazers) {
            const edge = newGraph.edges.get(w.edgeId);
            if (!edge || (edge.isClosed && w.state === "CRUISING")) {
                continue;
            }

            w.distOnEdge = Math.min(w.distOnEdge, Math.max(0, edge.lengthMeters - STOP_LINE_METERS));
            w.laneIndex = Math.min(w.laneIndex, edge.lanes - 1);

            let destEdge = newGraph.edges.get(w.destEdgeId);
            if (!destEdge || destEdge.isClosed) {
                const replacementId = pickWeightedEdgeId(
                    newGraph.destEdgeIds,
                    newGraph.destCumulativeWeights,
                    this.rng
                );
                if (!replacementId) continue;
                w.destEdgeId = replacementId;
                destEdge = newGraph.edges.get(replacementId);
                if (!destEdge) continue;
                w.destStreetName = destEdge.streetName;
            }

            const newRoute = findRoute(newGraph, w.edgeId, w.destEdgeId, this.edgeOccupancy);
            if (!newRoute) continue;

            const wasStuckOnBug = w.terminalBug !== null;
            w.routeEdgeIds = newRoute.routeEdgeIds;
            w.routeIndex = 0;
            w.terminalBug = newRoute.terminalBug;

            if (wasStuckOnBug && newRoute.terminalBug === null) {
                // The editor fixed the routing bug! Extinguish fire & let traffic flow
                if (w.state === "ON_FIRE") {
                    const pos = sampleEdgePosition(
                        edge,
                        w.distOnEdge,
                        w.laneIndex,
                        newGraph.isLeftHandTraffic
                    );
                    this.pushParticle({
                        xLon: pos.lon,
                        yLat: pos.lat,
                        vxPx: (this.rng() - 0.5) * 14,
                        vyPx: -18 - this.rng() * 14,
                        age: 0,
                        maxAge: 0.9,
                        size: 9,
                        kind: "SMOKE",
                    });
                }
                w.stuckSeconds = 0;
                w.state = "CRUISING";
                w.hornBubbleTimer = 0;
            }

            surviving.push(w);
            this.edgeOccupancy.set(w.edgeId, (this.edgeOccupancy.get(w.edgeId) ?? 0) + 1);
        }

        this.wazers = surviving;
        this.recomputeHotspots();
    }

    public spawnSpecificWazer(startEdgeId: string, destEdgeId: string): WazerAgent | null {
        if (!this.graph) return null;
        const startEdge = this.graph.edges.get(startEdgeId);
        const destEdge = this.graph.edges.get(destEdgeId);
        if (!startEdge || !destEdge || startEdge.isClosed || !startEdge.isDrivableDirection) return null;

        const occ = this.edgeOccupancy.get(startEdgeId) ?? 0;
        if (occ >= startEdge.maxCapacity) return null;

        const initialDist = computeViewportEntryDist(startEdge, this.graph.viewportBBox);
        const laneIndex = Math.floor(this.rng() * startEdge.lanes);
        for (const existing of this.wazers) {
            if (
                existing.edgeId === startEdgeId &&
                existing.laneIndex === laneIndex &&
                Math.abs(existing.distOnEdge - initialDist) < 12
            ) {
                return null;
            }
        }

        const route = findRoute(this.graph, startEdgeId, destEdgeId, this.edgeOccupancy);
        if (!route || route.routeEdgeIds.length === 0) return null;

        const startPos = sampleEdgePosition(
            startEdge,
            initialDist,
            laneIndex,
            this.graph.isLeftHandTraffic
        );
        const cruiseTrait = 1.04 + this.rng() * 0.14;
        const startSpeedMps = startEdge.hasUnrestrictedSpeed
            ? computePersonalAutobahnMps(cruiseTrait) * 0.85
            : startEdge.speedMps * 0.75;

        const wazer: WazerAgent = {
            id: this.nextWazerId++,
            moodIndex: Math.floor(this.rng() * this.moodCount),
            edgeId: startEdgeId,
            distOnEdge: initialDist,
            laneIndex,
            lateralOffset: 0,
            speedMps: startSpeedMps,
            cruiseTrait,
            openRoadSeconds: 0,
            facingLeft: Math.cos(startPos.bearingScreenRad) < 0,
            routeEdgeIds: route.routeEdgeIds,
            routeIndex: 0,
            destStreetName: destEdge.streetName,
            destEdgeId,
            terminalBug: route.terminalBug,
            stuckSeconds: 0,
            state: "CRUISING",
            honkCooldown: 0.8 + this.rng() * 1.5,
            hornBubbleTimer: 0,
            hornText: "BEEP!",
            rerouteCooldown: 3 + this.rng() * 3,
        };

        this.wazers.push(wazer);
        this.edgeOccupancy.set(startEdgeId, occ + 1);
        return wazer;
    }

    private findCorridorFallbackDestId(startEdge: DirectedEdge): string | null {
        const g = this.graph;
        if (!g) return null;

        const visited = new Set<string>([startEdge.id]);
        const queue: string[] = [startEdge.id];
        const borderExits: string[] = [];
        const otherReachable: string[] = [];

        for (let qi = 0; qi < queue.length && visited.size < 64; qi++) {
            const cur = queue[qi];
            for (const t of g.outgoing.get(cur) ?? []) {
                if (!t.isLegal || visited.has(t.toEdgeId)) continue;
                const next = g.edges.get(t.toEdgeId);
                if (!next || next.isClosed || !next.isDrivableDirection) continue;
                visited.add(next.id);
                queue.push(next.id);
                if (next.isMapBorderExit) {
                    borderExits.push(next.id);
                } else if (next.destWeight > 0) {
                    otherReachable.push(next.id);
                }
            }
        }

        if (borderExits.length > 0) {
            return borderExits[Math.floor(this.rng() * borderExits.length)] ?? null;
        }
        if (otherReachable.length > 0) {
            return otherReachable[Math.floor(this.rng() * otherReachable.length)] ?? null;
        }
        if (startEdge.isMapBorderExit && startEdge.lengthMeters >= 50) {
            return startEdge.id;
        }
        return null;
    }

    public spawnRandomWazer(): WazerAgent | null {
        const g = this.graph;
        if (!g || g.spawnEdgeIds.length === 0 || g.destEdgeIds.length === 0) return null;

        for (let attempt = 0; attempt < 6; attempt++) {
            const startId = pickWeightedEdgeId(g.spawnEdgeIds, g.spawnCumulativeWeights, this.rng);
            if (!startId) continue;
            const startEdge = g.edges.get(startId);
            if (!startEdge) continue;

            const occ = this.edgeOccupancy.get(startId) ?? 0;
            if (occ >= startEdge.maxCapacity) continue;

            for (let dTry = 0; dTry < 6; dTry++) {
                const candidateId = pickWeightedEdgeId(
                    g.destEdgeIds,
                    g.destCumulativeWeights,
                    this.rng
                );
                if (!candidateId || candidateId === startId) continue;
                const cand = g.edges.get(candidateId);
                if (!cand || cand.segmentId === startEdge.segmentId) continue;
                if (dTry < 4 && g.destEdgeIds.length > 6 && edgeDistanceMeters(startEdge, cand) < 80) {
                    continue;
                }
                const spawned = this.spawnSpecificWazer(startId, candidateId);
                if (spawned) return spawned;
            }

            // Grade-separated freeways / corridors without ramps in view still route through to exits
            const fallbackDestId = this.findCorridorFallbackDestId(startEdge);
            if (fallbackDestId) {
                const spawned = this.spawnSpecificWazer(startId, fallbackDestId);
                if (spawned) return spawned;
            }
        }
        return null;
    }

    public step(rawDtSeconds: number): void {
        const g = this.graph;
        if (!g || !this.settings.enabled || this.settings.paused) return;

        const clampedRawDt = Math.min(0.1, Math.max(0.001, rawDtSeconds));
        const dt = clampedRawDt * this.settings.simSpeed;

        // Tick node merge cooldowns
        for (const [nodeId, cd] of this.nodeCooldowns) {
            const nextCd = cd - dt;
            if (nextCd <= 0) {
                this.nodeCooldowns.delete(nodeId);
            } else {
                this.nodeCooldowns.set(nodeId, nextCd);
            }
        }

        // Spawn Wazers from highways up to maxWazers
        if (this.wazers.length < this.settings.maxWazers) {
            const spawnRate = Math.max(2, this.settings.maxWazers * 0.22);
            this.spawnAccumulator += dt * spawnRate;
            let spawnsThisStep = 0;
            while (
                this.spawnAccumulator >= 1 &&
                this.wazers.length < this.settings.maxWazers &&
                spawnsThisStep < 4
            ) {
                this.spawnAccumulator -= 1;
                this.spawnRandomWazer();
                spawnsThisStep++;
            }
        } else {
            this.spawnAccumulator = 0;
        }

        // Group Wazers by directed edge and sort front-to-back
        const byEdge = new Map<string, WazerAgent[]>();
        for (const w of this.wazers) {
            let list = byEdge.get(w.edgeId);
            if (!list) {
                list = [];
                byEdge.set(w.edgeId, list);
            }
            list.push(w);
        }
        for (const list of byEdge.values()) {
            list.sort((a, b) => b.distOnEdge - a.distOnEdge);
        }

        const removedIds = new Set<number>();

        // Advance each edge's Wazers front-to-back
        for (const [edgeId, list] of byEdge) {
            const edge = g.edges.get(edgeId);
            if (!edge) {
                for (const w of list) removedIds.add(w.id);
                continue;
            }

            // Track last leader distance per lane on this edge
            const laneLeader: Array<WazerAgent | null> = new Array(edge.lanes).fill(null);

            for (const w of list) {
                if (w.laneIndex >= edge.lanes) {
                    w.laneIndex = edge.lanes - 1;
                }

                // Multi-lane opportunistic lane switch if current lane is blocked closely ahead
                const currentLeader = laneLeader[w.laneIndex];
                if (edge.lanes > 1 && currentLeader) {
                    const currentGap = currentLeader.distOnEdge - w.distOnEdge;
                    if (currentGap < MIN_GAP_METERS * 2.2) {
                        for (let candLane = 0; candLane < edge.lanes; candLane++) {
                            if (candLane === w.laneIndex) continue;
                            const altLeader = laneLeader[candLane];
                            const altGap = altLeader ? altLeader.distOnEdge - w.distOnEdge : Infinity;
                            // Also ensure no trailing vehicle in altLane is right on top of us
                            const altBehindClear = !list.some(
                                (other) =>
                                    other.id !== w.id &&
                                    other.laneIndex === candLane &&
                                    Math.abs(other.distOnEdge - w.distOnEdge) < MIN_GAP_METERS
                            );
                            if (altBehindClear && altGap > currentGap + 18) {
                                w.lateralOffset += (w.laneIndex - candLane) * 3.2;
                                w.laneIndex = candLane;
                                break;
                            }
                        }
                    }
                }

                // Smoothly decay lateral lane-change animation offset
                if (Math.abs(w.lateralOffset) > 0.02) {
                    w.lateralOffset *= Math.exp(-dt * 8);
                } else {
                    w.lateralOffset = 0;
                }

                const leader = laneLeader[w.laneIndex];
                let leaderCapMps = Infinity;
                let maxPos = edge.lengthMeters + 100;

                if (leader) {
                    const gap = leader.distOnEdge - w.distOnEdge;
                    const safeDist = MIN_GAP_METERS + w.speedMps * TIME_HEADWAY_SEC;
                    if (gap <= MIN_GAP_METERS) {
                        leaderCapMps = 0;
                        maxPos = Math.max(0, leader.distOnEdge - MIN_GAP_METERS);
                    } else if (gap < safeDist * 1.6) {
                        const factor = Math.max(
                            0,
                            (gap - MIN_GAP_METERS) / Math.max(1, safeDist * 1.6 - MIN_GAP_METERS)
                        );
                        const targetFreeMps = edge.hasUnrestrictedSpeed
                            ? computePersonalAutobahnMps(w.cruiseTrait)
                            : edge.speedMps * w.cruiseTrait;
                        leaderCapMps =
                            leader.speedMps + (targetFreeMps - leader.speedMps) * factor;
                    }
                }

                const isLastRouteEdge = w.routeIndex >= w.routeEdgeIds.length - 1;
                const nextEdge =
                    !isLastRouteEdge && w.routeIndex + 1 < w.routeEdgeIds.length
                        ? g.edges.get(w.routeEdgeIds[w.routeIndex + 1])
                        : undefined;

                // Evaluate realistic speed limits: curves, permanent hazards, speed cameras, and upcoming turns
                const speedProfile = this.evaluateRoadSpeedProfile(w, edge, nextEdge);
                const leaderLimitingSpeed =
                    leader != null && leaderCapMps < edge.speedMps * 0.88;

                if (speedProfile.inNoSpeedingZone) {
                    w.openRoadSeconds = 0;
                } else if (speedProfile.infraMaxMps < edge.speedMps * 0.9 || leaderLimitingSpeed) {
                    w.openRoadSeconds = Math.max(0, w.openRoadSeconds - dt * 2.2);
                } else {
                    w.openRoadSeconds = Math.min(10, w.openRoadSeconds + dt);
                }

                let openRoadTarget: number;
                if (edge.hasUnrestrictedSpeed && !speedProfile.inNoSpeedingZone) {
                    const personalAutobahnMps = computePersonalAutobahnMps(w.cruiseTrait);
                    const warmup = Math.min(1, w.openRoadSeconds / 5.0);
                    const baseEntryMps = Math.min(
                        personalAutobahnMps,
                        Math.max(130 / 3.6, personalAutobahnMps * 0.88)
                    );
                    const targetAutobahnMps =
                        baseEntryMps + (personalAutobahnMps - baseEntryMps) * warmup;
                    openRoadTarget = Math.min(targetAutobahnMps, speedProfile.infraMaxMps);
                } else {
                    const paceMultiplier = speedProfile.inNoSpeedingZone
                        ? 0.97
                        : 0.94 + (w.cruiseTrait - 0.94) * Math.min(1, w.openRoadSeconds / 6.0);
                    openRoadTarget = Math.min(
                        edge.speedMps * paceMultiplier,
                        speedProfile.infraMaxMps
                    );
                }
                let desiredSpeed = Math.min(openRoadTarget, leaderCapMps);

                const stopLine = Math.max(0.5, edge.lengthMeters - STOP_LINE_METERS);

                if (isLastRouteEdge) {
                    if (w.terminalBug !== null) {
                        // Stuck at routing bug — cannot cross the end of this edge
                        const distToStop = stopLine - w.distOnEdge;
                        if (distToStop <= 0.6) {
                            desiredSpeed = 0;
                        } else if (distToStop < 25) {
                            desiredSpeed = Math.min(desiredSpeed, edge.speedMps * (distToStop / 25));
                        }
                        maxPos = Math.min(maxPos, stopLine);
                    } else {
                        // Approaching destination street or map border exit!
                        const targetEnd = Math.max(0.5, edge.lengthMeters - ARRIVAL_RADIUS_METERS);
                        let exitedViewport = false;
                        if (edge.isMapBorderExit && g.viewportBBox && w.distOnEdge > 80) {
                            const curPt = samplePolylineAt(edge.coords, edge.cumLengths, w.distOnEdge);
                            const prevPt = samplePolylineAt(
                                edge.coords,
                                edge.cumLengths,
                                Math.max(0, w.distOnEdge - 45)
                            );
                            if (
                                !isPointNearViewport(curPt.lon, curPt.lat, g.viewportBBox, 0.0005) &&
                                isPointNearViewport(prevPt.lon, prevPt.lat, g.viewportBBox, 0.0005)
                            ) {
                                exitedViewport = true;
                            }
                        }
                        if (w.distOnEdge >= targetEnd - 1.5 || exitedViewport) {
                            this.arrivedCount++;
                            if (!edge.isMapBorderExit) {
                                const pos = sampleEdgePosition(
                                    edge,
                                    w.distOnEdge,
                                    w.laneIndex,
                                    g.isLeftHandTraffic
                                );
                                this.pushParticle({
                                    xLon: pos.lon,
                                    yLat: pos.lat,
                                    vxPx: 0,
                                    vyPx: -12,
                                    age: 0,
                                    maxAge: 0.7,
                                    size: 10,
                                    kind: "ARRIVE",
                                });
                            }
                            removedIds.add(w.id);
                            continue;
                        }
                    }
                } else {
                    let canEnterNext = false;
                    let chosenNextLane = 0;

                    if (nextEdge && !nextEdge.isClosed) {
                        const nextOcc = this.edgeOccupancy.get(nextEdge.id) ?? 0;
                        const toNodeObj =
                            edge.toNodeId != null ? g.nodes.get(edge.toNodeId) : undefined;
                        const isMergeJunction = Boolean(
                            toNodeObj && toNodeObj.connectedSegmentIds.length > 2
                        );
                        const nodeBlocked =
                            isMergeJunction &&
                            edge.toNodeId != null &&
                            (this.nodeCooldowns.get(edge.toNodeId) ?? 0) > 0;

                        if (nextOcc < nextEdge.maxCapacity && !nodeBlocked) {
                            const nextList = byEdge.get(nextEdge.id);
                            chosenNextLane = Math.min(w.laneIndex, nextEdge.lanes - 1);
                            const checkLaneClear = (lane: number): boolean => {
                                if (!nextList) return true;
                                return !nextList.some(
                                    (other) =>
                                        other.laneIndex === lane &&
                                        other.distOnEdge < MIN_GAP_METERS
                                );
                            };

                            if (checkLaneClear(chosenNextLane)) {
                                canEnterNext = true;
                            } else {
                                for (let l = 0; l < nextEdge.lanes; l++) {
                                    if (checkLaneClear(l)) {
                                        chosenNextLane = l;
                                        canEnterNext = true;
                                        break;
                                    }
                                }
                            }
                        }
                    }

                    if (!canEnterNext) {
                        const distToStop = stopLine - w.distOnEdge;
                        if (distToStop <= 0.6) {
                            desiredSpeed = 0;
                        } else if (distToStop < 22) {
                            desiredSpeed = Math.min(desiredSpeed, edge.speedMps * (distToStop / 22));
                        }
                        maxPos = Math.min(maxPos, stopLine);
                    } else if (w.distOnEdge + Math.max(w.speedMps, 2) * dt >= edge.lengthMeters) {
                        // Transition to nextEdge
                        const oldOcc = this.edgeOccupancy.get(edge.id) ?? 1;
                        this.edgeOccupancy.set(edge.id, Math.max(0, oldOcc - 1));

                        const turnDeg = computeTurnDeflectionDeg(edge, nextEdge!);
                        if (turnDeg >= 45) {
                            w.openRoadSeconds *= 0.35;
                        }

                        w.routeIndex++;
                        w.edgeId = nextEdge!.id;
                        const overflow = Math.max(
                            0.2,
                            w.distOnEdge + w.speedMps * dt - edge.lengthMeters
                        );
                        w.distOnEdge = Math.min(overflow, Math.max(0.2, nextEdge!.lengthMeters * 0.25));
                        w.laneIndex = chosenNextLane;
                        w.lateralOffset = 0;
                        this.updateFacing(w, nextEdge!, g.isLeftHandTraffic);

                        this.edgeOccupancy.set(
                            nextEdge!.id,
                            (this.edgeOccupancy.get(nextEdge!.id) ?? 0) + 1
                        );
                        let nextList = byEdge.get(nextEdge!.id);
                        if (!nextList) {
                            nextList = [];
                            byEdge.set(nextEdge!.id, nextList);
                        }
                        nextList.push(w);

                        if (edge.toNodeId != null) {
                            const nodeObj = g.nodes.get(edge.toNodeId);
                            if (nodeObj && nodeObj.connectedSegmentIds.length > 2) {
                                this.nodeCooldowns.set(
                                    edge.toNodeId,
                                    1 / Math.max(1.2, nodeObj.lanesCapacity * 0.9)
                                );
                            }
                        }

                        // Skip updating laneLeader on old edge since Wazer left it
                        this.updateChaosState(w, nextEdge!, dt, clampedRawDt);
                        continue;
                    }
                }

                if (desiredSpeed === 0) {
                    w.openRoadSeconds = 0;
                } else if (desiredSpeed < openRoadTarget * 0.85) {
                    w.openRoadSeconds = Math.max(0, w.openRoadSeconds - dt * 3.5);
                }

                // Integrate speed and distance with realistic acceleration and braking
                if (desiredSpeed > w.speedMps) {
                    w.speedMps = Math.min(desiredSpeed, w.speedMps + 4.8 * dt);
                } else {
                    const hardBrake = maxPos - w.distOnEdge < 12;
                    const decelRate = hardBrake ? 22 : 7.5;
                    w.speedMps = Math.max(desiredSpeed, w.speedMps - decelRate * dt);
                }

                const nextDist = Math.min(maxPos, w.distOnEdge + w.speedMps * dt);
                if (nextDist >= maxPos - 0.05 && desiredSpeed === 0) {
                    w.speedMps = 0;
                }
                w.distOnEdge = Math.max(0, nextDist);
                this.updateFacing(w, edge, g.isLeftHandTraffic);

                laneLeader[w.laneIndex] = w;
                this.updateChaosState(w, edge, dt, clampedRawDt);
            }
        }

        // Periodic dynamic rerouting for non-bugged queued Wazers to detour around congestion
        for (const w of this.wazers) {
            if (removedIds.has(w.id)) continue;
            if (w.terminalBug === null && w.stuckSeconds > 4.5) {
                w.rerouteCooldown -= dt;
                if (w.rerouteCooldown <= 0) {
                    w.rerouteCooldown = 4.0 + this.rng() * 3.0;
                    const reroute = findRoute(g, w.edgeId, w.destEdgeId, this.edgeOccupancy);
                    if (reroute && reroute.terminalBug === null && reroute.routeEdgeIds.length > 0) {
                        w.routeEdgeIds = reroute.routeEdgeIds;
                        w.routeIndex = 0;
                    }
                }
            }
        }

        // Remove arrived Wazers and cap excess burnt-out wrecks per jam (>18) so map stays active
        const burningPerEdge = new Map<string, WazerAgent[]>();
        for (const w of this.wazers) {
            if (removedIds.has(w.id)) continue;
            if (w.state === "ON_FIRE") {
                let arr = burningPerEdge.get(w.edgeId);
                if (!arr) {
                    arr = [];
                    burningPerEdge.set(w.edgeId, arr);
                }
                arr.push(w);
            }
        }
        for (const arr of burningPerEdge.values()) {
            if (arr.length > MAX_BURNING_PER_JAM) {
                arr.sort((a, b) => b.stuckSeconds - a.stuckSeconds);
                for (let i = MAX_BURNING_PER_JAM; i < arr.length; i++) {
                    if (arr[i].stuckSeconds > this.settings.patienceSeconds + 35) {
                        removedIds.add(arr[i].id);
                    }
                }
            }
        }

        if (removedIds.size > 0) {
            this.wazers = this.wazers.filter((w) => !removedIds.has(w.id));
            this.rebuildOccupancy();
        }

        // Update particles
        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            p.age += clampedRawDt;
            if (p.age >= p.maxAge) {
                this.particles.splice(i, 1);
            }
        }

        // Recompute hotspots periodically
        this.hotspotTimer += clampedRawDt;
        if (this.hotspotTimer >= 0.35) {
            this.hotspotTimer = 0;
            this.recomputeHotspots();
        }
    }

    private evaluateRoadSpeedProfile(
        w: WazerAgent,
        edge: DirectedEdge,
        nextEdge: DirectedEdge | undefined
    ): { infraMaxMps: number; inNoSpeedingZone: boolean } {
        let infraMaxMps = Infinity;
        let inNoSpeedingZone = false;
        const brakingAccel = 3.8;

        for (const z of edge.speedZones) {
            if (w.distOnEdge > z.endDist) continue;
            if (w.distOnEdge >= z.startDist) {
                infraMaxMps = Math.min(infraMaxMps, z.maxSpeedMps);
                if (z.preventSpeeding) inNoSpeedingZone = true;
            } else {
                const distAhead = z.startDist - w.distOnEdge;
                if (distAhead <= 85) {
                    const approachCap = Math.sqrt(
                        z.maxSpeedMps * z.maxSpeedMps + 2 * brakingAccel * distAhead
                    );
                    infraMaxMps = Math.min(infraMaxMps, approachCap);
                    if (z.preventSpeeding && distAhead <= 25) {
                        inNoSpeedingZone = true;
                    }
                }
            }
        }

        if (nextEdge) {
            const distToNode = Math.max(0, edge.lengthMeters - w.distOnEdge);
            if (distToNode <= 85) {
                const turnDeg = computeTurnDeflectionDeg(edge, nextEdge);
                const isEnteringRoundabout = edge.junctionId == null && nextEdge.junctionId != null;
                const isFreewayContinuation =
                    edge.roadType === WME_ROAD_TYPE.FREEWAY &&
                    nextEdge.roadType === WME_ROAD_TYPE.FREEWAY &&
                    nextEdge.junctionId == null;

                let nodeTargetMps = nextEdge.hasUnrestrictedSpeed ? Infinity : nextEdge.speedMps;
                if (isEnteringRoundabout) {
                    nodeTargetMps = Math.min(nodeTargetMps, 7.5);
                } else if (isFreewayContinuation && turnDeg < 35) {
                    if (turnDeg >= 20) {
                        nodeTargetMps = Math.min(nodeTargetMps, Math.max(32, nextEdge.speedMps * 0.88));
                    }
                } else if (turnDeg >= 115) {
                    nodeTargetMps = Math.min(nodeTargetMps, 4.5);
                } else if (turnDeg >= 60) {
                    nodeTargetMps = Math.min(nodeTargetMps, 6.5);
                } else if (turnDeg >= 30) {
                    nodeTargetMps = Math.min(nodeTargetMps, Math.min(11.5, nextEdge.speedMps * 0.8));
                } else if (turnDeg >= 15) {
                    nodeTargetMps = Math.min(nodeTargetMps, Math.min(16.5, nextEdge.speedMps * 0.9));
                }

                if (Number.isFinite(nodeTargetMps)) {
                    const turnApproachCap = Math.sqrt(
                        nodeTargetMps * nodeTargetMps + 2 * brakingAccel * distToNode
                    );
                    infraMaxMps = Math.min(infraMaxMps, turnApproachCap);
                }
            }

            // Look ahead into hazards/curves right at the beginning of nextEdge
            for (const nz of nextEdge.speedZones) {
                if (nz.startDist > 35) continue;
                const distAhead = distToNode + nz.startDist;
                if (distAhead <= 85) {
                    const cap = Math.sqrt(
                        nz.maxSpeedMps * nz.maxSpeedMps + 2 * brakingAccel * distAhead
                    );
                    infraMaxMps = Math.min(infraMaxMps, cap);
                }
            }
        }

        return { infraMaxMps, inNoSpeedingZone };
    }

    private updateFacing(
        w: WazerAgent,
        edge: DirectedEdge,
        isLeftHandTraffic: boolean
    ): void {
        const pos = sampleEdgePosition(
            edge,
            w.distOnEdge,
            w.laneIndex,
            isLeftHandTraffic,
            w.lateralOffset
        );
        const dirX = Math.cos(pos.bearingScreenRad);
        if (dirX < -0.08) {
            w.facingLeft = true;
        } else if (dirX > 0.08) {
            w.facingLeft = false;
        }
    }

    private updateChaosState(
        w: WazerAgent,
        edge: DirectedEdge,
        dt: number,
        rawDt: number
    ): void {
        if (w.hornBubbleTimer > 0) {
            w.hornBubbleTimer = Math.max(0, w.hornBubbleTimer - rawDt);
        }

        if (w.speedMps < 1.0) {
            w.stuckSeconds += dt;
        } else if (w.speedMps > 2.5) {
            w.stuckSeconds = Math.max(0, w.stuckSeconds - dt * 2.5);
            if (w.stuckSeconds < 1.2) {
                w.state = "CRUISING";
            }
            return;
        }

        const patience = Math.max(3, this.settings.patienceSeconds);
        const honkThreshold = patience * 0.45;

        if (w.stuckSeconds >= patience) {
            if (w.state !== "ON_FIRE") {
                w.state = "ON_FIRE";
                this.audio?.playFireIgnite();
            }
            if (this.rng() < rawDt * 8.5 && this.graph) {
                const pos = sampleEdgePosition(
                    edge,
                    w.distOnEdge,
                    w.laneIndex,
                    this.graph.isLeftHandTraffic,
                    w.lateralOffset
                );
                this.pushParticle({
                    xLon: pos.lon,
                    yLat: pos.lat,
                    vxPx: (this.rng() - 0.5) * 16,
                    vyPx: -18 - this.rng() * 18,
                    age: 0,
                    maxAge: 0.55 + this.rng() * 0.35,
                    size: 5 + this.rng() * 4,
                    kind: this.rng() < 0.6 ? "FIRE" : "SMOKE",
                });
            }
        } else if (w.stuckSeconds >= honkThreshold) {
            w.state = "HONKING";
            w.honkCooldown -= dt;
            if (w.honkCooldown <= 0) {
                w.honkCooldown = 1.6 + this.rng() * 2.4;
                w.hornBubbleTimer = 0.85;
                w.hornText = HORN_WORDS[Math.floor(this.rng() * HORN_WORDS.length)];
                this.audio?.playHorn(w.moodIndex, edge.roadType);

                if (this.graph) {
                    const pos = sampleEdgePosition(
                        edge,
                        w.distOnEdge,
                        w.laneIndex,
                        this.graph.isLeftHandTraffic,
                        w.lateralOffset
                    );
                    this.pushParticle({
                        xLon: pos.lon,
                        yLat: pos.lat,
                        vxPx: 0,
                        vyPx: 0,
                        age: 0,
                        maxAge: 0.6,
                        size: 16,
                        kind: "RING",
                    });
                }
            }
        } else if (w.stuckSeconds >= 1.8) {
            w.state = "QUEUED";
        } else {
            w.state = "CRUISING";
        }
    }

    private pushParticle(p: Particle): void {
        if (this.particles.length >= MAX_PARTICLES) {
            this.particles.shift();
        }
        this.particles.push(p);
    }

    private rebuildOccupancy(): void {
        this.edgeOccupancy.clear();
        for (const w of this.wazers) {
            this.edgeOccupancy.set(w.edgeId, (this.edgeOccupancy.get(w.edgeId) ?? 0) + 1);
        }
    }

    public recomputeHotspots(): void {
        const g = this.graph;
        if (!g) {
            this.hotspots = [];
            return;
        }

        const stuckItems: Array<{
            w: WazerAgent;
            edge: DirectedEdge;
            lon: number;
            lat: number;
        }> = [];

        for (const w of this.wazers) {
            if (w.state === "CRUISING" || w.state === "ARRIVED") continue;
            const edge = g.edges.get(w.edgeId);
            if (!edge) continue;
            const pos = sampleEdgePosition(
                edge,
                w.distOnEdge,
                w.laneIndex,
                g.isLeftHandTraffic,
                w.lateralOffset
            );
            stuckItems.push({ w, edge, lon: pos.lon, lat: pos.lat });
        }

        // Prioritize root bug-blocked leaders first so clusters anchor on the actual bug point
        stuckItems.sort((a, b) => {
            const aBug = a.w.terminalBug ? 1 : 0;
            const bBug = b.w.terminalBug ? 1 : 0;
            if (aBug !== bBug) return bBug - aBug;
            return b.w.stuckSeconds - a.w.stuckSeconds;
        });

        const clusters: ChaosHotspot[] = [];

        for (const item of stuckItems) {
            const anchorLon = item.w.terminalBug?.lon ?? item.lon;
            const anchorLat = item.w.terminalBug?.lat ?? item.lat;

            let matched: ChaosHotspot | null = null;
            for (const c of clusters) {
                if (
                    distanceMeters(anchorLon, anchorLat, c.lon, c.lat) <= HOTSPOT_CLUSTER_RADIUS_M ||
                    distanceMeters(item.lon, item.lat, c.lon, c.lat) <= HOTSPOT_CLUSTER_RADIUS_M
                ) {
                    matched = c;
                    break;
                }
            }

            if (!matched) {
                const bug = item.w.terminalBug;
                const kind = bug ? bug.kind : "CAPACITY_BOTTLENECK";
                const segmentId = bug ? bug.segmentId : item.edge.segmentId;
                const nodeId = bug ? bug.nodeId : item.edge.toNodeId;
                const [endLon, endLat] = edgeEndCoord(item.edge);
                const lon = bug ? bug.lon : endLon;
                const lat = bug ? bug.lat : endLat;
                const description = bug
                    ? bug.message
                    : `${describeBugKind(kind)} on ${item.edge.streetName}`;

                matched = {
                    id: `${kind}:${segmentId}:${nodeId ?? "x"}`,
                    kind,
                    segmentId,
                    nodeId,
                    lon,
                    lat,
                    stuckCount: 0,
                    honkingCount: 0,
                    burningCount: 0,
                    description,
                };
                clusters.push(matched);
            }

            matched.stuckCount++;
            if (item.w.state === "HONKING") matched.honkingCount++;
            if (item.w.state === "ON_FIRE") matched.burningCount++;
        }

        clusters.sort((a, b) => {
            const scoreA = a.burningCount * 10 + a.honkingCount * 3 + a.stuckCount;
            const scoreB = b.burningCount * 10 + b.honkingCount * 3 + b.stuckCount;
            return scoreB - scoreA;
        });

        this.hotspots = clusters.slice(0, 20);
    }
}

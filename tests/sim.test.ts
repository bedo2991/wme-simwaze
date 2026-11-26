import type {
    PermanentHazard,
    RoadClosure,
    Segment,
    Street,
    Turn,
    TurnClosure,
    Node as WmeNode,
} from "wme-sdk-typings";
import { buildRoadGraphFromRawData, RawGraphInput } from "../src/graph";
import { WME_ROAD_TYPE as ROAD_TYPE } from "../src/roadProfiles";
import { findRoute, hasEnabledOutgoingTurn } from "../src/router";
import { TrafficSimulator } from "../src/simulator";
import { DEFAULT_SIM_SETTINGS, MIN_SIM_ZOOM } from "../src/types";

function assertOk(cond: unknown, msg: string): asserts cond {
    if (!cond) {
        throw new Error(`Assertion failed: ${msg}`);
    }
}

function assertEqual<T>(actual: T, expected: T, msg: string): void {
    if (actual !== expected) {
        throw new Error(`Assertion failed (${msg}): expected ${String(expected)}, got ${String(actual)}`);
    }
}

function assertDeepEqual(actual: unknown, expected: unknown, msg: string): void {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) {
        throw new Error(`Assertion failed (${msg}): expected ${e}, got ${a}`);
    }
}

function makeSegment(
    id: number,
    coords: [number, number][],
    opts: Partial<Segment> = {}
): Segment {
    return {
        allowNoDirection: false,
        alternateStreetIds: [],
        areFwdTurnsVerified: true,
        areRevTurnsVerified: true,
        elevationLevel: 0,
        flagAttributes: {
            beacons: false,
            fwdLanesEnabled: false,
            fwdSpeedCamera: false,
            headlights: false,
            nearbyHOV: false,
            revLanesEnabled: false,
            revSpeedCamera: false,
            tunnel: false,
            unpaved: false,
        },
        fromLanesInfo: null,
        fromNodeId: id * 10,
        fromNodeLanesCount: 0,
        fwdSpeedLimit: null,
        geometry: { type: "LineString", coordinates: coords },
        hasClosures: false,
        hasHouseNumbers: false,
        hasRestrictions: false,
        hasSeparator: false,
        id,
        isAtoB: false,
        isBtoA: false,
        isDrivable: true,
        isFwdSpeedLimitVerified: true,
        isRevSpeedLimitVerified: true,
        isTwoWay: true,
        junctionId: null,
        length: 120,
        lockRank: 0,
        modificationData: {
            createdBy: null,
            createdOn: null,
            updatedBy: null,
            updatedOn: null,
        },
        primaryStreetId: id,
        rank: 0,
        restrictions: [],
        revSpeedLimit: null,
        roadType: ROAD_TYPE.STREET,
        routingRoadType: null,
        toLanesInfo: null,
        toNodeId: id * 10 + 1,
        toNodeLanesCount: 0,
        ...opts,
    };
}

function makeNode(id: number, lon: number, lat: number, connectedSegmentIds: number[]): WmeNode {
    return {
        id,
        geometry: { type: "Point", coordinates: [lon, lat] },
        connectedSegmentIds,
    };
}

function makeStreet(id: number, name: string): Street {
    return {
        id,
        name,
        cityId: 1,
        direction: null,
        englishName: name,
        isEmpty: false,
        signText: null,
        signType: null,
        modificationData: {
            createdBy: null,
            createdOn: null,
            updatedBy: null,
            updatedOn: null,
        },
    };
}

function makeTurn(
    fromSegmentId: number,
    fromSegmentFwd: boolean,
    toSegmentId: number,
    toSegmentFwd: boolean,
    isAllowed: boolean
): Turn {
    return {
        id: `${fromSegmentId}:${fromSegmentFwd}-${toSegmentId}:${toSegmentFwd}`,
        fromSegmentId,
        fromSegmentFwd,
        toSegmentId,
        toSegmentFwd,
        isAllowed,
        isJunctionBoxTurn: false,
        isPathTurn: false,
        isUTurn: false,
        hasCustomTTS: false,
        hasShieldsPopulated: false,
        hasTowardsGuidance: false,
        hasTurnGuidance: false,
        hasVisualInstruction: false,
        instructionOpCode: null,
        lanes: null,
        restrictions: [],
        segmentPath: [],
        turnGuidance: null,
    };
}

function baseRaw(overrides: Partial<RawGraphInput> = {}): RawGraphInput {
    return {
        segments: [],
        nodes: [],
        turns: [],
        roadClosures: [],
        turnClosures: [],
        streets: [],
        isLeftHandTraffic: false,
        isImperial: false,
        ...overrides,
    };
}

// 1. Road capacities & highway spawning
{
    const raw = baseRaw({
        segments: [
            makeSegment(1, [[12.0, 45.0], [12.002, 45.0]], {
                roadType: ROAD_TYPE.FREEWAY,
                fromNodeId: 100,
                toNodeId: 101,
                isTwoWay: false,
                isAtoB: true,
                length: 200,
            }),
            makeSegment(2, [[12.002, 45.0], [12.003, 45.0]], {
                roadType: ROAD_TYPE.STREET,
                fromNodeId: 101,
                toNodeId: 102,
                length: 100,
            }),
            makeSegment(3, [[12.003, 45.0], [12.004, 45.0]], {
                roadType: ROAD_TYPE.ALLEY,
                fromNodeId: 102,
                toNodeId: 103,
                length: 80,
            }),
        ],
        nodes: [
            makeNode(100, 12.0, 45.0, [1]),
            makeNode(101, 12.002, 45.0, [1, 2]),
            makeNode(102, 12.003, 45.0, [2, 3]),
            makeNode(103, 12.004, 45.0, [3]),
        ],
        streets: [makeStreet(1, "A4 Freeway"), makeStreet(2, "Main St"), makeStreet(3, "Back Alley")],
    });

    const graph = buildRoadGraphFromRawData(raw);
    const fwy = graph.edges.get("1:F")!;
    const st = graph.edges.get("2:F")!;
    const alley = graph.edges.get("3:F")!;

    assertOk(fwy, "Freeway forward edge exists");
    assertEqual(graph.edges.get("1:R"), undefined, "One-way freeway has no reverse edge");
    assertOk(fwy.lanes > st.lanes, "Freeway has more lanes than Street");
    assertOk(fwy.maxCapacity > st.maxCapacity, "Freeway supports more Wazers than Street");
    assertOk(fwy.spawnWeight > st.spawnWeight, "Freeway has higher spawnWeight than Street");
    assertOk(st.spawnWeight > graph.edges.get("3:R")!.spawnWeight, "Street has higher spawnWeight than Alley");
    assertEqual(alley.spawnWeight, 0, "Dead-end alley tip does not spawn into cul-de-sac wall");
    assertOk(alley.destWeight > fwy.destWeight, "Alley has higher destination weight than Freeway");
    assertOk(graph.spawnEdgeIds.includes("1:F"), "Freeway included in spawnEdgeIds");
    assertOk(
        graph.spawnEdgeIds.includes("2:F") &&
            graph.spawnEdgeIds.includes("2:R") &&
            graph.spawnEdgeIds.includes("3:R"),
        "Connected local streets and outward alley included in spawnEdgeIds alongside highways"
    );
    console.log("PASS: Test 1 — Road capacities & weighted all-road spawning");
}

// 2. Speed limits & imperial conversion
{
    const raw = baseRaw({
        isImperial: true,
        segments: [
            makeSegment(1, [[12.0, 45.0], [12.001, 45.0]], {
                roadType: ROAD_TYPE.MAJOR_HIGHWAY,
                fromNodeId: 1,
                toNodeId: 2,
                fwdSpeedLimit: 60, // 60 mph ~ 96.5 km/h
            }),
            // Fast upper branch: 2 -> 3 -> 5 (50 mph)
            makeSegment(2, [[12.001, 45.0], [12.002, 45.001]], {
                roadType: ROAD_TYPE.PRIMARY_STREET,
                fromNodeId: 2,
                toNodeId: 3,
                fwdSpeedLimit: 50,
            }),
            makeSegment(3, [[12.002, 45.001], [12.003, 45.0]], {
                roadType: ROAD_TYPE.PRIMARY_STREET,
                fromNodeId: 3,
                toNodeId: 5,
                fwdSpeedLimit: 50,
            }),
            // Slow lower branch: 2 -> 4 -> 5 (15 mph)
            makeSegment(4, [[12.001, 45.0], [12.002, 44.999]], {
                roadType: ROAD_TYPE.PRIMARY_STREET,
                fromNodeId: 2,
                toNodeId: 4,
                fwdSpeedLimit: 15,
            }),
            makeSegment(5, [[12.002, 44.999], [12.003, 45.0]], {
                roadType: ROAD_TYPE.PRIMARY_STREET,
                fromNodeId: 4,
                toNodeId: 5,
                fwdSpeedLimit: 15,
            }),
            makeSegment(6, [[12.003, 45.0], [12.004, 45.0]], {
                roadType: ROAD_TYPE.STREET,
                fromNodeId: 5,
                toNodeId: 6,
            }),
        ],
        nodes: [
            makeNode(1, 12.0, 45.0, [1]),
            makeNode(2, 12.001, 45.0, [1, 2, 4]),
            makeNode(3, 12.002, 45.001, [2, 3]),
            makeNode(4, 12.002, 44.999, [4, 5]),
            makeNode(5, 12.003, 45.0, [3, 5, 6]),
            makeNode(6, 12.004, 45.0, [6]),
        ],
        streets: [makeStreet(1, "Hwy 1"), makeStreet(6, "Oak St")],
    });

    const graph = buildRoadGraphFromRawData(raw);
    const hwy = graph.edges.get("1:F")!;
    assertOk(hwy.speedKmh > 95 && hwy.speedKmh < 98, "60 mph converted to ~96.5 km/h");

    const route = findRoute(graph, "1:F", "6:F", new Map());
    assertOk(route, "Route found");
    assertEqual(route.terminalBug, null, "No terminal bug on speed route");
    assertDeepEqual(route.routeEdgeIds, ["1:F", "2:F", "3:F", "6:F"], "Router picks faster 50 mph branch");
    console.log("PASS: Test 2 — Speed limits & imperial conversion");
}

// 3. Road closures avoidance (directional)
{
    const closure: RoadClosure = {
        id: "closure-1",
        segmentId: 2,
        isForward: true,
        isPermanent: true,
        status: "ACTIVE",
        description: "Water main repair",
        startDate: null,
        endDate: null,
        trafficEventId: null,
        attributions: [],
        modificationData: { createdBy: null, createdOn: null, updatedBy: null, updatedOn: null },
    };

    const raw = baseRaw({
        segments: [
            makeSegment(1, [[12.0, 45.0], [12.001, 45.0]], {
                roadType: ROAD_TYPE.MAJOR_HIGHWAY,
                fromNodeId: 1,
                toNodeId: 2,
            }),
            makeSegment(2, [[12.001, 45.0], [12.002, 45.001]], {
                roadType: ROAD_TYPE.PRIMARY_STREET,
                fromNodeId: 2,
                toNodeId: 3,
                fwdSpeedLimit: 80,
                hasClosures: true,
            }),
            makeSegment(3, [[12.002, 45.001], [12.003, 45.0]], {
                roadType: ROAD_TYPE.PRIMARY_STREET,
                fromNodeId: 3,
                toNodeId: 5,
                fwdSpeedLimit: 80,
            }),
            makeSegment(4, [[12.001, 45.0], [12.002, 44.999]], {
                roadType: ROAD_TYPE.STREET,
                fromNodeId: 2,
                toNodeId: 4,
                fwdSpeedLimit: 40,
            }),
            makeSegment(5, [[12.002, 44.999], [12.003, 45.0]], {
                roadType: ROAD_TYPE.STREET,
                fromNodeId: 4,
                toNodeId: 5,
                fwdSpeedLimit: 40,
            }),
            makeSegment(6, [[12.003, 45.0], [12.004, 45.0]], {
                roadType: ROAD_TYPE.STREET,
                fromNodeId: 5,
                toNodeId: 6,
            }),
        ],
        nodes: [
            makeNode(1, 12.0, 45.0, [1]),
            makeNode(2, 12.001, 45.0, [1, 2, 4]),
            makeNode(3, 12.002, 45.001, [2, 3]),
            makeNode(4, 12.002, 44.999, [4, 5]),
            makeNode(5, 12.003, 45.0, [3, 5, 6]),
            makeNode(6, 12.004, 45.0, [6]),
        ],
        roadClosures: [closure],
        streets: [makeStreet(2, "Closed Ave"), makeStreet(4, "Detour Rd"), makeStreet(6, "Goal St")],
    });

    const graph = buildRoadGraphFromRawData(raw);
    assertEqual(graph.edges.get("2:F")!.isClosed, true, "Forward direction of seg 2 is closed");
    assertEqual(graph.edges.get("2:R")!.isClosed, false, "Reverse direction of seg 2 remains open");

    const route = findRoute(graph, "1:F", "6:F", new Map());
    assertOk(route, "Detour route found");
    assertEqual(route.terminalBug, null, "No terminal bug when detour exists");
    assertDeepEqual(route.routeEdgeIds, ["1:F", "4:F", "5:F", "6:F"], "Router detours around active closure");
    console.log("PASS: Test 3 — Road closures avoidance");
}

// 4. Impossible turn restriction -> pileup, honk, fire, and live fix recovery
{
    const buildTurnTestGraph = (allowed: boolean) =>
        buildRoadGraphFromRawData(
            baseRaw({
                segments: [
                    makeSegment(1, [[12.0, 45.0], [12.001, 45.0]], {
                        roadType: ROAD_TYPE.MAJOR_HIGHWAY,
                        fromNodeId: 10,
                        toNodeId: 100,
                        length: 80,
                    }),
                    makeSegment(2, [[12.001, 45.0], [12.002, 45.0]], {
                        roadType: ROAD_TYPE.STREET,
                        fromNodeId: 100,
                        toNodeId: 101,
                        length: 80,
                    }),
                ],
                nodes: [
                    makeNode(10, 12.0, 45.0, [1]),
                    makeNode(100, 12.001, 45.0, [1, 2]),
                    makeNode(101, 12.002, 45.0, [2]),
                ],
                turns: [makeTurn(1, true, 2, true, allowed)],
                streets: [makeStreet(1, "Highway 9"), makeStreet(2, "Blocked St")],
            })
        );

    const brokenGraph = buildTurnTestGraph(false);
    const route = findRoute(brokenGraph, "1:F", "2:F", new Map());
    assertOk(route, "Diagnostic route returned");
    assertOk(route.terminalBug, "Terminal bug detected for disallowed turn");
    assertEqual(route.terminalBug.kind, "DISALLOWED_TURN", "Bug kind is DISALLOWED_TURN");
    assertDeepEqual(route.routeEdgeIds, ["1:F"], "Wazer stops before illegal turn");

    const sim = new TrafficSimulator(
        { ...DEFAULT_SIM_SETTINGS, simSpeed: 1, patienceSeconds: 6 },
        { rng: () => 0.1 }
    );
    sim.setGraph(brokenGraph);
    const w = sim.spawnSpecificWazer("1:F", "2:F");
    assertOk(w, "Wazer spawned");

    let sawHonking = false;
    let sawFire = false;
    for (let i = 0; i < 160; i++) {
        sim.step(0.1);
        const cur = sim.getWazers()[0];
        assertOk(cur, "Wazer remains trapped on edge 1:F");
        assertEqual(cur.edgeId, "1:F", "Wazer never violates turn restriction");
        if (cur.state === "HONKING") sawHonking = true;
        if (cur.state === "ON_FIRE") sawFire = true;
    }

    assertOk(sawHonking, "Wazer honked while trapped at disallowed turn");
    assertOk(sawFire, "Wazer caught fire after exceeding patience");

    const hotspots = sim.getHotspots();
    assertOk(hotspots.length >= 1, "Hotspot emitted");
    assertEqual(hotspots[0].kind, "DISALLOWED_TURN", "Hotspot kind is DISALLOWED_TURN");
    assertOk(hotspots[0].burningCount >= 1, "Hotspot has burning Wazer");

    // Now the editor enables the turn!
    const fixedGraph = buildTurnTestGraph(true);
    sim.setGraph(fixedGraph);
    assertEqual(sim.getWazers()[0].state, "CRUISING", "Fire extinguished immediately when fixed");
    assertEqual(sim.getWazers()[0].terminalBug, null, "Terminal bug cleared on fix");

    for (let i = 0; i < 120; i++) {
        sim.step(0.1);
    }
    assertOk(sim.getStats().arrivedCount >= 1, "Wazer drove through fixed turn and arrived");
    console.log("PASS: Test 4 — Impossible turn restriction chaos & live fix recovery");
}

// 5. Disconnected node ("phantom gap") chaos & connection recovery
{
    const buildGapGraph = (connected: boolean) =>
        buildRoadGraphFromRawData(
            baseRaw({
                segments: [
                    makeSegment(10, [[12.0, 45.0], [12.001, 45.0]], {
                        roadType: ROAD_TYPE.MAJOR_HIGHWAY,
                        fromNodeId: 200,
                        toNodeId: 201,
                        length: 80,
                    }),
                    makeSegment(
                        20,
                        connected
                            ? [
                                  [12.001, 45.0],
                                  [12.002, 45.0],
                              ]
                            : [
                                  [12.00107, 45.0], // ~5.5m gap
                                  [12.002, 45.0],
                              ],
                        {
                            roadType: ROAD_TYPE.STREET,
                            fromNodeId: connected ? 201 : null,
                            toNodeId: 202,
                            length: 80,
                        }
                    ),
                ],
                nodes: [
                    makeNode(200, 12.0, 45.0, [10]),
                    makeNode(201, 12.001, 45.0, connected ? [10, 20] : [10]),
                    makeNode(202, 12.002, 45.0, [20]),
                ],
                turns: connected ? [makeTurn(10, true, 20, true, true)] : [],
                streets: [makeStreet(10, "Expressway"), makeStreet(20, "Orphan St")],
            })
        );

    const gapGraph = buildGapGraph(false);
    const gapRoute = findRoute(gapGraph, "10:F", "20:F", new Map());
    assertOk(gapRoute, "Diagnostic gap route returned");
    assertOk(gapRoute.terminalBug, "Terminal bug detected for phantom gap");
    assertEqual(gapRoute.terminalBug.kind, "DISCONNECTED_NODE", "Phantom gap detected as DISCONNECTED_NODE");
    assertDeepEqual(gapRoute.routeEdgeIds, ["10:F"], "Stops before phantom gap");

    const sim = new TrafficSimulator(
        { ...DEFAULT_SIM_SETTINGS, simSpeed: 1, patienceSeconds: 5, maxWazers: 6 },
        { rng: () => 0.1 }
    );
    sim.setGraph(gapGraph);
    sim.spawnSpecificWazer("10:F", "20:F");
    sim.spawnSpecificWazer("10:F", "20:F");

    for (let i = 0; i < 140; i++) {
        sim.step(0.1);
    }

    const hotspots = sim.getHotspots();
    assertOk(hotspots.length >= 1, "Disconnected hotspot created");
    assertEqual(hotspots[0].kind, "DISCONNECTED_NODE", "Hotspot kind is DISCONNECTED_NODE");
    assertOk(hotspots[0].burningCount >= 1, "Multiple Wazers burning at disconnected node");

    // Editor connects the node
    sim.setGraph(buildGapGraph(true));
    for (let i = 0; i < 120; i++) {
        sim.step(0.1);
    }
    assertOk(sim.getStats().arrivedCount >= 1, "Connected node clears jam and lets Wazers arrive");
    console.log("PASS: Test 5 — Disconnected node phantom gap chaos & recovery");
}

// 6. Roundabout entrance/exit flare branches & continuing roads are NOT dead ends
{
    const buildRoundaboutScenario = (allowPathTurn: boolean) =>
        buildRoadGraphFromRawData(
            baseRaw({
                viewportBBox: [11.999, 44.9985, 12.006, 45.0025],
                segments: [
                    // Approach road -> split node 100
                    makeSegment(1, [[11.999, 45.0], [12.001, 45.0]], {
                        roadType: ROAD_TYPE.MAJOR_HIGHWAY,
                        fromNodeId: 10,
                        toNodeId: 100,
                        length: 140,
                    }),
                    // Entrance branch (one-way 100 -> 101 into roundabout)
                    makeSegment(2, [[12.001, 45.0], [12.0014, 44.9998]], {
                        roadType: ROAD_TYPE.PRIMARY_STREET,
                        fromNodeId: 100,
                        toNodeId: 101,
                        isTwoWay: false,
                        isAtoB: true,
                        length: 35,
                    }),
                    // Roundabout ring seg 1 (101 -> 102)
                    makeSegment(3, [[12.0014, 44.9998], [12.0018, 45.0002]], {
                        roadType: ROAD_TYPE.PRIMARY_STREET,
                        fromNodeId: 101,
                        toNodeId: 102,
                        junctionId: 500,
                        isTwoWay: false,
                        isAtoB: true,
                        length: 35,
                    }),
                    // Roundabout ring seg 2 (102 -> 101)
                    makeSegment(4, [[12.0018, 45.0002], [12.0014, 44.9998]], {
                        roadType: ROAD_TYPE.PRIMARY_STREET,
                        fromNodeId: 102,
                        toNodeId: 101,
                        junctionId: 500,
                        isTwoWay: false,
                        isAtoB: true,
                        length: 35,
                    }),
                    // Exit branch (one-way 102 -> 103 to continuing road)
                    makeSegment(5, [[12.0018, 45.0002], [12.0024, 45.0]], {
                        roadType: ROAD_TYPE.PRIMARY_STREET,
                        fromNodeId: 102,
                        toNodeId: 103,
                        isTwoWay: false,
                        isAtoB: true,
                        length: 45,
                    }),
                    // Continuing road after exit branch (103 -> 104)
                    makeSegment(6, [[12.0024, 45.0], [12.004, 45.0]], {
                        roadType: ROAD_TYPE.STREET,
                        fromNodeId: 103,
                        toNodeId: 104,
                        length: 120,
                    }),
                    // Flare hairpin branch back toward roundabout (103 -> 101) with disallowed acute V-turn
                    makeSegment(7, [[12.0024, 45.0], [12.0014, 44.9998]], {
                        roadType: ROAD_TYPE.PRIMARY_STREET,
                        fromNodeId: 103,
                        toNodeId: 101,
                        isTwoWay: false,
                        isAtoB: true,
                        length: 65,
                    }),
                    // Separate viewport-clipped corridor across the map
                    makeSegment(50, [[11.999, 45.002], [12.006, 45.002]], {
                        roadType: ROAD_TYPE.FREEWAY,
                        fromNodeId: 5000,
                        toNodeId: 5001,
                        isTwoWay: false,
                        isAtoB: true,
                        length: 400,
                    }),
                ],
                nodes: [
                    makeNode(10, 11.999, 45.0, [1]),
                    makeNode(100, 12.001, 45.0, [1, 2]),
                    makeNode(101, 12.0014, 44.9998, [2, 3, 4, 7]),
                    makeNode(102, 12.0018, 45.0002, [3, 4, 5]),
                    makeNode(103, 12.0024, 45.0, [5, 6, 7]),
                    makeNode(104, 12.004, 45.0, [6]),
                    makeNode(5000, 11.999, 45.002, [50]),
                    makeNode(5001, 12.006, 45.002, [50]),
                ],
                turns: [
                    makeTurn(1, true, 2, true, true),
                    makeTurn(5, true, 6, true, true),
                    makeTurn(5, true, 7, true, false), // Disallowed flare hairpin V-turn
                    {
                        ...makeTurn(2, true, 5, true, allowPathTurn),
                        isPathTurn: true,
                        segmentPath: [3],
                    },
                    {
                        ...makeTurn(7, true, 5, true, allowPathTurn),
                        isPathTurn: true,
                        segmentPath: [3],
                    },
                ],
                // Simulate single-node isTurnAllowed returning false at roundabout nodes
                fallbackTurnAllowed: new Map([
                    ["2:1->3:1", false],
                    ["3:1->5:1", false],
                ]),
                streets: [
                    makeStreet(1, "West Ave"),
                    makeStreet(6, "East Blvd"),
                    makeStreet(50, "Outer Freeway"),
                ],
            })
        );

    const healthyGraph = buildRoundaboutScenario(true);
    assertEqual(hasEnabledOutgoingTurn(healthyGraph, "2:F"), true, "Entrance branch has enabled outgoing turn");
    assertEqual(hasEnabledOutgoingTurn(healthyGraph, "3:F"), true, "Roundabout ring has enabled outgoing turn");
    assertEqual(hasEnabledOutgoingTurn(healthyGraph, "5:F"), true, "Exit branch has enabled outgoing turn");

    const throughRoute = findRoute(healthyGraph, "1:F", "6:F", new Map());
    assertOk(throughRoute, "Route through roundabout found");
    assertEqual(throughRoute.terminalBug, null, "No false bug on roundabout entrance/exit");
    assertDeepEqual(
        throughRoute.routeEdgeIds,
        ["1:F", "2:F", "3:F", "5:F", "6:F"],
        "Wazer routes cleanly through roundabout entrance -> ring -> exit -> continuing road"
    );

    // Routing toward an independent viewport-clipped corridor must NOT fabricate a false DEAD_END on the roundabout
    const crossCorridorRoute = findRoute(healthyGraph, "1:F", "50:F", new Map());
    assertEqual(
        crossCorridorRoute,
        null,
        "Unreachable independent viewport corridor does not trigger false dead-end chaos"
    );

    const sim = new TrafficSimulator(
        { ...DEFAULT_SIM_SETTINGS, simSpeed: 1, patienceSeconds: 5, maxWazers: 1 },
        { rng: () => 0.1 }
    );
    sim.setGraph(healthyGraph);
    sim.spawnSpecificWazer("1:F", "6:F");
    for (let i = 0; i < 480; i++) {
        sim.step(0.1);
    }
    assertEqual(sim.getStats().arrivedCount, 1, "Wazer navigated roundabout and arrived");
    assertEqual(sim.getHotspots().length, 0, "Zero false chaos hotspots on healthy roundabout");
    console.log("PASS: Test 6 — Roundabout branches & continuing roads have no false dead ends");
}

// 7. True Dead End (zero enabled turns out of a segment, head-on one-way trap) triggers chaos
{
    const raw = baseRaw({
        segments: [
            makeSegment(1, [[12.0, 45.0], [12.001, 45.0]], {
                roadType: ROAD_TYPE.MAJOR_HIGHWAY,
                fromNodeId: 10,
                toNodeId: 100,
                isTwoWay: false,
                isAtoB: true,
                length: 80,
            }),
            // Opposing one-way pointing INTO node 100 (101 -> 100) so there is zero exit at node 100
            makeSegment(2, [[12.002, 45.0], [12.001, 45.0]], {
                roadType: ROAD_TYPE.STREET,
                fromNodeId: 101,
                toNodeId: 100,
                isTwoWay: false,
                isAtoB: true,
                length: 80,
            }),
        ],
        nodes: [
            makeNode(10, 12.0, 45.0, [1]),
            makeNode(100, 12.001, 45.0, [1, 2]),
            makeNode(101, 12.002, 45.0, [2]),
        ],
        streets: [makeStreet(1, "OneWay In"), makeStreet(2, "HeadOn St")],
    });

    const deadEndGraph = buildRoadGraphFromRawData(raw);
    assertEqual(
        hasEnabledOutgoingTurn(deadEndGraph, "1:F"),
        false,
        "True dead-end segment has zero enabled outgoing turns"
    );

    const route = findRoute(deadEndGraph, "1:F", "2:F", new Map());
    assertOk(route, "Diagnostic dead-end route returned");
    assertOk(route.terminalBug, "True dead end reports terminal bug");
    assertEqual(route.terminalBug.kind, "DEAD_END", "Bug kind is DEAD_END");

    const sim = new TrafficSimulator(
        { ...DEFAULT_SIM_SETTINGS, simSpeed: 1, patienceSeconds: 5 },
        { rng: () => 0.1 }
    );
    sim.setGraph(deadEndGraph);
    sim.spawnSpecificWazer("1:F", "2:F");
    for (let i = 0; i < 120; i++) {
        sim.step(0.1);
    }
    assertEqual(sim.getHotspots()[0]?.kind, "DEAD_END", "Chaos hotspot confirms true DEAD_END");
    assertOk(sim.getHotspots()[0]?.burningCount >= 1, "Wazer catches fire at true dead end");
    console.log("PASS: Test 7 — True dead end (zero enabled turns out) triggers chaos");
}

// 8. Realistic speed: slower on curves/turns/hazards, slight speeding on open straightaways
{
    const bumpHazard: PermanentHazard = {
        id: 700,
        type: "SPEED_BUMP",
        subTypes: [],
        segmentId: 1,
        direction: "BOTH",
        geometry: { type: "Point", coordinates: [12.004, 45.0] },
        lockRank: 0,
        rank: 1,
        modificationData: { createdBy: null, createdOn: null, updatedBy: null, updatedOn: null },
    };

    const raw = baseRaw({
        segments: [
            // Long straight ~630m Eastbound road (50 km/h = 13.89 m/s) with a speed bump at ~315m
            makeSegment(1, [[12.0, 45.0], [12.008, 45.0]], {
                roadType: ROAD_TYPE.PRIMARY_STREET,
                fromNodeId: 10,
                toNodeId: 20,
                fwdSpeedLimit: 50,
                length: 630,
            }),
            // Sharp 90-degree Northbound turn at node 20 (~330m)
            makeSegment(2, [[12.008, 45.0], [12.008, 45.003]], {
                roadType: ROAD_TYPE.PRIMARY_STREET,
                fromNodeId: 20,
                toNodeId: 30,
                fwdSpeedLimit: 50,
                length: 330,
            }),
        ],
        nodes: [
            makeNode(10, 12.0, 45.0, [1]),
            makeNode(20, 12.008, 45.0, [1, 2]),
            makeNode(30, 12.008, 45.003, [2]),
        ],
        permanentHazards: [bumpHazard],
        streets: [makeStreet(1, "Long Straight"), makeStreet(2, "Turn North")],
    });

    const graph = buildRoadGraphFromRawData(raw);
    const edge1 = graph.edges.get("1:F")!;
    assertOk(edge1.speedZones.length >= 1, "Speed bump registered as a speedZone");

    const sim = new TrafficSimulator(
        { ...DEFAULT_SIM_SETTINGS, simSpeed: 1, maxWazers: 1 },
        { rng: () => 0.8 } // cruiseTrait ~ 1.152 (+15.2% on open road)
    );
    sim.setGraph(graph);
    const w = sim.spawnSpecificWazer("1:F", "2:F");
    assertOk(w, "Wazer spawned");

    let maxOpenStraightSpeed = 0;
    let minSpeedNearBump = Infinity;
    let minSpeedAtTurn = Infinity;

    for (let i = 0; i < 600; i++) {
        sim.step(0.1);
        const cur = sim.getWazers()[0];
        if (!cur) break;
        if (cur.edgeId === "1:F") {
            if (cur.distOnEdge < 220 && cur.speedMps > maxOpenStraightSpeed) {
                maxOpenStraightSpeed = cur.speedMps;
            }
            if (cur.distOnEdge >= 295 && cur.distOnEdge <= 335 && cur.speedMps < minSpeedNearBump) {
                minSpeedNearBump = cur.speedMps;
            }
            if (cur.distOnEdge >= edge1.lengthMeters - 18 && cur.speedMps < minSpeedAtTurn) {
                minSpeedAtTurn = cur.speedMps;
            }
        }
    }

    assertOk(
        maxOpenStraightSpeed > edge1.speedMps * 1.03,
        `Open road speed (${maxOpenStraightSpeed.toFixed(2)} m/s) exceeds speed limit (${edge1.speedMps.toFixed(2)} m/s)`
    );
    assertOk(
        minSpeedNearBump <= 6.5,
        `Wazer slowed at speed bump (${minSpeedNearBump.toFixed(2)} m/s)`
    );
    assertOk(
        minSpeedAtTurn <= 8.5,
        `Wazer slowed for 90-degree turn (${minSpeedAtTurn.toFixed(2)} m/s)`
    );
    console.log("PASS: Test 8 — Realistic speed on open roads, hazards, and turns");
}

// 9. Horizontal facing flips west/left and stays default east/right
{
    const raw = baseRaw({
        segments: [
            makeSegment(1, [[12.0, 45.0], [12.002, 45.0]], {
                roadType: ROAD_TYPE.PRIMARY_STREET,
                fromNodeId: 1,
                toNodeId: 2,
                length: 150,
            }),
            makeSegment(2, [[12.002, 45.0], [12.004, 45.0]], {
                roadType: ROAD_TYPE.STREET,
                fromNodeId: 2,
                toNodeId: 3,
                length: 150,
            }),
        ],
        nodes: [
            makeNode(1, 12.0, 45.0, [1]),
            makeNode(2, 12.002, 45.0, [1, 2]),
            makeNode(3, 12.004, 45.0, [2]),
        ],
        streets: [makeStreet(1, "East-West Rd"), makeStreet(2, "Continuation Rd")],
    });

    const graph = buildRoadGraphFromRawData(raw);
    const sim = new TrafficSimulator({ ...DEFAULT_SIM_SETTINGS, simSpeed: 1, maxWazers: 2 });
    sim.setGraph(graph);

    const eastWazer = sim.spawnSpecificWazer("1:F", "2:F");
    const westWazer = sim.spawnSpecificWazer("2:R", "1:R");
    assertOk(eastWazer && westWazer, "Both Eastbound and Westbound Wazers spawned");
    assertEqual(eastWazer.facingLeft, false, "Eastbound Wazer does not flip horizontally");
    assertEqual(westWazer.facingLeft, true, "Westbound Wazer flips horizontally");

    sim.step(0.5);
    assertEqual(eastWazer.facingLeft, false, "Eastbound facing preserved after step");
    assertEqual(westWazer.facingLeft, true, "Westbound facing preserved after step");
    console.log("PASS: Test 9 — Horizontal flip when moving West vs East");
}

// 10. One-way segments with allowNoDirection=true never create reverse edges or spawn wrong-way
{
    const raw = baseRaw({
        segments: [
            // One-way A->B (10 -> 20) even with allowNoDirection=true
            makeSegment(1, [[12.0, 45.0], [12.003, 45.0]], {
                roadType: ROAD_TYPE.MAJOR_HIGHWAY,
                fromNodeId: 10,
                toNodeId: 20,
                isTwoWay: false,
                isAtoB: true,
                isBtoA: false,
                allowNoDirection: true,
                length: 235,
            }),
            // One-way B->A (node B=20 at 12.003 -> node A=30 at 12.006)
            makeSegment(2, [[12.006, 45.0], [12.003, 45.0]], {
                roadType: ROAD_TYPE.MAJOR_HIGHWAY,
                fromNodeId: 30,
                toNodeId: 20,
                isTwoWay: false,
                isAtoB: false,
                isBtoA: true,
                allowNoDirection: true,
                length: 235,
            }),
            // One-way A->B destination street (30 -> 40)
            makeSegment(3, [[12.006, 45.0], [12.009, 45.0]], {
                roadType: ROAD_TYPE.STREET,
                fromNodeId: 30,
                toNodeId: 40,
                isTwoWay: false,
                isAtoB: true,
                isBtoA: false,
                allowNoDirection: true,
                length: 235,
            }),
            // One-way A->B (40 -> 50) with accidentally reversed raw coordinates
            makeSegment(4, [[12.011, 45.0], [12.009, 45.0]], {
                roadType: ROAD_TYPE.PRIMARY_STREET,
                fromNodeId: 40,
                toNodeId: 50,
                isTwoWay: false,
                isAtoB: true,
                isBtoA: false,
                allowNoDirection: true,
                length: 160,
            }),
        ],
        nodes: [
            makeNode(10, 12.0, 45.0, [1]),
            makeNode(20, 12.003, 45.0, [1, 2]),
            makeNode(30, 12.006, 45.0, [2, 3]),
            makeNode(40, 12.009, 45.0, [3, 4]),
            makeNode(50, 12.011, 45.0, [4]),
        ],
        turns: [
            makeTurn(1, true, 2, false, true),
            makeTurn(2, false, 3, true, true),
            makeTurn(3, true, 4, true, true),
        ],
        streets: [
            makeStreet(1, "OneWay Hwy A->B"),
            makeStreet(2, "OneWay Hwy B->A"),
            makeStreet(3, "OneWay Street"),
            makeStreet(4, "OneWay Exit"),
        ],
        viewportBBox: [11.999, 44.998, 12.012, 45.002],
    });

    const graph = buildRoadGraphFromRawData(raw);
    assertOk(graph.edges.has("1:F") && !graph.edges.has("1:R"), "Seg 1 only has forward edge");
    assertOk(graph.edges.has("2:R") && !graph.edges.has("2:F"), "Seg 2 only has reverse edge");
    assertEqual(graph.edges.get("2:R")!.fromNodeId, 20, "Seg 2 reverse starts at node 20");
    assertEqual(graph.edges.get("2:R")!.toNodeId, 30, "Seg 2 reverse ends at node 30");
    assertEqual(graph.edges.get("2:R")!.coords[0][0], 12.003, "Seg 2 reverse geometry starts at 12.003");
    assertEqual(graph.edges.get("2:R")!.coords[1][0], 12.006, "Seg 2 reverse geometry ends at 12.006");
    assertOk(graph.edges.has("3:F") && !graph.edges.has("3:R"), "Seg 3 only has forward edge");
    assertOk(graph.edges.has("4:F") && !graph.edges.has("4:R"), "Seg 4 only has forward edge");
    assertEqual(graph.edges.get("4:F")!.coords[0][0], 12.009, "Seg 4 normalized geometry starts at node 40 (12.009)");

    for (const badId of ["1:R", "2:F", "3:R", "4:R"]) {
        assertOk(!graph.spawnEdgeIds.includes(badId), `Disallowed edge ${badId} is not in spawnEdgeIds`);
    }
    assertOk(graph.spawnEdgeIds.includes("1:F"), "Allowed 1:F is in spawnEdgeIds");
    assertOk(graph.spawnEdgeIds.includes("2:R"), "Allowed 2:R is in spawnEdgeIds");

    const sim = new TrafficSimulator({ ...DEFAULT_SIM_SETTINGS, simSpeed: 1, maxWazers: 6, patienceSeconds: 10 });
    sim.setGraph(graph);

    let spawnedCount = 0;
    for (let s = 0; s < 6; s++) {
        if (sim.spawnRandomWazer()) spawnedCount++;
        sim.step(0.6);
    }
    assertOk(spawnedCount >= 4, `Spawned Wazers on one-way network (got ${spawnedCount})`);

    for (let i = 0; i < 500; i++) {
        sim.step(0.1);
        for (const w of sim.getWazers()) {
            assertOk(
                w.edgeId === "1:F" || w.edgeId === "2:R" || w.edgeId === "3:F" || w.edgeId === "4:F",
                `Wazer ${w.id} stayed on allowed one-way direction (edge=${w.edgeId})`
            );
            assertEqual(w.terminalBug, null, `Wazer ${w.id} has no terminal routing bug on one-way street`);
            assertEqual(w.facingLeft, false, `Wazer ${w.id} travels eastbound with traffic`);
            assertOk(
                w.state === "CRUISING",
                `Wazer ${w.id} flows smoothly without getting stuck at entrance node (state=${w.state}, edge=${w.edgeId}, dist=${w.distOnEdge.toFixed(1)}, dest=${w.destEdgeId})`
            );
        }
    }
    assertOk(sim.getStats().arrivedCount >= 1, "Wazers completed one-way route and exited cleanly");
    console.log("PASS: Test 10 — One-way segments always spawn and drive in allowed direction");
}

// 11. German Autobahn (unrestricted Freeway 130-190 km/h), isolated corridor spawning & min zoom 16
{
    assertEqual(MIN_SIM_ZOOM, 16, "Minimum simulation zoom is 16");

    const localSegments: Segment[] = [];
    const localNodes: WmeNode[] = [];
    const localStreets: Street[] = [
        makeStreet(101, "A9 Autobahn Süd"),
        makeStreet(102, "A9 Autobahn Süd"),
        makeStreet(201, "A9 Autobahn Nord"),
    ];

    // 20 unreachable village streets below the grade-separated Autobahn to dominate destEdgeIds
    for (let k = 0; k < 20; k++) {
        const segId = 500 + k;
        const nA = 5000 + k * 2;
        const nB = nA + 1;
        const lonA = 12.002 + (k % 5) * 0.003;
        const latA = 44.997 + Math.floor(k / 5) * 0.0005;
        localSegments.push(
            makeSegment(segId, [[lonA, latA], [lonA + 0.002, latA]], {
                roadType: ROAD_TYPE.STREET,
                fromNodeId: nA,
                toNodeId: nB,
                length: 160,
            })
        );
        localNodes.push(makeNode(nA, lonA, latA, [segId]));
        localNodes.push(makeNode(nB, lonA + 0.002, latA, [segId]));
        localStreets.push(makeStreet(segId, `Village St ${k + 1}`));
    }

    const raw = baseRaw({
        segments: [
            // Eastbound Autobahn: 2 segments, no speed limit (fwdSpeedLimit: null)
            makeSegment(101, [[11.995, 45.001], [12.010, 45.001]], {
                roadType: ROAD_TYPE.FREEWAY,
                fromNodeId: 1001,
                toNodeId: 1002,
                isTwoWay: false,
                isAtoB: true,
                fwdSpeedLimit: null,
                length: 1180,
            }),
            makeSegment(102, [[12.010, 45.001], [12.025, 45.001]], {
                roadType: ROAD_TYPE.FREEWAY,
                fromNodeId: 1002,
                toNodeId: 1003,
                isTwoWay: false,
                isAtoB: true,
                fwdSpeedLimit: null,
                length: 1180,
            }),
            // Westbound Autobahn: single 2.4km segment spanning across viewport, speed limit 0 (unrestricted)
            makeSegment(201, [[12.025, 45.0015], [11.995, 45.0015]], {
                roadType: ROAD_TYPE.FREEWAY,
                fromNodeId: 2001,
                toNodeId: 2002,
                isTwoWay: false,
                isAtoB: true,
                fwdSpeedLimit: 0,
                length: 2360,
            }),
            ...localSegments,
        ],
        nodes: [
            makeNode(1001, 11.995, 45.001, [101]),
            makeNode(1002, 12.010, 45.001, [101, 102]),
            makeNode(1003, 12.025, 45.001, [102]),
            makeNode(2001, 12.025, 45.0015, [201]),
            makeNode(2002, 11.995, 45.0015, [201]),
            ...localNodes,
        ],
        turns: [makeTurn(101, true, 102, true, true)],
        streets: localStreets,
        viewportBBox: [12.0, 44.996, 12.02, 45.004],
    });

    const graph = buildRoadGraphFromRawData(raw);
    for (const edgeId of ["101:F", "102:F", "201:F"]) {
        const edge = graph.edges.get(edgeId)!;
        assertOk(edge, `${edgeId} exists`);
        assertOk(edge.hasUnrestrictedSpeed, `${edgeId} marked hasUnrestrictedSpeed`);
        assertOk(
            edge.speedKmh >= 130 && edge.speedKmh <= 190,
            `${edgeId} speed ${edge.speedKmh} km/h in 130-190 range`
        );
    }

    let seed11 = 123456789;
    const rng11 = () => {
        seed11 = (Math.imul(seed11, 1664525) + 1013904223) >>> 0;
        return seed11 / 0x100000000;
    };
    const sim = new TrafficSimulator(
        { ...DEFAULT_SIM_SETTINGS, simSpeed: 1, maxWazers: 16 },
        { rng: rng11 }
    );
    sim.setGraph(graph);

    let sawEastbound = false;
    let sawWestbound = false;
    const observedKmhs: number[] = [];

    for (let i = 0; i < 200; i++) {
        sim.step(0.1);
        for (const w of sim.getWazers()) {
            if (w.edgeId === "101:F" || w.edgeId === "102:F") sawEastbound = true;
            if (w.edgeId === "201:F") sawWestbound = true;
            if (
                (w.edgeId === "101:F" || w.edgeId === "102:F" || w.edgeId === "201:F") &&
                w.openRoadSeconds >= 4.0
            ) {
                const kmh = w.speedMps * 3.6;
                observedKmhs.push(kmh);
                assertOk(
                    kmh >= 125 && kmh <= 193,
                    `Autobahn cruising speed ${kmh.toFixed(1)} km/h in expected 130-190 km/h range`
                );
            }
        }
    }

    assertOk(sawEastbound, "Multi-segment Eastbound Autobahn spawns Wazers despite unreachable town streets");
    assertOk(sawWestbound, "Single-segment 2.4km Westbound Autobahn spawns Wazers through viewport");
    assertOk(observedKmhs.length >= 1, "Recorded unrestricted Autobahn cruising speeds");
    const minObs = Math.min(...observedKmhs);
    const maxObs = Math.max(...observedKmhs);
    assertOk(maxObs > 135, `Autobahn Wazers cruise fast (max=${maxObs.toFixed(1)} km/h, min=${minObs.toFixed(1)} km/h)`);
    console.log("PASS: Test 11 — German Autobahn variable high speed & isolated corridor spawning");
}

// 12. Dead-end roads are never detected as disconnected nodes and routes end cleanly there
{
    const raw = baseRaw({
        viewportBBox: [11.999, 44.998, 12.005, 45.003],
        segments: [
            // Main corridor reaching west & east viewport borders (node 1 -> 2 -> 3 -> 4)
            makeSegment(1, [[11.999, 45.0], [12.001, 45.0]], {
                roadType: ROAD_TYPE.MINOR_HIGHWAY,
                fromNodeId: 1,
                toNodeId: 2,
                length: 155,
            }),
            makeSegment(2, [[12.001, 45.0], [12.002, 45.0]], {
                roadType: ROAD_TYPE.PRIMARY_STREET,
                fromNodeId: 2,
                toNodeId: 3,
                length: 80,
            }),
            makeSegment(3, [[12.002, 45.0], [12.005, 45.0]], {
                roadType: ROAD_TYPE.PRIMARY_STREET,
                fromNodeId: 3,
                toNodeId: 4,
                length: 235,
            }),
            // Short (~18m) two-way dead-end Street branching north from node 2
            makeSegment(10, [[12.001, 45.0], [12.001, 45.00016]], {
                roadType: ROAD_TYPE.STREET,
                fromNodeId: 2,
                toNodeId: 10,
                length: 18,
            }),
            // Parallel (~6m offset) two-way dead-end Street branching off node 3 back toward node 10 (~18m away)
            makeSegment(11, [[12.002, 45.0], [12.00118, 45.00005]], {
                roadType: ROAD_TYPE.STREET,
                fromNodeId: 3,
                toNodeId: 11,
                length: 65,
            }),
            // 2-segment two-way dead-end branch (node 3 -> node 12 -> node 13)
            makeSegment(12, [[12.002, 45.0], [12.002, 44.9994]], {
                roadType: ROAD_TYPE.STREET,
                fromNodeId: 3,
                toNodeId: 12,
                length: 67,
            }),
            makeSegment(13, [[12.002, 44.9994], [12.002, 44.999]], {
                roadType: ROAD_TYPE.STREET,
                fromNodeId: 12,
                toNodeId: 13,
                length: 45,
            }),
            // Isolated unreachable street 200m north inside the viewport
            makeSegment(99, [[12.0025, 45.0018], [12.0035, 45.0018]], {
                roadType: ROAD_TYPE.STREET,
                fromNodeId: 990,
                toNodeId: 991,
                length: 80,
            }),
        ],
        nodes: [
            makeNode(1, 11.999, 45.0, [1]),
            makeNode(2, 12.001, 45.0, [1, 2, 10]),
            makeNode(3, 12.002, 45.0, [2, 3, 11, 12]),
            makeNode(4, 12.005, 45.0, [3]),
            makeNode(10, 12.001, 45.00016, [10]),
            makeNode(11, 12.00118, 45.00005, [11]),
            makeNode(12, 12.002, 44.9994, [12, 13]),
            makeNode(13, 12.002, 44.999, [13]),
            makeNode(990, 12.0025, 45.0018, [99]),
            makeNode(991, 12.0035, 45.0018, [99]),
        ],
        streets: [
            makeStreet(1, "Main Ave"),
            makeStreet(2, "Main Ave"),
            makeStreet(3, "Main Ave"),
            makeStreet(10, "Short Cul-de-Sac"),
            makeStreet(11, "Parallel Stub"),
            makeStreet(12, "Dead End Branch"),
            makeStreet(13, "Dead End Tip"),
            makeStreet(99, "Far Island St"),
        ],
    });

    const graph = buildRoadGraphFromRawData(raw);
    for (const deadEndEdgeId of ["10:F", "11:F", "13:F"]) {
        const edge = graph.edges.get(deadEndEdgeId)!;
        assertOk(edge, `${deadEndEdgeId} exists`);
        assertEqual(edge.isDeadEnd, true, `${deadEndEdgeId} classified as isDeadEnd`);
        assertEqual(edge.spawnWeight, 0, `${deadEndEdgeId} does not spawn traffic into dead end`);
    }

    for (const edgeId of ["10:F", "10:R", "11:F", "11:R", "12:F", "12:R", "13:F", "13:R"]) {
        const hasDisconnected = (graph.outgoing.get(edgeId) ?? []).some(
            (t) => t.bugKind === "DISCONNECTED_NODE"
        );
        assertEqual(hasDisconnected, false, `No false DISCONNECTED_NODE on ${edgeId}`);
    }

    // Routing to either inward (:F) or outward (:R) direction of dead-end streets ends cleanly
    for (const targetId of ["10:F", "10:R", "11:F", "11:R", "13:F", "13:R"]) {
        const route = findRoute(graph, "1:F", targetId, new Map());
        assertOk(route, `Route from 1:F to ${targetId} found`);
        assertEqual(route.terminalBug, null, `No terminal bug routing to dead-end ${targetId}`);
        const expectedEnd = targetId.endsWith(":R") ? targetId.replace(":R", ":F") : targetId;
        assertEqual(
            route.routeEdgeIds[route.routeEdgeIds.length - 1],
            expectedEnd,
            `Route to ${targetId} ends cleanly on ${expectedEnd}`
        );
    }

    // Routing from inside a dead-end branch toward Main Ave ends cleanly at the dead-end tip
    for (const startId of ["12:F", "13:F"]) {
        const trappedRoute = findRoute(graph, startId, "3:F", new Map());
        assertOk(trappedRoute, `Route starting on dead-end branch ${startId} ends cleanly`);
        assertEqual(trappedRoute.terminalBug, null, `No terminal bug when ending inside ${startId}`);
        assertEqual(
            trappedRoute.routeEdgeIds[trappedRoute.routeEdgeIds.length - 1],
            "13:F",
            `Route starting on ${startId} ends at dead-end terminus 13:F`
        );
    }

    // Distant unreachable street must NOT hijack dead-end streets as DISCONNECTED_NODE
    const farRoute = findRoute(graph, "1:F", "99:F", new Map());
    assertEqual(farRoute, null, "Unreachable island 200m away does not trigger false dead-end/disconnected bug");

    const sim = new TrafficSimulator(
        { ...DEFAULT_SIM_SETTINGS, simSpeed: 1, patienceSeconds: 5, maxWazers: 12 },
        { rng: () => 0.25 }
    );
    sim.setGraph(graph);
    sim.spawnSpecificWazer("1:F", "10:F");
    sim.spawnSpecificWazer("1:F", "11:R");
    sim.spawnSpecificWazer("1:F", "13:F");
    for (let i = 0; i < 300; i++) {
        sim.step(0.1);
    }
    assertOk(sim.getStats().arrivedCount >= 1, "Dead-end Wazers arrived cleanly");
    assertEqual(sim.getStats().burningCount, 0, "Zero burning Wazers on healthy dead-end roads");
    const badHotspots = sim
        .getHotspots()
        .filter((h) => h.kind === "DISCONNECTED_NODE" || h.kind === "DEAD_END");
    assertEqual(badHotspots.length, 0, "Zero DISCONNECTED_NODE or DEAD_END hotspots on healthy dead ends");
    console.log("PASS: Test 12 — Dead-end roads end routes cleanly without DISCONNECTED_NODE false positives");
}

// 13. Street-only maps spawn & flow (ignoring off-screen highways), and routes prioritize road importance
{
    // Part A: Street-only viewport with an off-screen cached Freeway 3km away
    const streetOnlyRaw = baseRaw({
        viewportBBox: [12.0, 45.0, 12.004, 45.003],
        segments: [
            makeSegment(1, [[12.0, 45.001], [12.002, 45.001]], {
                roadType: ROAD_TYPE.STREET,
                fromNodeId: 1,
                toNodeId: 2,
                length: 155,
            }),
            makeSegment(2, [[12.002, 45.001], [12.004, 45.001]], {
                roadType: ROAD_TYPE.STREET,
                fromNodeId: 2,
                toNodeId: 3,
                length: 155,
            }),
            makeSegment(3, [[12.002, 45.0], [12.002, 45.001]], {
                roadType: ROAD_TYPE.STREET,
                fromNodeId: 4,
                toNodeId: 2,
                length: 110,
            }),
            makeSegment(4, [[12.002, 45.001], [12.002, 45.003]], {
                roadType: ROAD_TYPE.STREET,
                fromNodeId: 2,
                toNodeId: 5,
                length: 220,
            }),
            // Off-screen cached Freeway far outside viewportBBox
            makeSegment(90, [[12.04, 45.04], [12.05, 45.04]], {
                roadType: ROAD_TYPE.FREEWAY,
                fromNodeId: 900,
                toNodeId: 901,
                isTwoWay: false,
                isAtoB: true,
                length: 800,
            }),
        ],
        nodes: [
            makeNode(1, 12.0, 45.001, [1]),
            makeNode(2, 12.002, 45.001, [1, 2, 3, 4]),
            makeNode(3, 12.004, 45.001, [2]),
            makeNode(4, 12.002, 45.0, [3]),
            makeNode(5, 12.002, 45.003, [4]),
            makeNode(900, 12.04, 45.04, [90]),
            makeNode(901, 12.05, 45.04, [90]),
        ],
        streets: [
            makeStreet(1, "Maple St"),
            makeStreet(2, "Maple St"),
            makeStreet(3, "Oak St"),
            makeStreet(4, "Oak St"),
            makeStreet(90, "Far Freeway"),
        ],
    });

    const streetGraph = buildRoadGraphFromRawData(streetOnlyRaw);
    assertOk(
        streetGraph.spawnEdgeIds.includes("1:F") &&
            streetGraph.spawnEdgeIds.includes("3:F") &&
            !streetGraph.spawnEdgeIds.includes("90:F"),
        "Street-only viewport spawns on visible streets and ignores off-screen cached freeway"
    );

    const sim = new TrafficSimulator(
        { ...DEFAULT_SIM_SETTINGS, simSpeed: 1, maxWazers: 10 },
        { rng: () => 0.3 }
    );
    sim.setGraph(streetGraph);
    for (let i = 0; i < 200; i++) {
        sim.step(0.1);
    }
    assertOk(sim.getStats().activeWazers > 0, "Street-only viewport actively spawns Wazers");
    assertOk(sim.getStats().arrivedCount >= 1, "Street-only Wazers complete trips and arrive");

    // Part B: Strict road importance hierarchy with equal lengths & equal 50 km/h speed limits
    const hierarchy = [
        ROAD_TYPE.FREEWAY,
        ROAD_TYPE.MAJOR_HIGHWAY,
        ROAD_TYPE.MINOR_HIGHWAY,
        ROAD_TYPE.PRIMARY_STREET,
        ROAD_TYPE.STREET,
        ROAD_TYPE.ALLEY,
        ROAD_TYPE.PRIVATE_ROAD,
        ROAD_TYPE.PARKING_LOT_ROAD,
    ] as const;

    for (let idx = 0; idx < hierarchy.length - 1; idx++) {
        const highType = hierarchy[idx];
        const lowType = hierarchy[idx + 1];
        const cmpRaw = baseRaw({
            segments: [
                makeSegment(1, [[12.0, 45.0], [12.001, 45.0]], {
                    roadType: ROAD_TYPE.PRIMARY_STREET,
                    fromNodeId: 1,
                    toNodeId: 2,
                    fwdSpeedLimit: 50,
                    length: 80,
                }),
                // Upper branch: higher-importance road
                makeSegment(2, [[12.001, 45.0], [12.002, 45.001]], {
                    roadType: highType,
                    fromNodeId: 2,
                    toNodeId: 3,
                    fwdSpeedLimit: 50,
                    revSpeedLimit: 50,
                    length: 135,
                }),
                makeSegment(3, [[12.002, 45.001], [12.003, 45.0]], {
                    roadType: highType,
                    fromNodeId: 3,
                    toNodeId: 5,
                    fwdSpeedLimit: 50,
                    revSpeedLimit: 50,
                    length: 135,
                }),
                // Lower branch: lower-importance road (same length & speed)
                makeSegment(4, [[12.001, 45.0], [12.002, 44.999]], {
                    roadType: lowType,
                    fromNodeId: 2,
                    toNodeId: 4,
                    fwdSpeedLimit: 50,
                    revSpeedLimit: 50,
                    length: 135,
                }),
                makeSegment(5, [[12.002, 44.999], [12.003, 45.0]], {
                    roadType: lowType,
                    fromNodeId: 4,
                    toNodeId: 5,
                    fwdSpeedLimit: 50,
                    revSpeedLimit: 50,
                    length: 135,
                }),
                makeSegment(6, [[12.003, 45.0], [12.004, 45.0]], {
                    roadType: ROAD_TYPE.STREET,
                    fromNodeId: 5,
                    toNodeId: 6,
                    fwdSpeedLimit: 50,
                    length: 80,
                }),
            ],
            nodes: [
                makeNode(1, 12.0, 45.0, [1]),
                makeNode(2, 12.001, 45.0, [1, 2, 4]),
                makeNode(3, 12.002, 45.001, [2, 3]),
                makeNode(4, 12.002, 44.999, [4, 5]),
                makeNode(5, 12.003, 45.0, [3, 5, 6]),
                makeNode(6, 12.004, 45.0, [6]),
            ],
            streets: [makeStreet(1, "Start Rd"), makeStreet(6, "End Rd")],
        });

        const cmpGraph = buildRoadGraphFromRawData(cmpRaw);
        const cmpRoute = findRoute(cmpGraph, "1:F", "6:F", new Map());
        assertOk(cmpRoute, `Route found comparing roadType ${highType} vs ${lowType}`);
        assertDeepEqual(
            cmpRoute.routeEdgeIds,
            ["1:F", "2:F", "3:F", "6:F"],
            `Router prioritizes roadType ${highType} over ${lowType}`
        );
    }

    // Verify routingRoadType override is also respected
    const overrideRaw = baseRaw({
        segments: [
            makeSegment(1, [[12.0, 45.0], [12.001, 45.0]], {
                roadType: ROAD_TYPE.STREET,
                fromNodeId: 1,
                toNodeId: 2,
                fwdSpeedLimit: 50,
            }),
            makeSegment(2, [[12.001, 45.0], [12.002, 45.001]], {
                roadType: ROAD_TYPE.STREET,
                routingRoadType: ROAD_TYPE.PRIMARY_STREET,
                fromNodeId: 2,
                toNodeId: 3,
                fwdSpeedLimit: 50,
            }),
            makeSegment(3, [[12.002, 45.001], [12.003, 45.0]], {
                roadType: ROAD_TYPE.STREET,
                routingRoadType: ROAD_TYPE.PRIMARY_STREET,
                fromNodeId: 3,
                toNodeId: 5,
                fwdSpeedLimit: 50,
            }),
            makeSegment(4, [[12.001, 45.0], [12.002, 44.999]], {
                roadType: ROAD_TYPE.STREET,
                fromNodeId: 2,
                toNodeId: 4,
                fwdSpeedLimit: 50,
            }),
            makeSegment(5, [[12.002, 44.999], [12.003, 45.0]], {
                roadType: ROAD_TYPE.STREET,
                fromNodeId: 4,
                toNodeId: 5,
                fwdSpeedLimit: 50,
            }),
            makeSegment(6, [[12.003, 45.0], [12.004, 45.0]], {
                roadType: ROAD_TYPE.STREET,
                fromNodeId: 5,
                toNodeId: 6,
                fwdSpeedLimit: 50,
            }),
        ],
        nodes: [
            makeNode(1, 12.0, 45.0, [1]),
            makeNode(2, 12.001, 45.0, [1, 2, 4]),
            makeNode(3, 12.002, 45.001, [2, 3]),
            makeNode(4, 12.002, 44.999, [4, 5]),
            makeNode(5, 12.003, 45.0, [3, 5, 6]),
            makeNode(6, 12.004, 45.0, [6]),
        ],
        streets: [makeStreet(1, "Entry"), makeStreet(6, "Exit")],
    });
    const overrideRoute = findRoute(buildRoadGraphFromRawData(overrideRaw), "1:F", "6:F", new Map());
    assertOk(overrideRoute, "Route found with routingRoadType override");
    assertDeepEqual(
        overrideRoute.routeEdgeIds,
        ["1:F", "2:F", "3:F", "6:F"],
        "Router respects routingRoadType priority override"
    );

    console.log("PASS: Test 13 — Street-only spawning & road importance routing priority");
}

// 14. 3 connected segments with 1 restricted segment: Wazers take unrestricted branch instead of getting stuck
{
    const makeRestriction = (
        overrides: Partial<Segment["restrictions"][number]> = {}
    ): Segment["restrictions"][number] => ({
        defaultType: "BLOCKED",
        description: "Test restriction",
        direction: "BOTH",
        disposition: "WHOLE_SEGMENT",
        driveProfiles: {},
        editable: true,
        isExpired: false,
        laneScope: "WHOLE_SEGMENT",
        laneType: null,
        timeFrames: [],
        vehicleRules: {},
        ...overrides,
    });

    const buildThreeBranchRaw = (restrictSeg2: boolean) =>
        baseRaw({
            viewportBBox: [11.999, 44.998, 12.005, 45.002],
            segments: [
                // Seg 1: Entry road (node 1 -> node 2)
                makeSegment(1, [[11.999, 45.0], [12.001, 45.0]], {
                    roadType: ROAD_TYPE.PRIMARY_STREET,
                    fromNodeId: 1,
                    toNodeId: 2,
                    length: 155,
                }),
                // Seg 2: Branch 1 (node 2 -> node 3) - forward direction blocked, reverse open
                makeSegment(2, [[12.001, 45.0], [12.0025, 45.001]], {
                    roadType: ROAD_TYPE.STREET,
                    fromNodeId: 2,
                    toNodeId: 3,
                    length: 155,
                    hasRestrictions: restrictSeg2,
                    restrictions: restrictSeg2
                        ? [
                              makeRestriction({
                                  direction: "FWD",
                                  defaultType: "FREE",
                                  vehicleRules: {
                                      BLOCKED: [
                                          {
                                              licensePlateNumber: null,
                                              licensePlateRule: null,
                                              minPassengers: 0,
                                              numPassengers: 0,
                                              subscriptions: [],
                                              vehicleTypes: ["PRIVATE"],
                                          },
                                      ],
                                  },
                              }),
                          ]
                        : [],
                }),
                // Seg 4: Downstream street behind Seg 2 (node 3 -> node 5)
                makeSegment(4, [[12.0025, 45.001], [12.004, 45.001]], {
                    roadType: ROAD_TYPE.STREET,
                    fromNodeId: 3,
                    toNodeId: 5,
                    length: 120,
                }),
                // Seg 3: Unrestricted alternative branch reaching east border (node 2 -> node 4)
                makeSegment(3, [[12.001, 45.0], [12.005, 44.9995]], {
                    roadType: ROAD_TYPE.STREET,
                    fromNodeId: 2,
                    toNodeId: 4,
                    length: 320,
                }),
            ],
            nodes: [
                makeNode(1, 11.999, 45.0, [1]),
                makeNode(2, 12.001, 45.0, [1, 2, 3]),
                makeNode(3, 12.0025, 45.001, [2, 4]),
                makeNode(4, 12.005, 44.9995, [3]),
                makeNode(5, 12.004, 45.001, [4]),
            ],
            streets: [
                makeStreet(1, "Entry Blvd"),
                makeStreet(2, "Restricted Way"),
                makeStreet(3, "Open Alternate St"),
                makeStreet(4, "Behind Restriction St"),
            ],
        });

    const restrictedGraph = buildRoadGraphFromRawData(buildThreeBranchRaw(true));
    assertEqual(restrictedGraph.edges.get("2:F")!.isClosed, true, "Seg 2 forward blocked by restriction");
    assertEqual(restrictedGraph.edges.get("2:R")!.isClosed, false, "Seg 2 reverse remains open");
    assertEqual(restrictedGraph.edges.get("3:F")!.isClosed, false, "Seg 3 unrestricted alternate open");

    // Routing toward the unreachable restricted branch or behind it must NOT trap Wazers at node 2
    assertEqual(
        findRoute(restrictedGraph, "1:F", "2:R", new Map()),
        null,
        "Routing from Seg 1 to 2:R returns null instead of jamming at node 2"
    );
    assertEqual(
        findRoute(restrictedGraph, "1:F", "4:F", new Map()),
        null,
        "Routing from Seg 1 to 4:F returns null instead of jamming at node 2"
    );

    const openRoute = findRoute(restrictedGraph, "1:F", "3:F", new Map());
    assertOk(openRoute, "Route onto unrestricted Seg 3 found");
    assertEqual(openRoute.terminalBug, null, "No terminal bug on unrestricted Seg 3 route");
    assertDeepEqual(openRoute.routeEdgeIds, ["1:F", "3:F"], "Wazer takes unrestricted Seg 3");

    // Simulate spawning & live restriction activation
    const sim = new TrafficSimulator(
        { ...DEFAULT_SIM_SETTINGS, simSpeed: 1, patienceSeconds: 5, maxWazers: 8 },
        { rng: () => 0.35 }
    );
    const openGraph = buildRoadGraphFromRawData(buildThreeBranchRaw(false));
    sim.setGraph(openGraph);
    const w = sim.spawnSpecificWazer("1:F", "4:F");
    assertOk(w, "Wazer spawned heading toward Seg 4 while Seg 2 is open");
    sim.step(0.5);

    // Editor adds restriction on Seg 2 while Wazer is still on Seg 1 -> reroutes onto Seg 3
    sim.setGraph(restrictedGraph);
    assertOk(sim.getWazers().length === 1, "Wazer survived graph rebuild after restriction added");
    assertEqual(sim.getWazers()[0].terminalBug, null, "Rerouted Wazer has no terminal bug");
    assertEqual(
        sim.getWazers()[0].routeEdgeIds[sim.getWazers()[0].routeEdgeIds.length - 1],
        "3:F",
        "Wazer rerouted onto unrestricted Seg 3"
    );

    for (let i = 0; i < 450; i++) {
        sim.step(0.1);
    }
    assertOk(sim.getStats().arrivedCount >= 1, "Wazers arrived via unrestricted branch");
    assertEqual(sim.getStats().burningCount, 0, "Zero burning Wazers when unrestricted branch exists");
    assertEqual(sim.getHotspots().length, 0, "Zero chaos hotspots when unrestricted branch exists");
    console.log("PASS: Test 14 — Multi-branch restricted segment routes cleanly via unrestricted segment");
}

// 15. Custom date & time evaluation (past & future) for restrictions and road/turn closures
{
    const makeTimeFramedRestriction = (
        timeFrames: Segment["restrictions"][number]["timeFrames"],
        overrides: Partial<Segment["restrictions"][number]> = {}
    ): Segment["restrictions"][number] => ({
        defaultType: "BLOCKED",
        description: "Timed restriction",
        direction: "FWD",
        disposition: "WHOLE_SEGMENT",
        driveProfiles: {},
        editable: true,
        isExpired: true, // Expired relative to current year, but active in 2024
        laneScope: "WHOLE_SEGMENT",
        laneType: null,
        timeFrames,
        vehicleRules: {},
        ...overrides,
    });

    const timedRaw = (evalTimestamp: string | null): RawGraphInput =>
        baseRaw({
            evalTimestamp,
            segments: [
                makeSegment(1, [[12.0, 45.0], [12.001, 45.0]], {
                    roadType: ROAD_TYPE.PRIMARY_STREET,
                    fromNodeId: 1,
                    toNodeId: 2,
                }),
                makeSegment(2, [[12.001, 45.0], [12.002, 45.0]], {
                    roadType: ROAD_TYPE.STREET,
                    fromNodeId: 2,
                    toNodeId: 3,
                    hasRestrictions: true,
                    restrictions: [
                        makeTimeFramedRestriction([
                            {
                                startDate: "2024-05-01",
                                endDate: "2024-05-31",
                                fromTime: "08:00",
                                toTime: "10:00",
                                weekdays: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"],
                                dayAlternation: null,
                                daysOfMonth: null,
                                repeatYearly: false,
                                timeZone: null,
                            },
                        ]),
                    ],
                }),
                makeSegment(3, [[12.001, 45.0], [12.002, 44.999]], {
                    roadType: ROAD_TYPE.STREET,
                    fromNodeId: 2,
                    toNodeId: 4,
                    hasRestrictions: true,
                    restrictions: [
                        makeTimeFramedRestriction(
                            [
                                {
                                    startDate: null,
                                    endDate: null,
                                    fromTime: "22:00",
                                    toTime: "03:00",
                                    weekdays: ["FRIDAY"],
                                    dayAlternation: null,
                                    daysOfMonth: null,
                                    repeatYearly: false,
                                    timeZone: null,
                                },
                            ],
                            { isExpired: false }
                        ),
                    ],
                }),
                // Past finished closure (2023-08-10 09:00..17:00)
                makeSegment(4, [[12.002, 45.0], [12.003, 45.0]], {
                    roadType: ROAD_TYPE.STREET,
                    fromNodeId: 3,
                    toNodeId: 5,
                    hasClosures: true,
                }),
                // Future scheduled closure (2027-02-01 06:00..18:00)
                makeSegment(5, [[12.002, 44.999], [12.003, 44.999]], {
                    roadType: ROAD_TYPE.STREET,
                    fromNodeId: 4,
                    toNodeId: 6,
                    hasClosures: false,
                }),
            ],
            nodes: [
                makeNode(1, 12.0, 45.0, [1]),
                makeNode(2, 12.001, 45.0, [1, 2, 3]),
                makeNode(3, 12.002, 45.0, [2, 4]),
                makeNode(4, 12.002, 44.999, [3, 5]),
                makeNode(5, 12.003, 45.0, [4]),
                makeNode(6, 12.003, 44.999, [5]),
            ],
            roadClosures: [
                {
                    id: "rc-past",
                    segmentId: 4,
                    isForward: true,
                    isPermanent: true,
                    status: "FINISHED",
                    description: "Past paving",
                    startDate: "2023-08-10 09:00",
                    endDate: "2023-08-10 17:00",
                    trafficEventId: null,
                    attributions: [],
                    modificationData: { createdBy: null, createdOn: null, updatedBy: null, updatedOn: null },
                },
                {
                    id: "rc-future",
                    segmentId: 5,
                    isForward: true,
                    isPermanent: true,
                    status: "NOT_STARTED",
                    description: "Future marathon",
                    startDate: "2027-02-01 06:00",
                    endDate: "2027-02-01 18:00",
                    trafficEventId: null,
                    attributions: [],
                    modificationData: { createdBy: null, createdOn: null, updatedBy: null, updatedOn: null },
                },
            ],
            streets: [
                makeStreet(1, "Base Rd"),
                makeStreet(2, "Morning Restricted St"),
                makeStreet(3, "Overnight Restricted St"),
                makeStreet(4, "Past Closed St"),
                makeStreet(5, "Future Closed St"),
            ],
        });

    // Past Monday 08:30 inside May 2024 weekday morning window -> blocked
    assertEqual(
        buildRoadGraphFromRawData(timedRaw("2024-05-13T08:30")).edges.get("2:F")!.isClosed,
        true,
        "Seg 2 blocked at past Monday 2024-05-13 08:30"
    );
    // Past Monday 11:30 outside 08:00-10:00 window -> open
    assertEqual(
        buildRoadGraphFromRawData(timedRaw("2024-05-13T11:30")).edges.get("2:F")!.isClosed,
        false,
        "Seg 2 open at past Monday 2024-05-13 11:30"
    );
    // Past Sunday 08:30 (not Mon-Fri) -> open
    assertEqual(
        buildRoadGraphFromRawData(timedRaw("2024-05-12T08:30")).edges.get("2:F")!.isClosed,
        false,
        "Seg 2 open at past Sunday 2024-05-12 08:30"
    );

    // Overnight Friday 22:00..03:00 window
    assertEqual(
        buildRoadGraphFromRawData(timedRaw("2026-05-15T23:00")).edges.get("3:F")!.isClosed,
        true,
        "Seg 3 blocked on Friday 23:00"
    );
    assertEqual(
        buildRoadGraphFromRawData(timedRaw("2026-05-16T01:30")).edges.get("3:F")!.isClosed,
        true,
        "Seg 3 still blocked on Saturday 01:30 (overnight from Friday)"
    );
    assertEqual(
        buildRoadGraphFromRawData(timedRaw("2026-05-16T12:00")).edges.get("3:F")!.isClosed,
        false,
        "Seg 3 open on Saturday 12:00"
    );

    // Past FINISHED closure active during its 2023 window, open outside & in live mode
    assertEqual(
        buildRoadGraphFromRawData(timedRaw("2023-08-10T12:00")).edges.get("4:F")!.isClosed,
        true,
        "Past FINISHED road closure is closed during its 2023-08-10 window"
    );
    assertEqual(
        buildRoadGraphFromRawData(timedRaw("2023-08-10T18:00")).edges.get("4:F")!.isClosed,
        false,
        "Past FINISHED road closure is open after its window"
    );
    assertEqual(
        buildRoadGraphFromRawData(timedRaw(null)).edges.get("4:F")!.isClosed,
        false,
        "Past FINISHED road closure is open in live mode despite seg.hasClosures=true"
    );

    // Future NOT_STARTED closure active during its 2027 window, open in live mode
    assertEqual(
        buildRoadGraphFromRawData(timedRaw("2027-02-01T10:00")).edges.get("5:F")!.isClosed,
        true,
        "Future NOT_STARTED road closure is closed during its 2027-02-01 window"
    );
    assertEqual(
        buildRoadGraphFromRawData(timedRaw(null)).edges.get("5:F")!.isClosed,
        false,
        "Future NOT_STARTED road closure is open in live mode"
    );

    console.log("PASS: Test 15 — Custom past & future timestamp evaluation for restrictions and closures");
}

// ============================================================================
// Test 16: Turn closure on roundabout segments does not close the segments themselves
// ============================================================================
{
    const activeTurnClosure: TurnClosure = {
        id: "tc-rb-1",
        fromSegmentId: 10,
        toSegmentId: 11,
        description: "Closed roundabout continuation turn",
        startDate: "2026-06-01 08:00",
        endDate: "2026-06-01 20:00",
        isPermanent: true,
        majorTrafficEventId: null,
        status: "ACTIVE",
        modificationData: { createdBy: null, createdOn: null, updatedBy: null, updatedOn: null },
    };

    const makeRbRaw = (evalTimestamp: string | null) =>
        baseRaw({
            viewportBBox: [11.999, 44.999, 12.005, 45.005],
            evalTimestamp,
            nowMs: new Date(2026, 5, 1, 12, 0, 0).getTime(),
            segments: [
                // West approach/exit (border at west)
                makeSegment(1, [[11.999, 45.002], [12.001, 45.002]], {
                    roadType: ROAD_TYPE.PRIMARY_STREET,
                    fromNodeId: 1,
                    toNodeId: 2,
                }),
                // South-East approach/exit (border at south)
                makeSegment(2, [[12.002, 45.001], [12.003, 44.999]], {
                    roadType: ROAD_TYPE.PRIMARY_STREET,
                    fromNodeId: 3,
                    toNodeId: 5,
                }),
                // North-East approach/exit (border at east)
                makeSegment(3, [[12.003, 45.003], [12.005, 45.004]], {
                    roadType: ROAD_TYPE.PRIMARY_STREET,
                    fromNodeId: 4,
                    toNodeId: 6,
                }),
                // Roundabout SW ring segment (W -> SE): hasClosures=true due to TurnClosure
                makeSegment(10, [[12.001, 45.002], [12.0014, 45.0012], [12.002, 45.001]], {
                    roadType: ROAD_TYPE.PRIMARY_STREET,
                    fromNodeId: 2,
                    toNodeId: 3,
                    junctionId: 900,
                    isTwoWay: false,
                    isAtoB: true,
                    isBtoA: false,
                    hasClosures: true,
                }),
                // Roundabout E ring segment (SE -> NE): hasClosures=true due to TurnClosure
                makeSegment(11, [[12.002, 45.001], [12.003, 45.0019], [12.003, 45.003]], {
                    roadType: ROAD_TYPE.PRIMARY_STREET,
                    fromNodeId: 3,
                    toNodeId: 4,
                    junctionId: 900,
                    isTwoWay: false,
                    isAtoB: true,
                    isBtoA: false,
                    hasClosures: true,
                }),
                // Roundabout N ring segment (NE -> W)
                makeSegment(12, [[12.003, 45.003], [12.002, 45.0032], [12.001, 45.002]], {
                    roadType: ROAD_TYPE.PRIMARY_STREET,
                    fromNodeId: 4,
                    toNodeId: 2,
                    junctionId: 900,
                    isTwoWay: false,
                    isAtoB: true,
                    isBtoA: false,
                }),
            ],
            nodes: [
                makeNode(1, 11.999, 45.002, [1]),
                makeNode(2, 12.001, 45.002, [1, 10, 12]),
                makeNode(3, 12.002, 45.001, [10, 11, 2]),
                makeNode(4, 12.003, 45.003, [11, 12, 3]),
                makeNode(5, 12.003, 44.999, [2]),
                makeNode(6, 12.005, 45.004, [3]),
            ],
            turnClosures: [activeTurnClosure],
            streets: [
                makeStreet(1, "West Ave"),
                makeStreet(2, "South-East Rd"),
                makeStreet(3, "North-East Rd"),
            ],
        });

    const liveGraph = buildRoadGraphFromRawData(makeRbRaw(null));
    assertEqual(
        liveGraph.edges.get("10:F")!.isClosed,
        false,
        "Roundabout seg 10 stays open when only a turn closure references it"
    );
    assertEqual(
        liveGraph.edges.get("11:F")!.isClosed,
        false,
        "Roundabout seg 11 stays open when only a turn closure references it"
    );

    const westToSe = findRoute(liveGraph, "1:F", "2:F", new Map());
    assertOk(westToSe, "Wazer can still route through seg 10 to exit South-East");
    assertEqual(westToSe.terminalBug, null, "No road-closure bug when exiting South-East");
    assertEqual(
        westToSe.routeEdgeIds.join(","),
        "1:F,10:F,2:F",
        "Route uses seg 10 and exits at South-East"
    );

    const seToNe = findRoute(liveGraph, "2:R", "3:F", new Map());
    assertOk(seToNe, "Wazer entering from South-East can still route through seg 11 to North-East");
    assertEqual(seToNe.terminalBug, null, "No road-closure bug when entering onto seg 11");
    assertEqual(
        seToNe.routeEdgeIds.join(","),
        "2:R,11:F,3:F",
        "Route enters seg 11 and exits at North-East"
    );

    const westToNeBlocked = findRoute(liveGraph, "1:F", "3:F", new Map());
    assertEqual(
        westToNeBlocked,
        null,
        "Closed turn 10->11 blocks West->North-East without jamming since other legal exits exist"
    );

    // Outside the turn closure window, the full roundabout continuation works legally
    const afterGraph = buildRoadGraphFromRawData(makeRbRaw("2026-06-01T21:00"));
    const westToNeOpen = findRoute(afterGraph, "1:F", "3:F", new Map());
    assertOk(westToNeOpen, "West->North-East routes legally after turn closure ends");
    assertEqual(westToNeOpen.terminalBug, null, "No terminal bug after turn closure ends");
    assertEqual(
        westToNeOpen.routeEdgeIds.join(","),
        "1:F,10:F,11:F,3:F",
        "Route continues through 10:F -> 11:F after turn closure ends"
    );

    console.log("PASS: Test 16 — Turn closure blocks only the closed turn, keeping participating segments drivable");
}

console.log("ALL SIMWAZE TESTS PASSED");

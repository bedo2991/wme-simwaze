import { AsyncWmeSDK, ZoomLevel } from "wme-sdk-typings";
import { DirectedEdge } from "./types";

const EARTH_RADIUS_M = 6371000;
const DEG_TO_RAD = Math.PI / 180;

export function distanceMeters(lon1: number, lat1: number, lon2: number, lat2: number): number {
    const meanLatRad = ((lat1 + lat2) * 0.5) * DEG_TO_RAD;
    const dx = (lon2 - lon1) * DEG_TO_RAD * Math.cos(meanLatRad) * EARTH_RADIUS_M;
    const dy = (lat2 - lat1) * DEG_TO_RAD * EARTH_RADIUS_M;
    return Math.hypot(dx, dy);
}

export function computeCumulativeLengths(coords: [number, number][]): {
    cumLengths: number[];
    totalLength: number;
} {
    const cumLengths: number[] = new Array(coords.length);
    if (coords.length === 0) {
        return { cumLengths, totalLength: 0 };
    }
    cumLengths[0] = 0;
    let total = 0;
    for (let i = 1; i < coords.length; i++) {
        total += distanceMeters(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
        cumLengths[i] = total;
    }
    return { cumLengths, totalLength: total };
}

export function pointToSegmentDistanceMeters(
    pxLon: number,
    pyLat: number,
    axLon: number,
    ayLat: number,
    bxLon: number,
    byLat: number
): { distMeters: number; closestLon: number; closestLat: number; t: number } {
    const meanLatRad = ((ayLat + byLat + pyLat) / 3) * DEG_TO_RAD;
    const cosLat = Math.cos(meanLatRad);
    const scaleX = DEG_TO_RAD * cosLat * EARTH_RADIUS_M;
    const scaleY = DEG_TO_RAD * EARTH_RADIUS_M;

    const abx = (bxLon - axLon) * scaleX;
    const aby = (byLat - ayLat) * scaleY;
    const apx = (pxLon - axLon) * scaleX;
    const apy = (pyLat - ayLat) * scaleY;
    const abLenSq = abx * abx + aby * aby;

    let t = 0;
    if (abLenSq > 1e-9) {
        t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / abLenSq));
    }
    const closestLon = axLon + (bxLon - axLon) * t;
    const closestLat = ayLat + (byLat - ayLat) * t;
    const dx = (pxLon - closestLon) * scaleX;
    const dy = (pyLat - closestLat) * scaleY;
    return {
        distMeters: Math.hypot(dx, dy),
        closestLon,
        closestLat,
        t,
    };
}

export function samplePolylineAt(
    coords: [number, number][],
    cumLengths: number[],
    distMeters: number
): { lon: number; lat: number; tangentLon: number; tangentLat: number } {
    const n = coords.length;
    if (n === 0) {
        return { lon: 0, lat: 0, tangentLon: 1, tangentLat: 0 };
    }
    if (n === 1) {
        return { lon: coords[0][0], lat: coords[0][1], tangentLon: 1, tangentLat: 0 };
    }
    const total = cumLengths[n - 1];
    const d = Math.max(0, Math.min(total, distMeters));

    // Binary search for segment containing d
    let lo = 0;
    let hi = n - 2;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (cumLengths[mid] <= d) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }

    const startD = cumLengths[lo];
    const endD = cumLengths[lo + 1];
    const segLen = endD - startD;
    const ratio = segLen > 1e-6 ? (d - startD) / segLen : 0;
    const [ax, ay] = coords[lo];
    const [bx, by] = coords[lo + 1];

    return {
        lon: ax + (bx - ax) * ratio,
        lat: ay + (by - ay) * ratio,
        tangentLon: bx - ax,
        tangentLat: by - ay,
    };
}

export function sampleEdgePosition(
    edge: DirectedEdge,
    distMeters: number,
    laneIndex: number,
    isLeftHandTraffic: boolean,
    lateralOffsetMeters = 0
): { lon: number; lat: number; bearingScreenRad: number } {
    const sample = samplePolylineAt(edge.coords, edge.cumLengths, distMeters);
    const cosLat = Math.max(0.1, Math.cos(sample.lat * DEG_TO_RAD));
    const dxMeters = sample.tangentLon * DEG_TO_RAD * cosLat * EARTH_RADIUS_M;
    const dyMeters = sample.tangentLat * DEG_TO_RAD * EARTH_RADIUS_M;
    const len = Math.hypot(dxMeters, dyMeters);

    let ux = 1;
    let uy = 0;
    if (len > 1e-6) {
        ux = dxMeters / len;
        uy = dyMeters / len;
    }

    // Screen-space angle (y increases downward in canvas, whereas lat increases upward)
    const bearingScreenRad = Math.atan2(-uy, ux);

    // Right-hand side of travel direction: (uy, -ux); left-hand side: (-uy, ux)
    const sideSign = isLeftHandTraffic ? -1 : 1;
    const laneCenter = (laneIndex - (edge.lanes - 1) * 0.5) * 3.2;
    // Also shift slightly outward from centerline on two-way roads so opposing traffic doesn't overlap
    const roadOffset = sideSign * (2.6 + laneCenter + lateralOffsetMeters);

    const nxMeters = uy * roadOffset;
    const nyMeters = -ux * roadOffset;

    const dLon = nxMeters / (DEG_TO_RAD * cosLat * EARTH_RADIUS_M);
    const dLat = nyMeters / (DEG_TO_RAD * EARTH_RADIUS_M);

    return {
        lon: sample.lon + dLon,
        lat: sample.lat + dLat,
        bearingScreenRad,
    };
}

function mercatorY(lat: number): number {
    const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
    return Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360)) / DEG_TO_RAD;
}

function inverseMercatorY(my: number): number {
    return (2 * Math.atan(Math.exp(my * DEG_TO_RAD)) - Math.PI / 2) / DEG_TO_RAD;
}

export class WebMercatorProjector {
    private scaleX = 1;
    private scaleY = -1;
    private originLon = 0;
    private originMercY = 0;
    private originPxX = 0;
    private originPxY = 0;
    private zoomLevel: ZoomLevel = 16;
    private resolution = 1;
    private calibrated = false;

    public isCalibrated(): boolean {
        return this.calibrated;
    }

    public getZoomLevel(): ZoomLevel {
        return this.zoomLevel;
    }

    public getMetersPerPixel(lat: number): number {
        if (!this.calibrated || Math.abs(this.scaleX) < 1e-6) {
            return Math.max(0.15, this.resolution || 1);
        }
        const metersPerDegLon = DEG_TO_RAD * Math.cos(lat * DEG_TO_RAD) * EARTH_RADIUS_M;
        return Math.max(0.05, metersPerDegLon / Math.abs(this.scaleX));
    }

    public async syncWithWmeMap(wmeSDK: AsyncWmeSDK): Promise<void> {
        try {
            const [extent, zoom, res] = await Promise.all([
                wmeSDK.Map.getMapExtent(),
                wmeSDK.Map.getZoomLevel(),
                wmeSDK.Map.getMapResolution(),
            ]);
            this.zoomLevel = zoom;
            this.resolution = res;
            if (!extent || extent.length < 4) return;

            const [west, south, east, north] = extent;
            if (Math.abs(east - west) < 1e-7 || Math.abs(north - south) < 1e-7) return;

            const [topLeftPx, bottomRightPx] = await Promise.all([
                wmeSDK.Map.getMapPixelFromLonLat({ lonLat: { lon: west, lat: north } }),
                wmeSDK.Map.getMapPixelFromLonLat({ lonLat: { lon: east, lat: south } }),
            ]);

            const dLon = east - west;
            const mTop = mercatorY(north);
            const mBottom = mercatorY(south);
            const dMercY = mBottom - mTop;

            if (Math.abs(dLon) < 1e-9 || Math.abs(dMercY) < 1e-9) return;

            this.originLon = west;
            this.originMercY = mTop;
            this.originPxX = topLeftPx.x;
            this.originPxY = topLeftPx.y;
            this.scaleX = (bottomRightPx.x - topLeftPx.x) / dLon;
            this.scaleY = (bottomRightPx.y - topLeftPx.y) / dMercY;
            this.calibrated = Number.isFinite(this.scaleX) && Number.isFinite(this.scaleY);
        } catch (err) {
            console.debug("SimWaze: Failed to calibrate WebMercatorProjector:", err);
        }
    }

    public project(lon: number, lat: number): { x: number; y: number } {
        const my = mercatorY(lat);
        return {
            x: this.originPxX + (lon - this.originLon) * this.scaleX,
            y: this.originPxY + (my - this.originMercY) * this.scaleY,
        };
    }

    public unproject(x: number, y: number): { lon: number; lat: number } {
        if (!this.calibrated || Math.abs(this.scaleX) < 1e-9 || Math.abs(this.scaleY) < 1e-9) {
            return { lon: 0, lat: 0 };
        }
        const lon = this.originLon + (x - this.originPxX) / this.scaleX;
        const my = this.originMercY + (y - this.originPxY) / this.scaleY;
        return {
            lon,
            lat: inverseMercatorY(my),
        };
    }
}

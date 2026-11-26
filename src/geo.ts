import { AsyncWmeSDK, ZoomLevel } from "wme-sdk-typings";
import { DirectedEdge } from "./types";

export const EARTH_RADIUS_M = 6371000;
export const DEG_TO_RAD = Math.PI / 180;
export const METERS_PER_DEG_LAT = DEG_TO_RAD * EARTH_RADIUS_M;

export function distanceMeters(
    lon1: number,
    lat1: number,
    lon2: number,
    lat2: number,
    cosLatOverride?: number
): number {
    const cosLat =
        cosLatOverride !== undefined
            ? cosLatOverride
            : Math.cos((lat1 + lat2) * 0.5 * DEG_TO_RAD);
    const dx = (lon2 - lon1) * METERS_PER_DEG_LAT * cosLat;
    const dy = (lat2 - lat1) * METERS_PER_DEG_LAT;
    return Math.hypot(dx, dy);
}

export function computeCumulativeLengths(
    coords: [number, number][],
    cosLatOverride?: number
): {
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
        total += distanceMeters(
            coords[i - 1][0],
            coords[i - 1][1],
            coords[i][0],
            coords[i][1],
            cosLatOverride
        );
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
    byLat: number,
    cosLatOverride?: number
): { distMeters: number; closestLon: number; closestLat: number; t: number } {
    const cosLat =
        cosLatOverride !== undefined
            ? cosLatOverride
            : Math.cos(((ayLat + byLat + pyLat) / 3) * DEG_TO_RAD);
    const scaleX = METERS_PER_DEG_LAT * cosLat;
    const scaleY = METERS_PER_DEG_LAT;

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

export interface SampledEdgePose {
    lon: number;
    lat: number;
    bearingScreenRad: number;
}

/**
 * Zero-allocation in-place edge position sampler for hot simulation loops.
 */
export function sampleEdgePositionInto(
    out: SampledEdgePose,
    edge: DirectedEdge,
    distMeters: number,
    laneIndex: number,
    isLeftHandTraffic: boolean,
    lateralOffsetMeters = 0,
    cosLatOverride?: number
): void {
    const coords = edge.coords;
    const cumLengths = edge.cumLengths;
    const n = coords.length;

    let sampleLon = 0;
    let sampleLat = 0;
    let tangentLon = 1;
    let tangentLat = 0;

    if (n === 1) {
        sampleLon = coords[0][0];
        sampleLat = coords[0][1];
    } else if (n >= 2) {
        const total = cumLengths[n - 1];
        const d = distMeters <= 0 ? 0 : distMeters >= total ? total : distMeters;
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
        const segLen = cumLengths[lo + 1] - startD;
        const ratio = segLen > 1e-6 ? (d - startD) / segLen : 0;
        const a = coords[lo];
        const b = coords[lo + 1];
        tangentLon = b[0] - a[0];
        tangentLat = b[1] - a[1];
        sampleLon = a[0] + tangentLon * ratio;
        sampleLat = a[1] + tangentLat * ratio;
    }

    const cosLat =
        cosLatOverride !== undefined
            ? cosLatOverride
            : Math.max(0.1, Math.cos(sampleLat * DEG_TO_RAD));
    const scaleX = METERS_PER_DEG_LAT * cosLat;
    const dxMeters = tangentLon * scaleX;
    const dyMeters = tangentLat * METERS_PER_DEG_LAT;
    const len = Math.hypot(dxMeters, dyMeters);

    let ux = 1;
    let uy = 0;
    if (len > 1e-6) {
        ux = dxMeters / len;
        uy = dyMeters / len;
    }

    out.bearingScreenRad = Math.atan2(-uy, ux);

    // Right-hand side of travel direction: (uy, -ux); left-hand side: (-uy, ux)
    const sideSign = isLeftHandTraffic ? -1 : 1;
    const laneCenter = (laneIndex - (edge.lanes - 1) * 0.5) * 3.2;
    // Shift outward from centerline on two-way roads; center one-way roads & roundabout rings
    const twoWayShift = edge.isTwoWay ? 2.6 : 0;
    const roadOffset = sideSign * (twoWayShift + laneCenter + lateralOffsetMeters);

    out.lon = sampleLon + (uy * roadOffset) / scaleX;
    out.lat = sampleLat + (-ux * roadOffset) / METERS_PER_DEG_LAT;
}

export function sampleEdgePosition(
    edge: DirectedEdge,
    distMeters: number,
    laneIndex: number,
    isLeftHandTraffic: boolean,
    lateralOffsetMeters = 0,
    cosLatOverride?: number
): SampledEdgePose {
    const out: SampledEdgePose = { lon: 0, lat: 0, bearingScreenRad: 0 };
    sampleEdgePositionInto(
        out,
        edge,
        distMeters,
        laneIndex,
        isLeftHandTraffic,
        lateralOffsetMeters,
        cosLatOverride
    );
    return out;
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
    private syncPromise: Promise<void> | null = null;
    private syncQueued = false;

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
        const metersPerDegLon = METERS_PER_DEG_LAT * Math.cos(lat * DEG_TO_RAD);
        return Math.max(0.05, metersPerDegLon / Math.abs(this.scaleX));
    }

    /**
     * Coalesces concurrent sync calls so high-frequency map pan events never saturate WME SDK RPCs.
     */
    public async syncWithWmeMap(wmeSDK: AsyncWmeSDK): Promise<void> {
        if (this.syncPromise) {
            this.syncQueued = true;
            return this.syncPromise;
        }
        this.syncPromise = this.performSync(wmeSDK);
        try {
            await this.syncPromise;
        } finally {
            this.syncPromise = null;
        }
    }

    private async performSync(wmeSDK: AsyncWmeSDK): Promise<void> {
        do {
            this.syncQueued = false;
            try {
                const [extent, zoom, res] = await Promise.all([
                    wmeSDK.Map.getMapExtent(),
                    wmeSDK.Map.getZoomLevel(),
                    wmeSDK.Map.getMapResolution(),
                ]);
                this.zoomLevel = zoom;
                this.resolution = res;
                if (!extent || extent.length < 4) continue;

                const [west, south, east, north] = extent;
                if (Math.abs(east - west) < 1e-7 || Math.abs(north - south) < 1e-7) continue;

                const [topLeftPx, bottomRightPx] = await Promise.all([
                    wmeSDK.Map.getMapPixelFromLonLat({ lonLat: { lon: west, lat: north } }),
                    wmeSDK.Map.getMapPixelFromLonLat({ lonLat: { lon: east, lat: south } }),
                ]);

                const dLon = east - west;
                const mTop = mercatorY(north);
                const mBottom = mercatorY(south);
                const dMercY = mBottom - mTop;

                if (Math.abs(dLon) < 1e-9 || Math.abs(dMercY) < 1e-9) continue;

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
        } while (this.syncQueued);
    }

    public projectX(lon: number): number {
        return this.originPxX + (lon - this.originLon) * this.scaleX;
    }

    public projectY(lat: number): number {
        return this.originPxY + (mercatorY(lat) - this.originMercY) * this.scaleY;
    }

    public project(lon: number, lat: number): { x: number; y: number } {
        return {
            x: this.projectX(lon),
            y: this.projectY(lat),
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

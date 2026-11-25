import { preloadMoodSprites } from "./assets/moods";
import { distanceMeters, sampleEdgePosition, WebMercatorProjector } from "./geo";
import { describeBugKind } from "./graph";
import { TrafficSimulator } from "./simulator";
import {
    BugKind,
    ChaosHotspot,
    DirectedEdge,
    HoverInfo,
    MIN_SIM_ZOOM,
    SimSettings,
    WazerAgent,
} from "./types";

const WAZER_COLORS = [
    "#38bdf8",
    "#fb7185",
    "#fbbf24",
    "#34d399",
    "#a78bfa",
    "#f97316",
] as const;

function bugShortLabel(kind: BugKind): string {
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

export class SimCanvasRenderer {
    private viewportEl: HTMLElement;
    private canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D;
    private tooltip: HTMLDivElement;
    private projector: WebMercatorProjector;
    private moodSprites: HTMLImageElement[];
    private resizeObserver: ResizeObserver;
    private dpr = 1;
    private reducedMotion = false;
    private hoverInfo: HoverInfo | null = null;
    private lastMouseMapPx: { x: number; y: number } | null = null;

    constructor(viewportEl: HTMLElement, projector: WebMercatorProjector) {
        this.viewportEl = viewportEl;
        this.projector = projector;
        this.moodSprites = preloadMoodSprites();

        if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
            const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
            this.reducedMotion = mq.matches;
            mq.addEventListener("change", (ev) => {
                this.reducedMotion = ev.matches;
            });
        }

        const existingCanvas = document.getElementById("wme-simwaze-canvas");
        if (existingCanvas) existingCanvas.remove();
        const existingTooltip = document.getElementById("wme-simwaze-tooltip");
        if (existingTooltip) existingTooltip.remove();

        this.canvas = document.createElement("canvas");
        this.canvas.id = "wme-simwaze-canvas";
        this.canvas.setAttribute("aria-hidden", "true");
        this.canvas.style.cssText = `
            position: absolute;
            inset: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 650;
        `;

        const ctx = this.canvas.getContext("2d");
        if (!ctx) {
            throw new Error("SimWaze: Failed to acquire 2D canvas context");
        }
        this.ctx = ctx;

        this.tooltip = document.createElement("div");
        this.tooltip.id = "wme-simwaze-tooltip";
        this.tooltip.setAttribute("role", "status");
        this.tooltip.style.cssText = `
            position: absolute;
            display: none;
            pointer-events: none;
            z-index: 660;
            max-width: 240px;
            padding: 6px 9px;
            border-radius: 6px;
            font-size: 11px;
            line-height: 1.35;
            font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
            color: #f8fafc;
            background: rgba(15, 23, 42, 0.92);
            border: 1px solid rgba(148, 163, 184, 0.35);
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        `;

        this.viewportEl.appendChild(this.canvas);
        this.viewportEl.appendChild(this.tooltip);

        this.resize();
        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(this.viewportEl);
    }

    public resize(): void {
        this.dpr = Math.min(2, window.devicePixelRatio || 1);
        const w = Math.max(1, this.viewportEl.clientWidth);
        const h = Math.max(1, this.viewportEl.clientHeight);
        this.canvas.width = Math.round(w * this.dpr);
        this.canvas.height = Math.round(h * this.dpr);
    }

    public setMousePosition(mapX: number | null, mapY: number | null): void {
        if (mapX == null || mapY == null) {
            this.lastMouseMapPx = null;
            this.hoverInfo = null;
            this.tooltip.style.display = "none";
            return;
        }
        this.lastMouseMapPx = { x: mapX, y: mapY };
    }

    public clear(): void {
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.tooltip.style.display = "none";
    }

    public destroy(): void {
        this.resizeObserver.disconnect();
        this.canvas.remove();
        this.tooltip.remove();
    }

    public render(simulator: TrafficSimulator, settings: SimSettings, nowSec: number): void {
        const ctx = this.ctx;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        const graph = simulator.getGraph();
        if (!settings.enabled || !graph || !this.projector.isCalibrated()) {
            this.tooltip.style.display = "none";
            return;
        }

        const zoom = this.projector.getZoomLevel();
        if (zoom < MIN_SIM_ZOOM) {
            this.tooltip.style.display = "none";
            return;
        }

        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        const viewW = this.viewportEl.clientWidth;
        const viewH = this.viewportEl.clientHeight;

        // 1. Congestion Heatmap
        if (settings.showHeatmap) {
            this.drawCongestionHeatmap(ctx, simulator, graph.edges, nowSec, viewW, viewH);
        }

        // Update hover hit-test
        this.updateHover(simulator, viewW, viewH);

        // 2. Hovered Wazer route line
        if (settings.showRoutesOnHover && this.hoverInfo?.wazer) {
            this.drawWazerRoute(ctx, this.hoverInfo.wazer, graph.edges);
        }

        // 3. Tiny Wazers
        const iconSize = this.computeIconSize(zoom);
        const wazers = simulator.getWazers();

        // Draw cruising first, then queued/honking, then burning on top
        for (const w of wazers) {
            const edge = graph.edges.get(w.edgeId);
            if (!edge) continue;
            const pos = sampleEdgePosition(
                edge,
                w.distOnEdge,
                w.laneIndex,
                graph.isLeftHandTraffic,
                w.lateralOffset
            );
            const pt = this.projector.project(pos.lon, pos.lat);
            if (pt.x < -40 || pt.x > viewW + 40 || pt.y < -40 || pt.y > viewH + 40) continue;

            this.drawWazer(
                ctx,
                w,
                pt.x,
                pt.y,
                pos.bearingScreenRad,
                iconSize,
                settings.patienceSeconds,
                nowSec,
                zoom
            );
        }

        // 4. Particles (Smoke, Fire, Horn Sonic Rings, Arrival Sparkles)
        this.drawParticles(ctx, simulator, nowSec);

        // 5. Chaos Hotspot Badges
        if (settings.showBugBadges) {
            for (const h of simulator.getHotspots()) {
                if (h.burningCount === 0 && h.honkingCount === 0 && h.stuckCount < 2) continue;
                const pt = this.projector.project(h.lon, h.lat);
                if (pt.x < -80 || pt.x > viewW + 80 || pt.y < -60 || pt.y > viewH + 60) continue;
                this.drawHotspotBadge(ctx, h, pt.x, pt.y);
            }
        }

        // 6. Floating non-interactive tooltip
        this.updateTooltipDOM(viewW, viewH, graph.isImperial);
    }

    private computeIconSize(zoom: number): number {
        if (zoom <= 12) return 10;
        if (zoom === 13) return 14;
        if (zoom === 14) return 18;
        if (zoom === 15) return 22;
        if (zoom === 16) return 26;
        return Math.min(34, 26 + (zoom - 16) * 1.8);
    }

    private drawCongestionHeatmap(
        ctx: CanvasRenderingContext2D,
        simulator: TrafficSimulator,
        edges: Map<string, DirectedEdge>,
        nowSec: number,
        viewW: number,
        viewH: number
    ): void {
        const occ = simulator.getEdgeOccupancy();
        if (occ.size === 0) return;

        // Gentle <= 1.2 Hz pulse (well under WCAG 2.3.1 3 flashes/sec threshold)
        const pulse = this.reducedMotion ? 0.5 : 0.35 + 0.25 * Math.sin(nowSec * Math.PI * 1.5);

        ctx.save();
        ctx.lineCap = "round";
        ctx.lineJoin = "round";

        for (const [edgeId, count] of occ) {
            if (count <= 0) continue;
            const edge = edges.get(edgeId);
            if (!edge || edge.maxCapacity <= 0) continue;
            const ratio = count / edge.maxCapacity;
            if (ratio < 0.35) continue;

            const first = this.projector.project(edge.coords[0][0], edge.coords[0][1]);
            const last = this.projector.project(
                edge.coords[edge.coords.length - 1][0],
                edge.coords[edge.coords.length - 1][1]
            );
            if (
                Math.max(first.x, last.x) < -40 ||
                Math.min(first.x, last.x) > viewW + 40 ||
                Math.max(first.y, last.y) < -40 ||
                Math.min(first.y, last.y) > viewH + 40
            ) {
                continue;
            }

            let strokeColor: string;
            let width: number;
            if (ratio >= 0.85) {
                strokeColor = `rgba(239, 68, 68, ${pulse.toFixed(2)})`;
                width = 9;
            } else if (ratio >= 0.6) {
                strokeColor = "rgba(249, 115, 22, 0.34)";
                width = 7;
            } else {
                strokeColor = "rgba(245, 158, 11, 0.24)";
                width = 5;
            }

            ctx.strokeStyle = strokeColor;
            ctx.lineWidth = width;
            ctx.beginPath();
            for (let i = 0; i < edge.coords.length; i++) {
                const pt = this.projector.project(edge.coords[i][0], edge.coords[i][1]);
                if (i === 0) ctx.moveTo(pt.x, pt.y);
                else ctx.lineTo(pt.x, pt.y);
            }
            ctx.stroke();
        }
        ctx.restore();
    }

    private drawWazerRoute(
        ctx: CanvasRenderingContext2D,
        wazer: WazerAgent,
        edges: Map<string, DirectedEdge>
    ): void {
        ctx.save();
        ctx.strokeStyle = wazer.terminalBug ? "rgba(239, 68, 68, 0.85)" : "rgba(56, 189, 248, 0.9)";
        ctx.lineWidth = 3.5;
        ctx.setLineDash([7, 5]);
        ctx.lineCap = "round";

        ctx.beginPath();
        let started = false;
        for (let i = wazer.routeIndex; i < wazer.routeEdgeIds.length; i++) {
            const edge = edges.get(wazer.routeEdgeIds[i]);
            if (!edge) continue;
            for (const c of edge.coords) {
                const pt = this.projector.project(c[0], c[1]);
                if (!started) {
                    ctx.moveTo(pt.x, pt.y);
                    started = true;
                } else {
                    ctx.lineTo(pt.x, pt.y);
                }
            }
        }
        ctx.stroke();

        if (wazer.terminalBug) {
            const bugPt = this.projector.project(wazer.terminalBug.lon, wazer.terminalBug.lat);
            ctx.setLineDash([]);
            ctx.fillStyle = "#ef4444";
            ctx.strokeStyle = "#ffffff";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(bugPt.x, bugPt.y, 7, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }

        ctx.restore();
    }

    private drawWazer(
        ctx: CanvasRenderingContext2D,
        w: WazerAgent,
        x: number,
        y: number,
        bearingRad: number,
        size: number,
        patienceSec: number,
        nowSec: number,
        zoom: number
    ): void {
        ctx.save();

        const isStuck = w.state !== "CRUISING";
        const wobbleX =
            !this.reducedMotion && w.state === "HONKING"
                ? Math.sin(nowSec * 14 + w.id) * 1.4
                : 0;
        const bobY =
            !this.reducedMotion && w.state === "CRUISING"
                ? Math.sin(nowSec * 7 + w.id * 1.7) * 0.9
                : 0;

        const cx = x + wobbleX;
        const cy = y + bobY;

        // Compact dot mode at zoom 12
        if (zoom <= 12) {
            ctx.fillStyle =
                w.state === "ON_FIRE"
                    ? "#ef4444"
                    : w.state === "HONKING"
                      ? "#f59e0b"
                      : WAZER_COLORS[w.moodIndex % WAZER_COLORS.length];
            ctx.strokeStyle = "#0f172a";
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(cx, cy, 4.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            ctx.restore();
            return;
        }

        // Ground shadow
        ctx.fillStyle = "rgba(15, 23, 42, 0.34)";
        ctx.beginPath();
        ctx.ellipse(cx, cy + size * 0.36, size * 0.36, size * 0.16, 0, 0, Math.PI * 2);
        ctx.fill();

        // Subtle forward direction chevron behind/ahead of Wazer
        const dirX = Math.cos(bearingRad);
        const dirY = Math.sin(bearingRad);
        const noseDist = size * 0.48;
        ctx.fillStyle = isStuck ? "#ef4444" : "#38bdf8";
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(cx + dirX * noseDist, cy + dirY * noseDist, Math.max(2.2, size * 0.12), 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // Patience arc ring when queued / honking / burning
        if (isStuck && w.stuckSeconds > 1.8) {
            const frac = Math.min(1, w.stuckSeconds / Math.max(3, patienceSec));
            ctx.strokeStyle =
                w.state === "ON_FIRE" ? "#ef4444" : w.state === "HONKING" ? "#f97316" : "#fbbf24";
            ctx.lineWidth = 2.4;
            ctx.beginPath();
            ctx.arc(cx, cy, size * 0.56, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
            ctx.stroke();
        }

        // Draw Waze Mood PNG sprite (or crisp procedural fallback if still decoding)
        // Flip horizontally when driving left/west; keep default orientation when driving right/east
        ctx.save();
        ctx.translate(cx, cy);
        if (w.facingLeft) {
            ctx.scale(-1, 1);
        }
        const sprite = this.moodSprites[w.moodIndex % this.moodSprites.length];
        if (sprite && sprite.complete && sprite.naturalWidth > 0) {
            const ratio = sprite.naturalHeight / Math.max(1, sprite.naturalWidth);
            const drawW = size;
            const drawH = size * ratio;
            ctx.drawImage(sprite, -drawW * 0.5, -drawH * 0.5, drawW, drawH);
        } else {
            // Procedural Wazer fallback badge
            const r = size * 0.4;
            ctx.fillStyle = WAZER_COLORS[w.moodIndex % WAZER_COLORS.length];
            ctx.strokeStyle = "#0f172a";
            ctx.lineWidth = 1.8;
            ctx.beginPath();
            ctx.arc(0, 0, r, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = "#0f172a";
            ctx.beginPath();
            ctx.arc(-r * 0.28, -r * 0.1, 1.5, 0, Math.PI * 2);
            ctx.arc(r * 0.28, -r * 0.1, 1.5, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();

        // Tiny horn speech bubble
        if (w.hornBubbleTimer > 0 && w.state !== "ON_FIRE") {
            ctx.font = "bold 9px system-ui, -apple-system, sans-serif";
            const tw = ctx.measureText(w.hornText).width + 8;
            const bx = cx - tw / 2;
            const by = cy - size * 0.72 - 14;
            ctx.fillStyle = "#fef08a";
            ctx.strokeStyle = "#854d0e";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.roundRect(bx, by, tw, 13, 4);
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = "#422006";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(w.hornText, cx, by + 6.5);
        }

        // Fire crown when ON_FIRE
        if (w.state === "ON_FIRE") {
            const flameFlicker = this.reducedMotion ? 1 : 0.9 + 0.18 * Math.sin(nowSec * 9 + w.id);
            const fh = size * 0.55 * flameFlicker;
            ctx.fillStyle = "rgba(239, 68, 68, 0.92)";
            ctx.beginPath();
            ctx.moveTo(cx - size * 0.28, cy - size * 0.18);
            ctx.quadraticCurveTo(cx - size * 0.15, cy - size * 0.25 - fh, cx, cy - size * 0.28 - fh);
            ctx.quadraticCurveTo(cx + size * 0.18, cy - size * 0.22 - fh * 0.8, cx + size * 0.28, cy - size * 0.18);
            ctx.closePath();
            ctx.fill();

            ctx.fillStyle = "rgba(250, 204, 21, 0.95)";
            ctx.beginPath();
            ctx.moveTo(cx - size * 0.14, cy - size * 0.16);
            ctx.quadraticCurveTo(cx, cy - size * 0.24 - fh * 0.65, cx + size * 0.14, cy - size * 0.16);
            ctx.closePath();
            ctx.fill();
        }

        ctx.restore();
    }

    private drawParticles(
        ctx: CanvasRenderingContext2D,
        simulator: TrafficSimulator,
        _nowSec: number
    ): void {
        const particles = simulator.getParticles();
        if (particles.length === 0) return;

        ctx.save();
        for (const p of particles) {
            const t = Math.min(1, p.age / p.maxAge);
            const alpha = Math.max(0, 1 - t);
            const pt = this.projector.project(p.xLon, p.yLat);
            const motionMult = this.reducedMotion ? 0.2 : 1;
            const px = pt.x + p.vxPx * p.age * motionMult;
            const py = pt.y + p.vyPx * p.age * motionMult;

            if (p.kind === "RING") {
                ctx.strokeStyle = `rgba(250, 204, 21, ${(alpha * 0.85).toFixed(2)})`;
                ctx.lineWidth = 1.8;
                ctx.beginPath();
                ctx.arc(pt.x, pt.y, 6 + t * p.size, 0, Math.PI * 2);
                ctx.stroke();
            } else if (p.kind === "ARRIVE") {
                ctx.strokeStyle = `rgba(52, 211, 153, ${alpha.toFixed(2)})`;
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.arc(pt.x, pt.y, 4 + t * 14, 0, Math.PI * 2);
                ctx.stroke();
            } else if (p.kind === "FIRE") {
                ctx.fillStyle = `rgba(249, 115, 22, ${(alpha * 0.85).toFixed(2)})`;
                ctx.beginPath();
                ctx.arc(px, py, p.size * (1 - t * 0.5), 0, Math.PI * 2);
                ctx.fill();
            } else {
                // SMOKE
                ctx.fillStyle = `rgba(100, 116, 139, ${(alpha * 0.45).toFixed(2)})`;
                ctx.beginPath();
                ctx.arc(px, py, p.size * (0.7 + t * 0.9), 0, Math.PI * 2);
                ctx.fill();
            }
        }
        ctx.restore();
    }

    private drawHotspotBadge(
        ctx: CanvasRenderingContext2D,
        h: ChaosHotspot,
        x: number,
        y: number
    ): void {
        ctx.save();
        const prefix = h.burningCount > 0 ? "🔥" : "⚠";
        const label = `${prefix} ${bugShortLabel(h.kind)} (${h.stuckCount})`;
        ctx.font = "600 10px system-ui, -apple-system, sans-serif";
        const tw = ctx.measureText(label).width + 14;
        const bx = x - tw / 2;
        const by = y - 34;

        ctx.fillStyle = h.burningCount > 0 ? "rgba(185, 28, 28, 0.92)" : "rgba(180, 83, 9, 0.92)";
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.roundRect(bx, by, tw, 18, 9);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(label, x, by + 9.5);
        ctx.restore();
    }

    private updateHover(simulator: TrafficSimulator, viewW: number, viewH: number): void {
        if (!this.lastMouseMapPx) {
            this.hoverInfo = null;
            return;
        }
        const mx = this.lastMouseMapPx.x;
        const my = this.lastMouseMapPx.y;
        const graph = simulator.getGraph();
        if (!graph) {
            this.hoverInfo = null;
            return;
        }

        // Check hotspots first
        let bestHotspot: ChaosHotspot | null = null;
        let bestHotspotDist = 24;
        for (const h of simulator.getHotspots()) {
            const pt = this.projector.project(h.lon, h.lat);
            const d = Math.hypot(pt.x - mx, pt.y - my);
            if (d < bestHotspotDist) {
                bestHotspotDist = d;
                bestHotspot = h;
            }
        }

        // Check individual Wazers
        let bestWazer: WazerAgent | null = null;
        let bestWazerDist = 20;
        for (const w of simulator.getWazers()) {
            const edge = graph.edges.get(w.edgeId);
            if (!edge) continue;
            const pos = sampleEdgePosition(
                edge,
                w.distOnEdge,
                w.laneIndex,
                graph.isLeftHandTraffic,
                w.lateralOffset
            );
            const pt = this.projector.project(pos.lon, pos.lat);
            if (pt.x < -30 || pt.x > viewW + 30 || pt.y < -30 || pt.y > viewH + 30) continue;
            const d = Math.hypot(pt.x - mx, pt.y - my);
            if (d < bestWazerDist) {
                bestWazerDist = d;
                bestWazer = w;
            }
        }

        if (bestWazer) {
            this.hoverInfo = { kind: "WAZER", screenX: mx, screenY: my, wazer: bestWazer };
        } else if (bestHotspot) {
            this.hoverInfo = {
                kind: "HOTSPOT",
                screenX: mx,
                screenY: my,
                hotspot: bestHotspot,
            };
        } else {
            this.hoverInfo = null;
        }
    }

    private updateTooltipDOM(viewW: number, viewH: number, isImperial: boolean): void {
        const info = this.hoverInfo;
        if (!info) {
            this.tooltip.style.display = "none";
            return;
        }

        this.tooltip.textContent = "";

        const titleEl = document.createElement("div");
        titleEl.style.fontWeight = "700";
        titleEl.style.marginBottom = "2px";

        const bodyEl = document.createElement("div");
        bodyEl.style.color = "#cbd5e1";

        if (info.kind === "WAZER" && info.wazer) {
            const w = info.wazer;
            const kmh = Math.round(w.speedMps * 3.6);
            const speedText = isImperial ? `${Math.round(kmh / 1.60934)} mph` : `${kmh} km/h`;
            const stateBadge =
                w.state === "ON_FIRE"
                    ? "🔥 On Fire"
                    : w.state === "HONKING"
                      ? "📣 Honking"
                      : w.state === "QUEUED"
                        ? "⏳ Queued"
                        : "🚗 Cruising";

            titleEl.textContent = `Wazer #${w.id} · ${stateBadge} (${speedText})`;
            bodyEl.textContent = w.terminalBug
                ? `To: ${w.destStreetName} — Blocked: ${w.terminalBug.message}`
                : `Heading to: ${w.destStreetName}`;
        } else if (info.kind === "HOTSPOT" && info.hotspot) {
            const h = info.hotspot;
            titleEl.textContent = `${describeBugKind(h.kind)} (${h.stuckCount} stuck)`;
            bodyEl.textContent = h.description;
        }

        this.tooltip.appendChild(titleEl);
        this.tooltip.appendChild(bodyEl);
        this.tooltip.style.display = "block";

        const left = Math.min(viewW - 250, Math.max(8, info.screenX + 14));
        const top = Math.min(viewH - 80, Math.max(8, info.screenY + 14));
        this.tooltip.style.left = `${left}px`;
        this.tooltip.style.top = `${top}px`;
    }
}

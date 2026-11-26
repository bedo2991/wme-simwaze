import { preloadMoodSprites } from "./assets/moods";
import { WebMercatorProjector } from "./geo";
import { TrafficSimulator } from "./simulator";
import {
    bugShortLabel,
    ChaosHotspot,
    describeBugKind,
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

const HORN_FONT = "bold 9px system-ui, -apple-system, sans-serif";
const BADGE_FONT = "600 10px system-ui, -apple-system, sans-serif";

interface ProjectedWazer {
    wazer: WazerAgent;
    x: number;
    y: number;
}

export class SimCanvasRenderer {
    private viewportEl: HTMLElement;
    private canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D;
    private tooltip: HTMLDivElement;
    private tooltipTitleEl: HTMLDivElement;
    private tooltipBodyEl: HTMLDivElement;
    private projector: WebMercatorProjector;
    private moodSprites: HTMLImageElement[] | null = null;
    private resizeObserver: ResizeObserver;
    private dpr = 1;
    private reducedMotion = false;
    private hoverInfo: HoverInfo | null = null;
    private lastMouseMapPx: { x: number; y: number } | null = null;

    // Reusable render-pass buffers & caches
    private cruisingLayer: ProjectedWazer[] = [];
    private queuedLayer: ProjectedWazer[] = [];
    private burningLayer: ProjectedWazer[] = [];
    private projectedPool: ProjectedWazer[] = [];
    private textWidthCache = new Map<string, number>();

    private lastTooltipVisible = false;
    private lastTooltipTitle = "";
    private lastTooltipBody = "";
    private lastTooltipLeft = -1;
    private lastTooltipTop = -1;

    constructor(viewportEl: HTMLElement, projector: WebMercatorProjector) {
        this.viewportEl = viewportEl;
        this.projector = projector;

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
            top: 0;
            left: 0;
            display: none;
            pointer-events: none;
            will-change: transform;
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

        this.tooltipTitleEl = document.createElement("div");
        this.tooltipTitleEl.style.fontWeight = "700";
        this.tooltipTitleEl.style.marginBottom = "2px";

        this.tooltipBodyEl = document.createElement("div");
        this.tooltipBodyEl.style.color = "#cbd5e1";

        this.tooltip.appendChild(this.tooltipTitleEl);
        this.tooltip.appendChild(this.tooltipBodyEl);

        this.viewportEl.appendChild(this.canvas);
        this.viewportEl.appendChild(this.tooltip);

        this.resize();
        this.resizeObserver = new ResizeObserver(() => this.resize());
        this.resizeObserver.observe(this.viewportEl);
    }

    private getMoodSprites(): HTMLImageElement[] {
        if (!this.moodSprites) {
            this.moodSprites = preloadMoodSprites();
        }
        return this.moodSprites;
    }

    private measureCachedText(ctx: CanvasRenderingContext2D, font: string, text: string): number {
        const key = `${font}|${text}`;
        const cached = this.textWidthCache.get(key);
        if (cached !== undefined) return cached;
        if (this.textWidthCache.size >= 256) {
            this.textWidthCache.clear();
        }
        ctx.font = font;
        const w = ctx.measureText(text).width;
        this.textWidthCache.set(key, w);
        return w;
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
            this.hideTooltip();
            return;
        }
        if (this.lastMouseMapPx) {
            this.lastMouseMapPx.x = mapX;
            this.lastMouseMapPx.y = mapY;
        } else {
            this.lastMouseMapPx = { x: mapX, y: mapY };
        }
    }

    private hideTooltip(): void {
        if (this.lastTooltipVisible) {
            this.tooltip.style.display = "none";
            this.lastTooltipVisible = false;
        }
    }

    public clear(): void {
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.hideTooltip();
    }

    public destroy(): void {
        this.resizeObserver.disconnect();
        this.canvas.remove();
        this.tooltip.remove();
    }

    private acquireProjected(wazer: WazerAgent, x: number, y: number): ProjectedWazer {
        const item = this.projectedPool.pop();
        if (item) {
            item.wazer = wazer;
            item.x = x;
            item.y = y;
            return item;
        }
        return { wazer, x, y };
    }

    private recycleLayer(layer: ProjectedWazer[]): void {
        for (let i = 0; i < layer.length; i++) {
            this.projectedPool.push(layer[i]);
        }
        layer.length = 0;
    }

    public render(simulator: TrafficSimulator, settings: SimSettings, nowSec: number): void {
        const ctx = this.ctx;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        const graph = simulator.getGraph();
        if (!settings.enabled || !graph || !this.projector.isCalibrated()) {
            this.hideTooltip();
            return;
        }

        const zoom = this.projector.getZoomLevel();
        if (zoom < MIN_SIM_ZOOM) {
            this.hideTooltip();
            return;
        }

        const sprites = this.getMoodSprites();
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        const viewW = this.viewportEl.clientWidth;
        const viewH = this.viewportEl.clientHeight;

        // 1. Congestion Heatmap
        if (settings.showHeatmap) {
            this.drawCongestionHeatmap(ctx, simulator, graph.edges, nowSec, viewW, viewH);
        }

        // Single-pass Wazer projection + z-layer bucketing + hover hit-test
        const mouse = this.lastMouseMapPx;
        const hasMouse = mouse !== null;
        const mx = mouse ? mouse.x : 0;
        const my = mouse ? mouse.y : 0;
        let bestWazer: WazerAgent | null = null;
        let bestWazerDistSq = 20 * 20;

        const wazers = simulator.getWazers();
        for (let i = 0; i < wazers.length; i++) {
            const w = wazers[i];
            const px = this.projector.projectX(w.lon);
            const py = this.projector.projectY(w.lat);
            if (px < -40 || px > viewW + 40 || py < -40 || py > viewH + 40) continue;

            if (hasMouse) {
                const dx = px - mx;
                const dy = py - my;
                const dSq = dx * dx + dy * dy;
                if (dSq < bestWazerDistSq) {
                    bestWazerDistSq = dSq;
                    bestWazer = w;
                }
            }

            const proj = this.acquireProjected(w, px, py);
            if (w.state === "ON_FIRE") {
                this.burningLayer.push(proj);
            } else if (w.state === "CRUISING") {
                this.cruisingLayer.push(proj);
            } else {
                this.queuedLayer.push(proj);
            }
        }

        // Hotspot hover hit-test (only if no Wazer matched under cursor)
        let bestHotspot: ChaosHotspot | null = null;
        if (hasMouse && !bestWazer) {
            let bestHotspotDistSq = 24 * 24;
            const hotspots = simulator.getHotspots();
            for (let i = 0; i < hotspots.length; i++) {
                const h = hotspots[i];
                const hx = this.projector.projectX(h.lon);
                const hy = this.projector.projectY(h.lat);
                const dx = hx - mx;
                const dy = hy - my;
                const dSq = dx * dx + dy * dy;
                if (dSq < bestHotspotDistSq) {
                    bestHotspotDistSq = dSq;
                    bestHotspot = h;
                }
            }
        }

        if (bestWazer) {
            this.hoverInfo = { kind: "WAZER", screenX: mx, screenY: my, wazer: bestWazer };
        } else if (bestHotspot) {
            this.hoverInfo = { kind: "HOTSPOT", screenX: mx, screenY: my, hotspot: bestHotspot };
        } else {
            this.hoverInfo = null;
        }

        // 2. Hovered Wazer route line
        if (settings.showRoutesOnHover && bestWazer) {
            this.drawWazerRoute(ctx, bestWazer, graph.edges);
        }

        // 3. Tiny Wazers rendered in true z-order: cruising -> queued/honking -> burning
        const iconSize = this.computeIconSize(zoom);
        const layers = [this.cruisingLayer, this.queuedLayer, this.burningLayer] as const;
        for (let li = 0; li < layers.length; li++) {
            const layer = layers[li];
            for (let i = 0; i < layer.length; i++) {
                const item = layer[i];
                this.drawWazer(
                    ctx,
                    sprites,
                    item.wazer,
                    item.x,
                    item.y,
                    iconSize,
                    settings.patienceSeconds,
                    nowSec,
                    zoom
                );
            }
            this.recycleLayer(layer);
        }

        // 4. Particles (Smoke, Fire, Horn Sonic Rings, Arrival Sparkles)
        this.drawParticles(ctx, simulator);

        // 5. Chaos Hotspot Badges
        if (settings.showBugBadges) {
            const hotspots = simulator.getHotspots();
            for (let i = 0; i < hotspots.length; i++) {
                const h = hotspots[i];
                if (h.burningCount === 0 && h.honkingCount === 0 && h.stuckCount < 2) continue;
                const hx = this.projector.projectX(h.lon);
                const hy = this.projector.projectY(h.lat);
                if (hx < -80 || hx > viewW + 80 || hy < -60 || hy > viewH + 60) continue;
                this.drawHotspotBadge(ctx, h, hx, hy);
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

        const pulse = this.reducedMotion ? 0.5 : 0.35 + 0.25 * Math.sin(nowSec * Math.PI * 1.5);
        const highCongestionColor = `rgba(239, 68, 68, ${pulse.toFixed(2)})`;

        ctx.save();
        ctx.lineCap = "round";
        ctx.lineJoin = "round";

        for (const [edgeId, count] of occ) {
            if (count <= 0) continue;
            const edge = edges.get(edgeId);
            if (!edge || edge.maxCapacity <= 0) continue;
            const ratio = count / edge.maxCapacity;
            if (ratio < 0.35) continue;

            // Compute exact projected bounds across polyline vertices
            const coords = edge.coords;
            let minX = Infinity;
            let maxX = -Infinity;
            let minY = Infinity;
            let maxY = -Infinity;
            for (let i = 0; i < coords.length; i++) {
                const px = this.projector.projectX(coords[i][0]);
                const py = this.projector.projectY(coords[i][1]);
                if (px < minX) minX = px;
                if (px > maxX) maxX = px;
                if (py < minY) minY = py;
                if (py > maxY) maxY = py;
            }
            if (maxX < -40 || minX > viewW + 40 || maxY < -40 || minY > viewH + 40) {
                continue;
            }

            if (ratio >= 0.85) {
                ctx.strokeStyle = highCongestionColor;
                ctx.lineWidth = 9;
            } else if (ratio >= 0.6) {
                ctx.strokeStyle = "rgba(249, 115, 22, 0.34)";
                ctx.lineWidth = 7;
            } else {
                ctx.strokeStyle = "rgba(245, 158, 11, 0.24)";
                ctx.lineWidth = 5;
            }

            ctx.beginPath();
            for (let i = 0; i < coords.length; i++) {
                const px = this.projector.projectX(coords[i][0]);
                const py = this.projector.projectY(coords[i][1]);
                if (i === 0) ctx.moveTo(px, py);
                else ctx.lineTo(px, py);
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
            for (let ci = 0; ci < edge.coords.length; ci++) {
                const c = edge.coords[ci];
                const px = this.projector.projectX(c[0]);
                const py = this.projector.projectY(c[1]);
                if (!started) {
                    ctx.moveTo(px, py);
                    started = true;
                } else {
                    ctx.lineTo(px, py);
                }
            }
        }
        ctx.stroke();

        if (wazer.terminalBug) {
            const bugX = this.projector.projectX(wazer.terminalBug.lon);
            const bugY = this.projector.projectY(wazer.terminalBug.lat);
            ctx.setLineDash([]);
            ctx.fillStyle = "#ef4444";
            ctx.strokeStyle = "#ffffff";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(bugX, bugY, 7, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }

        ctx.restore();
    }

    private drawWazer(
        ctx: CanvasRenderingContext2D,
        sprites: HTMLImageElement[],
        w: WazerAgent,
        x: number,
        y: number,
        size: number,
        patienceSec: number,
        nowSec: number,
        zoom: number
    ): void {
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
            return;
        }

        // Ground shadow
        ctx.fillStyle = "rgba(15, 23, 42, 0.34)";
        ctx.beginPath();
        ctx.ellipse(cx, cy + size * 0.36, size * 0.36, size * 0.16, 0, 0, Math.PI * 2);
        ctx.fill();

        // Subtle forward direction dot
        const dirX = Math.cos(w.bearingScreenRad);
        const dirY = Math.sin(w.bearingScreenRad);
        const noseDist = size * 0.48;
        ctx.fillStyle = isStuck ? "#ef4444" : "#38bdf8";
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(
            cx + dirX * noseDist,
            cy + dirY * noseDist,
            Math.max(2.2, size * 0.12),
            0,
            Math.PI * 2
        );
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

        // Draw Waze Mood PNG sprite using direct transform instead of nested save/restore
        const sprite = sprites.length > 0 ? sprites[w.moodIndex % sprites.length] : undefined;
        if (sprite && sprite.complete && sprite.naturalWidth > 0) {
            const ratio = sprite.naturalHeight / Math.max(1, sprite.naturalWidth);
            const drawW = size;
            const drawH = size * ratio;
            if (w.facingLeft) {
                ctx.setTransform(-this.dpr, 0, 0, this.dpr, cx * this.dpr, cy * this.dpr);
                ctx.drawImage(sprite, -drawW * 0.5, -drawH * 0.5, drawW, drawH);
                ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
            } else {
                ctx.drawImage(sprite, cx - drawW * 0.5, cy - drawH * 0.5, drawW, drawH);
            }
        } else {
            const r = size * 0.4;
            ctx.fillStyle = WAZER_COLORS[w.moodIndex % WAZER_COLORS.length];
            ctx.strokeStyle = "#0f172a";
            ctx.lineWidth = 1.8;
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = "#0f172a";
            ctx.beginPath();
            ctx.arc(cx - r * 0.28, cy - r * 0.1, 1.5, 0, Math.PI * 2);
            ctx.arc(cx + r * 0.28, cy - r * 0.1, 1.5, 0, Math.PI * 2);
            ctx.fill();
        }

        // Tiny horn speech bubble (with cached text measurement)
        if (w.hornBubbleTimer > 0 && w.state !== "ON_FIRE") {
            const tw = this.measureCachedText(ctx, HORN_FONT, w.hornText) + 8;
            const bx = cx - tw / 2;
            const by = cy - size * 0.72 - 14;
            ctx.fillStyle = "#fef08a";
            ctx.strokeStyle = "#854d0e";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.roundRect(bx, by, tw, 13, 4);
            ctx.fill();
            ctx.stroke();
            ctx.font = HORN_FONT;
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
            ctx.quadraticCurveTo(
                cx + size * 0.18,
                cy - size * 0.22 - fh * 0.8,
                cx + size * 0.28,
                cy - size * 0.18
            );
            ctx.closePath();
            ctx.fill();

            ctx.fillStyle = "rgba(250, 204, 21, 0.95)";
            ctx.beginPath();
            ctx.moveTo(cx - size * 0.14, cy - size * 0.16);
            ctx.quadraticCurveTo(
                cx,
                cy - size * 0.24 - fh * 0.65,
                cx + size * 0.14,
                cy - size * 0.16
            );
            ctx.closePath();
            ctx.fill();
        }
    }

    private drawParticles(ctx: CanvasRenderingContext2D, simulator: TrafficSimulator): void {
        const particles = simulator.getParticles();
        if (particles.length === 0) return;

        const motionMult = this.reducedMotion ? 0.2 : 1;
        ctx.save();

        for (let i = 0; i < particles.length; i++) {
            const p = particles[i];
            const t = Math.min(1, p.age / p.maxAge);
            const alpha = Math.max(0, 1 - t);
            if (alpha <= 0.01) continue;

            const baseX = this.projector.projectX(p.xLon);
            const baseY = this.projector.projectY(p.yLat);
            const px = baseX + p.vxPx * p.age * motionMult;
            const py = baseY + p.vyPx * p.age * motionMult;

            if (p.kind === "RING") {
                ctx.globalAlpha = alpha * 0.85;
                ctx.strokeStyle = "#facc15";
                ctx.lineWidth = 1.8;
                ctx.beginPath();
                ctx.arc(baseX, baseY, 6 + t * p.size, 0, Math.PI * 2);
                ctx.stroke();
            } else if (p.kind === "ARRIVE") {
                ctx.globalAlpha = alpha;
                ctx.strokeStyle = "#34d399";
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.arc(baseX, baseY, 4 + t * 14, 0, Math.PI * 2);
                ctx.stroke();
            } else if (p.kind === "FIRE") {
                ctx.globalAlpha = alpha * 0.85;
                ctx.fillStyle = "#f97316";
                ctx.beginPath();
                ctx.arc(px, py, p.size * (1 - t * 0.5), 0, Math.PI * 2);
                ctx.fill();
            } else {
                ctx.globalAlpha = alpha * 0.45;
                ctx.fillStyle = "#64748b";
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
        const prefix = h.burningCount > 0 ? "🔥" : "⚠";
        const label = `${prefix} ${bugShortLabel(h.kind)} (${h.stuckCount})`;
        const tw = this.measureCachedText(ctx, BADGE_FONT, label) + 14;
        const bx = x - tw / 2;
        const by = y - 34;

        ctx.fillStyle = h.burningCount > 0 ? "rgba(185, 28, 28, 0.92)" : "rgba(180, 83, 9, 0.92)";
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.roundRect(bx, by, tw, 18, 9);
        ctx.fill();
        ctx.stroke();

        ctx.font = BADGE_FONT;
        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(label, x, by + 9.5);
    }

    private updateTooltipDOM(viewW: number, viewH: number, isImperial: boolean): void {
        const info = this.hoverInfo;
        if (!info) {
            this.hideTooltip();
            return;
        }

        let title = "";
        let body = "";

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

            title = `Wazer #${w.id} · ${stateBadge} (${speedText})`;
            body = w.terminalBug
                ? `To: ${w.destStreetName} — Blocked: ${w.terminalBug.message}`
                : `Heading to: ${w.destStreetName}`;
        } else if (info.kind === "HOTSPOT" && info.hotspot) {
            const h = info.hotspot;
            title = `${describeBugKind(h.kind)} (${h.stuckCount} stuck)`;
            body = h.description;
        }

        if (title !== this.lastTooltipTitle) {
            this.tooltipTitleEl.textContent = title;
            this.lastTooltipTitle = title;
        }
        if (body !== this.lastTooltipBody) {
            this.tooltipBodyEl.textContent = body;
            this.lastTooltipBody = body;
        }
        if (!this.lastTooltipVisible) {
            this.tooltip.style.display = "block";
            this.lastTooltipVisible = true;
        }

        const left = Math.round(Math.min(viewW - 250, Math.max(8, info.screenX + 14)));
        const top = Math.round(Math.min(viewH - 80, Math.max(8, info.screenY + 14)));
        if (left !== this.lastTooltipLeft || top !== this.lastTooltipTop) {
            this.tooltip.style.transform = `translate3d(${left}px, ${top}px, 0)`;
            this.lastTooltipLeft = left;
            this.lastTooltipTop = top;
        }
    }
}

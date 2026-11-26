import { AsyncWmeSDK } from "wme-sdk-typings";
import { describeBugKind } from "./graph";
import { ROAD_LEGEND_ITEMS } from "./roadProfiles";
import { formatLocalDateTimeInputValue } from "./timeEval";
import { ChaosHotspot, MIN_SIM_ZOOM, SimSettings, SimStats } from "./types";

export interface SimUICallbacks {
    onSettingsChange: (next: SimSettings) => void;
    onClearAll: () => void;
    onRescanMap: () => void;
}

const STYLE_ID = "wme-simwaze-styles";

export class SimSidebarUI {
    private wmeSDK: AsyncWmeSDK;
    private settings: SimSettings;
    private callbacks: SimUICallbacks;

    private rootEl: HTMLDivElement | null = null;
    private liveRegionEl: HTMLElement | null = null;
    private isTelemetryVisible = true;

    private enabledToggle: HTMLInputElement | null = null;
    private pauseBtn: HTMLButtonElement | null = null;
    private soundToggle: HTMLInputElement | null = null;
    private zoomWarningEl: HTMLDivElement | null = null;
    private evalDateTimeInput: HTMLInputElement | null = null;
    private evalStatusEl: HTMLElement | null = null;
    private evalClearBtn: HTMLButtonElement | null = null;

    private statActiveEl: HTMLElement | null = null;
    private statJamEl: HTMLElement | null = null;
    private statFireEl: HTMLElement | null = null;
    private statArrivedEl: HTMLElement | null = null;
    private hotspotListEl: HTMLDivElement | null = null;
    private lastHotspotSignature = "";

    constructor(wmeSDK: AsyncWmeSDK, settings: SimSettings, callbacks: SimUICallbacks) {
        this.wmeSDK = wmeSDK;
        this.settings = { ...settings };
        this.callbacks = callbacks;
    }

    public async mount(version: string): Promise<void> {
        const { tabLabel, tabPane } = await this.wmeSDK.Sidebar.registerScriptTab();
        tabLabel.textContent = "SimWaze";
        tabLabel.title = "SimWaze — Live Traffic & Chaos Simulator";

        await this.wmeSDK.LayerSwitcher.addLayerCheckbox({
            name: "SimWaze Live Traffic",
            isChecked: this.settings.enabled,
        });

        this.injectStyles();

        const root = document.createElement("div");
        root.className = "wme-simwaze-panel";
        root.innerHTML = this.buildStaticMarkup(version);
        tabPane.appendChild(root);
        this.rootEl = root;

        this.bindElements(root);
        this.setupVisibilityPause(root);
    }

    public syncEnabledFromLayer(enabled: boolean): void {
        this.settings.enabled = enabled;
        if (this.enabledToggle) {
            this.enabledToggle.checked = enabled;
        }
        this.updatePauseButtonLabel();
    }

    public setZoomWarning(visible: boolean, currentZoom?: number): void {
        if (!this.zoomWarningEl) return;
        if (visible) {
            this.zoomWarningEl.hidden = false;
            this.zoomWarningEl.textContent = `Zoom in to level ${MIN_SIM_ZOOM}+ to run traffic — segment connections are not loaded at zoom ${currentZoom ?? "?"}.`;
        } else {
            this.zoomWarningEl.hidden = true;
        }
    }

    public updateTelemetry(stats: SimStats, hotspots: readonly ChaosHotspot[]): void {
        if (!this.isTelemetryVisible) return;

        if (this.statActiveEl) this.statActiveEl.textContent = String(stats.activeWazers);
        if (this.statJamEl) {
            this.statJamEl.textContent = String(stats.queuedCount + stats.honkingCount);
        }
        if (this.statFireEl) this.statFireEl.textContent = String(stats.burningCount);
        if (this.statArrivedEl) this.statArrivedEl.textContent = String(stats.arrivedCount);

        const listEl = this.hotspotListEl;
        if (!listEl) return;

        const sig = hotspots
            .map((h) => `${h.id}:${h.stuckCount}:${h.honkingCount}:${h.burningCount}`)
            .join("|");
        if (sig === this.lastHotspotSignature) return;
        this.lastHotspotSignature = sig;

        listEl.textContent = "";
        if (hotspots.length === 0) {
            const empty = document.createElement("p");
            empty.className = "wme-sim-empty";
            empty.textContent =
                stats.edgeCount === 0
                    ? "Pan or zoom into a mapped road network to start simulation."
                    : "No routing bugs or gridlock detected yet — traffic is flowing smoothly!";
            listEl.appendChild(empty);
            return;
        }

        for (const h of hotspots) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = `wme-sim-hotspot ${h.burningCount > 0 ? "is-fire" : "is-warn"}`;

            const head = document.createElement("div");
            head.className = "wme-sim-hotspot-head";

            const kindSpan = document.createElement("span");
            kindSpan.className = "wme-sim-hotspot-kind";
            kindSpan.textContent = `${h.burningCount > 0 ? "🔥" : "⚠"} ${describeBugKind(h.kind)}`;

            const countSpan = document.createElement("span");
            countSpan.className = "wme-sim-hotspot-badge";
            countSpan.textContent = `${h.stuckCount} cars`;

            head.appendChild(kindSpan);
            head.appendChild(countSpan);

            const desc = document.createElement("div");
            desc.className = "wme-sim-hotspot-desc";
            desc.textContent = h.description;

            btn.appendChild(head);
            btn.appendChild(desc);

            btn.addEventListener("click", () => {
                void this.focusHotspot(h);
            });
            listEl.appendChild(btn);
        }
    }

    private async focusHotspot(h: ChaosHotspot): Promise<void> {
        try {
            await this.wmeSDK.Map.setMapCenter({ lonLat: { lon: h.lon, lat: h.lat } });
            const selection =
                h.nodeId != null && h.kind !== "ROAD_CLOSURE"
                    ? { objectType: "node" as const, ids: [h.nodeId] }
                    : { objectType: "segment" as const, ids: [h.segmentId] };
            await this.wmeSDK.Editing.setSelection({ selection });
        } catch (err) {
            console.debug("SimWaze: Could not select hotspot feature:", err);
        }
    }

    private bindElements(root: HTMLDivElement): void {
        this.liveRegionEl = root.querySelector<HTMLElement>("#wme-sim-live-telemetry");
        this.zoomWarningEl = root.querySelector<HTMLDivElement>("#wme-sim-zoom-warning");
        this.statActiveEl = root.querySelector<HTMLElement>("#wme-sim-stat-active");
        this.statJamEl = root.querySelector<HTMLElement>("#wme-sim-stat-jam");
        this.statFireEl = root.querySelector<HTMLElement>("#wme-sim-stat-fire");
        this.statArrivedEl = root.querySelector<HTMLElement>("#wme-sim-stat-arrived");
        this.hotspotListEl = root.querySelector<HTMLDivElement>("#wme-sim-hotspots");

        this.enabledToggle = root.querySelector<HTMLInputElement>("#wme-sim-enabled");
        if (this.enabledToggle) {
            this.enabledToggle.checked = this.settings.enabled;
            this.enabledToggle.addEventListener("change", () => {
                this.settings.enabled = Boolean(this.enabledToggle?.checked);
                void this.wmeSDK.LayerSwitcher.setLayerCheckboxChecked({
                    name: "SimWaze Live Traffic",
                    isChecked: this.settings.enabled,
                });
                this.updatePauseButtonLabel();
                this.emitChange();
            });
        }

        this.pauseBtn = root.querySelector<HTMLButtonElement>("#wme-sim-pause-btn");
        if (this.pauseBtn) {
            this.updatePauseButtonLabel();
            this.pauseBtn.addEventListener("click", () => {
                this.settings.paused = !this.settings.paused;
                this.updatePauseButtonLabel();
                this.emitChange();
            });
        }

        this.soundToggle = root.querySelector<HTMLInputElement>("#wme-sim-sound");
        if (this.soundToggle) {
            this.soundToggle.checked = this.settings.soundEnabled;
            this.soundToggle.addEventListener("change", () => {
                this.settings.soundEnabled = Boolean(this.soundToggle?.checked);
                this.emitChange();
            });
        }

        root.querySelector<HTMLButtonElement>("#wme-sim-clear-btn")?.addEventListener("click", () => {
            this.callbacks.onClearAll();
        });
        root.querySelector<HTMLButtonElement>("#wme-sim-rescan-btn")?.addEventListener(
            "click",
            () => {
                this.callbacks.onRescanMap();
            }
        );

        this.bindSlider(
            root,
            "#wme-sim-max-wazers",
            "#wme-sim-max-wazers-val",
            this.settings.maxWazers,
            (val) => `${val} Wazers`,
            (val) => {
                this.settings.maxWazers = val;
                this.emitChange();
            }
        );

        this.bindSlider(
            root,
            "#wme-sim-speed",
            "#wme-sim-speed-val",
            this.settings.simSpeed,
            (val) => `${val.toFixed(1)}×`,
            (val) => {
                this.settings.simSpeed = val;
                this.emitChange();
            }
        );

        this.bindSlider(
            root,
            "#wme-sim-patience",
            "#wme-sim-patience-val",
            this.settings.patienceSeconds,
            (val) => `${val}s`,
            (val) => {
                this.settings.patienceSeconds = val;
                this.emitChange();
            }
        );

        this.bindCheckbox(root, "#wme-sim-heatmap", this.settings.showHeatmap, (checked) => {
            this.settings.showHeatmap = checked;
            this.emitChange();
        });
        this.bindCheckbox(root, "#wme-sim-routes", this.settings.showRoutesOnHover, (checked) => {
            this.settings.showRoutesOnHover = checked;
            this.emitChange();
        });
        this.bindCheckbox(root, "#wme-sim-badges", this.settings.showBugBadges, (checked) => {
            this.settings.showBugBadges = checked;
            this.emitChange();
        });

        this.evalDateTimeInput = root.querySelector<HTMLInputElement>("#wme-sim-eval-datetime");
        this.evalStatusEl = root.querySelector<HTMLElement>("#wme-sim-eval-status");
        this.evalClearBtn = root.querySelector<HTMLButtonElement>("#wme-sim-eval-clear-btn");

        const syncEvalStatusUI = () => {
            const isCustom = Boolean(this.settings.evalTimestamp);
            if (this.evalStatusEl) {
                this.evalStatusEl.textContent = isCustom ? "Custom" : "Live";
                this.evalStatusEl.classList.toggle("is-custom", isCustom);
            }
            if (this.evalClearBtn) {
                this.evalClearBtn.disabled = !isCustom;
            }
        };

        if (this.evalDateTimeInput) {
            this.evalDateTimeInput.value = this.settings.evalTimestamp ?? "";
            syncEvalStatusUI();

            this.evalDateTimeInput.addEventListener("input", () => {
                this.evalDateTimeInput?.setCustomValidity("");
            });

            this.evalDateTimeInput.addEventListener("change", () => {
                if (!this.evalDateTimeInput) return;
                const val = this.evalDateTimeInput.value.trim();
                if (!val) {
                    this.settings.evalTimestamp = null;
                    syncEvalStatusUI();
                    this.emitChange();
                } else if (this.evalDateTimeInput.validity.valid) {
                    this.settings.evalTimestamp = val;
                    syncEvalStatusUI();
                    this.emitChange();
                }
            });
        } else {
            syncEvalStatusUI();
        }

        root.querySelector<HTMLButtonElement>("#wme-sim-eval-now-btn")?.addEventListener(
            "click",
            () => {
                const val = formatLocalDateTimeInputValue();
                this.settings.evalTimestamp = val;
                if (this.evalDateTimeInput) {
                    this.evalDateTimeInput.value = val;
                    this.evalDateTimeInput.setCustomValidity("");
                }
                syncEvalStatusUI();
                this.emitChange();
            }
        );

        this.evalClearBtn?.addEventListener("click", () => {
            this.settings.evalTimestamp = null;
            if (this.evalDateTimeInput) {
                this.evalDateTimeInput.value = "";
                this.evalDateTimeInput.setCustomValidity("");
            }
            syncEvalStatusUI();
            this.emitChange();
        });
    }

    private bindCheckbox(
        root: HTMLDivElement,
        selector: string,
        initial: boolean,
        onChange: (checked: boolean) => void
    ): void {
        const el = root.querySelector<HTMLInputElement>(selector);
        if (!el) return;
        el.checked = initial;
        el.addEventListener("change", () => onChange(el.checked));
    }

    private bindSlider(
        root: HTMLDivElement,
        inputSel: string,
        valSel: string,
        initial: number,
        format: (v: number) => string,
        onInput: (v: number) => void
    ): void {
        const slider = root.querySelector<HTMLInputElement>(inputSel);
        const readout = root.querySelector<HTMLElement>(valSel);
        if (!slider) return;

        slider.value = String(initial);
        const sync = (val: number) => {
            slider.style.setProperty("--attr-min", slider.min || "0");
            slider.style.setProperty("--attr-max", slider.max || "100");
            slider.style.setProperty("--control-value", String(val));
            const formatted = format(val);
            slider.setAttribute("aria-valuetext", formatted);
            if (readout) readout.textContent = formatted;
        };

        sync(initial);
        slider.addEventListener("input", () => {
            const v = Number(slider.value);
            sync(v);
            onInput(v);
        });
    }

    private updatePauseButtonLabel(): void {
        if (!this.pauseBtn) return;
        this.pauseBtn.disabled = !this.settings.enabled;
        this.pauseBtn.textContent = this.settings.paused ? "Resume" : "Pause";
    }

    private setupVisibilityPause(root: HTMLDivElement): void {
        const target = this.liveRegionEl ?? root;
        if ("contentVisibility" in document.documentElement.style) {
            target.addEventListener("contentvisibilityautostatechange", (event) => {
                const ev = event as Event & { skipped?: boolean };
                this.isTelemetryVisible = !ev.skipped;
            });
        } else if (typeof IntersectionObserver !== "undefined") {
            const observer = new IntersectionObserver(
                (entries) => {
                    for (const entry of entries) {
                        this.isTelemetryVisible = entry.isIntersecting;
                    }
                },
                { rootMargin: "120px" }
            );
            observer.observe(target);
        }
    }

    private emitChange(): void {
        this.callbacks.onSettingsChange({ ...this.settings });
    }

    private buildStaticMarkup(version: string): string {
        const legendRows = ROAD_LEGEND_ITEMS.map(
            (p) => `
                <li>
                    <span class="wme-sim-legend-name">
                        <span class="wme-sim-swatch" style="background:${p.color}"></span>
                        ${p.label}
                    </span>
                    <span class="wme-sim-legend-meta">${p.defaultLanes}L · ${p.defaultSpeedKmh} km/h</span>
                </li>
            `
        ).join("");

        return `
            <div class="wme-sim-header">
                <div>
                    <h2>SimWaze <small>v${version}</small></h2>
                    <p class="wme-sim-subtitle">Live Traffic &amp; Chaos Simulator</p>
                </div>
                <kbd title="Shortcut: Alt + Shift + S">Alt+Shift+S</kbd>
            </div>

            <div id="wme-sim-zoom-warning" class="wme-sim-warning" hidden></div>

            <section class="wme-sim-section">
                <div class="wme-sim-controls-row">
                    <label class="wme-sim-check-label" for="wme-sim-enabled">
                        <input type="checkbox" id="wme-sim-enabled" class="wme-sim-checkbox">
                        <span>Simulate Traffic</span>
                    </label>
                    <button type="button" id="wme-sim-pause-btn" class="wme-sim-btn wme-sim-btn-primary">Pause</button>
                </div>

                <div class="wme-sim-controls-row">
                    <label class="wme-sim-check-label" for="wme-sim-sound">
                        <input type="checkbox" id="wme-sim-sound" class="wme-sim-checkbox">
                        <span>Tiny Horns &amp; Fire SFX</span>
                    </label>
                    <div class="wme-sim-btn-group">
                        <button type="button" id="wme-sim-rescan-btn" class="wme-sim-btn" title="Rebuild road graph">Rescan</button>
                        <button type="button" id="wme-sim-clear-btn" class="wme-sim-btn" title="Clear all active Wazers">Clear</button>
                    </div>
                </div>
            </section>

            <section class="wme-sim-section">
                <h3>Traffic Tuning</h3>
                <div class="wme-sim-slider-field">
                    <div class="wme-sim-slider-head">
                        <label for="wme-sim-max-wazers">Max Wazers</label>
                        <span id="wme-sim-max-wazers-val" class="wme-sim-val">42 Wazers</span>
                    </div>
                    <input type="range" id="wme-sim-max-wazers" class="wme-sim-slider" min="2" max="150" step="2" value="42">
                </div>

                <div class="wme-sim-slider-field">
                    <div class="wme-sim-slider-head">
                        <label for="wme-sim-speed">Simulation Speed</label>
                        <span id="wme-sim-speed-val" class="wme-sim-val">1.5×</span>
                    </div>
                    <input type="range" id="wme-sim-speed" class="wme-sim-slider" min="0.5" max="5" step="0.5" value="1.5">
                </div>

                <div class="wme-sim-slider-field">
                    <div class="wme-sim-slider-head">
                        <label for="wme-sim-patience">Fire Patience</label>
                        <span id="wme-sim-patience-val" class="wme-sim-val">10s</span>
                    </div>
                    <input type="range" id="wme-sim-patience" class="wme-sim-slider" min="5" max="25" step="1" value="10">
                </div>

                <div class="wme-sim-datetime-field">
                    <div class="wme-sim-slider-head">
                        <label for="wme-sim-eval-datetime">Restriction &amp; Closure Time</label>
                        <span id="wme-sim-eval-status" class="wme-sim-mode-pill">Live</span>
                    </div>
                    <input
                        type="datetime-local"
                        id="wme-sim-eval-datetime"
                        name="evalDatetime"
                        class="wme-sim-datetime"
                        aria-describedby="wme-sim-eval-help"
                    >
                    <div class="wme-sim-datetime-actions">
                        <span id="wme-sim-eval-help" class="wme-sim-field-hint">Past or future; empty = live.</span>
                        <div class="wme-sim-btn-group">
                            <button type="button" id="wme-sim-eval-now-btn" class="wme-sim-btn wme-sim-btn-sm" title="Set to current date and time">Now</button>
                            <button type="button" id="wme-sim-eval-clear-btn" class="wme-sim-btn wme-sim-btn-sm" title="Reset to live clock">Reset</button>
                        </div>
                    </div>
                </div>
            </section>

            <section id="wme-sim-live-telemetry" class="wme-sim-section wme-sim-telemetry">
                <h3>Live Telemetry &amp; Chaos Radar</h3>
                <div class="wme-sim-stats-grid">
                    <div class="wme-sim-stat">
                        <span class="wme-sim-stat-num" id="wme-sim-stat-active">0</span>
                        <span class="wme-sim-stat-lbl">Active</span>
                    </div>
                    <div class="wme-sim-stat is-warn">
                        <span class="wme-sim-stat-num" id="wme-sim-stat-jam">0</span>
                        <span class="wme-sim-stat-lbl">Jammed</span>
                    </div>
                    <div class="wme-sim-stat is-fire">
                        <span class="wme-sim-stat-num" id="wme-sim-stat-fire">0</span>
                        <span class="wme-sim-stat-lbl">On Fire</span>
                    </div>
                    <div class="wme-sim-stat is-ok">
                        <span class="wme-sim-stat-num" id="wme-sim-stat-arrived">0</span>
                        <span class="wme-sim-stat-lbl">Arrived</span>
                    </div>
                </div>
                <div id="wme-sim-hotspots" class="wme-sim-hotspots"></div>
            </section>

            <section class="wme-sim-accordion" aria-label="Additional Options">
                <details>
                    <summary>Map Overlays</summary>
                    <div class="wme-sim-details-body">
                        <label class="wme-sim-check-label" for="wme-sim-heatmap">
                            <input type="checkbox" id="wme-sim-heatmap" class="wme-sim-checkbox">
                            <span>Congestion heatmap glow</span>
                        </label>
                        <label class="wme-sim-check-label" for="wme-sim-routes">
                            <input type="checkbox" id="wme-sim-routes" class="wme-sim-checkbox">
                            <span>Show planned route on hover</span>
                        </label>
                        <label class="wme-sim-check-label" for="wme-sim-badges">
                            <input type="checkbox" id="wme-sim-badges" class="wme-sim-checkbox">
                            <span>Show floating chaos badges</span>
                        </label>
                    </div>
                </details>

                <details>
                    <summary>Road Capacity &amp; Spawn Rules</summary>
                    <div class="wme-sim-details-body">
                        <p class="wme-sim-note">
                            Wazers spawn across all drivable roads weighted by road importance and prioritize higher-tier roads while obeying real speed limits, turn permissions, and active closures.
                        </p>
                        <ul class="wme-sim-legend">${legendRows}</ul>
                    </div>
                </details>
            </section>
        `;
    }

    private injectStyles(): void {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = `
            :root {
                --wme-sim-icon-check: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='3.5' stroke-linecap='round' stroke-linejoin='round'><polyline points='20 6 9 17 4 12'></polyline></svg>");
                --wme-sim-icon-chevron: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'></polyline></svg>");
            }
            .wme-simwaze-panel {
                color-scheme: light dark;
                accent-color: #1a73e8;
                padding: 12px;
                font-size: 13px;
                line-height: 1.45;
                color: var(--content_default, #202124);
                display: flex;
                flex-direction: column;
                gap: 12px;
            }
            .wme-sim-header {
                display: flex;
                align-items: flex-start;
                justify-content: space-between;
                gap: 8px;
            }
            .wme-sim-header h2 {
                margin: 0;
                font-size: 16px;
                font-weight: 700;
                color: var(--content_default, #202124);
            }
            .wme-sim-header h2 small {
                font-weight: 500;
                font-size: 11px;
                opacity: 0.75;
            }
            .wme-sim-subtitle {
                margin: 2px 0 0 0;
                font-size: 11px;
                color: var(--content_p2, #5f6368);
            }
            .wme-simwaze-panel kbd {
                display: inline-block;
                padding: 2px 6px;
                font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
                font-size: 10px;
                font-weight: 600;
                color: var(--content_default, #202124);
                background-color: rgba(128, 128, 128, 0.16);
                border: 1px solid rgba(128, 128, 128, 0.4);
                border-bottom-width: 2px;
                border-radius: 4px;
                white-space: nowrap;
            }
            .wme-sim-warning {
                padding: 8px 10px;
                border-radius: 6px;
                font-size: 12px;
                background: rgba(245, 158, 11, 0.14);
                border-left: 3px solid #f59e0b;
                color: var(--content_default, #202124);
            }
            .wme-sim-section {
                background: var(--surface_default, rgba(128, 128, 128, 0.06));
                border: 1px solid var(--hairline, rgba(128, 128, 128, 0.25));
                border-radius: 8px;
                padding: 10px 12px;
                display: flex;
                flex-direction: column;
                gap: 8px;
            }
            .wme-sim-section h3 {
                margin: 0;
                font-size: 13px;
                font-weight: 600;
                color: var(--content_default, #202124);
            }
            .wme-sim-telemetry {
                content-visibility: auto;
                contain-intrinsic-size: auto none auto 240px;
            }
            .wme-sim-controls-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
            }
            .wme-sim-btn-group {
                display: flex;
                gap: 6px;
            }
            .wme-sim-btn {
                padding: 6px 10px;
                border-radius: 6px;
                border: 1px solid var(--hairline, rgba(128, 128, 128, 0.4));
                background: var(--background_default, #ffffff);
                color: var(--content_default, #202124);
                font-size: 12px;
                font-weight: 600;
                cursor: pointer;
            }
            .wme-sim-btn:hover:not(:disabled) {
                filter: brightness(0.95);
            }
            .wme-sim-btn:focus-visible {
                outline: 2px solid #1a73e8;
                outline-offset: 2px;
            }
            .wme-sim-btn:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }
            .wme-sim-btn-primary {
                background: #1a73e8;
                border-color: #1a73e8;
                color: #ffffff;
            }
            .wme-sim-check-label {
                display: inline-flex;
                align-items: center;
                gap: 0.65rem;
                min-block-size: 44px;
                cursor: pointer;
                font-weight: 500;
                color: var(--content_default, #202124);
            }
            .wme-sim-checkbox {
                --checkbox-size: 1.25em;
                --checkbox-icon-size: 0.8em;
                appearance: none;
                -webkit-appearance: none;
                display: inline-grid;
                place-content: center;
                inline-size: var(--checkbox-size);
                aspect-ratio: 1;
                margin: 0;
                flex-shrink: 0;
                background-color: var(--background_default, #ffffff);
                border: 2px solid var(--content_p2, #5f6368);
                border-radius: 4px;
                cursor: pointer;
            }
            .wme-sim-checkbox::before {
                content: "";
                inline-size: var(--checkbox-icon-size);
                aspect-ratio: 1;
                background-color: #ffffff;
                -webkit-mask: var(--wme-sim-icon-check) no-repeat center / contain;
                mask: var(--wme-sim-icon-check) no-repeat center / contain;
                scale: 0;
            }
            @media (prefers-reduced-motion: no-preference) {
                .wme-sim-checkbox::before {
                    transition: scale 150ms ease;
                }
            }
            @media (forced-colors: active) {
                .wme-sim-checkbox::before {
                    background-color: CanvasText;
                }
            }
            .wme-sim-checkbox:checked {
                background-color: #1a73e8;
                border-color: #1a73e8;
            }
            .wme-sim-checkbox:checked::before {
                scale: 1;
            }
            .wme-sim-checkbox:focus-visible {
                outline: 2px solid #1a73e8;
                outline-offset: 2px;
            }
            .wme-sim-slider-field {
                display: flex;
                flex-direction: column;
                gap: 2px;
            }
            .wme-sim-slider-head {
                display: flex;
                justify-content: space-between;
                align-items: center;
                font-size: 12px;
            }
            .wme-sim-val {
                font-weight: 600;
                font-variant-numeric: tabular-nums;
            }
            .wme-sim-slider {
                --slider-track-size: 0.45rem;
                --slider-thumb-size: 1.1rem;
                --slider-track-radius: 999px;
                --slider-thumb-radius: 50%;
                --slider-track-color: rgba(128, 128, 128, 0.35);
                --slider-fill-color: #1a73e8;
                --slider-thumb-color: #1a73e8;
                --slider-direction: to right;
                --attr-min: 0;
                --attr-max: 100;
                --control-value: 50;
                --slider-progress: calc(progress(var(--control-value), var(--attr-min), var(--attr-max)) * 100%);
                appearance: none;
                -webkit-appearance: none;
                inline-size: 100%;
                block-size: 2rem;
                margin: 0;
                padding: 0;
                border: 0;
                background: transparent;
                cursor: pointer;
            }
            @supports not (opacity: progress(1, 0, 100)) {
                .wme-sim-slider {
                    --slider-progress: calc((var(--control-value) - var(--attr-min)) / (var(--attr-max) - var(--attr-min)) * 100%);
                }
            }
            .wme-sim-slider::-webkit-slider-runnable-track {
                block-size: var(--slider-track-size);
                border: 0;
                border-radius: var(--slider-track-radius);
                background: linear-gradient(
                    var(--slider-direction),
                    var(--slider-fill-color) var(--slider-progress),
                    var(--slider-track-color) var(--slider-progress)
                );
            }
            .wme-sim-slider::-webkit-slider-thumb {
                -webkit-appearance: none;
                appearance: none;
                inline-size: var(--slider-thumb-size);
                block-size: var(--slider-thumb-size);
                margin-block-start: calc((var(--slider-track-size) - var(--slider-thumb-size)) / 2);
                border: 0;
                border-radius: var(--slider-thumb-radius);
                background: var(--slider-thumb-color);
            }
            .wme-sim-slider::-moz-range-track {
                block-size: var(--slider-track-size);
                border: 0;
                border-radius: var(--slider-track-radius);
                background: var(--slider-track-color);
            }
            .wme-sim-slider::-moz-range-progress {
                block-size: var(--slider-track-size);
                border-radius: var(--slider-track-radius);
                background: var(--slider-fill-color);
            }
            .wme-sim-slider::-moz-range-thumb {
                inline-size: var(--slider-thumb-size);
                block-size: var(--slider-thumb-size);
                border: 0;
                border-radius: var(--slider-thumb-radius);
                background: var(--slider-thumb-color);
            }
            .wme-sim-slider:focus-visible {
                outline: 2px solid var(--slider-fill-color);
                outline-offset: 4px;
            }
            .wme-sim-stats-grid {
                display: grid;
                grid-template-columns: repeat(4, 1fr);
                gap: 6px;
            }
            .wme-sim-stat {
                display: flex;
                flex-direction: column;
                align-items: center;
                padding: 6px 4px;
                border-radius: 6px;
                background: var(--background_default, #ffffff);
                border: 1px solid var(--hairline, rgba(128, 128, 128, 0.22));
            }
            .wme-sim-stat-num {
                font-size: 15px;
                font-weight: 700;
                font-variant-numeric: tabular-nums;
            }
            .wme-sim-stat-lbl {
                font-size: 10px;
                opacity: 0.78;
            }
            .wme-sim-stat.is-warn .wme-sim-stat-num { color: #d97706; }
            .wme-sim-stat.is-fire .wme-sim-stat-num { color: #dc2626; }
            .wme-sim-stat.is-ok .wme-sim-stat-num { color: #059669; }
            .wme-sim-hotspots {
                display: flex;
                flex-direction: column;
                gap: 6px;
                max-height: 220px;
                overflow-y: auto;
            }
            .wme-sim-empty {
                margin: 2px 0 0 0;
                font-size: 12px;
                color: var(--content_p2, #5f6368);
            }
            .wme-sim-hotspot {
                width: 100%;
                text-align: left;
                padding: 7px 9px;
                border-radius: 6px;
                border: 1px solid var(--hairline, rgba(128, 128, 128, 0.28));
                border-left-width: 3px;
                background: var(--background_default, #ffffff);
                color: var(--content_default, #202124);
                cursor: pointer;
                display: flex;
                flex-direction: column;
                gap: 3px;
            }
            .wme-sim-hotspot.is-fire { border-left-color: #dc2626; }
            .wme-sim-hotspot.is-warn { border-left-color: #d97706; }
            .wme-sim-hotspot:hover {
                filter: brightness(0.96);
            }
            .wme-sim-hotspot:focus-visible {
                outline: 2px solid #1a73e8;
                outline-offset: 2px;
            }
            .wme-sim-hotspot-head {
                display: flex;
                justify-content: space-between;
                align-items: center;
                gap: 6px;
                font-size: 12px;
                font-weight: 700;
            }
            .wme-sim-hotspot-badge {
                font-size: 10px;
                font-weight: 600;
                padding: 1px 6px;
                border-radius: 999px;
                background: rgba(128, 128, 128, 0.16);
            }
            .wme-sim-hotspot-desc {
                font-size: 11px;
                color: var(--content_p2, #5f6368);
            }
            .wme-sim-accordion {
                display: flex;
                flex-direction: column;
                gap: 8px;
            }
            .wme-sim-accordion details {
                background: var(--surface_default, rgba(128, 128, 128, 0.06));
                border: 1px solid var(--hairline, rgba(128, 128, 128, 0.25));
                border-radius: 8px;
                padding: 4px 12px;
            }
            .wme-sim-accordion summary {
                list-style: none;
                display: flex;
                align-items: center;
                gap: 0.5ch;
                min-block-size: 36px;
                font-weight: 600;
                font-size: 13px;
                cursor: pointer;
            }
            .wme-sim-accordion summary::-webkit-details-marker {
                display: none;
            }
            .wme-sim-accordion summary::before {
                content: "";
                inline-size: 1em;
                block-size: 1em;
                flex-shrink: 0;
                background-color: currentColor;
                -webkit-mask: var(--wme-sim-icon-chevron) no-repeat center / contain;
                mask: var(--wme-sim-icon-chevron) no-repeat center / contain;
                rotate: -90deg;
            }
            .wme-sim-accordion details[open] > summary::before {
                rotate: 0deg;
            }
            @media (prefers-reduced-motion: no-preference) {
                .wme-sim-accordion summary::before {
                    transition: rotate 0.2s;
                }
                .wme-sim-accordion details::details-content {
                    interpolate-size: allow-keywords;
                    overflow: clip;
                    contain: layout;
                    transition: block-size 0.25s ease-in-out, content-visibility 0.25s ease-in-out allow-discrete;
                }
                .wme-sim-accordion details:not([open])::details-content {
                    block-size: 0;
                }
            }
            .wme-sim-details-body {
                padding: 4px 0 8px 0;
                display: flex;
                flex-direction: column;
                gap: 4px;
            }
            .wme-sim-note {
                margin: 0 0 6px 0;
                font-size: 12px;
                color: var(--content_p2, #5f6368);
            }
            .wme-sim-legend {
                list-style: none;
                margin: 0;
                padding: 0;
                display: flex;
                flex-direction: column;
                gap: 4px;
                font-size: 12px;
            }
            .wme-sim-legend li {
                display: flex;
                justify-content: space-between;
                align-items: center;
                gap: 8px;
            }
            .wme-sim-legend-name {
                display: inline-flex;
                align-items: center;
                gap: 6px;
            }
            .wme-sim-swatch {
                display: inline-block;
                width: 10px;
                height: 10px;
                border-radius: 3px;
            }
            .wme-sim-legend-meta {
                font-size: 11px;
                color: var(--content_p2, #5f6368);
                font-variant-numeric: tabular-nums;
            }
            .wme-sim-datetime-field {
                display: flex;
                flex-direction: column;
                gap: 4px;
                padding-block-start: 6px;
                border-block-start: 1px solid var(--hairline, rgba(128, 128, 128, 0.2));
            }
            .wme-sim-datetime {
                inline-size: 100%;
                box-sizing: border-box;
                min-block-size: 38px;
                padding: 5px 8px;
                font: inherit;
                font-size: 12px;
                border-radius: 6px;
                border: 1px solid var(--content_p2, #5f6368);
                background: var(--background_default, #ffffff);
                color: var(--content_default, #202124);
            }
            .wme-sim-datetime:focus-visible {
                outline: 2px solid #1a73e8;
                outline-offset: 2px;
            }
            .wme-sim-datetime:user-invalid {
                border-color: #dc2626;
            }
            .wme-sim-datetime-actions {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 6px;
            }
            .wme-sim-field-hint {
                font-size: 11px;
                color: var(--content_p2, #5f6368);
            }
            .wme-sim-mode-pill {
                font-size: 10px;
                font-weight: 600;
                padding: 1px 6px;
                border-radius: 999px;
                background: rgba(128, 128, 128, 0.16);
                color: var(--content_p2, #5f6368);
            }
            .wme-sim-mode-pill.is-custom {
                background: rgba(26, 115, 232, 0.16);
                color: #1a73e8;
            }
            .wme-sim-btn-sm {
                padding: 3px 8px;
                font-size: 11px;
            }
        `;
        document.head.appendChild(style);
    }
}

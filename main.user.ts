import { AsyncWmeSDK } from "wme-sdk-typings";
import { WAZER_MOOD_URIS } from "./src/assets/moods";
import { SimAudioEngine } from "./src/audio";
import { WebMercatorProjector } from "./src/geo";
import { buildRoadGraphFromSDK, invalidateFallbackTurnCache } from "./src/graph";
import { SimCanvasRenderer } from "./src/renderer";
import { TrafficSimulator } from "./src/simulator";
import { DEFAULT_SIM_SETTINGS, MIN_SIM_ZOOM, SimSettings } from "./src/types";
import { SimSidebarUI } from "./src/ui";

declare const GM_info: {
    script: {
        version: string;
    };
};

const STORAGE_KEY_SETTINGS = "wme-simwaze-settings";

function loadSettings(): SimSettings {
    try {
        const raw = localStorage.getItem(STORAGE_KEY_SETTINGS);
        if (!raw) return { ...DEFAULT_SIM_SETTINGS };
        const parsed = JSON.parse(raw) as Partial<SimSettings>;
        return {
            ...DEFAULT_SIM_SETTINGS,
            ...parsed,
        };
    } catch {
        return { ...DEFAULT_SIM_SETTINGS };
    }
}

let saveSettingsTimer: number | null = null;
let pendingSaveSettings: SimSettings | null = null;

function flushSavedSettings(): void {
    if (saveSettingsTimer !== null) {
        window.clearTimeout(saveSettingsTimer);
        saveSettingsTimer = null;
    }
    if (!pendingSaveSettings) return;
    const toWrite = pendingSaveSettings;
    pendingSaveSettings = null;
    try {
        localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(toWrite));
    } catch (err) {
        console.debug("SimWaze: Failed to save settings:", err);
    }
}

function scheduleSaveSettings(settings: SimSettings): void {
    pendingSaveSettings = { ...settings };
    if (saveSettingsTimer !== null) {
        window.clearTimeout(saveSettingsTimer);
    }
    saveSettingsTimer = window.setTimeout(flushSavedSettings, 150);
}

window.SDK_INITIALIZED.then(initScript);

async function initScript(): Promise<void> {
    if (!window.getWmeSdk) {
        throw new Error("SimWaze: WME SDK not available");
    }

    const wmeSDK: AsyncWmeSDK = window.getWmeSdk({
        scriptId: "wme-simwaze",
        scriptName: "SimWaze",
        // @ts-ignore: mode is supported by runtime SDK
        mode: "async",
    });

    console.debug(`SimWaze: SDK v${wmeSDK.getSDKVersion()} on WME ${wmeSDK.getWMEVersion()}`);

    const settings = loadSettings();
    const audio = new SimAudioEngine();
    audio.setEnabled(settings.soundEnabled);

    const projector = new WebMercatorProjector();
    const simulator = new TrafficSimulator(settings, {
        audio,
        moodCount: WAZER_MOOD_URIS.length,
    });

    const viewportEl = await wmeSDK.Map.getMapViewportElement();
    const renderer = new SimCanvasRenderer(viewportEl, projector);

    let rafId: number | null = null;
    let lastFrameMs = 0;
    let lastTelemetryMs = 0;
    let lastLiveMinuteSlot = Math.floor(Date.now() / 60_000);
    let graphRebuildTimer: number | null = null;
    let isRebuilding = false;
    let rebuildQueued = false;

    const ui = new SimSidebarUI(wmeSDK, settings, {
        onSettingsChange: (next) => {
            const wasEnabled = settings.enabled;
            const prevEvalTimestamp = settings.evalTimestamp;
            Object.assign(settings, next);
            scheduleSaveSettings(settings);
            audio.setEnabled(settings.soundEnabled);
            if (settings.soundEnabled) audio.unlock();
            simulator.updateSettings(settings);
            if (!settings.enabled) {
                if (graphRebuildTimer !== null) {
                    window.clearTimeout(graphRebuildTimer);
                    graphRebuildTimer = null;
                }
                renderer.clear();
            } else if (!wasEnabled || prevEvalTimestamp !== settings.evalTimestamp) {
                scheduleGraphRebuild(50);
            }
            syncAnimationLoop();
        },
        onClearAll: () => {
            simulator.reset();
            ui.updateTelemetry(simulator.getStats(), simulator.getHotspots());
        },
        onRescanMap: () => {
            invalidateFallbackTurnCache();
            void rebuildGraph();
        },
    });

    const version = typeof GM_info !== "undefined" ? GM_info.script.version : "1.0.0";
    await ui.mount(version);

    async function rebuildGraph(): Promise<void> {
        if (!settings.enabled) return;
        if (isRebuilding) {
            rebuildQueued = true;
            return;
        }
        isRebuilding = true;
        try {
            await projector.syncWithWmeMap(wmeSDK);
            const zoom = projector.getZoomLevel();
            if (zoom < MIN_SIM_ZOOM) {
                ui.setZoomWarning(true, zoom);
                simulator.reset();
                renderer.clear();
                ui.updateTelemetry(simulator.getStats(), simulator.getHotspots());
                return;
            }
            ui.setZoomWarning(false);
            lastLiveMinuteSlot = Math.floor(Date.now() / 60_000);
            const graph = await buildRoadGraphFromSDK(wmeSDK, settings.evalTimestamp);
            simulator.setGraph(graph);
            ui.updateTelemetry(simulator.getStats(), simulator.getHotspots());
        } catch (err) {
            console.debug("SimWaze: Graph rebuild failed:", err);
        } finally {
            isRebuilding = false;
            if (rebuildQueued) {
                rebuildQueued = false;
                void rebuildGraph();
            }
        }
    }

    function scheduleGraphRebuild(delayMs = 200): void {
        if (!settings.enabled) return;
        if (graphRebuildTimer !== null) {
            window.clearTimeout(graphRebuildTimer);
        }
        graphRebuildTimer = window.setTimeout(() => {
            graphRebuildTimer = null;
            void rebuildGraph();
        }, delayMs);
    }

    function frameLoop(nowMs: number): void {
        if (!settings.enabled || document.hidden) {
            rafId = null;
            return;
        }

        if (lastFrameMs === 0) lastFrameMs = nowMs;
        const dtSec = Math.min(0.1, Math.max(0.001, (nowMs - lastFrameMs) / 1000));
        lastFrameMs = nowMs;

        const zoom = projector.getZoomLevel();
        if (zoom >= MIN_SIM_ZOOM) {
            // Re-evaluate live time-based restrictions/closures when wall-clock minute advances
            if (!settings.evalTimestamp) {
                const curMinuteSlot = Math.floor(Date.now() / 60_000);
                if (curMinuteSlot !== lastLiveMinuteSlot) {
                    lastLiveMinuteSlot = curMinuteSlot;
                    scheduleGraphRebuild(100);
                }
            }
            simulator.step(dtSec);
            renderer.render(simulator, settings, nowMs / 1000);
        } else {
            renderer.clear();
        }

        if (nowMs - lastTelemetryMs >= 350) {
            lastTelemetryMs = nowMs;
            ui.updateTelemetry(simulator.getStats(), simulator.getHotspots());
        }

        rafId = window.requestAnimationFrame(frameLoop);
    }

    function syncAnimationLoop(): void {
        if (settings.enabled && !document.hidden) {
            if (rafId === null) {
                lastFrameMs = 0;
                rafId = window.requestAnimationFrame(frameLoop);
            }
        } else if (rafId !== null) {
            window.cancelAnimationFrame(rafId);
            rafId = null;
        }
    }

    // Register toggle shortcut (Alt+Shift+S) if free
    try {
        const inUse = await wmeSDK.Shortcuts.areShortcutKeysInUse({ shortcutKeys: "AS+83" });
        if (!inUse) {
            await wmeSDK.Shortcuts.createShortcut({
                shortcutId: "wme-simwaze-toggle",
                shortcutKeys: "AS+83",
                description: "Toggle SimWaze Live Traffic & Chaos Simulator",
                callback: () => {
                    settings.enabled = !settings.enabled;
                    scheduleSaveSettings(settings);
                    ui.syncEnabledFromLayer(settings.enabled);
                    void wmeSDK.LayerSwitcher.setLayerCheckboxChecked({
                        name: "SimWaze Live Traffic",
                        isChecked: settings.enabled,
                    });
                    simulator.updateSettings(settings);
                    if (settings.enabled) {
                        void rebuildGraph();
                    } else {
                        renderer.clear();
                    }
                    syncAnimationLoop();
                },
            });
        }
    } catch (err) {
        console.debug("SimWaze: Shortcut registration skipped:", err);
    }

    const onMapEdited = () => {
        invalidateFallbackTurnCache();
        scheduleGraphRebuild(150);
    };

    // WME SDK Events
    wmeSDK.Events.on({
        eventName: "wme-map-initial-data-loaded",
        eventHandler: () => scheduleGraphRebuild(120),
    });
    wmeSDK.Events.on({
        eventName: "wme-map-data-loaded",
        eventHandler: () => scheduleGraphRebuild(200),
    });
    wmeSDK.Events.on({
        eventName: "wme-after-edit",
        eventHandler: onMapEdited,
    });
    wmeSDK.Events.on({
        eventName: "wme-after-undo",
        eventHandler: onMapEdited,
    });
    wmeSDK.Events.on({
        eventName: "wme-after-redo-clear",
        eventHandler: onMapEdited,
    });
    wmeSDK.Events.on({
        eventName: "wme-no-edits",
        eventHandler: onMapEdited,
    });
    wmeSDK.Events.on({
        eventName: "wme-user-settings-changed",
        eventHandler: () => scheduleGraphRebuild(150),
    });

    for (const modelName of ["roadClosures", "turnClosures"] as const) {
        try {
            // @ts-ignore: turnClosures may be supported at runtime depending on WME SDK version
            await wmeSDK.Events.trackDataModelEvents({ dataModelName: modelName });
        } catch (err) {
            console.debug(`SimWaze: ${modelName} data model tracking unavailable:`, err);
        }
    }

    wmeSDK.Events.on({
        eventName: "wme-data-model-objects-added",
        eventHandler: () => scheduleGraphRebuild(180),
    });
    wmeSDK.Events.on({
        eventName: "wme-data-model-objects-changed",
        eventHandler: () => scheduleGraphRebuild(180),
    });
    wmeSDK.Events.on({
        eventName: "wme-data-model-objects-removed",
        eventHandler: () => scheduleGraphRebuild(180),
    });

    const syncMapProjection = () => {
        if (!settings.enabled) return;
        void projector.syncWithWmeMap(wmeSDK).then(() => {
            const zoom = projector.getZoomLevel();
            const underZoom = zoom < MIN_SIM_ZOOM;
            ui.setZoomWarning(underZoom, zoom);
            if (underZoom) {
                simulator.reset();
                renderer.clear();
                ui.updateTelemetry(simulator.getStats(), simulator.getHotspots());
            }
        });
    };

    wmeSDK.Events.on({
        eventName: "wme-map-move",
        eventHandler: syncMapProjection,
    });
    wmeSDK.Events.on({
        eventName: "wme-map-move-end",
        eventHandler: () => {
            syncMapProjection();
            scheduleGraphRebuild(280);
        },
    });
    wmeSDK.Events.on({
        eventName: "wme-map-zoom-changed",
        eventHandler: () => {
            syncMapProjection();
            scheduleGraphRebuild(280);
        },
    });

    wmeSDK.Events.on({
        eventName: "wme-layer-checkbox-toggled",
        eventHandler: (ev: { name: string; checked: boolean }) => {
            if (ev.name !== "SimWaze Live Traffic") return;
            settings.enabled = ev.checked;
            scheduleSaveSettings(settings);
            ui.syncEnabledFromLayer(ev.checked);
            simulator.updateSettings(settings);
            if (settings.enabled) {
                void rebuildGraph();
            } else {
                renderer.clear();
            }
            syncAnimationLoop();
        },
    });

    wmeSDK.Events.on({
        eventName: "wme-map-mouse-move",
        eventHandler: (ev: { x: number; y: number }) => {
            if (!settings.enabled) return;
            renderer.setMousePosition(ev.x, ev.y);
        },
    });
    wmeSDK.Events.on({
        eventName: "wme-map-mouse-out",
        eventHandler: () => {
            renderer.setMousePosition(null, null);
        },
    });

    document.addEventListener("visibilitychange", syncAnimationLoop);
    window.addEventListener("pagehide", flushSavedSettings);

    // Initial calibration & start
    if (settings.enabled) {
        await projector.syncWithWmeMap(wmeSDK);
        if (await wmeSDK.State.isInitialMapDataLoaded()) {
            await rebuildGraph();
        }
    }
    syncAnimationLoop();
}

import { AsyncWmeSDK } from "wme-sdk-typings";
import { SANTA_MOOD_COUNT, YEAR_ROUND_MOOD_COUNT } from "./src/assets/moods";
import { SimAudioEngine } from "./src/audio";
import { WebMercatorProjector } from "./src/geo";
import { buildRoadGraphFromSDK, invalidateFallbackTurnCache } from "./src/graph";
import { SimCanvasRenderer } from "./src/renderer";
import { ScreensaverController } from "./src/screensaver";
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
        moodCount: YEAR_ROUND_MOOD_COUNT,
        santaMoodCount: SANTA_MOOD_COUNT,
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

    const clearRebuildTimer = () => {
        if (graphRebuildTimer !== null) {
            window.clearTimeout(graphRebuildTimer);
            graphRebuildTimer = null;
        }
    };

    let ui: SimSidebarUI;

    const screensaver = new ScreensaverController({
        enabled: settings.enabled,
        screensaverMode: settings.screensaverMode,
        idleSeconds: settings.screensaverIdleSeconds,
        hidden: document.hidden,
        onDisplayStateChange: (shouldDisplay) => {
            ui?.setScreensaverStatus(settings.screensaverMode, shouldDisplay);
            if (shouldDisplay) {
                void rebuildGraph();
            } else {
                clearRebuildTimer();
                rebuildQueued = false;
                simulator.reset();
                renderer.clear();
                ui?.updateTelemetry(simulator.getStats(), simulator.getHotspots());
            }
            syncAnimationLoop();
        },
    });

    const canDisplayWazers = (): boolean => screensaver.shouldDisplayWazers();

    ui = new SimSidebarUI(wmeSDK, settings, {
        onSettingsChange: (next) => {
            const prevEvalTimestamp = settings.evalTimestamp;
            Object.assign(settings, next);
            scheduleSaveSettings(settings);
            audio.setEnabled(settings.soundEnabled);
            if (settings.soundEnabled) audio.unlock();
            simulator.updateSettings(settings);

            const wasDisplaying = canDisplayWazers();
            screensaver.configure(
                settings.enabled,
                settings.screensaverMode,
                settings.screensaverIdleSeconds
            );
            const nowDisplaying = canDisplayWazers();
            ui.setScreensaverStatus(settings.screensaverMode, nowDisplaying);
            if (nowDisplaying) {
                ui.updateTelemetry(simulator.getStats(), simulator.getHotspots());
            }

            if (wasDisplaying && nowDisplaying && prevEvalTimestamp !== settings.evalTimestamp) {
                scheduleGraphRebuild(50);
            }
            syncAnimationLoop();
        },
        onClearAll: () => {
            simulator.reset();
            renderer.clear();
            ui.updateTelemetry(simulator.getStats(), simulator.getHotspots());
        },
        onRescanMap: () => {
            invalidateFallbackTurnCache();
            if (canDisplayWazers()) {
                void rebuildGraph();
            }
        },
    });

    const version = typeof GM_info !== "undefined" ? GM_info.script.version : "1.0.0";
    await ui.mount(version);
    ui.setScreensaverStatus(settings.screensaverMode, canDisplayWazers());

    async function rebuildGraph(): Promise<void> {
        if (!canDisplayWazers()) return;
        if (isRebuilding) {
            rebuildQueued = true;
            return;
        }
        isRebuilding = true;
        try {
            await projector.syncWithWmeMap(wmeSDK);
            if (!canDisplayWazers()) return;
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
            if (!canDisplayWazers()) return;
            simulator.setGraph(graph);
            ui.updateTelemetry(simulator.getStats(), simulator.getHotspots());
        } catch (err) {
            console.debug("SimWaze: Graph rebuild failed:", err);
        } finally {
            isRebuilding = false;
            if (rebuildQueued && canDisplayWazers()) {
                rebuildQueued = false;
                void rebuildGraph();
            } else {
                rebuildQueued = false;
            }
        }
    }

    function scheduleGraphRebuild(delayMs = 200): void {
        if (!canDisplayWazers()) return;
        clearRebuildTimer();
        graphRebuildTimer = window.setTimeout(() => {
            graphRebuildTimer = null;
            void rebuildGraph();
        }, delayMs);
    }

    function frameLoop(nowMs: number): void {
        if (!canDisplayWazers()) {
            rafId = null;
            return;
        }

        if (lastFrameMs === 0) lastFrameMs = nowMs;
        const dtSec = Math.min(0.1, Math.max(0.001, (nowMs - lastFrameMs) / 1000));
        lastFrameMs = nowMs;

        const zoom = projector.getZoomLevel();
        if (zoom >= MIN_SIM_ZOOM) {
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
        if (canDisplayWazers()) {
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
                    screensaver.configure(
                        settings.enabled,
                        settings.screensaverMode,
                        settings.screensaverIdleSeconds
                    );
                    ui.setScreensaverStatus(settings.screensaverMode, canDisplayWazers());
                },
            });
        }
    } catch (err) {
        console.debug("SimWaze: Shortcut registration skipped:", err);
    }

    // Map edit handler: invalidates turn cache, dismisses Wazers in screensaver mode, or rebuilds in normal mode
    const onMapEditDone = () => {
        invalidateFallbackTurnCache();
        if (settings.screensaverMode) {
            screensaver.notifyMapEdit();
        } else {
            scheduleGraphRebuild(150);
        }
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

    for (const editEvent of [
        "wme-after-edit",
        "wme-after-undo",
        "wme-after-redo-clear",
        "wme-house-number-added",
        "wme-house-number-deleted",
        "wme-house-number-moved",
        "wme-house-number-updated",
    ] as const) {
        wmeSDK.Events.on({
            eventName: editEvent,
            eventHandler: onMapEditDone,
        });
    }

    wmeSDK.Events.on({
        eventName: "wme-no-edits",
        eventHandler: () => {
            invalidateFallbackTurnCache();
            scheduleGraphRebuild(150);
        },
    });
    wmeSDK.Events.on({
        eventName: "wme-user-settings-changed",
        eventHandler: () => scheduleGraphRebuild(150),
    });

    for (const modelName of ["roadClosures", "segments"] as const) {
        try {
            await wmeSDK.Events.trackDataModelEvents({ dataModelName: modelName });
        } catch (err) {
            console.debug(`SimWaze: ${modelName} data model tracking unavailable:`, err);
        }
    }

    const onDataModelEvent = (ev?: { dataModelName?: string }) => {
        if (ev?.dataModelName === "roadClosures" && settings.screensaverMode) {
            screensaver.notifyMapEdit();
        } else {
            scheduleGraphRebuild(180);
        }
    };

    wmeSDK.Events.on({
        eventName: "wme-data-model-objects-added",
        eventHandler: onDataModelEvent,
    });
    wmeSDK.Events.on({
        eventName: "wme-data-model-objects-changed",
        eventHandler: onDataModelEvent,
    });
    wmeSDK.Events.on({
        eventName: "wme-data-model-objects-removed",
        eventHandler: onDataModelEvent,
    });
    wmeSDK.Events.on({
        eventName: "wme-save-finished",
        eventHandler: () => scheduleGraphRebuild(150),
    });

    const syncMapProjection = () => {
        screensaver.notifyUserActivity();
        if (!canDisplayWazers()) return;
        void projector.syncWithWmeMap(wmeSDK).then(() => {
            if (!canDisplayWazers()) return;
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
        eventName: "wme-selection-changed",
        eventHandler: () => screensaver.notifyUserActivity(true),
    });

    wmeSDK.Events.on({
        eventName: "wme-layer-checkbox-toggled",
        eventHandler: (ev: { name: string; checked: boolean }) => {
            if (ev.name !== "SimWaze Live Traffic") return;
            settings.enabled = ev.checked;
            scheduleSaveSettings(settings);
            ui.syncEnabledFromLayer(ev.checked);
            simulator.updateSettings(settings);
            screensaver.configure(
                settings.enabled,
                settings.screensaverMode,
                settings.screensaverIdleSeconds
            );
            ui.setScreensaverStatus(settings.screensaverMode, canDisplayWazers());
        },
    });
    wmeSDK.Events.on({
        eventName: "wme-layer-visibility-changed",
        eventHandler: () => scheduleGraphRebuild(180),
    });

    wmeSDK.Events.on({
        eventName: "wme-map-mouse-move",
        eventHandler: (ev: { x: number; y: number }) => {
            screensaver.notifyUserActivity();
            if (!canDisplayWazers()) return;
            renderer.setMousePosition(ev.x, ev.y);
        },
    });
    wmeSDK.Events.on({
        eventName: "wme-map-mouse-out",
        eventHandler: () => {
            renderer.setMousePosition(null, null);
        },
    });

    // Global passive user-activity listeners to reset screensaver standby timer while working in WME
    window.addEventListener("pointerdown", () => screensaver.notifyUserActivity(true), {
        passive: true,
    });
    window.addEventListener("pointermove", () => screensaver.notifyUserActivity(false), {
        passive: true,
    });
    window.addEventListener("keydown", () => screensaver.notifyUserActivity(true), {
        passive: true,
    });
    window.addEventListener("wheel", () => screensaver.notifyUserActivity(false), {
        passive: true,
    });

    document.addEventListener("visibilitychange", () => {
        screensaver.setDocumentHidden(document.hidden);
        ui.setScreensaverStatus(settings.screensaverMode, canDisplayWazers());
        syncAnimationLoop();
    });
    window.addEventListener("pagehide", flushSavedSettings);

    // Initial calibration & start (only immediately builds if not waiting in screensaver standby)
    if (canDisplayWazers()) {
        await projector.syncWithWmeMap(wmeSDK);
        if (await wmeSDK.State.isInitialMapDataLoaded()) {
            await rebuildGraph();
        }
    }
    syncAnimationLoop();
}

export interface ScreensaverControllerOptions {
    enabled: boolean;
    screensaverMode: boolean;
    idleSeconds: number;
    hidden?: boolean;
    activityThrottleMs?: number;
    now?: () => number;
    setTimer?: (cb: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
    clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
    onDisplayStateChange: (shouldDisplay: boolean) => void;
}

/**
 * Coordinates Screensaver Mode lifecycle:
 * - When `screensaverMode` is off, Wazers display continuously whenever `enabled && !hidden`.
 * - When `screensaverMode` is on, Wazers stay hidden in standby until `idleSeconds` of user
 *   inactivity elapses, then start displaying and keep running across mouse/pan inspection
 *   until a map edit occurs (or simulation is disabled / tab hidden), which immediately
 *   hides Wazers and restarts the inactivity timer.
 */
export class ScreensaverController {
    private enabled: boolean;
    private screensaverMode: boolean;
    private idleMs: number;
    private hidden: boolean;
    private screensaverActive = false;
    private lastEmittedDisplay: boolean;

    private timerHandle: ReturnType<typeof setTimeout> | null = null;
    private lastActivityResetMs = -Infinity;
    private readonly activityThrottleMs: number;
    private readonly now: () => number;
    private readonly setTimer: (cb: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
    private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
    private readonly onDisplayStateChange: (shouldDisplay: boolean) => void;

    constructor(opts: ScreensaverControllerOptions) {
        this.enabled = opts.enabled;
        this.screensaverMode = opts.screensaverMode;
        this.idleMs = ScreensaverController.clampIdleMs(opts.idleSeconds);
        this.hidden = Boolean(opts.hidden);
        this.activityThrottleMs = opts.activityThrottleMs ?? 400;
        this.now = opts.now ?? (() => performance.now());
        this.setTimer = opts.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
        this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h));
        this.onDisplayStateChange = opts.onDisplayStateChange;
        this.lastEmittedDisplay = this.shouldDisplayWazers();

        if (this.enabled && this.screensaverMode && !this.hidden) {
            this.armIdleTimer();
        }
    }

    private static clampIdleMs(seconds: number): number {
        const clampedSec = Number.isFinite(seconds) ? Math.max(5, Math.min(3600, seconds)) : 30;
        return Math.round(clampedSec * 1000);
    }

    public isScreensaverActive(): boolean {
        return this.screensaverMode && this.screensaverActive;
    }

    public shouldDisplayWazers(): boolean {
        if (!this.enabled || this.hidden) return false;
        return this.screensaverMode ? this.screensaverActive : true;
    }

    public configure(enabled: boolean, screensaverMode: boolean, idleSeconds: number): void {
        const prevEnabled = this.enabled;
        const prevMode = this.screensaverMode;
        const prevIdleMs = this.idleMs;
        const nextIdleMs = ScreensaverController.clampIdleMs(idleSeconds);

        this.enabled = enabled;
        this.screensaverMode = screensaverMode;
        this.idleMs = nextIdleMs;

        if (!enabled) {
            this.cancelIdleTimer();
            this.screensaverActive = false;
            this.emitIfChanged();
            return;
        }

        if (!screensaverMode) {
            this.cancelIdleTimer();
            this.screensaverActive = false;
            this.emitIfChanged();
            return;
        }

        // Entering screensaver mode, re-enabling simulation, or changing the idle timeout resets to standby
        if (!prevEnabled || !prevMode || prevIdleMs !== nextIdleMs) {
            this.screensaverActive = false;
            if (!this.hidden) {
                this.armIdleTimer();
            } else {
                this.cancelIdleTimer();
            }
            this.emitIfChanged();
            return;
        }

        if (!this.screensaverActive && !this.hidden && this.timerHandle === null) {
            this.armIdleTimer();
        }
        this.emitIfChanged();
    }

    public setDocumentHidden(hidden: boolean): void {
        if (this.hidden === hidden) return;
        this.hidden = hidden;

        if (hidden) {
            this.cancelIdleTimer();
            if (this.screensaverMode) {
                this.screensaverActive = false;
            }
            this.emitIfChanged();
            return;
        }

        if (this.enabled && this.screensaverMode && !this.screensaverActive) {
            this.armIdleTimer();
        }
        this.emitIfChanged();
    }

    /**
     * Resets the inactivity countdown ONLY while waiting in screensaver standby.
     * Once screensaver is actively displaying Wazers, hovering/panning does not dismiss it.
     */
    public notifyUserActivity(force = false): void {
        if (!this.enabled || !this.screensaverMode || this.screensaverActive || this.hidden) {
            return;
        }
        const nowMs = this.now();
        if (!force && nowMs - this.lastActivityResetMs < this.activityThrottleMs) {
            return;
        }
        this.lastActivityResetMs = nowMs;
        this.armIdleTimer();
    }

    /**
     * In screensaver mode, any map edit immediately hides Wazers and restarts the idle timer.
     */
    public notifyMapEdit(): void {
        if (!this.enabled || !this.screensaverMode) {
            return;
        }
        this.screensaverActive = false;
        if (!this.hidden) {
            this.lastActivityResetMs = this.now();
            this.armIdleTimer();
        } else {
            this.cancelIdleTimer();
        }
        this.emitIfChanged();
    }

    public destroy(): void {
        this.cancelIdleTimer();
    }

    private armIdleTimer(): void {
        this.cancelIdleTimer();
        this.timerHandle = this.setTimer(() => {
            this.timerHandle = null;
            if (!this.enabled || !this.screensaverMode || this.hidden) return;
            this.screensaverActive = true;
            this.emitIfChanged();
        }, this.idleMs);
    }

    private cancelIdleTimer(): void {
        if (this.timerHandle !== null) {
            this.clearTimer(this.timerHandle);
            this.timerHandle = null;
        }
    }

    private emitIfChanged(): void {
        const nextDisplay = this.shouldDisplayWazers();
        if (nextDisplay !== this.lastEmittedDisplay) {
            this.lastEmittedDisplay = nextDisplay;
            this.onDisplayStateChange(nextDisplay);
        }
    }
}

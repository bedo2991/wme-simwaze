import type {
    RoadClosure,
    Segment,
    TimeFrame,
    Turn,
    TurnClosure,
    VehicleRule,
    WeekDay,
} from "wme-sdk-typings";

export interface EvalDateTime {
    isCustom: boolean;
    epochMs: number;
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
    weekday: number;
}

export type RestrictionEffect = "BLOCKED" | "DISCOURAGED" | "ALLOWED";

type RestrictionLike = Segment["restrictions"][number] | Turn["restrictions"][number];
type ClosureLike = Pick<RoadClosure | TurnClosure, "status" | "startDate" | "endDate">;

const WEEKDAY_BY_INDEX: readonly WeekDay[] = [
    "SUNDAY",
    "MONDAY",
    "TUESDAY",
    "WEDNESDAY",
    "THURSDAY",
    "FRIDAY",
    "SATURDAY",
];

function pad2(n: number): string {
    return String(n).padStart(2, "0");
}

export function formatLocalDateTimeInputValue(date: Date = new Date()): string {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function resolveEvalDateTime(
    evalTimestamp?: string | null,
    nowMs: number = Date.now()
): EvalDateTime {
    if (typeof evalTimestamp === "string") {
        const trimmed = evalTimestamp.trim();
        const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(trimmed);
        if (m) {
            const year = Number(m[1]);
            const month = Number(m[2]);
            const day = Number(m[3]);
            const hour = Number(m[4]);
            const minute = Number(m[5]);
            const second = Number(m[6] ?? 0);
            const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
            const epochMs = new Date(year, month - 1, day, hour, minute, second).getTime();
            if (
                month >= 1 &&
                month <= 12 &&
                day >= 1 &&
                day <= 31 &&
                hour >= 0 &&
                hour <= 23 &&
                minute >= 0 &&
                minute <= 59 &&
                second >= 0 &&
                second <= 59 &&
                Number.isFinite(epochMs)
            ) {
                return {
                    isCustom: true,
                    epochMs,
                    year,
                    month,
                    day,
                    hour,
                    minute,
                    second,
                    weekday,
                };
            }
        }
    }

    const d = new Date(nowMs);
    return {
        isCustom: false,
        epochMs: d.getTime(),
        year: d.getFullYear(),
        month: d.getMonth() + 1,
        day: d.getDate(),
        hour: d.getHours(),
        minute: d.getMinutes(),
        second: d.getSeconds(),
        weekday: d.getDay(),
    };
}

interface WallClockFields {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
    weekday: number;
}

const DTF_CACHE = new Map<string, Intl.DateTimeFormat>();
const WALL_CLOCK_CACHE = new Map<string, WallClockFields>();

function getCachedDateTimeFormat(timeZone: string): Intl.DateTimeFormat {
    let fmt = DTF_CACHE.get(timeZone);
    if (!fmt) {
        if (DTF_CACHE.size >= 64) {
            DTF_CACHE.clear();
        }
        fmt = new Intl.DateTimeFormat("en-US", {
            timeZone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hourCycle: "h23",
        });
        DTF_CACHE.set(timeZone, fmt);
    }
    return fmt;
}

function projectEvalToTimeZone(evalDt: EvalDateTime, timeZone: string): WallClockFields {
    const cacheKey = `${Math.floor(evalDt.epochMs / 1000)}|${timeZone}`;
    const cached = WALL_CLOCK_CACHE.get(cacheKey);
    if (cached) return cached;

    try {
        const fmt = getCachedDateTimeFormat(timeZone);
        const parts = fmt.formatToParts(new Date(evalDt.epochMs));
        let year: number | null = null;
        let month: number | null = null;
        let day: number | null = null;
        let hour: number | null = null;
        let minute: number | null = null;
        let second: number | null = null;
        for (const p of parts) {
            switch (p.type) {
                case "year":
                    year = Number(p.value);
                    break;
                case "month":
                    month = Number(p.value);
                    break;
                case "day":
                    day = Number(p.value);
                    break;
                case "hour":
                    hour = Number(p.value);
                    break;
                case "minute":
                    minute = Number(p.value);
                    break;
                case "second":
                    second = Number(p.value);
                    break;
                default:
                    break;
            }
        }
        if (
            year != null &&
            month != null &&
            day != null &&
            hour != null &&
            minute != null &&
            second != null
        ) {
            const resolved: WallClockFields = {
                year,
                month,
                day,
                hour: hour % 24,
                minute,
                second,
                weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
            };
            if (WALL_CLOCK_CACHE.size >= 128) {
                WALL_CLOCK_CACHE.clear();
            }
            WALL_CLOCK_CACHE.set(cacheKey, resolved);
            return resolved;
        }
    } catch {
        // Fallback to evalDt fields if timezone identifier is invalid
    }
    return evalDt;
}

function parseYmd(dateStr: string | null | undefined): { y: number; m: number; d: number } | null {
    if (!dateStr) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr.trim());
    if (!m) return null;
    return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

function parseHmMinutes(timeStr: string | null | undefined): number | null {
    if (!timeStr) return null;
    const m = /^\s*(\d{1,2}):(\d{2})/.exec(timeStr);
    if (!m) return null;
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (hh < 0 || hh > 24 || mm < 0 || mm > 59) return null;
    return hh * 60 + mm;
}

function matchesCalendarDay(day: number, dow: number, tf: TimeFrame): boolean {
    if (Array.isArray(tf.weekdays) && tf.weekdays.length > 0) {
        if (!tf.weekdays.includes(WEEKDAY_BY_INDEX[dow])) {
            return false;
        }
    }
    const alt = tf.dayAlternation ?? tf.daysOfMonth;
    if (alt === "EVEN_DAYS" && day % 2 !== 0) return false;
    if (alt === "ODD_DAYS" && day % 2 !== 1) return false;
    return true;
}

export function isTimeFrameActive(tf: TimeFrame, evalDt: EvalDateTime): boolean {
    const wc: WallClockFields =
        !evalDt.isCustom && tf.timeZone ? projectEvalToTimeZone(evalDt, tf.timeZone) : evalDt;

    const startYmd = parseYmd(tf.startDate);
    const endYmd = parseYmd(tf.endDate);

    if (tf.repeatYearly) {
        const curMd = wc.month * 100 + wc.day;
        const startMd = startYmd ? startYmd.m * 100 + startYmd.d : null;
        const endMd = endYmd ? endYmd.m * 100 + endYmd.d : null;
        if (startMd != null && endMd != null) {
            if (startMd <= endMd) {
                if (curMd < startMd || curMd > endMd) return false;
            } else {
                if (curMd < startMd && curMd > endMd) return false;
            }
        } else if (startMd != null && curMd < startMd) {
            return false;
        } else if (endMd != null && curMd > endMd) {
            return false;
        }
    } else {
        const curYmd = wc.year * 10000 + wc.month * 100 + wc.day;
        if (startYmd) {
            const s = startYmd.y * 10000 + startYmd.m * 100 + startYmd.d;
            if (curYmd < s) return false;
        }
        if (endYmd) {
            const e = endYmd.y * 10000 + endYmd.m * 100 + endYmd.d;
            if (curYmd > e) return false;
        }
    }

    const fromMins = parseHmMinutes(tf.fromTime);
    const toMins = parseHmMinutes(tf.toTime);
    const curMins = wc.hour * 60 + wc.minute;

    if (fromMins != null && toMins != null && fromMins !== toMins) {
        if (fromMins < toMins) {
            const endInclusive = toMins >= 23 * 60 + 59;
            const timeOk = endInclusive
                ? curMins >= fromMins && curMins <= toMins
                : curMins >= fromMins && curMins < toMins;
            return timeOk && matchesCalendarDay(wc.day, wc.weekday, tf);
        }
        // Overnight window (e.g. 22:00 -> 06:00)
        if (curMins >= fromMins) {
            return matchesCalendarDay(wc.day, wc.weekday, tf);
        }
        if (curMins < toMins) {
            const prev = new Date(Date.UTC(wc.year, wc.month - 1, wc.day - 1));
            return matchesCalendarDay(prev.getUTCDate(), prev.getUTCDay(), tf);
        }
        return false;
    }

    if (fromMins != null && toMins == null && curMins < fromMins) {
        return false;
    }
    if (toMins != null && fromMins == null && curMins >= toMins) {
        return false;
    }

    return matchesCalendarDay(wc.day, wc.weekday, tf);
}

function ruleMatchesGeneralPrivateCar(vr: VehicleRule): boolean {
    const minPass = vr.minPassengers ?? vr.numPassengers ?? 0;
    const plate = vr.licensePlateRule ?? vr.licensePlateNumber ?? null;
    const subs = vr.subscriptions ?? [];
    const vTypes = vr.vehicleTypes ?? [];
    return (
        minPass === 0 &&
        !plate &&
        subs.length === 0 &&
        (vTypes.length === 0 || vTypes.includes("PRIVATE"))
    );
}

export function evaluateRestrictionEffect(
    r: RestrictionLike,
    evalDt: EvalDateTime
): RestrictionEffect {
    if (!evalDt.isCustom && r.isExpired && (!r.timeFrames || r.timeFrames.length === 0)) {
        return "ALLOWED";
    }
    if (Array.isArray(r.timeFrames) && r.timeFrames.length > 0) {
        if (!r.timeFrames.some((tf) => isTimeFrameActive(tf, evalDt))) {
            return "ALLOWED";
        }
    }

    const rules = r.vehicleRules ?? r.driveProfiles;
    const freeAllowsPrivate =
        Array.isArray(rules?.FREE) && rules.FREE.some(ruleMatchesGeneralPrivateCar);
    const blockedBlocksPrivate =
        Array.isArray(rules?.BLOCKED) && rules.BLOCKED.some(ruleMatchesGeneralPrivateCar);

    if (r.defaultType === "BLOCKED") {
        return freeAllowsPrivate ? "ALLOWED" : "BLOCKED";
    }
    if (r.defaultType === "FREE") {
        return blockedBlocksPrivate ? "BLOCKED" : "ALLOWED";
    }
    if (
        r.defaultType === "DIFFICULT" ||
        r.defaultType === "PENALTY" ||
        r.defaultType === "ENTER_ONLY"
    ) {
        if (blockedBlocksPrivate) return "BLOCKED";
        if (freeAllowsPrivate) return "ALLOWED";
        return "DISCOURAGED";
    }

    return blockedBlocksPrivate ? "BLOCKED" : "ALLOWED";
}

export function evaluateSegmentDirectionRestriction(
    segment: Segment,
    isForward: boolean,
    evalDt: EvalDateTime
): RestrictionEffect {
    if (!segment.restrictions || segment.restrictions.length === 0) return "ALLOWED";
    let sawDiscouraged = false;

    for (const r of segment.restrictions) {
        const scope = r.laneScope ?? r.disposition;
        if (scope && scope !== "WHOLE_SEGMENT" && scope !== "NONE") continue;
        const dirMatch =
            r.direction === "BOTH" ||
            r.direction === null ||
            (isForward && r.direction === "FWD") ||
            (!isForward && r.direction === "REV");
        if (!dirMatch) continue;

        const effect = evaluateRestrictionEffect(r, evalDt);
        if (effect === "BLOCKED") return "BLOCKED";
        if (effect === "DISCOURAGED") sawDiscouraged = true;
    }

    return sawDiscouraged ? "DISCOURAGED" : "ALLOWED";
}

export function isTurnBlockedAt(turn: Turn, evalDt: EvalDateTime): boolean {
    if (!turn.restrictions || turn.restrictions.length === 0) return false;
    return turn.restrictions.some((r) => evaluateRestrictionEffect(r, evalDt) === "BLOCKED");
}

type ParsedClosureBound =
    | { kind: "epoch"; ms: number }
    | { kind: "wall"; wallMs: number };

function parseClosureDate(raw: string | null | undefined, isEnd: boolean): ParsedClosureBound | null {
    if (!raw) return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;

    if (/^\d{10,15}$/.test(trimmed)) {
        const num = Number(trimmed);
        return { kind: "epoch", ms: trimmed.length <= 10 ? num * 1000 : num };
    }

    if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(trimmed)) {
        const ms = Date.parse(trimmed);
        if (Number.isFinite(ms)) {
            return { kind: "epoch", ms };
        }
    }

    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(trimmed);
    if (m) {
        const y = Number(m[1]);
        const mo = Number(m[2]);
        const d = Number(m[3]);
        const hh = m[4] != null ? Number(m[4]) : isEnd ? 23 : 0;
        const mm = m[5] != null ? Number(m[5]) : isEnd ? 59 : 0;
        const ss = m[6] != null ? Number(m[6]) : isEnd ? 59 : 0;
        return { kind: "wall", wallMs: Date.UTC(y, mo - 1, d, hh, mm, ss) };
    }

    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? { kind: "epoch", ms: parsed } : null;
}

function matchesClosureBound(
    bound: ParsedClosureBound | null,
    evalDt: EvalDateTime,
    isStart: boolean
): boolean {
    if (!bound) return true;
    if (bound.kind === "epoch") {
        return isStart ? evalDt.epochMs >= bound.ms : evalDt.epochMs <= bound.ms;
    }
    const evalWallMs = Date.UTC(
        evalDt.year,
        evalDt.month - 1,
        evalDt.day,
        evalDt.hour,
        evalDt.minute,
        evalDt.second
    );
    return isStart ? evalWallMs >= bound.wallMs : evalWallMs <= bound.wallMs;
}

export function isClosureActiveAt(closure: ClosureLike, evalDt: EvalDateTime): boolean {
    if (
        closure.status === "FAILED" ||
        closure.status === "SUSPENDED" ||
        closure.status === "FINISHED_EARLY_DUE_TO_DELETION" ||
        closure.status === "FINISHED_EARLY_DUE_TO_OVERLAPPING_CLOSURES"
    ) {
        return false;
    }

    const statusLiveActive =
        closure.status === "ACTIVE" ||
        closure.status === "UNVERIFIED" ||
        closure.status === "UNKNOWN";

    const startBound = parseClosureDate(closure.startDate, false);
    const endBound = parseClosureDate(closure.endDate, true);

    if (evalDt.isCustom) {
        if (startBound != null || endBound != null) {
            return (
                matchesClosureBound(startBound, evalDt, true) &&
                matchesClosureBound(endBound, evalDt, false)
            );
        }
        return statusLiveActive;
    }

    if (!statusLiveActive) {
        return false;
    }

    return (
        matchesClosureBound(startBound, evalDt, true) &&
        matchesClosureBound(endBound, evalDt, false)
    );
}

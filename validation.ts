import { DateTime, IANAZone } from "luxon";
import { EventTemplate, RecurringRule } from "./types";
import { expandTemplate, resolveLinkedNotePath } from "./templates";

export type ValidationLevel = "error" | "warning" | "info";

export interface ValidationMessage {
    level: ValidationLevel;
    text: string;
}

export interface ValidationResult<T = string> {
    ok: boolean;
    normalized?: T;
    messages: ValidationMessage[];
}

function result<T>(ok: boolean, messages: ValidationMessage[], normalized?: T): ValidationResult<T> {
    return { ok, messages, normalized };
}

export function validateTimezone(value: string): ValidationResult<string> {
    const trimmed = value.trim();
    if (!trimmed) {
	return result(false, [{ level: "error", text: "Timezone is required." }]);
    }
    if (!IANAZone.isValidZone(trimmed)) {
	return result(false, [{ level: "error", text: "Use a valid IANA timezone like Europe/Warsaw." }]);
    }
    return result(true, [{ level: "info", text: `Using ${trimmed}.` }], trimmed);
}

export function validateCalendarUrl(value: string): ValidationResult<string> {
    const trimmed = value.trim();
    if (!trimmed) {
	return result(false, [{ level: "error", text: "Calendar URL is required." }]);
    }

    let parsed: URL;
    try {
	parsed = new URL(trimmed);
    } catch {
	return result(false, [{ level: "error", text: "Enter a valid URL." }]);
    }

    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
	return result(false, [{ level: "error", text: "Only http and https calendar URLs are supported." }]);
    }

    const messages: ValidationMessage[] = [];
    if (parsed.protocol === "http:") {
	messages.push({ level: "warning", text: "Prefer https feeds when available." });
    } else {
	messages.push({ level: "info", text: "HTTPS calendar feed." });
    }

    return result(true, messages, parsed.toString());
}

export function validateCalendarId(value: string, duplicates: Set<string>): ValidationResult<string> {
    const trimmed = value.trim();
    const messages: ValidationMessage[] = [];

    if (!trimmed) {
	messages.push({ level: "warning", text: "Calendar label is empty; timeline entries will be harder to scan." });
    }
    if (trimmed && duplicates.has(trimmed.toLowerCase())) {
	messages.push({ level: "warning", text: "Duplicate calendar labels can be confusing in timeline prefixes." });
    }

    return result(true, messages.length > 0 ? messages : [{ level: "info", text: "Calendar label looks fine." }], trimmed);
}

export function validateTime(value: string, required = true): ValidationResult<string | undefined> {
    const trimmed = value.trim();
    if (!trimmed) {
	return required
	    ? result(false, [{ level: "error", text: "Time is required." }])
	    : result(true, [], undefined);
    }

    const match = trimmed.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) {
	return result(false, [{ level: "error", text: "Use HH:MM format." }]);
    }

    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
	return result(false, [{ level: "error", text: "Time must be between 00:00 and 23:59." }]);
    }

    const normalized = `${match[1].padStart(2, "0")}:${match[2]}`;
    return result(true, [], normalized);
}

export function validateTimeRange(start: string, end: string): ValidationResult<{ start: string; end: string }> {
    const startResult = validateTime(start);
    const endResult = validateTime(end);

    if (!startResult.ok || !endResult.ok || !startResult.normalized || !endResult.normalized) {
	return result(false, [...startResult.messages, ...endResult.messages]);
    }

    if (startResult.normalized >= endResult.normalized) {
	return result(false, [{ level: "error", text: "End time must be after start time." }]);
    }

    return result(true, [{ level: "info", text: `${startResult.normalized}-${endResult.normalized}` }], {
	start: startResult.normalized,
	end: endResult.normalized,
    });
}

export function validateDurationMinutes(value: string | number): ValidationResult<number> {
    const numeric = typeof value === "number" ? value : Number.parseInt(value.trim(), 10);
    if (!Number.isFinite(numeric) || numeric <= 0) {
	return result(false, [{ level: "error", text: "Duration must be a positive number of minutes." }]);
    }
    return result(true, [{ level: "info", text: `${numeric} minutes.` }], numeric);
}

export function validateIsoDate(value: string, required = true): ValidationResult<string | undefined> {
    const trimmed = value.trim();
    if (!trimmed) {
	return required
	    ? result(false, [{ level: "error", text: "Date is required." }])
	    : result(true, [], undefined);
    }

    const parsed = DateTime.fromISO(trimmed);
    if (!parsed.isValid || parsed.toISODate() !== trimmed) {
	return result(false, [{ level: "error", text: "Use YYYY-MM-DD." }]);
    }

    return result(true, [], trimmed);
}

export function validateWeeklyDays(days: string[]): ValidationResult<string[]> {
    if (days.length === 0) {
	return result(false, [{ level: "error", text: "Select at least one day." }]);
    }
    return result(true, [{ level: "info", text: days.join(", ") }], [...days]);
}

export function validateMonthlyDay(value: string | number): ValidationResult<number> {
    const numeric = typeof value === "number" ? value : Number.parseInt(value.trim(), 10);
    if (!Number.isFinite(numeric) || numeric === 0 || numeric < -31 || numeric > 31) {
	return result(false, [{ level: "error", text: "Day must be between 1 and 31 or -1 and -31." }]);
    }
    return result(true, [{ level: "info", text: `Runs on day ${numeric}.` }], numeric);
}

export function validateExceptionDates(value: string): ValidationResult<string[]> {
    const dates = value.split("\n").map(d => d.trim()).filter(Boolean);
    const invalid = dates.filter(d => !validateIsoDate(d).ok);
    if (invalid.length > 0) {
	return result(false, [{ level: "error", text: `Invalid date: ${invalid[0]}` }]);
    }
    return result(true, dates.length > 0 ? [{ level: "info", text: `${dates.length} exception date(s).` }] : [], dates);
}

export function validateTemplateShortcode(value: string, duplicates: Set<string>): ValidationResult<string> {
    const trimmed = value.trim();
    const messages: ValidationMessage[] = [];

    if (!trimmed) {
	messages.push({ level: "warning", text: "Empty shortcode disables quick-add for this template." });
    }
    if (trimmed && duplicates.has(trimmed.toLowerCase())) {
	messages.push({ level: "warning", text: "Duplicate shortcodes make quick-add ambiguous." });
    }

    return result(true, messages.length > 0 ? messages : [{ level: "info", text: "Quick-add shortcode is unique." }], trimmed);
}

export function validateTemplatePath(template: EventTemplate, dateStr: string, timezone: string): ValidationResult<string> {
    if (!template.namePattern.trim()) {
	return result(false, [{ level: "error", text: "Note name pattern cannot be empty." }]);
    }

    const path = resolveLinkedNotePath(template, dateStr, timezone);
    if (!path.trim()) {
	return result(false, [{ level: "error", text: "Generated path is empty." }]);
    }
    if (path.includes("..")) {
	return result(false, [{ level: "error", text: "Generated path cannot contain '..' segments." }]);
    }
    if (path.startsWith("/")) {
	return result(false, [{ level: "error", text: "Use vault-relative paths only." }]);
    }
    if (path.split("/").some(part => part.trim() === "")) {
	return result(false, [{ level: "error", text: "Generated path contains an empty folder segment." }]);
    }

    return result(true, [{ level: "info", text: path }], path);
}

export function buildTemplatePreview(template: EventTemplate, dateStr: string, timezone: string): { summary: string; start: string; end: string; path: string } {
    const expanded = expandTemplate(template, dateStr, timezone);
    const path = resolveLinkedNotePath(template, dateStr, timezone);
    return {
	summary: expanded.summary,
	start: expanded.start,
	end: expanded.end,
	path,
    };
}

export function summarizeRule(rule: RecurringRule): string {
    if (rule.recurrence.type === "weekly") {
	return rule.recurrence.days.length > 0
	    ? `${rule.start}, ${rule.duration}m on ${rule.recurrence.days.join(", ")}`
	    : `${rule.start}, ${rule.duration}m weekly`;
    }
    return `${rule.start}, ${rule.duration}m on day ${rule.recurrence.day}`;
}

import { App } from "obsidian";
import { DateTime } from "luxon";
import { TascalSettings, DayStore, UnscheduledTask } from "./types";
import {
    loadDayStore, saveDayStore, syncCheckboxState,
    renderTimeline, applyRecurringRules
} from "./store";

const MANAGED_START = "<!-- tascal:start -->";
const MANAGED_END = "<!-- tascal:end -->";
const UNSCHEDULED_START = "<!-- tascal:unscheduled:start -->";
const UNSCHEDULED_END = "<!-- tascal:unscheduled:end -->";
const DEFAULT_HEADING_LEVEL = 2;

export function extractTascalSection(content: string): {
    timeline: string[];
    manualBlockLines: string[];
    fullSection: string;
    start: number;
    end: number;
} {
    const startTag = "<!--tascal-->";
    const endTag = "<!--/tascal-->";

    const start = content.indexOf(startTag);
    const end = content.indexOf(endTag);

    if (start === -1 || end === -1 || start > end) {
	return { timeline: [], manualBlockLines: [], fullSection: "", start: -1, end: -1 };
    }

    const sectionContent = content.slice(start + startTag.length, end).trim();
    const timeline = sectionContent
	.split("\n")
	.filter(line => line.trim() && !line.startsWith("### Timeline") && !line.startsWith("<!--manual"));

    return {
	timeline,
	manualBlockLines: [],
	fullSection: sectionContent,
	start,
	end: end + endTag.length,
    };
}

export function extractManagedTimelineSection(content: string, heading: string): {
    timeline: string[];
    start: number;
    end: number;
    headingFound: boolean;
} {
    const headingMatch = findHeading(content, heading);
    if (!headingMatch) {
	return { timeline: [], start: -1, end: -1, headingFound: false };
    }

    const bodyStart = headingMatch.lineEnd;
    const sectionEnd = findSectionEnd(content, headingMatch.lineEnd, headingMatch.level);
    const sectionBody = content.slice(bodyStart, sectionEnd).replace(/^\n+/, "");

    const anchorStart = sectionBody.indexOf(MANAGED_START);
    const anchorEnd = sectionBody.indexOf(MANAGED_END);
    const managed = anchorStart !== -1 && anchorEnd !== -1 && anchorStart < anchorEnd
	? sectionBody.slice(anchorStart + MANAGED_START.length, anchorEnd)
	: sectionBody;

    return {
	timeline: managed.split("\n").map(line => line.trimEnd()).filter(line => line.trim()),
	start: bodyStart,
	end: sectionEnd,
	headingFound: true,
    };
}

export function extractManagedUnscheduledSection(content: string, heading: string): {
    lines: string[];
    start: number;
    end: number;
    headingFound: boolean;
} {
    const headingMatch = findHeading(content, heading);
    if (!headingMatch) {
	return { lines: [], start: -1, end: -1, headingFound: false };
    }

    const bodyStart = headingMatch.lineEnd;
    const sectionEnd = findSectionEnd(content, headingMatch.lineEnd, headingMatch.level);
    const sectionBody = content.slice(bodyStart, sectionEnd).replace(/^\n+/, "");

    const anchorStart = sectionBody.indexOf(UNSCHEDULED_START);
    const anchorEnd = sectionBody.indexOf(UNSCHEDULED_END);
    const managed = anchorStart !== -1 && anchorEnd !== -1 && anchorStart < anchorEnd
	? sectionBody.slice(anchorStart + UNSCHEDULED_START.length, anchorEnd)
	: sectionBody;

    return {
	lines: managed.split("\n").map(line => line.trimEnd()).filter(line => line.trim()),
	start: bodyStart,
	end: sectionEnd,
	headingFound: true,
    };
}

export function updateTascalSection(
    content: string,
    timelineLines: string[],
    heading: string
): string {
    const managedBlock = [MANAGED_START, ...timelineLines, MANAGED_END].join("\n");
    const existing = extractManagedTimelineSection(content, heading);

    if (!existing.headingFound) {
	const headingPrefix = `${"#".repeat(DEFAULT_HEADING_LEVEL)} ${heading}`;
	const prefix = content.trimEnd();
	return `${prefix}${prefix.length > 0 ? "\n\n" : ""}${headingPrefix}\n${managedBlock}\n`;
    }

    const replacement = `${managedBlock}\n`;
    return content.slice(0, existing.start) + replacement + content.slice(existing.end);
}

export function updateUnscheduledSection(
    content: string,
    lines: string[],
    heading: string
): string {
    const managedBlock = [UNSCHEDULED_START, ...lines, UNSCHEDULED_END].join("\n");
    const existing = extractManagedUnscheduledSection(content, heading);

    if (!existing.headingFound) {
	const headingPrefix = `${"#".repeat(DEFAULT_HEADING_LEVEL)} ${heading}`;
	const prefix = content.trimEnd();
	return `${prefix}${prefix.length > 0 ? "\n\n" : ""}${headingPrefix}\n${managedBlock}\n`;
    }

    const replacement = `${managedBlock}\n`;
    return content.slice(0, existing.start) + replacement + content.slice(existing.end);
}

export async function appendRescheduledTask(app: App, globalPath: string, targetDate: string, originalDate: string, line: string) {
    const filePath = `${globalPath}/rescheduled.md`;
    const adapter = app.vault.adapter;

    if (!(await adapter.exists(globalPath))) {
	await adapter.mkdir(globalPath);
    }

    const rescheduleEntry = `@${targetDate} from ${originalDate}: ${line}`;

    if (!(await adapter.exists(filePath))) {
	await adapter.write(filePath, `${rescheduleEntry}\n`);
    } else {
	const current = await adapter.read(filePath);
	if (!current.includes(rescheduleEntry)) {
	    await adapter.write(filePath, `${current.trim()}\n${rescheduleEntry}\n`);
	}
    }
}

async function applyLegacyRecurringEvents(
    app: App,
    store: DayStore,
    recurringEvents: string[],
    date: DateTime
): Promise<DayStore> {
    const adapter = app.vault.adapter;
    const recurringFilePath = ".tascal/recurring.md";
    const dateStr = date.toISODate()!;

    let existingMarkers: Record<string, string[]> = {};
    if (await adapter.exists(recurringFilePath)) {
	try {
	    const content = await adapter.read(recurringFilePath);
	    for (const line of content.split("\n").filter(l => l.trim())) {
		const markerMatch = line.match(/^(.+?)\s*<!--\s*added:(\d{4}-\d{2}-\d{2})\s*-->$/);
		if (markerMatch) {
		    const [_, eventKey, markerDate] = markerMatch;
		    if (!existingMarkers[eventKey]) existingMarkers[eventKey] = [];
		    existingMarkers[eventKey].push(markerDate);
		}
	    }
	} catch (e) {
	    console.error("Error loading recurring markers:", e);
	}
    }

    let updated = store;
    const newMarkers: string[] = [];
    const suppressions = new Set(store.suppressions || []);

    for (const line of recurringEvents) {
	const repeatMatch = line.match(/\[(w|m):([^\]]+)\]/);
	if (!repeatMatch) continue;

	const [_, type, rule] = repeatMatch;
	const eventKey = line.replace(/\s*\[(rc:[wm]|[wm]:[^\]]+)\]$/, "").trim();
	if (existingMarkers[eventKey]?.includes(dateStr)) continue;
	if (suppressions.has(eventKey)) continue;

	let shouldAdd = false;
	if (type === "w") {
	    const days = rule.split(",").map((d: string) => d.trim());
	    if (days.includes(date.toFormat("ccc"))) shouldAdd = true;
	}
	if (type === "m") {
	    const day = parseInt(rule);
	    const lastDay = date.endOf("month").day;
	    const targetDay = day > 0 ? day : lastDay + 1 + day;
	    if (date.day === targetDay) shouldAdd = true;
	}

	if (shouldAdd) {
	    const taskLine = line
		.replace(/\s*<!--.*$/, "")
		.trim()
		.replace(/\s*\[(rc:[wm]|[wm]:[^\]]+)\]$/, "");

	    const startEndMatch = taskLine.match(/^@(\d{1,2}(?::\d{2})?)\s*[-–—]\s*(\d{1,2}(?::\d{2})?)\s+(.+)$/);
	    const startDurMatch = taskLine.match(/^@(\d{1,2}(?::\d{2})?)\s*\(([\dhm]+)\)\s+(.+)$/);

	    let summary: string;
	    let startStr: string;
	    let endStr: string;

	    if (startEndMatch) {
		startStr = normalizeTime(startEndMatch[1]);
		endStr = normalizeTime(startEndMatch[2]);
		summary = startEndMatch[3].trim();
	    } else if (startDurMatch) {
		startStr = normalizeTime(startDurMatch[1]);
		const dur = parseDurationToMinutes(startDurMatch[2]);
		const startDt = DateTime.fromFormat(startStr, "HH:mm");
		endStr = startDt.plus({ minutes: dur }).toFormat("HH:mm");
		summary = startDurMatch[3].trim();
	    } else {
		continue;
	    }

	    const exists = updated.events.some(ev => ev.start === startStr && ev.summary === summary);
	    if (!exists) {
		updated = {
		    ...updated,
		    events: [...updated.events, {
			id: crypto.randomUUID(),
			summary,
			start: startStr,
			end: endStr,
			source: "recurring",
			done: false,
			timeTracking: [],
		    }],
		};
	    }

	    newMarkers.push(`${eventKey} <!-- added:${dateStr} -->`);
	}
    }

    if (newMarkers.length > 0) {
	const folderPath = ".tascal";
	if (!(await adapter.exists(folderPath))) await adapter.mkdir(folderPath);

	let existingContent = "";
	if (await adapter.exists(recurringFilePath)) {
	    existingContent = await adapter.read(recurringFilePath);
	}
	await adapter.write(recurringFilePath, (existingContent + "\n" + newMarkers.join("\n")).trim() + "\n");
    }

    return updated;
}

async function loadRescheduledIntoStore(
    app: App,
    store: DayStore,
    dateStr: string,
): Promise<DayStore> {
    const filePath = ".tascal/rescheduled.md";
    const adapter = app.vault.adapter;

    if (!(await adapter.exists(filePath))) return store;

    const text = await adapter.read(filePath);
    const lines = text.split("\n");
    let updated = store;
    const updatedLines: string[] = [];

    const RANGE_RE = /^@(\d{4}-\d{2}-\d{2}) from (\d{4}-\d{2}-\d{2}): @(\d{1,2}(?::\d{2})?)[-–—](\d{1,2}(?::\d{2})?) (.+)$/;
    const DUR_RE = /^@(\d{4}-\d{2}-\d{2}) from (\d{4}-\d{2}-\d{2}): @(\d{1,2}(?::\d{2})?)\s*\(([\dhm\s]+)\) (.+)$/;

    for (const line of lines) {
	if (line.startsWith("%%processed%%")) {
	    updatedLines.push(line);
	    continue;
	}

	let rangeMatch = line.match(RANGE_RE);
	if (rangeMatch) {
	    const [_, reschedDate, fromDate, startRaw, endRaw, summaryRaw] = rangeMatch;
	    if (reschedDate !== dateStr) {
		updatedLines.push(line);
		continue;
	    }
	    const summary = summaryRaw.replace(/\[[^\]]+\]/, "").replace(/@\d{4}-\d{2}-\d{2}/, "").trim();
	    const startStr = normalizeTime(startRaw);
	    const endStr = normalizeTime(endRaw);

	    const exists = updated.events.some(ev => ev.start === startStr && ev.summary === summary);
	    if (!exists) {
		updated = {
		    ...updated,
		    events: [...updated.events, {
			id: crypto.randomUUID(),
			summary,
			start: startStr,
			end: endStr,
			source: "rescheduled",
			sourceRef: fromDate,
			done: false,
			timeTracking: [],
		    }]
		};
	    }
	    updatedLines.push(`%%processed%% ${line}`);
	    continue;
	}

	let durMatch = line.match(DUR_RE);
	if (durMatch) {
	    const [_, reschedDate, fromDate, startRaw, durStr, summaryRaw] = durMatch;
	    if (reschedDate !== dateStr) {
		updatedLines.push(line);
		continue;
	    }
	    const summary = summaryRaw.replace(/\[[^\]]+\]/, "").replace(/@\d{4}-\d{2}-\d{2}/, "").trim();
	    const startStr = normalizeTime(startRaw);
	    const dur = parseDurationToMinutes(durStr);
	    const startDt = DateTime.fromFormat(startStr, "HH:mm");
	    const endStr = startDt.plus({ minutes: dur }).toFormat("HH:mm");

	    const exists = updated.events.some(ev => ev.start === startStr && ev.summary === summary);
	    if (!exists) {
		updated = {
		    ...updated,
		    events: [...updated.events, {
			id: crypto.randomUUID(),
			summary,
			start: startStr,
			end: endStr,
			source: "rescheduled",
			sourceRef: fromDate,
			done: false,
			timeTracking: [],
		    }]
		};
	    }
	    updatedLines.push(`%%processed%% ${line}`);
	    continue;
	}

	updatedLines.push(line);
    }

    await adapter.write(filePath, updatedLines.join("\n") + "\n");
    return updated;
}

export interface BuildTimelineResult {
    updatedNote: string;
    store: DayStore;
    rescheduled: { target: string; line: string }[];
    sourceTaskChanges: { registryId: string; done: boolean; kind: "event" | "unscheduled"; itemId: string }[];
}

export async function buildTimeline(
    app: App,
    note: string,
    dateStr: string,
    settings: TascalSettings,
    options?: { skipCheckboxSync?: boolean }
): Promise<BuildTimelineResult> {
    const localDate = DateTime.fromISO(dateStr, { zone: settings.timezone });
    const { timeline: existingTimeline } = extractManagedTimelineSection(note, settings.timelineHeading);
    const { lines: existingUnscheduled } = extractManagedUnscheduledSection(note, settings.unscheduledHeading);

    const originalStore = await loadDayStore(app, dateStr);
    let store = originalStore;

    if (!options?.skipCheckboxSync && existingTimeline.length > 0) {
	store = syncCheckboxState(store, existingTimeline);
    }
    if (!options?.skipCheckboxSync && existingUnscheduled.length > 0) {
	store = syncUnscheduledCheckboxState(store, existingUnscheduled);
    }
    const sourceTaskChanges = collectSourceTaskChanges(originalStore, store);

    const rescheduled: { target: string; line: string }[] = [];

    store = await loadRescheduledIntoStore(app, store, dateStr);

    if (settings.recurringRules && settings.recurringRules.length > 0) {
	store = applyRecurringRules(store, settings.recurringRules, dateStr, settings.timezone);
    }

    store = await applyLegacyRecurringEvents(app, store, settings.recurringEvents, localDate);

    await saveDayStore(app, dateStr, store);

    const timelineLines = renderTimeline(
	store.events,
	settings,
	dateStr,
	settings.currentTrackingEventId,
	store.lastCalendarSync
    );
    const unscheduledLines = renderUnscheduledTasks(store.unscheduledTasks || []);
    let updatedNote = updateTascalSection(note, timelineLines, settings.timelineHeading);
    updatedNote = updateUnscheduledSection(updatedNote, unscheduledLines, settings.unscheduledHeading);

    return { updatedNote, store, rescheduled, sourceTaskChanges };
}

function collectSourceTaskChanges(
    before: DayStore,
    after: DayStore
): { registryId: string; done: boolean; kind: "event" | "unscheduled"; itemId: string }[] {
    const changes: { registryId: string; done: boolean; kind: "event" | "unscheduled"; itemId: string }[] = [];

    const beforeEvents = new Map(before.events.map(event => [event.id, event]));
    for (const event of after.events) {
	const prior = beforeEvents.get(event.id);
	if (!prior || prior.done === event.done || !event.sourceRegistryId) continue;
	changes.push({
	    registryId: event.sourceRegistryId,
	    done: event.done,
	    kind: "event",
	    itemId: event.id,
	});
    }

    const beforeTasks = new Map((before.unscheduledTasks || []).map(task => [task.id, task]));
    for (const task of after.unscheduledTasks || []) {
	const prior = beforeTasks.get(task.id);
	if (!prior || prior.done === task.done || !task.sourceRegistryId) continue;
	changes.push({
	    registryId: task.sourceRegistryId,
	    done: task.done,
	    kind: "unscheduled",
	    itemId: task.id,
	});
    }

    return changes;
}

function findHeading(content: string, heading: string): { start: number; lineEnd: number; level: number } | null {
    const escaped = escapeRegExp(heading.trim());
    const regex = new RegExp(`^(#{1,6})\\s+${escaped}\\s*$`, "gm");
    const match = regex.exec(content);
    if (!match || match.index === undefined) {
	return null;
    }
    const start = match.index;
    const lineEnd = content.indexOf("\n", start);
    return {
	start,
	lineEnd: lineEnd === -1 ? content.length : lineEnd + 1,
	level: match[1].length,
    };
}

function findSectionEnd(content: string, from: number, level: number): number {
    const regex = /^(#{1,6})\s+.*$/gm;
    regex.lastIndex = from;

    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
	if (match.index >= from && match[1].length <= level) {
	    return match.index;
	}
    }

    return content.length;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeTime(time: string): string {
    if (time.includes(":")) {
	const [hours, minutes] = time.split(":");
	return `${hours.padStart(2, "0")}:${minutes}`;
    }
    return `${time.padStart(2, "0")}:00`;
}

function parseDurationToMinutes(text: string): number {
    const regex = /(\d+)(h|m)/g;
    let match: RegExpExecArray | null;
    let totalMinutes = 0;
    while ((match = regex.exec(text)) !== null) {
	const value = parseInt(match[1]);
	const unit = match[2];
	totalMinutes += unit === "h" ? value * 60 : value;
    }
    return totalMinutes;
}

export function renderUnscheduledTasks(tasks: UnscheduledTask[]): string[] {
    if (tasks.length === 0) {
	return ["- *No unscheduled tasks*"];
    }

    return tasks.map((task) => {
	const checked = task.done ? "x" : " ";
	const estimate = task.estimateMinutes ? ` *(${formatMinutes(task.estimateMinutes)})*` : "";
	let summary = task.summary;
	if (task.sourceProjectId) {
	    summary += ` *· project-id: ${task.sourceProjectId}*`;
	}
	if (task.sourceNotePath) {
	    const vaultPath = task.sourceNotePath.replace(/\.md$/, "");
	    const displayName = vaultPath.split("/").pop()!;
	    summary += ` [[${vaultPath}|${displayName}]]`;
	}
	if (task.sourceLoadedAt) {
	    summary += ` *· loaded ${task.sourceLoadedAt}*`;
	}
	return `- [${checked}] ${summary}${estimate}`;
    });
}

export function syncUnscheduledCheckboxState(store: DayStore, lines: string[]): DayStore {
    const pattern = /^- \[( |x)]\s+(.+)$/;
    let updated = store;

    for (const line of lines) {
	const match = line.match(pattern);
	if (!match) continue;
	const done = match[1] === "x";
	const summary = stripRenderedUnscheduledSummary(match[2]);
	const task = (updated.unscheduledTasks || []).find(item => item.summary === summary);
	if (task && task.done !== done) {
	    updated = {
		...updated,
		unscheduledTasks: (updated.unscheduledTasks || []).map(item =>
		    item.id === task.id ? { ...item, done } : item
		),
	    };
	}
    }

    return updated;
}

function stripRenderedUnscheduledSummary(text: string): string {
    let summary = text.trim();

    let changed = true;
    while (changed) {
	changed = false;
	for (const pattern of [
	    /\s*\*· loaded [^*]+\*$/,
	    /\s*\[\[[^\]]+\]\]$/,
	    /\s*\[[^\]]*\]\([^)]+\)$/,
	    /\s*\*· project-id: [^*]+\*$/,
	    /\s+\*\([^)]+\)\*$/,
	]) {
	    const updated = summary.replace(pattern, "");
	    if (updated !== summary) {
		summary = updated.trimEnd();
		changed = true;
	    }
	}
    }

    return summary.trim();
}

function formatMinutes(minutes: number): string {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (hours > 0 && mins > 0) return `${hours}h${mins}m`;
    if (hours > 0) return `${hours}h`;
    return `${mins}m`;
}

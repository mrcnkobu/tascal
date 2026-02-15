import { App } from "obsidian";
import { DateTime } from "luxon";
import { DayStore, TascalSettings, StoredEvent } from "./types";
import { formatTime, parseDuration } from "./utils";
import {
    loadDayStore, saveDayStore, addEvent, syncCheckboxState,
    renderTimeline, createManualEvent, sortEventsByTime,
    applyRecurringRules
} from "./store";

// ===== Section parsing =====

export function extractTascalSection(content: string): {
    timeline: string[];
    manualBlockLines: string[];
    fullSection: string;
    start: number;
    end: number;
} {
    const startTag = "<!--tascal-->";
    const endTag = "<!--/tascal-->";
    const manualTag = "<!--manual";

    const start = content.indexOf(startTag);
    const end = content.indexOf(endTag);

    if (start === -1 || end === -1 || start > end) {
        return { timeline: [], manualBlockLines: [], fullSection: "", start: -1, end: -1 };
    }

    const sectionContent = content.slice(start + startTag.length, end).trim();

    const manualStart = sectionContent.indexOf(manualTag);
    let timelineText = "";
    let manualText = "";

    if (manualStart !== -1) {
        timelineText = sectionContent.slice(0, manualStart).trim();
        const manualEnd = sectionContent.indexOf("-->", manualStart);
        manualText = sectionContent.slice(manualStart + manualTag.length, manualEnd).trim();
    } else {
        const parts = sectionContent.split("\n---\n");
        timelineText = parts[0] || "";
        manualText = parts[1] || "";
    }

    const timeline = timelineText.split("\n").filter(line => line.trim() && !line.startsWith("### Timeline"));
    const manualBlockLines = manualText.split("\n").filter(line => line.trim());

    return {
        timeline,
        manualBlockLines,
        fullSection: sectionContent,
        start,
        end: end + endTag.length,
    };
}

export function updateTascalSection(
    content: string,
    timelineLines: string[]
): string {
    const startTag = "<!--tascal-->";
    const endTag = "<!--/tascal-->";
    const newSection =
        `${startTag}\n` +
        `### Timeline\n` +
        timelineLines.join("\n") + "\n" +
        `${endTag}`;

    const { start, end } = extractTascalSection(content);
    if (start === -1 || end === -1) {
        return content + `\n\n${newSection}`;
    }

    return content.slice(0, start) + newSection + content.slice(end);
}

// ===== Manual block import (one-time, from legacy <!--manual--> blocks) =====

const MANUAL_START_END_RE = /^@(\d{1,2}(?::\d{2})?)\s*[-–—]\s*(\d{1,2}(?::\d{2})?)\s+(.*?)(?:\s+@(\d{4}-\d{2}-\d{2}))?$/;
const MANUAL_START_DUR_RE = /^@(\d{1,2}(?::\d{2})?)\s*\(([\dhm]+)\)\s+(.*?)(?:\s+@(\d{4}-\d{2}-\d{2}))?$/;

function importManualBlocksToStore(
    store: DayStore,
    manualBlockLines: string[],
    dateStr: string,
    timezone: string
): { store: DayStore; rescheduled: { target: string; line: string }[] } {
    let updated = store;
    const rescheduled: { target: string; line: string }[] = [];

    for (const line of manualBlockLines) {
	// Check for reschedule
	const rescheduleMatch = line.match(/@(\d{4}-\d{2}-\d{2})(?:@(\d{2}:\d{2}))?/);
	const isRescheduled = rescheduleMatch !== null;
	const rescheduleTime = rescheduleMatch?.[2] || null;

	let m;
	if ((m = line.match(MANUAL_START_END_RE))) {
	    const [_, startRaw, endRaw, summary, reschedDate] = m;

	    if (isRescheduled && !rescheduleTime) {
		rescheduled.push({ target: reschedDate!, line });
		continue;
	    }

	    const startStr = formatTime(startRaw);
	    const endStr = formatTime(endRaw);
	    const cleanSummary = summary.replace(/\s*\[rc:[wm]\]$/, "").trim();

	    // Only add if not already in store
	    const exists = updated.events.some(
		ev => ev.start === startStr && ev.summary === cleanSummary
	    );
	    if (!exists) {
		const source = line.includes("[rc:") ? "recurring" as const : "manual" as const;
		updated = addEvent(updated, {
		    id: crypto.randomUUID(),
		    summary: cleanSummary,
		    start: startStr,
		    end: endStr,
		    source,
		    done: false,
		    timeTracking: [],
		});
	    }
	} else if ((m = line.match(MANUAL_START_DUR_RE))) {
	    const [_, startRaw, durStr, summary, reschedDate] = m;

	    if (isRescheduled && !rescheduleTime) {
		rescheduled.push({ target: reschedDate!, line });
		continue;
	    }

	    const startStr = formatTime(startRaw);
	    const durationMinutes = parseDuration(durStr);
	    const startDt = DateTime.fromFormat(startStr, "HH:mm");
	    const endStr = startDt.plus({ minutes: durationMinutes }).toFormat("HH:mm");
	    const cleanSummary = summary.replace(/\s*\[rc:[wm]\]$/, "").trim();

	    const exists = updated.events.some(
		ev => ev.start === startStr && ev.summary === cleanSummary
	    );
	    if (!exists) {
		const source = line.includes("[rc:") ? "recurring" as const : "manual" as const;
		updated = addEvent(updated, {
		    id: crypto.randomUUID(),
		    summary: cleanSummary,
		    start: startStr,
		    end: endStr,
		    source,
		    done: false,
		    timeTracking: [],
		});
	    }
	}
    }

    return { store: updated, rescheduled };
}

// ===== Recurring tasks (from settings strings — legacy format) =====

async function applyLegacyRecurringEvents(
    app: App,
    store: DayStore,
    recurringEvents: string[],
    date: DateTime
): Promise<DayStore> {
    const adapter = app.vault.adapter;
    const recurringFilePath = ".tascal/recurring.md";
    const dateStr = date.toISODate()!;

    // Load existing markers
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

	// Skip if explicitly suppressed (deleted/rescheduled)
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
	    // Parse the event line
	    let taskLine = line.replace(/\s*<!--.*$/, "").trim();
	    taskLine = taskLine.replace(/\s*\[(rc:[wm]|[wm]:[^\]]+)\]$/, "");

	    // Parse start/end from the event definition
	    const startEndMatch = taskLine.match(/^@(\d{1,2}(?::\d{2})?)\s*[-–—]\s*(\d{1,2}(?::\d{2})?)\s+(.+)$/);
	    const startDurMatch = taskLine.match(/^@(\d{1,2}(?::\d{2})?)\s*\(([\dhm]+)\)\s+(.+)$/);

	    let summary: string;
	    let startStr: string;
	    let endStr: string;

	    if (startEndMatch) {
		startStr = formatTime(startEndMatch[1]);
		endStr = formatTime(startEndMatch[2]);
		summary = startEndMatch[3].trim();
	    } else if (startDurMatch) {
		startStr = formatTime(startDurMatch[1]);
		const dur = parseDuration(startDurMatch[2]);
		const startDt = DateTime.fromFormat(startStr, "HH:mm");
		endStr = startDt.plus({ minutes: dur }).toFormat("HH:mm");
		summary = startDurMatch[3].trim();
	    } else {
		continue;
	    }

	    // Deduplicate against store
	    const exists = updated.events.some(
		ev => ev.start === startStr && ev.summary === summary
	    );
	    if (!exists) {
		updated = addEvent(updated, {
		    id: crypto.randomUUID(),
		    summary,
		    start: startStr,
		    end: endStr,
		    source: "recurring",
		    done: false,
		    timeTracking: [],
		});
	    }

	    newMarkers.push(`${eventKey} <!-- added:${dateStr} -->`);
	}
    }

    // Save markers
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

// ===== Rescheduled tasks =====

async function loadRescheduledIntoStore(
    app: App,
    store: DayStore,
    dateStr: string,
    timezone: string
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
	    const startStr = formatTime(startRaw);
	    const endStr = formatTime(endRaw);

	    const exists = updated.events.some(ev => ev.start === startStr && ev.summary === summary);
	    if (!exists) {
		updated = addEvent(updated, {
		    id: crypto.randomUUID(),
		    summary,
		    start: startStr,
		    end: endStr,
		    source: "rescheduled",
		    sourceRef: fromDate,
		    done: false,
		    timeTracking: [],
		});
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
	    const startStr = formatTime(startRaw);
	    const dur = parseDuration(durStr);
	    const startDt = DateTime.fromFormat(startStr, "HH:mm");
	    const endStr = startDt.plus({ minutes: dur }).toFormat("HH:mm");

	    const exists = updated.events.some(ev => ev.start === startStr && ev.summary === summary);
	    if (!exists) {
		updated = addEvent(updated, {
		    id: crypto.randomUUID(),
		    summary,
		    start: startStr,
		    end: endStr,
		    source: "rescheduled",
		    sourceRef: fromDate,
		    done: false,
		    timeTracking: [],
		});
	    }
	    updatedLines.push(`%%processed%% ${line}`);
	    continue;
	}

	updatedLines.push(line);
    }

    await adapter.write(filePath, updatedLines.join("\n") + "\n");
    return updated;
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

// ===== Main build pipeline =====

export interface BuildTimelineResult {
    updatedNote: string;
    store: DayStore;
    rescheduled: { target: string; line: string }[];
}

export async function buildTimeline(
    app: App,
    note: string,
    dateStr: string,
    settings: TascalSettings
): Promise<BuildTimelineResult> {
    const localDate = DateTime.fromISO(dateStr, { zone: settings.timezone });
    const { timeline: existingTimeline, manualBlockLines } = extractTascalSection(note);

    // Load current store
    let store = await loadDayStore(app, dateStr);

    // Sync checkbox state from existing rendered markdown
    if (existingTimeline.length > 0) {
	store = syncCheckboxState(store, existingTimeline);
    }

    // Import legacy manual blocks if present
    let rescheduled: { target: string; line: string }[] = [];
    if (manualBlockLines.length > 0) {
	const result = importManualBlocksToStore(store, manualBlockLines, dateStr, settings.timezone);
	store = result.store;
	rescheduled = result.rescheduled;
    }

    // Apply rescheduled tasks from file
    store = await loadRescheduledIntoStore(app, store, dateStr, settings.timezone);

    // Apply structured recurring rules (Phase 5)
    if (settings.recurringRules && settings.recurringRules.length > 0) {
	store = applyRecurringRules(store, settings.recurringRules, dateStr, settings.timezone);
    }

    // Apply legacy recurring events (for rules not yet migrated)
    store = await applyLegacyRecurringEvents(app, store, settings.recurringEvents, localDate);

    // Save store
    await saveDayStore(app, dateStr, store);

    // Render timeline
    const timelineLines = renderTimeline(store.events, settings, dateStr, settings.currentTrackingEventId);
    const updatedNote = updateTascalSection(note, timelineLines);

    return { updatedNote, store, rescheduled };
}

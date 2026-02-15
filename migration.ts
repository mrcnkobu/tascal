import { App } from "obsidian";
import { DateTime } from "luxon";
import { StoredEvent, DayStore, TimeTrackingData, TimeTrackingEntry, TascalSettings, RecurringRule } from "./types";
import { loadDayStore, saveDayStore } from "./store";
import { extractTascalSection } from "./timeline";
import { formatTime, parseDuration } from "./utils";

// Pattern for timeline event lines: "- [x] > 09:00–10:00 Summary {TT: ...}"
const TIMELINE_EVENT_RE = /^- \[( |x)]\s*(>?\s*)(\d{1,2}:\d{2})–(\d{1,2}:\d{2})\s+(.+?)(?:\s*\{TT:([^}]*)\})?$/;
// Pattern for manual block lines: "@09:00 (1h) Summary" or "@09:00–10:00 Summary"
const MANUAL_START_END_RE = /^@(\d{1,2}(?::\d{2})?)\s*[-–—]\s*(\d{1,2}(?::\d{2})?)\s+(.+?)$/;
const MANUAL_START_DUR_RE = /^@(\d{1,2}(?::\d{2})?)\s*\(([\dhm]+)\)\s+(.+?)$/;
// Rescheduled entries: "@2025-04-20 from 2025-04-18: @09:00–10:00 Summary"
const RESCHED_RANGE_RE = /^@(\d{4}-\d{2}-\d{2}) from (\d{4}-\d{2}-\d{2}): @(\d{1,2}(?::\d{2})?)[-–—](\d{1,2}(?::\d{2})?) (.+)$/;
const RESCHED_DUR_RE = /^@(\d{4}-\d{2}-\d{2}) from (\d{4}-\d{2}-\d{2}): @(\d{1,2}(?::\d{2})?)\s*\(([\dhm\s]+)\) (.+)$/;

export async function runStoreMigration(app: App, settings: TascalSettings): Promise<void> {
    if (settings.storeMigrationDone) return;

    const adapter = app.vault.adapter;
    console.log("Tascal: starting store migration...");

    // Collect all dates that have any old data
    const datesToMigrate = new Set<string>();

    // 1. Scan old calendar cache files (.tascal/YYYY-MM-DD.json)
    if (await adapter.exists(".tascal")) {
	const listing = await adapter.list(".tascal");
	for (const file of listing.files) {
	    const match = file.match(/\.tascal\/(\d{4}-\d{2}-\d{2})\.json$/);
	    if (match) {
		datesToMigrate.add(match[1]);
	    }
	}

	// Also pick up tt-*.json dates
	for (const file of listing.files) {
	    const match = file.match(/\.tascal\/tt-(\d{4}-\d{2}-\d{2})\.json$/);
	    if (match) {
		datesToMigrate.add(match[1]);
	    }
	}
    }

    // 2. Scan daily notes for tascal sections (files matching YYYY-MM-DD*.md)
    const allFiles = app.vault.getMarkdownFiles();
    const notesByDate = new Map<string, string>(); // dateStr → file path
    for (const file of allFiles) {
	const dateMatch = file.basename.match(/^(\d{4}-\d{2}-\d{2})/);
	if (dateMatch) {
	    datesToMigrate.add(dateMatch[1]);
	    notesByDate.set(dateMatch[1], file.path);
	}
    }

    // 3. Parse rescheduled.md for target dates
    const rescheduledByDate = new Map<string, { summary: string; start: string; end: string; originDate: string }[]>();
    const rescheduledPath = ".tascal/rescheduled.md";
    if (await adapter.exists(rescheduledPath)) {
	const text = await adapter.read(rescheduledPath);
	for (const line of text.split("\n")) {
	    if (line.startsWith("%%processed%%")) continue;

	    let rangeMatch = line.match(RESCHED_RANGE_RE);
	    if (rangeMatch) {
		const [_, targetDate, fromDate, startStr, endStr, summaryRaw] = rangeMatch;
		const summary = summaryRaw.replace(/\[[^\]]+\]/, "").replace(/@\d{4}-\d{2}-\d{2}/, "").trim();
		if (!rescheduledByDate.has(targetDate)) rescheduledByDate.set(targetDate, []);
		rescheduledByDate.get(targetDate)!.push({
		    summary,
		    start: formatTime(startStr),
		    end: formatTime(endStr),
		    originDate: fromDate,
		});
		datesToMigrate.add(targetDate);
		continue;
	    }

	    let durMatch = line.match(RESCHED_DUR_RE);
	    if (durMatch) {
		const [_, targetDate, fromDate, startStr, durStr, summaryRaw] = durMatch;
		const summary = summaryRaw.replace(/\[[^\]]+\]/, "").replace(/@\d{4}-\d{2}-\d{2}/, "").trim();
		const startFormatted = formatTime(startStr);
		const durationMinutes = parseDuration(durStr);
		const startDt = DateTime.fromFormat(startFormatted, "HH:mm");
		const endDt = startDt.plus({ minutes: durationMinutes });
		if (!rescheduledByDate.has(targetDate)) rescheduledByDate.set(targetDate, []);
		rescheduledByDate.get(targetDate)!.push({
		    summary,
		    start: startFormatted,
		    end: endDt.toFormat("HH:mm"),
		    originDate: fromDate,
		});
		datesToMigrate.add(targetDate);
	    }
	}
    }

    let migratedCount = 0;

    for (const dateStr of datesToMigrate) {
	// Skip if day store already exists (don't overwrite)
	const existing = await loadDayStore(app, dateStr);
	if (existing.events.length > 0) continue;

	const store: DayStore = { version: 1, events: [] };
	const seenKeys = new Set<string>();

	// --- Calendar cache ---
	const calCachePath = `.tascal/${dateStr}.json`;
	if (await adapter.exists(calCachePath)) {
	    try {
		const raw = JSON.parse(await adapter.read(calCachePath));
		for (const item of raw) {
		    const startDt = DateTime.fromISO(item.start);
		    const endDt = DateTime.fromISO(item.end);
		    const startStr = startDt.toFormat("HH:mm");
		    const endStr = endDt.toFormat("HH:mm");
		    const key = `cal-${item.uid}`;
		    if (seenKeys.has(key)) continue;
		    seenKeys.add(key);

		    const event: StoredEvent = {
			id: crypto.randomUUID(),
			summary: item.summary,
			start: startStr,
			end: endStr,
			source: "calendar",
			sourceRef: item.uid,
			done: item.done === true,
			timeTracking: [],
		    };
		    store.events.push(event);
		}
	    } catch (e) {
		console.error(`Migration: failed to read calendar cache for ${dateStr}:`, e);
	    }
	}

	// --- Time tracking data (tt-*.json) ---
	const ttPath = `.tascal/tt-${dateStr}.json`;
	let ttData: TimeTrackingData = {};
	if (await adapter.exists(ttPath)) {
	    try {
		ttData = JSON.parse(await adapter.read(ttPath));
	    } catch (e) {
		console.error(`Migration: failed to read TT data for ${dateStr}:`, e);
	    }
	}

	// --- Daily note tascal section ---
	const notePath = notesByDate.get(dateStr);
	if (notePath) {
	    try {
		const noteFile = app.vault.getAbstractFileByPath(notePath);
		if (noteFile && "extension" in noteFile) {
		    const note = await adapter.read(notePath);
		    const { timeline, manualBlockLines } = extractTascalSection(note);

		    // Parse timeline lines for checkbox + TT state
		    for (const line of timeline) {
			const m = line.match(TIMELINE_EVENT_RE);
			if (!m) continue;

			const [_, checkbox, _tracking, startStr, endStr, summary, ttStr] = m;
			const isDone = checkbox === "x";

			// Parse inline TT
			let entries: TimeTrackingEntry[] = [];
			if (ttStr) {
			    entries = ttStr.split(",").map((e: string) => {
				const parts = e.trim().split("::");
				return { start: parts[0].trim(), duration: (parts[1] || "").trim() };
			    }).filter(e => e.start);
			}

			// Try to match to existing store event by start+summary
			const existing = store.events.find(
			    ev => ev.start === startStr && ev.summary === summary
			);
			if (existing) {
			    existing.done = isDone;
			    if (entries.length > 0) existing.timeTracking = entries;
			} else {
			    // This is a manual event found only in the timeline
			    const key = `manual-${startStr}-${summary}`;
			    if (!seenKeys.has(key)) {
				seenKeys.add(key);
				store.events.push({
				    id: crypto.randomUUID(),
				    summary,
				    start: startStr,
				    end: endStr,
				    source: "manual",
				    done: isDone,
				    timeTracking: entries,
				});
			    }
			}
		    }

		    // Parse manual block lines
		    for (const line of manualBlockLines) {
			let m = line.match(MANUAL_START_END_RE);
			if (m) {
			    const [_, startRaw, endRaw, summary] = m;
			    const startStr = formatTime(startRaw);
			    const endStr = formatTime(endRaw);
			    const key = `manual-${startStr}-${summary.trim()}`;
			    if (!seenKeys.has(key)) {
				seenKeys.add(key);
				store.events.push({
				    id: crypto.randomUUID(),
				    summary: summary.trim(),
				    start: startStr,
				    end: endStr,
				    source: "manual",
				    done: false,
				    timeTracking: [],
				});
			    }
			    continue;
			}

			m = line.match(MANUAL_START_DUR_RE);
			if (m) {
			    const [_, startRaw, durStr, summary] = m;
			    const startStr = formatTime(startRaw);
			    const durationMinutes = parseDuration(durStr);
			    const startDt = DateTime.fromFormat(startStr, "HH:mm");
			    const endDt = startDt.plus({ minutes: durationMinutes });
			    const endStr = endDt.toFormat("HH:mm");
			    const key = `manual-${startStr}-${summary.trim()}`;
			    if (!seenKeys.has(key)) {
				seenKeys.add(key);
				store.events.push({
				    id: crypto.randomUUID(),
				    summary: summary.trim(),
				    start: startStr,
				    end: endStr,
				    source: "manual",
				    done: false,
				    timeTracking: [],
				});
			    }
			}
		    }
		}
	    } catch (e) {
		console.error(`Migration: failed to parse daily note for ${dateStr}:`, e);
	    }
	}

	// --- Merge TT data from tt-*.json into store events ---
	for (const [eventKey, entries] of Object.entries(ttData)) {
	    // eventKey might be a summary or "start-end-summary" format
	    const summaryMatch = eventKey.match(/^\d{1,2}:\d{2}-\d{1,2}:\d{2}-(.+)$/);
	    const summaryToMatch = summaryMatch ? summaryMatch[1].trim() : eventKey.trim();

	    const event = store.events.find(ev => ev.summary === summaryToMatch);
	    if (event && event.timeTracking.length === 0) {
		event.timeTracking = entries;
	    }
	}

	// --- Rescheduled events ---
	const rescheduled = rescheduledByDate.get(dateStr) || [];
	for (const r of rescheduled) {
	    const key = `resched-${r.start}-${r.summary}`;
	    if (!seenKeys.has(key)) {
		seenKeys.add(key);
		store.events.push({
		    id: crypto.randomUUID(),
		    summary: r.summary,
		    start: r.start,
		    end: r.end,
		    source: "rescheduled",
		    sourceRef: r.originDate,
		    done: false,
		    timeTracking: [],
		});
	    }
	}

	// Sort by start time before saving
	store.events.sort((a, b) => a.start.localeCompare(b.start));

	if (store.events.length > 0) {
	    await saveDayStore(app, dateStr, store);
	    migratedCount++;
	}
    }

    console.log(`Tascal: migration complete — ${migratedCount} day(s) migrated.`);
}

// ===== Migrate recurring event strings to structured RecurringRule objects =====

export function migrateRecurringStringsToRules(recurringEvents: string[]): RecurringRule[] {
    const rules: RecurringRule[] = [];

    const START_END_RE = /^@(\d{1,2}(?::\d{2})?)\s*[-–—]\s*(\d{1,2}(?::\d{2})?)\s+(.+?)(?:\s*\[(w|m):([^\]]+)\])$/;
    const START_DUR_RE = /^@(\d{1,2}(?::\d{2})?)\s*\(([\dhm]+)\)\s+(.+?)(?:\s*\[(w|m):([^\]]+)\])$/;

    for (const line of recurringEvents) {
	let m;

	if ((m = line.match(START_DUR_RE))) {
	    const [_, startRaw, durStr, summary, type, rule] = m;
	    const start = formatTime(startRaw);
	    const duration = parseDuration(durStr);

	    const recurrence = type === "w"
		? { type: "weekly" as const, days: rule.split(",").map(d => d.trim()) }
		: { type: "monthly" as const, day: parseInt(rule) };

	    rules.push({
		id: crypto.randomUUID(),
		summary: summary.trim(),
		start,
		duration,
		recurrence,
	    });
	} else if ((m = line.match(START_END_RE))) {
	    const [_, startRaw, endRaw, summary, type, rule] = m;
	    const start = formatTime(startRaw);
	    const endStr = formatTime(endRaw);
	    const startDt = DateTime.fromFormat(start, "HH:mm");
	    const endDt = DateTime.fromFormat(endStr, "HH:mm");
	    const duration = endDt.diff(startDt, "minutes").minutes;

	    const recurrence = type === "w"
		? { type: "weekly" as const, days: rule.split(",").map(d => d.trim()) }
		: { type: "monthly" as const, day: parseInt(rule) };

	    rules.push({
		id: crypto.randomUUID(),
		summary: summary.trim(),
		start,
		duration,
		recurrence,
	    });
	}
    }

    return rules;
}

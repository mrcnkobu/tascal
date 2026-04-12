import { App } from "obsidian";
import { DateTime } from "luxon";
import { StoredEvent, DayStore, TascalSettings, RecurringRule, TimeTrackingEntry, UnscheduledTask } from "./types";
import { formatDuration } from "./utils";

const DAYS_DIR = ".tascal/days";

function dayStorePath(dateStr: string): string {
    return `${DAYS_DIR}/${dateStr}.json`;
}

function emptyDayStore(): DayStore {
    return { version: 1, events: [], unscheduledTasks: [] };
}

// ===== Persistence =====

export async function loadDayStore(app: App, dateStr: string): Promise<DayStore> {
    const adapter = app.vault.adapter;
    const path = dayStorePath(dateStr);

    if (!(await adapter.exists(path))) {
	return emptyDayStore();
    }

    try {
	const text = await adapter.read(path);
	const data = JSON.parse(text) as DayStore;
	if (data.version !== 1) {
	    console.warn(`DayStore ${dateStr}: unknown version ${data.version}, treating as empty`);
	    return emptyDayStore();
	}
	if (!data.unscheduledTasks) {
	    data.unscheduledTasks = [];
	}
	return data;
    } catch (e) {
	console.error(`Failed to read DayStore for ${dateStr}:`, e);
	return emptyDayStore();
    }
}

export async function saveDayStore(app: App, dateStr: string, store: DayStore): Promise<void> {
    const adapter = app.vault.adapter;

    if (!(await adapter.exists(DAYS_DIR))) {
	await adapter.mkdir(DAYS_DIR);
    }

    const path = dayStorePath(dateStr);
    await adapter.write(path, JSON.stringify(store, null, 2));
}

// ===== Immutable mutators =====

export function addEvent(store: DayStore, event: StoredEvent): DayStore {
    return { ...store, events: [...store.events, event] };
}

export function updateEvent(store: DayStore, id: string, updates: Partial<Omit<StoredEvent, "id">>): DayStore {
    return {
	...store,
	events: store.events.map(ev =>
	    ev.id === id ? { ...ev, ...updates } : ev
	),
    };
}

export function removeEvent(store: DayStore, id: string): DayStore {
    return { ...store, events: store.events.filter(ev => ev.id !== id) };
}

export function addSuppression(store: DayStore, key: string): DayStore {
    const existing = store.suppressions || [];
    if (existing.includes(key)) return store;
    return { ...store, suppressions: [...existing, key] };
}

export function addUnscheduledTask(store: DayStore, task: UnscheduledTask): DayStore {
    return { ...store, unscheduledTasks: [...(store.unscheduledTasks || []), task] };
}

export function updateUnscheduledTask(
    store: DayStore,
    id: string,
    updates: Partial<Omit<UnscheduledTask, "id">>
): DayStore {
    return {
	...store,
	unscheduledTasks: (store.unscheduledTasks || []).map(task =>
	    task.id === id ? { ...task, ...updates } : task
	),
    };
}

export function removeUnscheduledTask(store: DayStore, id: string): DayStore {
    return {
	...store,
	unscheduledTasks: (store.unscheduledTasks || []).filter(task => task.id !== id),
    };
}

// ===== Queries =====

export function findEventById(store: DayStore, id: string): StoredEvent | undefined {
    return store.events.find(ev => ev.id === id);
}

export function findUnscheduledTaskById(store: DayStore, id: string): UnscheduledTask | undefined {
    return (store.unscheduledTasks || []).find(task => task.id === id);
}

export function findEventBySourceRef(
    store: DayStore,
    source: StoredEvent["source"],
    ref: string
): StoredEvent | undefined {
    return store.events.find(ev => ev.source === source && ev.sourceRef === ref);
}

export function sortEventsByTime(events: StoredEvent[]): StoredEvent[] {
    return [...events].sort((a, b) => a.start.localeCompare(b.start));
}

// ===== Time tracking =====

export function startTracking(event: StoredEvent, startTime: string): StoredEvent {
    return {
	...event,
	timeTracking: [...event.timeTracking, { start: startTime, duration: "" }],
    };
}

export function stopTracking(event: StoredEvent, duration: string): StoredEvent {
    const entries = [...event.timeTracking];
    // Find last entry with empty duration
    for (let i = entries.length - 1; i >= 0; i--) {
	if (entries[i].duration === "") {
	    entries[i] = { ...entries[i], duration };
	    break;
	}
    }
    return { ...event, timeTracking: entries };
}

// ===== Calendar merge =====

export interface IncomingCalendarEvent {
    summary: string;
    start: string; // "HH:MM"
    end: string;   // "HH:MM"
    icsUid: string;
}

export function mergeCalendarEvents(store: DayStore, incoming: IncomingCalendarEvent[]): DayStore {
    let updated = { ...store, events: [...store.events] };

    for (const inc of incoming) {
	const existing = findEventBySourceRef(updated, "calendar", inc.icsUid);

	if (existing) {
	    // Update time/summary but preserve done + timeTracking
	    updated = updateEvent(updated, existing.id, {
		summary: inc.summary,
		start: inc.start,
		end: inc.end,
	    });
	} else {
	    const newEvent: StoredEvent = {
		id: crypto.randomUUID(),
		summary: inc.summary,
		start: inc.start,
		end: inc.end,
		source: "calendar",
		sourceRef: inc.icsUid,
		done: false,
		timeTracking: [],
	    };
	    updated = addEvent(updated, newEvent);
	}
    }

    // Remove calendar events whose UID no longer appears in the incoming set
    const incomingUids = new Set(incoming.map(e => e.icsUid));
    updated = {
	...updated,
	events: updated.events.filter(
	    ev => ev.source !== "calendar" || incomingUids.has(ev.sourceRef ?? "")
	),
    };

    return updated;
}

// ===== Helpers =====

export function createManualEvent(
    summary: string,
    start: string,
    end: string,
    extras?: Partial<Pick<StoredEvent, "sourceRegistryId" | "sourceProjectId" | "sourceTaskId" | "sourceNotePath" | "sourceLoadedAt">>
): StoredEvent {
    return {
	id: crypto.randomUUID(),
	summary,
	start,
	end,
	source: "manual",
	done: false,
	timeTracking: [],
	...extras,
    };
}

export function createUnscheduledTask(
    summary: string,
    estimateMinutes?: number,
    extras?: Partial<Pick<UnscheduledTask, "sourceRegistryId" | "sourceProjectId" | "sourceTaskId" | "sourceNotePath" | "sourceLoadedAt">>
): UnscheduledTask {
    return {
	id: crypto.randomUUID(),
	summary,
	done: false,
	estimateMinutes,
	...extras,
    };
}

export function createRecurringEvent(summary: string, start: string, end: string, ruleId: string): StoredEvent {
    return {
	id: crypto.randomUUID(),
	summary,
	start,
	end,
	source: "recurring",
	sourceRef: ruleId,
	done: false,
	timeTracking: [],
    };
}

export function createRescheduledEvent(summary: string, start: string, end: string, originDate: string): StoredEvent {
    return {
	id: crypto.randomUUID(),
	summary,
	start,
	end,
	source: "rescheduled",
	sourceRef: originDate,
	done: false,
	timeTracking: [],
    };
}

// ===== Recurring rules =====

export function applyRecurringRules(
    store: DayStore,
    rules: RecurringRule[],
    dateStr: string,
    timezone: string
): DayStore {
    const date = DateTime.fromISO(dateStr, { zone: timezone });
    let updated = store;

    const suppressions = new Set(store.suppressions || []);

    for (const rule of rules) {
	// Check exceptions
	if (rule.exceptions?.includes(dateStr)) continue;

	// Skip if explicitly suppressed (deleted/rescheduled)
	if (suppressions.has(rule.id)) continue;

	// Check day match
	let matches = false;
	if (rule.recurrence.type === "weekly") {
	    const dayAbbr = date.toFormat("ccc"); // Mon, Tue, etc.
	    matches = rule.recurrence.days.includes(dayAbbr);
	} else if (rule.recurrence.type === "monthly") {
	    const lastDay = date.endOf("month").day;
	    const targetDay = rule.recurrence.day > 0
		? rule.recurrence.day
		: lastDay + 1 + rule.recurrence.day;
	    matches = date.day === targetDay;
	}

	if (!matches) continue;

	// Dedup: check if already in store via sourceRef
	const existing = findEventBySourceRef(updated, "recurring", rule.id);
	if (existing) continue;

	// Calculate end time
	const startDt = DateTime.fromFormat(rule.start, "HH:mm");
	const endStr = startDt.plus({ minutes: rule.duration }).toFormat("HH:mm");

	updated = addEvent(updated, {
	    id: crypto.randomUUID(),
	    summary: rule.summary,
	    start: rule.start,
	    end: endStr,
	    source: "recurring",
	    sourceRef: rule.id,
	    done: false,
	    timeTracking: [],
	});
    }

    return updated;
}

// ===== Timeline rendering (pure projection) =====

export function renderTimeline(
    events: StoredEvent[],
    settings: TascalSettings,
    dateStr: string,
    currentTrackingEventId: string | null,
    lastCalendarSync?: string
): string[] {
    const sorted = sortEventsByTime(events);
    const date = DateTime.fromISO(dateStr, { zone: settings.timezone });
    const dayName = date.toFormat("EEEE");
    const override = settings.dayOverrides[dayName];
    const startStr = override?.start || settings.defaultDayStart;
    const endStr = override?.end || settings.defaultDayEnd;

    let cursor = startStr;
    const endOfDay = endStr;

    let totalTasks = 0;
    let completedTasks = 0;
    let totalMinutes = 0;
    let elapsedMinutes = 0;
    let remainingMinutes = 0;
    let totalTrackedMinutes = 0;

    const eventLines: string[] = [];
    let previousEnd: string | null = null;

    for (const ev of sorted) {
	const overlapMinutes = previousEnd && ev.start < previousEnd
	    ? timeToMinutes(previousEnd) - timeToMinutes(ev.start)
	    : 0;

	// Insert free-time gap
	if (ev.start > cursor) {
	    eventLines.push(`- *${cursor}–${ev.start} (free)*`);
	}

	const checked = ev.done ? "x" : " ";
	const isTracking = currentTrackingEventId === ev.id;
	const trackingSymbol = isTracking ? " >" : "";

	// Format time tracking entries
	let trackingInfo = "";
	if (ev.timeTracking.length > 0) {
	    const entries = ev.timeTracking
		.map(e => e.duration ? `${e.start}::${e.duration}` : `${e.start}::`)
		.join(", ");
	    trackingInfo = ` {TT: ${entries}}`;
	}

	// Format summary: italicize source annotations
	let displaySummary = ev.summary;
	if (ev.source === "calendar") {
	    displaySummary = displaySummary.replace(/^\(([^)]+)\)/, "*($1)*");
	}
	if (ev.source === "rescheduled" && ev.sourceRef) {
	    displaySummary += ` *· rs:${ev.sourceRef}*`;
	}
	if (ev.source === "recurring") {
	    displaySummary += " *· rc*";
	}
	if (ev.linkedNoteMarkdown) {
	    displaySummary += ` ${ev.linkedNoteMarkdown}`;
	} else if (ev.linkedNotePath) {
	    // Fallback for events created before linkedNoteMarkdown was stored
	    const vaultPath = ev.linkedNotePath.replace(/\.md$/, "");
	    const displayName = vaultPath.split("/").pop()!;
	    displaySummary += ` [[${vaultPath}|${displayName}]]`;
	}
	if (ev.sourceProjectId) {
	    displaySummary += ` *· project-id: ${ev.sourceProjectId}*`;
	}
	if (ev.sourceNotePath) {
	    const vaultPath = ev.sourceNotePath.replace(/\.md$/, "");
	    const displayName = vaultPath.split("/").pop()!;
	    displaySummary += ` [[${vaultPath}|${displayName}]]`;
	}
	if (ev.sourceLoadedAt) {
	    displaySummary += ` *· loaded ${ev.sourceLoadedAt}*`;
	}
	if (isTracking) {
	    displaySummary += " *· tracking*";
	}
	if (overlapMinutes > 0) {
	    displaySummary += ` *· overlap ${formatDuration(overlapMinutes)}*`;
	}

	eventLines.push(`- [${checked}]${trackingSymbol} ${ev.start}–${ev.end} ${displaySummary}${trackingInfo}`);

	if (ev.end > cursor) {
	    cursor = ev.end;
	}
	previousEnd = previousEnd && previousEnd > ev.end ? previousEnd : ev.end;

	// Stats
	const blockMinutes = timeToMinutes(ev.end) - timeToMinutes(ev.start);
	totalTasks++;
	totalMinutes += blockMinutes;
	if (ev.done) {
	    completedTasks++;
	    elapsedMinutes += blockMinutes;
	} else {
	    remainingMinutes += blockMinutes;
	}

	// Tracked time
	for (const entry of ev.timeTracking) {
	    if (entry.duration && entry.duration !== "") {
		const [h, m] = entry.duration.split(":").map(Number);
		totalTrackedMinutes += h * 60 + m;
	    }
	}
    }

    // Trailing free time
    if (cursor < endOfDay) {
	eventLines.push(`- *${cursor}–${endOfDay} (free)*`);
    }

    const totalTimeStr = formatDuration(totalMinutes);
    const elapsedTimeStr = formatDuration(elapsedMinutes);
    const totalTrackedStr = formatDuration(totalTrackedMinutes);

    const statsParts = [
	`**${completedTasks}/${totalTasks}** done`,
	`${elapsedTimeStr}/${totalTimeStr}`,
	`**TT ${totalTrackedStr}**`,
    ];
    const hasCalendarEvents = sorted.some(event => event.source === "calendar");
    if (hasCalendarEvents) {
	if (!lastCalendarSync) {
	    statsParts.push("*sync missing*");
	} else {
	    const syncTime = DateTime.fromISO(lastCalendarSync, { zone: settings.timezone });
	    const hoursSinceSync = DateTime.now().setZone(settings.timezone).diff(syncTime, "hours").hours;
	    if (date.hasSame(DateTime.now().setZone(settings.timezone), "day") && hoursSinceSync >= 6) {
		statsParts.push("*sync stale*");
	    } else {
		statsParts.push(`*sync ${syncTime.toFormat("HH:mm")}*`);
	    }
	}
    }

    const statsLine = statsParts.join(" | ");

    return [statsLine, "", ...eventLines];
}

// ===== Sync checkbox state from rendered markdown back to store =====

export function syncCheckboxState(store: DayStore, renderedLines: string[]): DayStore {
    const pattern = /^- \[( |x)]\s*(>?\s*)(\d{1,2}:\d{2})–(\d{1,2}:\d{2})\s+(.+?)(?:\s*\{TT:[^}]*\})?$/;

    let updated = store;
    for (const line of renderedLines) {
	const m = line.match(pattern);
	if (!m) continue;

	const isDone = m[1] === "x";
	const startStr = m[3];
	// Strip rendering decorations to recover the stored summary
	let summary = m[5].trim();
	summary = stripRenderedEventSummary(summary);

	// Match by start + summary (unique within a day)
	const event = updated.events.find(
	    ev => ev.start === startStr && ev.summary === summary
	);
	if (event && event.done !== isDone) {
	    updated = updateEvent(updated, event.id, { done: isDone });
	}
    }

    return updated;
}

function stripRenderedEventSummary(summary: string): string {
    let next = summary.trim();
    next = next.replace(/^\*\(([^)]+)\)\*/, "($1)");

    let changed = true;
    while (changed) {
	changed = false;
	for (const pattern of [
	    /\s*\*· tracking\*$/,
	    /\s*\*· overlap [^*]+\*$/,
	    /\s*\*· loaded [^*]+\*$/,
	    /\s*\[\[[^\]]+\]\]$/,
	    /\s*\[[^\]]*\]\([^)]+\)$/,
	    /\s*\*· project-id: [^*]+\*$/,
	    /\s*\*· (rs:[^*]+|rc)\*$/,
	]) {
	    const updated = next.replace(pattern, "");
	    if (updated !== next) {
		next = updated.trimEnd();
		changed = true;
	    }
	}
    }

    return next.trim();
}

// ===== Directory listing =====

export async function listDayStoreDates(app: App): Promise<string[]> {
    const adapter = app.vault.adapter;

    if (!(await adapter.exists(DAYS_DIR))) {
	return [];
    }

    const listing = await adapter.list(DAYS_DIR);
    return listing.files
	.filter(f => f.endsWith(".json"))
	.map(f => f.replace(`${DAYS_DIR}/`, "").replace(".json", ""))
	.sort();
}

export async function getLatestCalendarSync(app: App): Promise<string | null> {
    const adapter = app.vault.adapter;

    if (!(await adapter.exists(DAYS_DIR))) {
	return null;
    }

    const listing = await adapter.list(DAYS_DIR);
    let latest: string | null = null;

    for (const file of listing.files) {
	if (!file.endsWith(".json")) continue;

	try {
	    const text = await adapter.read(file);
	    const data = JSON.parse(text) as DayStore;
	    if (!data.lastCalendarSync) continue;
	    if (!latest || data.lastCalendarSync > latest) {
		latest = data.lastCalendarSync;
	    }
	} catch (error) {
	    console.error(`Failed to inspect DayStore ${file}:`, error);
	}
    }

    return latest;
}

// ===== Private helpers =====

function timeToMinutes(time: string): number {
    const [h, m] = time.split(":").map(Number);
    return h * 60 + m;
}

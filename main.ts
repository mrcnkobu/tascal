import { Notice, Plugin, requestUrl } from 'obsidian';
import ICAL from "ical.js";
import { DateTime } from "luxon";
import { StoredEvent, TascalSettings, DEFAULT_SETTINGS } from "./types";
import { extractDateFromFilename, formatTime, parseDuration } from "./utils";
import { extractEventsForDate } from "./calendar";
import {
    loadDayStore, saveDayStore, mergeCalendarEvents, updateEvent,
    removeEvent, addEvent, addSuppression, findEventById, startTracking, stopTracking,
    renderTimeline, createManualEvent, listDayStoreDates, IncomingCalendarEvent
} from "./store";
import { updateTascalSection, appendRescheduledTask, buildTimeline } from "./timeline";
import { TascalSettingTab } from "./settings-tab";
import { runStoreMigration, migrateRecurringStringsToRules } from "./migration";
import {
    EventSelectionModal, AddEventModal, EditEventModal,
    RescheduleModal, RescheduledEventsModal,
    AddEventResult, RescheduledEventEntry
} from "./modals";
import { createLinkedNote } from "./templates";


export default class TascalPlugin extends Plugin {
    settings: TascalSettings;

    async onload() {
	await this.loadSettings();

	// Migrate recurring events from file to settings if not already done
	await this.migrateRecurringEvents();

	// One-time migration to unified day store (.tascal/days/*.json)
	if (!this.settings.storeMigrationDone) {
	    await runStoreMigration(this.app, this.settings);
	    this.settings.storeMigrationDone = true;
	    await this.saveSettings();
	}

	// Migrate legacy recurring event strings to structured rules
	if (this.settings.recurringEvents.length > 0 && (!this.settings.recurringRules || this.settings.recurringRules.length === 0)) {
	    this.settings.recurringRules = migrateRecurringStringsToRules(this.settings.recurringEvents);
	    await this.saveSettings();
	    console.log(`Tascal: migrated ${this.settings.recurringRules.length} recurring rule(s)`);
	}

	this.addSettingTab(new TascalSettingTab(this.app, this));

	// ===== Calendar & timeline commands =====

	this.addCommand({
	    id: "import-calendar-events",
	    name: "Sync calendar",
	    callback: async () => {
		try {
		    const activeFile = this.app.workspace.getActiveFile();
		    if (!activeFile) return new Notice("No active note open.");

		    const dateStr = extractDateFromFilename(activeFile.name);
		    if (!dateStr) return new Notice("Note title must start with a date like 2025-04-17");

		    const localDate = DateTime.fromISO(dateStr, { zone: this.settings.timezone });
		    new Notice("Loading calendar events...");

		    const incoming: IncomingCalendarEvent[] = [];

		    for (const cal of this.settings.calendars) {
			try {
			    const res = await requestUrl({ url: cal.url });
			    const jcalData = ICAL.parse(res.text);
			    const comp = new ICAL.Component(jcalData);
			    const events = extractEventsForDate(comp, localDate, this.settings.timezone);
			    for (const ev of events) {
				incoming.push({
				    summary: `(${cal.id}) ${ev.summary}`,
				    start: ev.start.toFormat("HH:mm"),
				    end: ev.end.toFormat("HH:mm"),
				    icsUid: ev.uid,
				});
			    }
			} catch (e) {
			    console.error(`Failed to load calendar ${cal.id}:`, e);
			    new Notice(`Error loading calendar ${cal.id}`);
			}
		    }

		    // Merge into store
		    let store = await loadDayStore(this.app, dateStr);
		    store = mergeCalendarEvents(store, incoming);
		    store.lastCalendarSync = DateTime.now().setZone(this.settings.timezone).toISO()!;
		    await saveDayStore(this.app, dateStr, store);

		    // Build timeline
		    const note = await this.app.vault.read(activeFile);
		    const result = await buildTimeline(this.app, note, dateStr, this.settings);

		    await this.app.vault.modify(activeFile, result.updatedNote);
		    new Notice(`Inserted ${incoming.length} event(s) for ${dateStr}.`);
		} catch (error) {
		    console.error("Failed to insert ICS events:", error);
		    new Notice("Error occurred. See console.");
		}
	    }
	});

	this.addCommand({
	    id: "update-timeline",
	    name: "Update timeline",
	    callback: async () => {
		const file = this.app.workspace.getActiveFile();
		if (!file) return new Notice("No active file.");

		const note = await this.app.vault.read(file);
		const dateStr = extractDateFromFilename(file.name);
		if (!dateStr) return new Notice("Note must start with a date (YYYY-MM-DD)");

		const result = await buildTimeline(this.app, note, dateStr, this.settings);

		for (const task of result.rescheduled) {
		    await appendRescheduledTask(this.app, ".tascal", task.target, dateStr, task.line);
		}

		await this.app.vault.modify(file, result.updatedNote);
		new Notice("Timeline updated.");
	    }
	});

	// ===== Time tracking commands =====

	this.addCommand({
	    id: "start-time-tracking",
	    name: "Start time tracking",
	    callback: () => this.startTimeTracking()
	});

	this.addCommand({
	    id: "stop-time-tracking",
	    name: "Stop time tracking",
	    callback: () => this.stopTimeTracking()
	});

	// ===== Event CRUD commands =====

	this.addCommand({
	    id: "add-event",
	    name: "Add event",
	    callback: () => this.addEventCommand()
	});

	this.addCommand({
	    id: "edit-event",
	    name: "Edit / delete event",
	    callback: () => this.editEventCommand()
	});

	this.addCommand({
	    id: "reschedule-event",
	    name: "Reschedule event",
	    callback: () => this.rescheduleEventCommand()
	});

	this.addCommand({
	    id: "manage-rescheduled",
	    name: "Manage rescheduled events",
	    callback: () => this.manageRescheduledCommand()
	});

    }

    async loadSettings() {
	this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
	await this.saveData(this.settings);
    }

    async migrateRecurringEvents() {
	if (this.settings.recurringEvents.length === 0) {
	    try {
		const oldRecurringPath = "tascal/recurring.md";
		const adapter = this.app.vault.adapter;

		if (await adapter.exists(oldRecurringPath)) {
		    const content = await adapter.read(oldRecurringPath);
		    const lines = content.split("\n").filter(line => line.trim());

		    this.settings.recurringEvents = lines;
		    await this.saveSettings();

		    const newRecurringPath = ".tascal/recurring.md";
		    const folderPath = ".tascal";

		    if (!(await adapter.exists(folderPath))) {
			await adapter.mkdir(folderPath);
		    }

		    await adapter.write(newRecurringPath, content);
		    await adapter.remove(oldRecurringPath);

		    console.log("Migrated recurring events from file to settings");
		}
	    } catch (error) {
		console.error("Error migrating recurring events:", error);
	    }
	}
    }

    // ===== Helper: get active date context =====

    private getActiveDateContext(): { file: any; dateStr: string } | null {
	const file = this.app.workspace.getActiveFile();
	if (!file) {
	    new Notice("No active note open.");
	    return null;
	}
	const dateStr = extractDateFromFilename(file.name);
	if (!dateStr) {
	    new Notice("Note must start with a date (YYYY-MM-DD)");
	    return null;
	}
	return { file, dateStr };
    }

    private suppressAndRemove(store: import("./types").DayStore, event: StoredEvent): import("./types").DayStore {
	let updated = removeEvent(store, event.id);
	if (event.sourceRef) {
	    updated = addSuppression(updated, event.sourceRef);
	}
	return updated;
    }

    private async reRenderTimeline(file: any, dateStr: string, store: import("./types").DayStore) {
	const note = await this.app.vault.read(file);
	const timelineLines = renderTimeline(store.events, this.settings, dateStr, this.settings.currentTrackingEventId);
	const updatedNote = updateTascalSection(note, timelineLines);
	await this.app.vault.modify(file, updatedNote);
    }

    // ===== Time tracking =====

    async startTimeTracking() {
	const ctx = this.getActiveDateContext();
	if (!ctx) return;

	const store = await loadDayStore(this.app, ctx.dateStr);
	const trackableEvents = store.events.filter(ev => !ev.done);

	if (trackableEvents.length === 0) {
	    new Notice("No events found in timeline.");
	    return;
	}

	if (this.settings.currentTrackingEventId) {
	    const tracked = findEventById(store, this.settings.currentTrackingEventId);
	    if (tracked) {
		new Notice(`Already tracking: ${tracked.summary}. Stop tracking first.`);
		return;
	    }
	}

	const modal = new EventSelectionModal(
	    this.app, trackableEvents,
	    async (event) => {
		const startTime = DateTime.now().setZone(this.settings.timezone).toFormat("HH:mm");
		const updatedEvent = startTracking(event, startTime);

		let updatedStore = updateEvent(store, event.id, {
		    timeTracking: updatedEvent.timeTracking,
		});
		await saveDayStore(this.app, ctx.dateStr, updatedStore);

		this.settings.currentTrackingEventId = event.id;
		await this.saveSettings();

		await this.reRenderTimeline(ctx.file, ctx.dateStr, updatedStore);
		new Notice(`Started tracking: ${event.summary}`);
	    },
	    "Select Event to Track",
	    "Track"
	);
	modal.open();
    }

    async stopTimeTracking() {
	const ctx = this.getActiveDateContext();
	if (!ctx) return;

	if (!this.settings.currentTrackingEventId) {
	    new Notice("No event is currently being tracked.");
	    return;
	}

	const store = await loadDayStore(this.app, ctx.dateStr);
	const event = findEventById(store, this.settings.currentTrackingEventId);
	if (!event) {
	    new Notice("Tracked event not found in store.");
	    this.settings.currentTrackingEventId = null;
	    await this.saveSettings();
	    return;
	}

	const activeEntry = [...event.timeTracking].reverse().find(e => e.duration === "");
	if (!activeEntry) {
	    new Notice("No active tracking session found.");
	    this.settings.currentTrackingEventId = null;
	    await this.saveSettings();
	    return;
	}

	const startTime = DateTime.fromFormat(activeEntry.start, "HH:mm", { zone: this.settings.timezone });
	const endTime = DateTime.now().setZone(this.settings.timezone);
	const durationMinutes = endTime.diff(startTime, "minutes").minutes;
	const hours = Math.floor(durationMinutes / 60);
	const mins = Math.floor(durationMinutes % 60);
	const durationStr = `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;

	const updatedEvent = stopTracking(event, durationStr);
	let updatedStore = updateEvent(store, event.id, {
	    timeTracking: updatedEvent.timeTracking,
	});
	await saveDayStore(this.app, ctx.dateStr, updatedStore);

	this.settings.currentTrackingEventId = null;
	await this.saveSettings();

	await this.reRenderTimeline(ctx.file, ctx.dateStr, updatedStore);
	new Notice(`Stopped tracking: ${event.summary} (${durationStr})`);
    }

    // ===== Event CRUD =====

    async addEventCommand() {
	const ctx = this.getActiveDateContext();
	if (!ctx) return;

	const templates = this.settings.eventTemplates || [];
	const modal = new AddEventModal(
	    this.app, this.settings.timezone, ctx.dateStr, templates,
	    async (result) => { await this.handleAddEventResult(ctx, result); }
	);
	modal.open();
    }

    private async handleAddEventResult(ctx: { file: any; dateStr: string }, result: AddEventResult) {
	const newEvent = createManualEvent(result.summary, result.start, result.end);

	// Create linked note immediately if requested
	if (result.createNote && result.templateId) {
	    const tmpl = (this.settings.eventTemplates || []).find(t => t.id === result.templateId);
	    if (tmpl) {
		const linkedFile = await createLinkedNote(this.app, tmpl, ctx.dateStr, this.settings.timezone);
		newEvent.linkedNotePath = linkedFile.path;
		newEvent.linkedNoteMarkdown = this.app.fileManager.generateMarkdownLink(linkedFile, ctx.file.path);
		newEvent.templateId = result.templateId;
	    }
	}

	let store = await loadDayStore(this.app, ctx.dateStr);
	store = addEvent(store, newEvent);
	await saveDayStore(this.app, ctx.dateStr, store);

	await this.reRenderTimeline(ctx.file, ctx.dateStr, store);
	new Notice(`Added: ${result.summary}`);
    }

    async editEventCommand() {
	const ctx = this.getActiveDateContext();
	if (!ctx) return;

	const store = await loadDayStore(this.app, ctx.dateStr);
	if (store.events.length === 0) {
	    new Notice("No events to edit.");
	    return;
	}

	const selectModal = new EventSelectionModal(
	    this.app, store.events,
	    (event) => {
		const editModal = new EditEventModal(
		    this.app, event,
		    async (updates) => {
			let updatedStore = updateEvent(store, event.id, updates);
			await saveDayStore(this.app, ctx.dateStr, updatedStore);
			await this.reRenderTimeline(ctx.file, ctx.dateStr, updatedStore);
			new Notice(`Updated: ${updates.summary || event.summary}`);
		    },
		    async () => {
			let updatedStore = this.suppressAndRemove(store, event);
			await saveDayStore(this.app, ctx.dateStr, updatedStore);
			await this.reRenderTimeline(ctx.file, ctx.dateStr, updatedStore);
			new Notice(`Deleted: ${event.summary}`);
		    }
		);
		editModal.open();
	    },
	    "Select Event to Edit",
	    "Edit"
	);
	selectModal.open();
    }

    async rescheduleEventCommand() {
	const ctx = this.getActiveDateContext();
	if (!ctx) return;

	const store = await loadDayStore(this.app, ctx.dateStr);
	if (store.events.length === 0) {
	    new Notice("No events to reschedule.");
	    return;
	}

	const selectModal = new EventSelectionModal(
	    this.app, store.events,
	    (event) => {
		const reschedModal = new RescheduleModal(
		    this.app, event, this.settings.timezone,
		    async (targetDate, newStart) => {
			// Calculate new start/end
			const start = newStart ? formatTime(newStart) : event.start;
			const durationMinutes = timeToMinutes(event.end) - timeToMinutes(event.start);
			const startDt = DateTime.fromFormat(start, "HH:mm");
			const end = startDt.plus({ minutes: durationMinutes }).toFormat("HH:mm");

			// Add to target date's store
			let targetStore = await loadDayStore(this.app, targetDate);
			const rescheduledEvent: StoredEvent = {
			    id: crypto.randomUUID(),
			    summary: event.summary,
			    start,
			    end,
			    source: "rescheduled",
			    sourceRef: ctx.dateStr,
			    done: false,
			    timeTracking: [],
			};
			targetStore = addEvent(targetStore, rescheduledEvent);
			await saveDayStore(this.app, targetDate, targetStore);

			// Remove from source date's store (with suppression so recurring doesn't re-add)
			let updatedStore = this.suppressAndRemove(store, event);
			await saveDayStore(this.app, ctx.dateStr, updatedStore);

			await this.reRenderTimeline(ctx.file, ctx.dateStr, updatedStore);
			new Notice(`Rescheduled "${event.summary}" to ${targetDate}`);
		    }
		);
		reschedModal.open();
	    },
	    "Select Event to Reschedule",
	    "Reschedule"
	);
	selectModal.open();
    }

    async manageRescheduledCommand() {
	const today = DateTime.now().setZone(this.settings.timezone).toISODate()!;
	const allDates = await listDayStoreDates(this.app);
	const futureDates = allDates.filter(d => d >= today);

	const entries: RescheduledEventEntry[] = [];

	for (const dateStr of futureDates) {
	    const store = await loadDayStore(this.app, dateStr);
	    for (const event of store.events) {
		if (event.source === "rescheduled" && !event.done) {
		    entries.push({ event, targetDate: dateStr });
		}
	    }
	}

	if (entries.length === 0) {
	    new Notice("No pending rescheduled events.");
	    return;
	}

	const modal = new RescheduledEventsModal(
	    this.app, entries,
	    // Reschedule
	    (entry) => {
		const reschedModal = new RescheduleModal(
		    this.app, entry.event, this.settings.timezone,
		    async (newTargetDate, newStart) => {
			if (newTargetDate === entry.targetDate) {
			    new Notice("Same date selected — nothing changed.");
			    return;
			}

			// Calculate new start/end
			const start = newStart ? formatTime(newStart) : entry.event.start;
			const durationMinutes = timeToMinutes(entry.event.end) - timeToMinutes(entry.event.start);
			const startDt = DateTime.fromFormat(start, "HH:mm");
			const end = startDt.plus({ minutes: durationMinutes }).toFormat("HH:mm");

			// Add to new target date's store
			let newStore = await loadDayStore(this.app, newTargetDate);
			const rescheduledEvent: StoredEvent = {
			    id: crypto.randomUUID(),
			    summary: entry.event.summary,
			    start,
			    end,
			    source: "rescheduled",
			    sourceRef: entry.event.sourceRef,
			    done: false,
			    timeTracking: [],
			};
			newStore = addEvent(newStore, rescheduledEvent);
			await saveDayStore(this.app, newTargetDate, newStore);

			// Remove from old target date's store
			let oldStore = await loadDayStore(this.app, entry.targetDate);
			oldStore = removeEvent(oldStore, entry.event.id);
			await saveDayStore(this.app, entry.targetDate, oldStore);

			new Notice(`Rescheduled "${entry.event.summary}" from ${entry.targetDate} to ${newTargetDate}`);
		    }
		);
		reschedModal.open();
	    },
	    // Delete
	    async (entry) => {
		let store = await loadDayStore(this.app, entry.targetDate);
		store = removeEvent(store, entry.event.id);
		await saveDayStore(this.app, entry.targetDate, store);
		new Notice(`Deleted rescheduled event: ${entry.event.summary}`);
	    }
	);
	modal.open();
    }
}

function timeToMinutes(time: string): number {
    const [h, m] = time.split(":").map(Number);
    return h * 60 + m;
}

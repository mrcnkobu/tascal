import { Notice, Plugin, requestUrl, TFile } from 'obsidian';
import ICAL from "ical.js";
import { DateTime } from "luxon";
import { DayStore, StoredEvent, TascalSettings, DEFAULT_SETTINGS } from "./types";
import { extractDateFromFilename, formatTime } from "./utils";
import { extractEventsForDate } from "./calendar";
import {
    loadDayStore, saveDayStore, mergeCalendarEvents, updateEvent,
    removeEvent, addEvent, addSuppression, findEventById, startTracking, stopTracking,
    createManualEvent, listDayStoreDates, IncomingCalendarEvent,
    addUnscheduledTask, createUnscheduledTask, removeUnscheduledTask, updateUnscheduledTask
} from "./store";
import { appendRescheduledTask, buildTimeline } from "./timeline";
import { TascalSettingTab } from "./settings-tab";
import { runStoreMigration, migrateRecurringStringsToRules } from "./migration";
import {
    EventSelectionModal, AddEventModal, EditEventModal,
    RescheduleModal, RescheduledEventsModal,
    AddEventResult, RescheduledEventEntry, AddUnscheduledTaskModal,
    UnscheduledTasksModal, ScheduleUnscheduledTaskModal, ImportSourceTasksModal
} from "./modals";
import { createLinkedNote } from "./templates";
import {
    currentDateString,
    markSourceTaskDone,
    markSourceTaskImported,
    markSourceTaskOpen,
    resetSourceTaskAvailable,
    scanSourceTaskCandidates,
} from "./source-inbox";
import {
    createRegistryRecord,
    findRegistryRecordById,
    findRegistryRecordBySourceIdentity,
    loadSourceTaskRegistry,
    markRegistryAvailable,
    markRegistryDone,
    markRegistryImported,
    markRegistryOpen,
    markRegistryOrphaned,
    saveSourceTaskRegistry,
    upsertRegistryRecord,
    updateRegistryLocation,
} from "./source-registry";


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
	    callback: () => {
		void this.syncCalendarCommand();
	    }
	});

	this.addCommand({
	    id: "update-timeline",
	    name: "Update timeline",
	    callback: () => {
		void this.updateTimelineCommand();
	    }
	});

	// ===== Time tracking commands =====

	this.addCommand({
	    id: "start-time-tracking",
	    name: "Start time tracking",
	    callback: () => { void this.startTimeTracking(); }
	});

	this.addCommand({
	    id: "stop-time-tracking",
	    name: "Stop time tracking",
	    callback: () => { void this.stopTimeTracking(); }
	});

	// ===== Event CRUD commands =====

	this.addCommand({
	    id: "add-event",
	    name: "Add event",
	    callback: () => { void this.addEventCommand(); }
	});

	this.addCommand({
	    id: "edit-event",
	    name: "Edit event",
	    callback: () => { void this.editEventCommand(); }
	});

	this.addCommand({
	    id: "manage-rescheduled",
	    name: "Manage rescheduled events",
	    callback: () => { void this.manageRescheduledCommand(); }
	});

	this.addCommand({
	    id: "add-unscheduled-task",
	    name: "Add unscheduled task",
	    callback: () => { void this.addUnscheduledTaskCommand(); }
	});

	this.addCommand({
	    id: "manage-unscheduled-tasks",
	    name: "Manage unscheduled tasks",
	    callback: () => { void this.manageUnscheduledTasksCommand(); }
	});

	this.addCommand({
	    id: "import-project-tasks",
	    name: "Import project tasks",
	    callback: () => { void this.importProjectTasksCommand(); }
	});

    }

    private async syncCalendarCommand() {
			try {
			    const activeFile = this.app.workspace.getActiveFile();
			    if (!activeFile) return new Notice("No active note open.");

		    const dateStr = extractDateFromFilename(activeFile.name);
		    if (!dateStr) return new Notice("Note title must start with a date like 2025-04-17");

		    const localDate = DateTime.fromISO(dateStr, { zone: this.settings.timezone });
		    new Notice("Loading calendar events...");

		    const incoming: IncomingCalendarEvent[] = [];
		    const syncStats = {
			succeeded: 0,
			failed: [] as string[],
		    };

			    // Fetch all calendars in parallel; each result keeps its own success/failure.
			    const calendarResults = await Promise.all(
				this.settings.calendars.map(async (cal) => {
				    try {
					const res = await requestUrl({ url: cal.url });
					const comp = ICAL.Component.fromString(res.text);
					const events = extractEventsForDate(comp, localDate, this.settings.timezone);
					return { ok: true as const, cal, events };
				    } catch (e) {
					console.error(`Failed to load calendar ${cal.id}:`, e);
					return { ok: false as const, cal };
				    }
				})
			    );

			    for (const result of calendarResults) {
				if (!result.ok) {
				    syncStats.failed.push(result.cal.id || result.cal.url);
				    continue;
				}
				for (const ev of result.events) {
				    incoming.push({
					summary: `(${result.cal.id}) ${ev.summary}`,
					start: ev.start.toFormat("HH:mm"),
					end: ev.end.toFormat("HH:mm"),
					icsUid: ev.uid,
				    });
				}
				syncStats.succeeded += 1;
			    }

		    // Merge into store
		    let store = await loadDayStore(this.app, dateStr);
		    store = mergeCalendarEvents(store, incoming);
		    store.lastCalendarSync = DateTime.now().setZone(this.settings.timezone).toISO()!;
		    await saveDayStore(this.app, dateStr, store);

		    // Build timeline
		    const note = await this.app.vault.read(activeFile);
		    const result = await buildTimeline(this.app, note, dateStr, this.settings);
		    await this.applySourceTaskChanges(result.sourceTaskChanges, dateStr);

		    await this.app.vault.modify(activeFile, result.updatedNote);
		    const syncSummary = [
			`Synced ${incoming.length} event(s) for ${dateStr}.`,
			`${syncStats.succeeded} calendar(s) succeeded.`,
		    ];
		    if (syncStats.failed.length > 0) {
			syncSummary.push(`Failed: ${syncStats.failed.join(", ")}`);
		    }
		    new Notice(syncSummary.join(" "), 8000);
			} catch (error) {
			    console.error("Failed to insert ICS events:", error);
			    new Notice("Error occurred. See console.");
			}
    }

    private async updateTimelineCommand() {
			const file = this.app.workspace.getActiveFile();
			if (!file) return new Notice("No active file.");

		const note = await this.app.vault.read(file);
		const dateStr = extractDateFromFilename(file.name);
		if (!dateStr) return new Notice("Note must start with a date (YYYY-MM-DD)");

		const result = await buildTimeline(this.app, note, dateStr, this.settings);
		await this.applySourceTaskChanges(result.sourceTaskChanges, dateStr);

		for (const task of result.rescheduled) {
		    await appendRescheduledTask(this.app, ".tascal", task.target, dateStr, task.line);
		}

		await this.app.vault.modify(file, result.updatedNote);
		new Notice(
		    result.rescheduled.length > 0
			? `Timeline updated. Moved ${result.rescheduled.length} task(s) to future dates.`
			: "Timeline updated.",
		    6000
			);
    }

    async loadSettings() {
		const data = await this.loadData() as Partial<TascalSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
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

	    private getActiveDateContext(): { file: TFile; dateStr: string } | null {
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

    private suppressAndRemove(store: DayStore, event: StoredEvent): DayStore {
	let updated = removeEvent(store, event.id);
	if (event.sourceRef) {
	    updated = addSuppression(updated, event.sourceRef);
	}
	return updated;
    }

	    private async reRenderTimeline(file: TFile, dateStr: string, store: DayStore) {
	const note = await this.app.vault.read(file);
	await saveDayStore(this.app, dateStr, store);
	const result = await buildTimeline(this.app, note, dateStr, this.settings, { skipCheckboxSync: true });
	await this.applySourceTaskChanges(result.sourceTaskChanges, dateStr);
	await this.app.vault.modify(file, result.updatedNote);
    }

    private nowIso(): string {
	return DateTime.now().setZone(this.settings.timezone).toISO()!;
    }

    private async importProjectTasksCommand() {
	const ctx = this.getActiveDateContext();
	if (!ctx) return;

	if (!this.settings.sourceDirectories || this.settings.sourceDirectories.length === 0) {
	    new Notice("Configure project source directories in Tascal settings first.");
	    return;
	}

	const candidates = await scanSourceTaskCandidates(
	    this.app,
	    this.settings.sourceDirectories,
	    currentDateString(this.settings.timezone)
	);

	const registry = await loadSourceTaskRegistry(this.app);
	const importable = candidates.filter((candidate) => {
	    if (candidate.status !== "available") return false;
	    if (!candidate.sourceTaskId) return true;
	    const record = findRegistryRecordBySourceIdentity(registry, candidate.projectId, candidate.sourceTaskId);
	    return !record || record.state !== "imported";
	});

	if (importable.length === 0) {
	    new Notice("No importable project tasks found.");
	    return;
	}

	const modal = new ImportSourceTasksModal(this.app, importable, async (candidate) => {
	    const sourceTaskId = candidate.sourceTaskId || `tsk-${crypto.randomUUID().slice(0, 8)}`;
	    const loadedAt = DateTime.now().setZone(this.settings.timezone).toFormat("yyyy-MM-dd HH:mm");
	    const imported = await markSourceTaskImported(this.app, this.settings.sourceDirectories, candidate, sourceTaskId, loadedAt);
	    if (!imported.ok) {
		new Notice(`Failed to update source note for "${candidate.summary}".`);
		return;
	    }

	    let registryState = await loadSourceTaskRegistry(this.app);
	    let record = findRegistryRecordBySourceIdentity(registryState, candidate.projectId, sourceTaskId);
	    const importedAt = this.nowIso();
	    const newTask = createUnscheduledTask(candidate.summary, candidate.estimateMinutes, {
		sourceRegistryId: record?.registryId,
		sourceProjectId: candidate.projectId,
		sourceTaskId,
		sourceNotePath: imported.sourcePath,
		sourceLoadedAt: loadedAt,
	    });

	    if (!record) {
		record = createRegistryRecord(
		    candidate.projectId,
		    sourceTaskId,
		    imported.sourcePath,
		    candidate.summary,
		    importedAt,
		    { date: ctx.dateStr, kind: "unscheduled", itemId: newTask.id }
		);
		registryState = upsertRegistryRecord(registryState, record);
		newTask.sourceRegistryId = record.registryId;
	    } else {
		registryState = markRegistryImported(
		    registryState,
		    record.registryId,
		    imported.sourcePath,
		    candidate.summary,
		    importedAt,
		    { date: ctx.dateStr, kind: "unscheduled", itemId: newTask.id }
		);
		newTask.sourceRegistryId = record.registryId;
	    }

	    await saveSourceTaskRegistry(this.app, registryState);

	    let store = await loadDayStore(this.app, ctx.dateStr);
	    store = addUnscheduledTask(store, newTask);
	    await saveDayStore(this.app, ctx.dateStr, store);
	    await this.reRenderTimeline(ctx.file, ctx.dateStr, store);
	    new Notice(`Imported "${candidate.summary}" to today's unscheduled tasks.`, 7000);
	});
	modal.open();
    }

    private async applySourceTaskChanges(
	changes: { registryId: string; done: boolean; kind: "event" | "unscheduled"; itemId: string }[],
	dateStr: string
    ) {
	if (changes.length === 0) return;

	let registry = await loadSourceTaskRegistry(this.app);
	let dirty = false;

	for (const change of changes) {
	    const record = findRegistryRecordById(registry, change.registryId);
	    if (!record) continue;

	    if (change.done) {
		const updated = await markSourceTaskDone(
		    this.app,
		    this.settings.sourceDirectories,
		    record.projectId,
		    record.sourceTaskId,
		    dateStr,
		    record.sourcePath
		);
		registry = updated
		    ? markRegistryDone(registry, record.registryId, this.nowIso())
		    : markRegistryOrphaned(registry, record.registryId, this.nowIso());
	    } else {
		const updated = await markSourceTaskOpen(
		    this.app,
		    this.settings.sourceDirectories,
		    record.projectId,
		    record.sourceTaskId,
		    record.sourcePath
		);
		registry = updated
		    ? markRegistryOpen(registry, record.registryId, { date: dateStr, kind: change.kind, itemId: change.itemId }, this.nowIso())
		    : markRegistryOrphaned(registry, record.registryId, this.nowIso());
	    }
	    dirty = true;
	}

	if (dirty) {
	    await saveSourceTaskRegistry(this.app, registry);
	}
    }

    private async syncSourceBackedItemState(
	item: { id: string; sourceRegistryId?: string },
	dateStr: string,
	kind: "event" | "unscheduled",
	done: boolean
    ) {
	if (!item.sourceRegistryId) return;

	let registry = await loadSourceTaskRegistry(this.app);
	const record = findRegistryRecordById(registry, item.sourceRegistryId);
	if (!record) return;

	if (done) {
	    const updated = await markSourceTaskDone(
		this.app,
		this.settings.sourceDirectories,
		record.projectId,
		record.sourceTaskId,
		dateStr,
		record.sourcePath
	    );
	    registry = updated
		? markRegistryDone(registry, record.registryId, this.nowIso())
		: markRegistryOrphaned(registry, record.registryId, this.nowIso());
	} else {
	    const updated = await markSourceTaskOpen(
		this.app,
		this.settings.sourceDirectories,
		record.projectId,
		record.sourceTaskId,
		record.sourcePath
	    );
	    registry = updated
		? markRegistryOpen(registry, record.registryId, { date: dateStr, kind, itemId: item.id }, this.nowIso())
		: markRegistryOrphaned(registry, record.registryId, this.nowIso());
	}

	await saveSourceTaskRegistry(this.app, registry);
    }

    private async resetSourceBackedItem(item: { sourceRegistryId?: string }) {
	if (!item.sourceRegistryId) return;

	let registry = await loadSourceTaskRegistry(this.app);
	const record = findRegistryRecordById(registry, item.sourceRegistryId);
	if (!record) return;

	const updated = await resetSourceTaskAvailable(
	    this.app,
	    this.settings.sourceDirectories,
	    record.projectId,
	    record.sourceTaskId,
	    record.sourcePath
	);

	registry = updated
	    ? markRegistryAvailable(registry, record.registryId, this.nowIso())
	    : markRegistryOrphaned(registry, record.registryId, this.nowIso());
	await saveSourceTaskRegistry(this.app, registry);
    }

    private async updateSourceRegistryLocation(
	item: { sourceRegistryId?: string },
	dateStr: string,
	kind: "event" | "unscheduled",
	itemId: string
    ) {
	if (!item.sourceRegistryId) return;
	let registry = await loadSourceTaskRegistry(this.app);
	registry = updateRegistryLocation(registry, item.sourceRegistryId, { date: dateStr, kind, itemId });
	await saveSourceTaskRegistry(this.app, registry);
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
		    (event) => {
			void (async () => {
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
			})();
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
		    (result) => { void this.handleAddEventResult(ctx, result); }
	);
	modal.open();
    }

	    private async handleAddEventResult(ctx: { file: TFile; dateStr: string }, result: AddEventResult) {
	const newEvent = createManualEvent(result.summary, result.start, result.end);
	let noteOutcome: string | null = null;

	// Create linked note immediately if requested
	if (result.createNote && result.templateId) {
	    const tmpl = (this.settings.eventTemplates || []).find(t => t.id === result.templateId);
	    if (tmpl) {
		try {
		    const linkedNote = await createLinkedNote(this.app, tmpl, ctx.dateStr, this.settings.timezone);
		    newEvent.linkedNotePath = linkedNote.file.path;
		    newEvent.linkedNoteMarkdown = this.app.fileManager.generateMarkdownLink(linkedNote.file, ctx.file.path);
		    newEvent.templateId = result.templateId;
		    noteOutcome = linkedNote.status === "created"
			? `Created note ${linkedNote.file.basename}.`
			: `Reused existing note ${linkedNote.file.basename}.`;
		} catch (error) {
		    console.error("Failed to create linked note:", error);
		    noteOutcome = "Linked note creation failed.";
		}
	    }
	}

	let store = await loadDayStore(this.app, ctx.dateStr);
	store = addEvent(store, newEvent);
	await saveDayStore(this.app, ctx.dateStr, store);

	await this.reRenderTimeline(ctx.file, ctx.dateStr, store);
	const parts = [`Added ${result.start}-${result.end} ${result.summary}.`];
	if (noteOutcome) {
	    parts.push(noteOutcome);
	}
	new Notice(parts.join(" "), 7000);
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
			    (updates) => {
				void (async () => {
				let updatedStore = updateEvent(store, event.id, updates);
			await saveDayStore(this.app, ctx.dateStr, updatedStore);
			if (updates.done !== undefined && updates.done !== event.done) {
			    await this.syncSourceBackedItemState(event, ctx.dateStr, "event", updates.done);
			}
				await this.reRenderTimeline(ctx.file, ctx.dateStr, updatedStore);
				new Notice(`Updated: ${updates.summary || event.summary}`);
				})();
			    },
			    () => {
				void (async () => {
				let updatedStore = this.suppressAndRemove(store, event);
			await saveDayStore(this.app, ctx.dateStr, updatedStore);
			await this.resetSourceBackedItem(event);
				await this.reRenderTimeline(ctx.file, ctx.dateStr, updatedStore);
				new Notice(`Deleted: ${event.summary}`);
				})();
			    },
		    () => {
			const reschedModal = new RescheduleModal(
			    this.app, event, this.settings.timezone,
				    (targetDate, newStart) => {
					void (async () => {
					const start = newStart ? formatTime(newStart) : event.start;
				const durationMinutes = timeToMinutes(event.end) - timeToMinutes(event.start);
				const startDt = DateTime.fromFormat(start, "HH:mm");
				const end = startDt.plus({ minutes: durationMinutes }).toFormat("HH:mm");

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
				    sourceRegistryId: event.sourceRegistryId,
				    sourceProjectId: event.sourceProjectId,
				    sourceTaskId: event.sourceTaskId,
				    sourceNotePath: event.sourceNotePath,
				    sourceLoadedAt: event.sourceLoadedAt,
				};
				targetStore = addEvent(targetStore, rescheduledEvent);
				await saveDayStore(this.app, targetDate, targetStore);

				let updatedStore = this.suppressAndRemove(store, event);
				await saveDayStore(this.app, ctx.dateStr, updatedStore);
				await this.updateSourceRegistryLocation(event, targetDate, "event", rescheduledEvent.id);

					await this.reRenderTimeline(ctx.file, ctx.dateStr, updatedStore);
					new Notice(`Rescheduled "${event.summary}" to ${targetDate} at ${start}.`, 7000);
					})();
				    }
			);
			reschedModal.open();
		    }
		);
		editModal.open();
	    },
	    "Select Event to Edit",
	    "Edit"
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
			    (newTargetDate, newStart) => {
				void (async () => {
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
			    sourceRegistryId: entry.event.sourceRegistryId,
			    sourceProjectId: entry.event.sourceProjectId,
			    sourceTaskId: entry.event.sourceTaskId,
			    sourceNotePath: entry.event.sourceNotePath,
			    sourceLoadedAt: entry.event.sourceLoadedAt,
			};
			newStore = addEvent(newStore, rescheduledEvent);
			await saveDayStore(this.app, newTargetDate, newStore);

			// Remove from old target date's store
			let oldStore = await loadDayStore(this.app, entry.targetDate);
			oldStore = removeEvent(oldStore, entry.event.id);
			await saveDayStore(this.app, entry.targetDate, oldStore);
			await this.updateSourceRegistryLocation(entry.event, newTargetDate, "event", rescheduledEvent.id);

				new Notice(`Rescheduled "${entry.event.summary}" from ${entry.targetDate} to ${newTargetDate} at ${start}.`, 7000);
				})();
			    }
		);
		reschedModal.open();
	    },
	    // Delete
		    (entry) => {
			void (async () => {
			let store = await loadDayStore(this.app, entry.targetDate);
		store = removeEvent(store, entry.event.id);
		await saveDayStore(this.app, entry.targetDate, store);
			await this.resetSourceBackedItem(entry.event);
			new Notice(`Deleted rescheduled event: ${entry.event.summary}`);
			})();
		    }
	);
	modal.open();
    }

    async addUnscheduledTaskCommand() {
	const ctx = this.getActiveDateContext();
	if (!ctx) return;

		const modal = new AddUnscheduledTaskModal(this.app, (result) => {
		    void (async () => {
		    let store = await loadDayStore(this.app, ctx.dateStr);
	    store = addUnscheduledTask(store, createUnscheduledTask(result.summary, result.estimateMinutes));
	    await saveDayStore(this.app, ctx.dateStr, store);
		    await this.reRenderTimeline(ctx.file, ctx.dateStr, store);
		    new Notice(`Added unscheduled task: ${result.summary}`, 6000);
		    })();
		});
	modal.open();
    }

    async manageUnscheduledTasksCommand() {
	const ctx = this.getActiveDateContext();
	if (!ctx) return;

	const store = await loadDayStore(this.app, ctx.dateStr);
	const tasks = store.unscheduledTasks || [];
	if (tasks.length === 0) {
	    new Notice("No unscheduled tasks.");
	    return;
	}

	const modal = new UnscheduledTasksModal(
	    this.app,
	    tasks,
		    (task) => {
			void (async () => {
			let updatedStore = updateUnscheduledTask(store, task.id, { done: !task.done });
		await saveDayStore(this.app, ctx.dateStr, updatedStore);
		await this.syncSourceBackedItemState(task, ctx.dateStr, "unscheduled", !task.done);
			await this.reRenderTimeline(ctx.file, ctx.dateStr, updatedStore);
			new Notice(`${task.done ? "Reopened" : "Completed"} unscheduled task: ${task.summary}`, 6000);
			})();
		    },
	    (task) => {
		const moveModal = new RescheduleModal(
		    this.app,
		    {
			id: task.id,
			summary: task.summary,
			start: "09:00",
			end: "09:00",
			source: "manual",
			done: task.done,
			timeTracking: [],
		    },
		    this.settings.timezone,
			    (targetDate) => {
				void (async () => {
				let currentStore = await loadDayStore(this.app, ctx.dateStr);
			currentStore = removeUnscheduledTask(currentStore, task.id);
			await saveDayStore(this.app, ctx.dateStr, currentStore);

			let targetStore = await loadDayStore(this.app, targetDate);
			const movedTask = createUnscheduledTask(task.summary, task.estimateMinutes, {
			    sourceRegistryId: task.sourceRegistryId,
			    sourceProjectId: task.sourceProjectId,
			    sourceTaskId: task.sourceTaskId,
			    sourceNotePath: task.sourceNotePath,
			    sourceLoadedAt: task.sourceLoadedAt,
			});
			targetStore = addUnscheduledTask(targetStore, movedTask);
			await saveDayStore(this.app, targetDate, targetStore);
			await this.updateSourceRegistryLocation(task, targetDate, "unscheduled", movedTask.id);

				await this.reRenderTimeline(ctx.file, ctx.dateStr, currentStore);
				new Notice(`Moved "${task.summary}" to ${targetDate}.`, 7000);
				})();
			    }
		);
		moveModal.open();
	    },
		    (task) => {
			const scheduleModal = new ScheduleUnscheduledTaskModal(this.app, task, (start, durationMinutes) => {
			    void (async () => {
			    const end = DateTime.fromFormat(start, "HH:mm").plus({ minutes: durationMinutes }).toFormat("HH:mm");
		    let updatedStore = await loadDayStore(this.app, ctx.dateStr);
		    updatedStore = removeUnscheduledTask(updatedStore, task.id);
		    const scheduledEvent = createManualEvent(task.summary, start, end, {
			sourceRegistryId: task.sourceRegistryId,
			sourceProjectId: task.sourceProjectId,
			sourceTaskId: task.sourceTaskId,
			sourceNotePath: task.sourceNotePath,
			sourceLoadedAt: task.sourceLoadedAt,
		    });
		    updatedStore = addEvent(updatedStore, scheduledEvent);
		    await saveDayStore(this.app, ctx.dateStr, updatedStore);
		    await this.updateSourceRegistryLocation(task, ctx.dateStr, "event", scheduledEvent.id);
			    await this.reRenderTimeline(ctx.file, ctx.dateStr, updatedStore);
			    new Notice(`Scheduled "${task.summary}" for ${start}-${end}.`, 7000);
			    })();
			});
		scheduleModal.open();
	    },
		    (task) => {
			void (async () => {
			let updatedStore = removeUnscheduledTask(store, task.id);
		await saveDayStore(this.app, ctx.dateStr, updatedStore);
		await this.resetSourceBackedItem(task);
			await this.reRenderTimeline(ctx.file, ctx.dateStr, updatedStore);
			new Notice(`Deleted unscheduled task: ${task.summary}`, 6000);
			})();
		    }
	);
	modal.open();
    }
}

function timeToMinutes(time: string): number {
    const [h, m] = time.split(":").map(Number);
    return h * 60 + m;
}

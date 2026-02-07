import { App, Modal, Notice, Plugin, requestUrl } from 'obsidian';
import ICAL from "ical.js";
import { DateTime } from "luxon";
import { EventData, TimeTrackingData, TascalSettings, DEFAULT_SETTINGS } from "./types";
import { extractDateFromFilename, formatDuration } from "./utils";
import { extractEventsForDate, writeCalendarCache, readCalendarCache } from "./calendar";
import { saveTimeTrackingData, extractTimeTrackingFromTimeline } from "./time-tracking";
import { extractTascalSection, updateTascalSection, parseManualBlocksFromLines, appendRescheduledTask, buildTimeline } from "./timeline";
import { TascalSettingTab } from "./settings-tab";


export default class TascalPlugin extends Plugin {
    settings: TascalSettings;
    calendarCache: EventData[] = [];

    async onload() {
	await this.loadSettings();

	// Migrate recurring events from file to settings if not already done
	await this.migrateRecurringEvents();

	this.addSettingTab(new TascalSettingTab(this.app, this));

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
		    new Notice("Loading calendar events…");

		    const allEvents: EventData[] = [];

		    for (const cal of this.settings.calendars) {
			try {
			    const res = await requestUrl({ url: cal.url });
			    const jcalData = ICAL.parse(res.text);
			    const comp = new ICAL.Component(jcalData);
			    const events = extractEventsForDate(comp, localDate, this.settings.timezone);
			    events.forEach(ev => ev.summary = `(${cal.id}) ${ev.summary}`);
			    allEvents.push(...events);
			} catch (e) {
			    console.error(`Failed to load calendar ${cal.id}:`, e);
			    new Notice(`Error loading calendar ${cal.id}`);
			}
		    }

		    allEvents.sort((a, b) => a.start.toMillis() - b.start.toMillis());
		    this.calendarCache = allEvents;

		    const note = await this.app.vault.read(activeFile);
		    const result = await buildTimeline(this.app, note, dateStr, allEvents, this.settings);
		    this.settings.timeTrackingData = result.refreshedTimeTracking;

		    await writeCalendarCache(this.app, localDate, allEvents);
		    await this.app.vault.modify(activeFile, result.updatedNote);
		    new Notice(`Inserted ${allEvents.length} event(s) for ${dateStr}.`);
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

		const localDate = DateTime.fromISO(dateStr, { zone: this.settings.timezone });
		let calendarEvents: EventData[] = [];

		// Try to load calendar events from cache for any date
		const cached = await readCalendarCache(this.app, localDate);
		if (cached) {
		    calendarEvents = cached;
		    if (localDate.toISODate() === DateTime.now().setZone(this.settings.timezone).toISODate()) {
			this.calendarCache = cached;
		    }
		    new Notice(`Loaded ${cached.length} calendar events from cache for ${localDate.toISODate()}.`);
		} else {
		    new Notice("No cached calendar events found for this date.");
		}

		const result = await buildTimeline(this.app, note, dateStr, calendarEvents, this.settings);
		this.settings.timeTrackingData = result.refreshedTimeTracking;

		// Save newly rescheduled entries to the persistent file
		for (const task of result.rescheduled) {
		    await appendRescheduledTask(this.app, ".tascal", task.target, dateStr, task.line);
		}

		await this.app.vault.modify(file, result.updatedNote);
		new Notice("✅ Timeline updated.");
	    }
	});


	this.addCommand({
	    id: "format-blocks",
	    name: "Format tasks",
	    callback: async () => {
		await this.formatManualBlocks();
	    }
	});

	// Time tracking commands
	this.addCommand({
	    id: "start-time-tracking",
	    name: "Start time tracking",
	    callback: async () => {
		await this.startTimeTracking();
	    }
	});

	this.addCommand({
	    id: "stop-time-tracking",
	    name: "Stop time tracking",
	    callback: async () => {
		await this.stopTimeTracking();
	    }
	});

	this.addCommand({
	    id: "save-time-tracking-data",
	    name: "Save time tracking data",
	    callback: async () => {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
		    new Notice("No active note open.");
		    return;
		}
		const note = await this.app.vault.read(activeFile);
		const { timeline } = extractTascalSection(note);
		const dateStr = extractDateFromFilename(activeFile.name);
		if (!dateStr) {
		    new Notice("Note must start with a date (YYYY-MM-DD)");
		    return;
		}
		const timeTrackingData = extractTimeTrackingFromTimeline(timeline);
		const timeTrackingFilePath = `.tascal/tt-${dateStr}.json`;
		await saveTimeTrackingData(this.app, timeTrackingFilePath, timeTrackingData);
		
		// Update the stats line with total tracked time
		const updatedNoteWithStats = this.updateStatsLineWithTotalTT(note, timeTrackingData);
		await this.app.vault.modify(activeFile, updatedNoteWithStats);
		
		new Notice("✅ Time tracking data saved from timeline.");
	    }
	});

    }

    async loadSettings() {
	this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
	await this.saveData(this.settings);
    }

    async migrateRecurringEvents() {
	// Only migrate if we haven't already (check if settings has recurring events)
	if (this.settings.recurringEvents.length === 0) {
	    try {
		const oldRecurringPath = "tascal/recurring.md";
		const adapter = this.app.vault.adapter;
		
		if (await adapter.exists(oldRecurringPath)) {
		    const content = await adapter.read(oldRecurringPath);
		    const lines = content.split("\n").filter(line => line.trim());
		    
		    // Migrate lines to settings, preserving all markers
		    this.settings.recurringEvents = lines;
		    await this.saveSettings();
		    
		    // Move the file to .tascal folder
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

    async formatManualBlocks() {
	const activeFile = this.app.workspace.getActiveFile();
	if (!activeFile) {
            new Notice("No active note open.");
            return;
	}

	const note = await this.app.vault.read(activeFile);
	const dateStr = extractDateFromFilename(activeFile.name);
	if (!dateStr) {
            new Notice("Note must start with a date (YYYY-MM-DD)");
            return;
	}

	const localDate = DateTime.fromISO(dateStr, { zone: this.settings.timezone });

	const { timeline, manualBlockLines, start, end } = extractTascalSection(note);
	if (start === -1 || end === -1) {
            new Notice("No Tascal section found.");
            return;
	}

	const { blocks: manualBlocks, rescheduled } = parseManualBlocksFromLines(
	    manualBlockLines,
	    localDate,
	    this.settings.timezone
	);


	// Sort manual blocks by start time
	manualBlocks.sort((a, b) => a.start.toMillis() - b.start.toMillis());

	// Format them back into lines
	const formattedManualLines = manualBlocks.map(block => {
            const startStr = block.start.toFormat("HH:mm");
            const endStr = block.end.toFormat("HH:mm");

            const durationMinutes = block.end.diff(block.start, "minutes").minutes;
            const hours = Math.floor(durationMinutes / 60);
            const minutes = Math.floor(durationMinutes % 60);

            let durationStr = "";
            if (hours > 0) durationStr += `${hours}h`;
            if (minutes > 0) durationStr += `${minutes}m`;

            // You can choose: output in "start-end" format or "start (duration)" format
            if (durationMinutes <= 90) { // short tasks in duration format, longer in start-end
		return `@${startStr} (${durationStr}) ${block.summary}`;
            } else {
		return `@${startStr}–${endStr} ${block.summary}`;
            }
	});

	// Rebuild note content
	const updatedNote = updateTascalSection(note, timeline, formattedManualLines);

	await this.app.vault.modify(activeFile, updatedNote);
	new Notice("✅ Manual blocks formatted!");
    }

    async startTimeTracking() {
	const activeFile = this.app.workspace.getActiveFile();
	if (!activeFile) {
	    new Notice("No active note open.");
	    return;
	}

	const note = await this.app.vault.read(activeFile);
	const { timeline } = extractTascalSection(note);

	// Check if there's exactly one line with ">" after the checkbox
	const trackingLines = timeline.filter(line => {
	    const match = line.match(/^- \[( |x)]\s*(>)\s*(\d{1,2}:\d{2})/);
	    return match !== null;
	});
	
	if (trackingLines.length === 1) {
	    // Start tracking for the existing line
	    const trackingLine = trackingLines[0];
	    const eventId = this.generateEventId(trackingLine);
	    const startTime = DateTime.now().setZone(this.settings.timezone).toFormat("HH:mm");
	    
	    // Store start time in plugin state
	    this.settings.timeTrackingData[eventId] = this.settings.timeTrackingData[eventId] || [];
	    this.settings.timeTrackingData[eventId].push({ start: startTime, duration: "" });
	    this.settings.currentTrackingEventId = eventId;
	    await this.saveSettings();
	    
	    // Add start time to timeline in curly braces format
	    const noteWithTracking = this.addTimeTrackingToTimeline(note, trackingLine, startTime);
	    await this.app.vault.modify(activeFile, noteWithTracking);
	    
	    // Extract time tracking data from updated timeline and overwrite the JSON file
	    const { timeline: updatedTimeline } = extractTascalSection(noteWithTracking);
	    const timelineTimeTrackingData = extractTimeTrackingFromTimeline(updatedTimeline);
	    const dateStr = extractDateFromFilename(activeFile.name);
	    const timeTrackingFilePath = `.tascal/tt-${dateStr}.json`;
	    await saveTimeTrackingData(this.app, timeTrackingFilePath, timelineTimeTrackingData);
	    
	    new Notice(`Started tracking: ${this.extractEventSummary(trackingLine)}`);
	} else if (trackingLines.length > 1) {
	    new Notice("Only one event can be tracked at a time. Please remove extra '>' symbols.");
	} else {
	    // Show modal to select event
	    await this.showEventSelectionModal(activeFile, note);
	}
    }

    async stopTimeTracking() {
	const activeFile = this.app.workspace.getActiveFile();
	if (!activeFile) {
	    new Notice("No active note open.");
	    return;
	}

	const note = await this.app.vault.read(activeFile);
	const { timeline } = extractTascalSection(note);

	// Find the line with ">" after the checkbox
	const trackingLine = timeline.find(line => {
	    const match = line.match(/^- \[( |x)]\s*(>)\s*(\d{1,2}:\d{2})/);
	    return match !== null;
	});
	
	if (!trackingLine) {
	    new Notice("No event is currently being tracked.");
	    return;
	}

	const eventId = this.generateEventId(trackingLine);
	const trackingData = this.settings.timeTrackingData[eventId];
	
	if (!trackingData || trackingData.length === 0) {
	    new Notice("No tracking data found for this event.");
	    return;
	}

	// Find the last entry without duration (active tracking)
	const lastEntry = trackingData[trackingData.length - 1];
	if (lastEntry.duration !== "") {
	    new Notice("No active tracking session found.");
	    return;
	}

	// Calculate duration
	const startTime = DateTime.fromFormat(lastEntry.start, "HH:mm", { zone: this.settings.timezone });
	const endTime = DateTime.now().setZone(this.settings.timezone);
	const durationMinutes = endTime.diff(startTime, "minutes").minutes;
	const durationStr = this.formatDurationForTracking(durationMinutes);
	
	// Update the duration
	lastEntry.duration = durationStr;
	this.settings.currentTrackingEventId = null;
	await this.saveSettings();

	// Complete the duration in the timeline
	const updatedNote = this.completeTimeTrackingInTimeline(note, eventId, lastEntry.start, durationStr);
	await this.app.vault.modify(activeFile, updatedNote);

	// Extract time tracking data from updated timeline and overwrite the JSON file
	const { timeline: updatedTimeline } = extractTascalSection(updatedNote);
	const timelineTimeTrackingData = extractTimeTrackingFromTimeline(updatedTimeline);
	const dateStr = extractDateFromFilename(activeFile.name);
	const timeTrackingFilePath = `.tascal/tt-${dateStr}.json`;
	await saveTimeTrackingData(this.app, timeTrackingFilePath, timelineTimeTrackingData);
	
	// Update the stats line with total tracked time
	const updatedNoteWithStats = this.updateStatsLineWithTotalTT(updatedNote, timelineTimeTrackingData);
	await this.app.vault.modify(activeFile, updatedNoteWithStats);
	
	new Notice(`Stopped tracking: ${this.extractEventSummary(trackingLine)} (${durationStr})`);
    }

    private generateEventId(line: string): string {
	// Extract time range and summary from the line
	const match = line.match(/>?\s*- \[( |x)]\s*(>?\s*)(\d{1,2}:\d{2})–(\d{1,2}:\d{2})\s+(.+?)(?:\s*\{TT:[^}]*\})?$/);
	if (match) {
	    const [_, checkbox, tracking, start, end, summary] = match;
	    const eventSummary = summary.trim();
	    
	    // Try to find matching event in calendar cache or manual blocks
	    const allEvents = [...this.calendarCache];
	    
	    // For now, fall back to the old method if we can't find a match
	    // This ensures backward compatibility
	    const matchingEvent = allEvents.find(event => 
		event.start.toFormat("HH:mm") === start &&
		event.end.toFormat("HH:mm") === end &&
		event.summary === eventSummary
	    );
	    
	    if (matchingEvent) {
		return matchingEvent.uid;
	    }
	    
	    // Fallback to time-based ID for backward compatibility
	    return `${start}-${end}-${eventSummary}`;
	}
	
	// For manual tasks, generate a different pattern
	const manualMatch = line.match(/>?\s*- \[( |x)]\s*(>?\s*)@(\d{1,2}:\d{2})[–-](\d{1,2}:\d{2})\s+(.+?)(?:\s*\{TT:[^}]*\})?$/);
	if (manualMatch) {
	    const [_, checkbox, tracking, start, end, summary] = manualMatch;
	    const eventSummary = summary.trim();
	    
	    // For manual events, we can reconstruct the UID from the current date and summary
	    const activeFile = this.app.workspace.getActiveFile();
	    if (activeFile) {
		const dateStr = extractDateFromFilename(activeFile.name);
		if (dateStr) {
		    return `manual-${dateStr}-${eventSummary.replace(/[^a-zA-Z0-9]/g, '-')}`;
		}
	    }
	    
	    // Fallback
	    return `manual_${start}-${end}-${eventSummary}`;
	}
	
	// Fallback
	return `event_${Date.now()}`;
    }

    private extractEventSummary(line: string): string {
	// Remove ">" and time tracking info
	const cleanLine = line.replace(/^>\s*/, "").replace(/\s*\{TT:[^}]*\}/, "");
	
	// Extract summary after time range
	const match = cleanLine.match(/- \[( |x)]\s*(>?\s*)(\d{1,2}:\d{2})–(\d{1,2}:\d{2})\s+(.+)$/);
	if (match) {
	    return match[5].trim();
	}
	
	const manualMatch = cleanLine.match(/- \[( |x)]\s*(>?\s*)@(\d{1,2}:\d{2})[–-](\d{1,2}:\d{2})\s+(.+)$/);
	if (manualMatch) {
	    return manualMatch[5].trim();
	}
	
	return cleanLine.trim();
    }

    private formatDurationForTracking(minutes: number): string {
	const hours = Math.floor(minutes / 60);
	const mins = Math.floor(minutes % 60);
	return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
    }

    private async showEventSelectionModal(activeFile: any, note: string) {
	const { timeline } = extractTascalSection(note);
	const eventLines = timeline.filter(line => 
	    line.match(/^- \[( |x)]\s*(>?\s*)(\d{1,2}:\d{2})–(\d{1,2}:\d{2})/) && 
	    !line.includes("available")
	);

	if (eventLines.length === 0) {
	    new Notice("No events found in timeline.");
	    return;
	}

	const modal = new EventSelectionModal(this.app, eventLines, async (selectedLine: string) => {
	    // Add ">" to the selected line
	    const updatedNote = this.addTrackingSymbol(note, selectedLine);
	    await this.app.vault.modify(activeFile, updatedNote);
	    
	    // Start tracking
	    const eventId = this.generateEventId(selectedLine);
	    const startTime = DateTime.now().setZone(this.settings.timezone).toFormat("HH:mm");
	    
	    this.settings.timeTrackingData[eventId] = this.settings.timeTrackingData[eventId] || [];
	    this.settings.timeTrackingData[eventId].push({ start: startTime, duration: "" });
	    this.settings.currentTrackingEventId = eventId;
	    await this.saveSettings();
	    
	    // Add start time to timeline in curly braces format
	    const noteWithTracking = this.addTimeTrackingToTimeline(note, selectedLine, startTime);
	    await this.app.vault.modify(activeFile, noteWithTracking);
	    
	    // Extract time tracking data from updated timeline and overwrite the JSON file
	    const { timeline: updatedTimeline } = extractTascalSection(noteWithTracking);
	    const timelineTimeTrackingData = extractTimeTrackingFromTimeline(updatedTimeline);
	    const dateStr = extractDateFromFilename(activeFile.name);
	    const timeTrackingFilePath = `.tascal/tt-${dateStr}.json`;
	    await saveTimeTrackingData(this.app, timeTrackingFilePath, timelineTimeTrackingData);
	    
	    new Notice(`Started tracking: ${this.extractEventSummary(selectedLine)}`);
	});
	
	modal.open();
    }

    private addTrackingSymbol(note: string, targetLine: string): string {
	const lines = note.split("\n");
	const startTag = "<!--tascal-->";
	const endTag = "<!--/tascal-->";
	
	let inTascalSection = false;
	let inTimeline = false;
	
	for (let i = 0; i < lines.length; i++) {
	    const line = lines[i];
	    
	    if (line.includes(startTag)) {
		inTascalSection = true;
		continue;
	    }
	    
	    if (line.includes(endTag)) {
		inTascalSection = false;
		continue;
	    }
	    
	    if (inTascalSection && line.trim() === "### Timeline") {
		inTimeline = true;
		continue;
	    }
	    
	    if (inTimeline && line.startsWith("### ")) {
		inTimeline = false;
		continue;
	    }
	    
	    if (inTimeline && line.trim() === targetLine.trim()) {
		// Remove any existing ">" and add it after the checkbox but before the time
		const match = line.match(/^(- \[( |x)])\s*(>?\s*)(\d{1,2}:\d{2})/);
		if (match) {
		    const [_, checkbox, checked, existingTracking, time] = match;
		    lines[i] = line.replace(/^(- \[( |x)])\s*(>?\s*)(\d{1,2}:\d{2})/, `$1 > $4`);
		}
		break;
	    }
	}
	
	return lines.join("\n");
    }

    private addTimeTrackingToTimeline(note: string, trackingLine: string, startTime: string): string {
	const lines = note.split("\n");
	const startTag = "<!--tascal-->";
	const endTag = "<!--/tascal-->";
	
	let inTascalSection = false;
	let inTimeline = false;
	
	for (let i = 0; i < lines.length; i++) {
	    const line = lines[i];
	    
	    if (line.includes(startTag)) {
		inTascalSection = true;
		continue;
	    }
	    
	    if (line.includes(endTag)) {
		inTascalSection = false;
		continue;
	    }
	    
	    if (inTascalSection && line.trim() === "### Timeline") {
		inTimeline = true;
		continue;
	    }
	    
	    if (inTimeline && line.startsWith("### ")) {
		inTimeline = false;
		continue;
	    }
	    
	    if (inTimeline && line.trim() === trackingLine.trim()) {
		// Add ">" after checkbox if not present
		const match = line.match(/^(- \[( |x)])\s*(>?\s*)(\d{1,2}:\d{2})/);
		if (match) {
		    const [_, checkbox, checked, existingTracking, time] = match;
		    let updatedLine = line.replace(/^(- \[( |x)])\s*(>?\s*)(\d{1,2}:\d{2})/, `$1 > $4`);
		    
		    // Add or update time tracking data in curly braces
		    if (updatedLine.includes("{TT:")) {
			// Add new session to existing tracking data
			updatedLine = updatedLine.replace(/\{TT:([^}]*)\}/, `{TT: $1, ${startTime}::}`);
		    } else {
			// Add new time tracking data
			updatedLine = updatedLine + ` {TT: ${startTime}::}`;
		    }
		    lines[i] = updatedLine;
		}
		break;
	    }
	}
	
	return lines.join("\n");
    }

    private completeTimeTrackingInTimeline(note: string, eventId: string, startTime: string, durationStr: string): string {
	const lines = note.split("\n");
	const startTag = "<!--tascal-->";
	const endTag = "<!--/tascal-->";
	
	let inTascalSection = false;
	let inTimeline = false;
	
	for (let i = 0; i < lines.length; i++) {
	    const line = lines[i];
	    
	    if (line.includes(startTag)) {
		inTascalSection = true;
		continue;
	    }
	    
	    if (line.includes(endTag)) {
		inTascalSection = false;
		continue;
	    }
	    
	    if (inTascalSection && line.trim() === "### Timeline") {
		inTimeline = true;
		continue;
	    }
	    
	    if (inTimeline && line.startsWith("### ")) {
		inTimeline = false;
		continue;
	    }
	    
	    if (inTimeline) {
		const trackingMatch = line.match(/^- \[( |x)]\s*(>)\s*(\d{1,2}:\d{2})/);
		if (trackingMatch) {
		    const currentEventId = this.generateEventId(line);
		    if (currentEventId === eventId) {
			// Find the last incomplete session in {TT: ...} and complete it
			lines[i] = line.replace(/\{TT:([^}]*)\}/, (match, content) => {
			    const entries = content.split(",").map((e: string) => e.trim());
			    for (let j = entries.length - 1; j >= 0; j--) {
				if (/::\s*$/.test(entries[j])) {
				    entries[j] = `${startTime}::${durationStr}`;
				    break;
				}
			    }
			    return `{TT: ${entries.join(", ")}}`;
			});
			break;
		    }
		}
	    }
	}
	return lines.join("\n");
    }

    private updateStatsLineWithTotalTT(note: string, timeTrackingData: TimeTrackingData): string {
	const lines = note.split("\n");
	const startTag = "<!--tascal-->";
	const endTag = "<!--/tascal-->";
	
	let inTascalSection = false;
	let inTimeline = false;
	
	// Find and update the stats line
	for (let i = 0; i < lines.length; i++) {
	    const line = lines[i];
	    
	    if (line.includes(startTag)) {
		inTascalSection = true;
		continue;
	    }
	    
	    if (line.includes(endTag)) {
		inTascalSection = false;
		continue;
	    }
	    
	    if (inTascalSection && line.trim() === "### Timeline") {
		inTimeline = true;
		continue;
	    }
	    
	    if (inTimeline && line.startsWith("### ")) {
		break;
	    }
	    
	    // Check if this is the stats line (contains "done |")
	    if (inTimeline && line.includes("done |")) {
		// Calculate total tracked time
		let totalTrackedMinutes = 0;
		for (const [eventId, entries] of Object.entries(timeTrackingData)) {
		    for (const entry of entries) {
			if (entry.duration && entry.duration !== "") {
			    const [hours, minutes] = entry.duration.split(":").map(Number);
			    totalTrackedMinutes += hours * 60 + minutes;
			}
		    }
		}
		const totalTrackedStr = formatDuration(totalTrackedMinutes);
		
		// Update the stats line to include total tracked time
		const updatedStatsLine = line.replace(/\|\s*\*\*Total TT:[^*]*\*\*/, "") + ` | **Total TT: ${totalTrackedStr}**`;
		lines[i] = updatedStatsLine;
		break;
	    }
	}
	
	return lines.join("\n");
    }


}

class EventSelectionModal extends Modal {
    private eventLines: string[];
    private onSelect: (selectedLine: string) => void;

    constructor(app: App, eventLines: string[], onSelect: (selectedLine: string) => void) {
	super(app);
	this.eventLines = eventLines;
	this.onSelect = onSelect;
    }

    onOpen() {
	const { contentEl } = this;
	contentEl.empty();

	contentEl.createEl("h2", { text: "Select Event to Track" });
	contentEl.createEl("p", { 
	    text: "Click on an event to start time tracking", 
	    cls: "modal-description" 
	});

	const container = contentEl.createEl("div", { cls: "event-selection-container" });

	if (this.eventLines.length === 0) {
	    container.createEl("p", { 
		text: "No events found in timeline.", 
		cls: "no-events-message" 
	    });
	} else {
	    this.eventLines.forEach(line => {
		const eventDiv = container.createEl("div", { cls: "event-option" });
		
		// Parse the event line to extract time and summary
		const match = line.match(/^- \[( |x)]\s*(>?\s*)(\d{1,2}:\d{2})–(\d{1,2}:\d{2}) (.+?)(?:\s*\{TT:[^}]*\})?$/);
		if (match) {
		    const [_, checkbox, tracking, start, end, summary] = match;
		    const isCompleted = checkbox === "x";
		    const isCurrentlyTracked = tracking.includes(">");
		    
		    // Event time range
		    const timeDiv = eventDiv.createEl("div", { cls: "event-time" });
		    timeDiv.setText(`${start}–${end}`);
		    
		    // Event summary
		    const summaryDiv = eventDiv.createEl("div", { cls: "event-summary" });
		    summaryDiv.setText(summary.trim());
		    
		    // Status indicators
		    const statusDiv = eventDiv.createEl("div", { cls: "event-status" });
		    if (isCompleted) {
			statusDiv.createEl("span", { 
			    text: "✓", 
			    cls: "status-completed",
			    title: "Completed"
			});
		    }
		    if (isCurrentlyTracked) {
			statusDiv.createEl("span", { 
			    text: "▶", 
			    cls: "status-tracking",
			    title: "Currently tracked"
			});
		    }
		    
		    // Select button
		    const selectBtn = eventDiv.createEl("button", { 
			text: "Track", 
			cls: "track-button" 
		    });
		    selectBtn.addEventListener("click", () => {
			this.onSelect(line);
			this.close();
		    });
		} else {
		    // Fallback for non-standard format
		    eventDiv.createEl("div", { 
			text: line.trim(), 
			cls: "event-fallback" 
		    });
		    const selectBtn = eventDiv.createEl("button", { 
			text: "Track", 
			cls: "track-button" 
		    });
		    selectBtn.addEventListener("click", () => {
			this.onSelect(line);
			this.close();
		    });
		}
	    });
	}

	// Cancel button
	const cancelBtn = contentEl.createEl("button", { 
	    text: "Cancel", 
	    cls: "cancel-button" 
	});
	cancelBtn.addEventListener("click", () => {
	    this.close();
	});
    }

    onClose() {
	const { contentEl } = this;
	contentEl.empty();
    }
}

import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, requestUrl } from 'obsidian';
import ICAL from "ical.js";
import { DateTime } from "luxon";

interface EventData {
    summary: string;
    start: DateTime;
    end: DateTime;
    uid: string;
    done?: boolean;
    source?: string;
}

interface TimeTrackingEntry {
    start: string; // "15:30"
    duration: string; // "00:34"
}

interface TimeTrackingData {
    [eventId: string]: TimeTrackingEntry[];
}

interface TascalSettings {
    timezone: string;
    calendars: { id: string; url: string }[];
    defaultDayStart: string; // e.g., "08:00"
    defaultDayEnd: string;   // e.g., "22:00"
    dayOverrides: Record<string, { start: string; end: string }>; // e.g., { "Saturday": { start: "10:00", end: "18:00" } }
    recurringEvents: string[]; // Array of recurring event definitions
    timeTrackingData: TimeTrackingData;
    currentTrackingEventId: string | null;
}

const DEFAULT_SETTINGS: TascalSettings = {
    timezone: "Europe/Warsaw",
    calendars: [],
    defaultDayStart: "08:00",
    defaultDayEnd: "22:00",
    dayOverrides: {
	"Saturday": { start: "10:00", end: "18:00" },
	"Sunday": { start: "10:00", end: "20:00" }
    },
    recurringEvents: [],
    timeTrackingData: {},
    currentTrackingEventId: null
};


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
		    const { timeline, manualBlockLines } = extractTascalSection(note);

		    // Extract current time tracking data from timeline
		    const currentTimeTracking = extractTimeTrackingFromTimeline(timeline);
		    
		    // Load time tracking data from daily JSON file
		    const timeTrackingFilePath = `.tascal/tt-${dateStr}.json`;
		    const fileTimeTrackingData = await loadTimeTrackingData(this.app, timeTrackingFilePath);
		    
		    const rescheduledLines = await loadRescheduledTasks(
			this.app,
			".tascal",
			dateStr,
			this.settings.timezone,
			localDate
		    );
		    manualBlockLines.push(...rescheduledLines);

		    const recurringLines = await loadRecurringTasks(this.app, this.settings.recurringEvents, localDate, this);
		    manualBlockLines.push(...recurringLines);


		    const { blocks: finalManualBlocks, rescheduled } = parseManualBlocksFromLines(
			manualBlockLines,
			localDate,
			this.settings.timezone
		    );

		    // Migrate time tracking data from time-based IDs to UIDs
		    const migratedTimeTrackingData = migrateTimeTrackingData(
			fileTimeTrackingData,
			allEvents,
			finalManualBlocks,
			dateStr
		    );
		    
		    // Refresh time tracking data: keep only currently tracked event, replace others with migrated file data
		    const refreshedTimeTracking: TimeTrackingData = {};
		    
		    // Keep the currently tracked event if it exists
		    if (this.settings.currentTrackingEventId && this.settings.timeTrackingData[this.settings.currentTrackingEventId]) {
			refreshedTimeTracking[this.settings.currentTrackingEventId] = this.settings.timeTrackingData[this.settings.currentTrackingEventId];
		    }
		    
		    // Add all migrated time tracking data from file
		    Object.assign(refreshedTimeTracking, migratedTimeTrackingData);
		    
		    this.settings.timeTrackingData = refreshedTimeTracking;

		    const timelineLines = generateSafeTimelineLines(allEvents, finalManualBlocks, localDate, timeline || [], this.settings, fileTimeTrackingData);
		    const updatedNote = updateTascalSection(note, timelineLines, manualBlockLines);

		    await writeCalendarCache(this.app, localDate, allEvents);
		    await this.app.vault.modify(activeFile, updatedNote);
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

		const { timeline, manualBlockLines } = extractTascalSection(note);

		// Extract current time tracking data from timeline
		const currentTimeTracking = extractTimeTrackingFromTimeline(timeline);
		
		// Load time tracking data from daily JSON file
		const timeTrackingFilePath = `.tascal/tt-${dateStr}.json`;
		const fileTimeTrackingData = await loadTimeTrackingData(this.app, timeTrackingFilePath);
		
		const rescheduledLines = await loadRescheduledTasks(
		    this.app,
		    ".tascal",
		    dateStr,
		    this.settings.timezone,
		    localDate
		);
		manualBlockLines.push(...rescheduledLines);

		const recurringLines = await loadRecurringTasks(this.app, this.settings.recurringEvents, localDate, this);
		manualBlockLines.push(...recurringLines);


		const { blocks: finalManualBlocks, rescheduled } = parseManualBlocksFromLines(
		    manualBlockLines,
		    localDate,
		    this.settings.timezone
		);

		// Migrate time tracking data from time-based IDs to UIDs
		const migratedTimeTrackingData = migrateTimeTrackingData(
		    fileTimeTrackingData,
		    calendarEvents,
		    finalManualBlocks,
		    dateStr
		);
		
		// Refresh time tracking data: keep only currently tracked event, replace others with migrated file data
		const refreshedTimeTracking: TimeTrackingData = {};
		
		// Keep the currently tracked event if it exists
		if (this.settings.currentTrackingEventId && this.settings.timeTrackingData[this.settings.currentTrackingEventId]) {
		    refreshedTimeTracking[this.settings.currentTrackingEventId] = this.settings.timeTrackingData[this.settings.currentTrackingEventId];
		}
		
		// Add all migrated time tracking data from file
		Object.assign(refreshedTimeTracking, migratedTimeTrackingData);
		
		this.settings.timeTrackingData = refreshedTimeTracking;

		// Save newly rescheduled entries to the persistent file
		for (const task of rescheduled) {
		    await appendRescheduledTask(this.app, ".tascal", task.target, dateStr, task.line);
		}

		// Combine calendar events and manual blocks
		const allBlocks = [...calendarEvents, ...finalManualBlocks];
		allBlocks.sort((a, b) => a.start.toMillis() - b.start.toMillis());

		const timelineLines = generateSafeTimelineLines(
		    allBlocks,
		    [],
		    localDate,
		    timeline || [],
		    this.settings,
		    fileTimeTrackingData
		);

		const updatedNote = updateTascalSection(note, timelineLines, manualBlockLines);
		await this.app.vault.modify(file, updatedNote);
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

// HELPER FUNCTIONS
function extractDateFromFilename(filename: string): string | null {
    const match = filename.match(/^(\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : null;
}

function extractEventsForDate(
    calendar: ICAL.Component,
    localDate: DateTime,
    timezone: string
): EventData[] {
    const startOfDay = localDate.startOf("day");
    const endOfDay = localDate.endOf("day");

    const vevents = calendar.getAllSubcomponents("vevent");
    const events: EventData[] = [];

    const overridesByUid: Record<string, ICAL.Event[]> = {};
    const overriddenByUid: Record<string, Set<number>> = {};
    const exdatesByUid: Record<string, Set<number>> = {};

    // Step 1: separate overrides and build override maps
    for (const comp of vevents) {
	const event = new ICAL.Event(comp);

	if (event.recurrenceId) {
	    const uid = event.uid;
	    if (!overridesByUid[uid]) overridesByUid[uid] = [];
	    overridesByUid[uid].push(event);

	    const originalDate = event.recurrenceId.toJSDate().getTime();
	    if (!overriddenByUid[uid]) overriddenByUid[uid] = new Set();
	    overriddenByUid[uid].add(originalDate);
	}
    }

    // Step 2: collect EXDATEs per UID
    for (const comp of vevents) {
	const event = new ICAL.Event(comp);
	const uid = event.uid;
	const exs = comp.getAllProperties("exdate");
	if (!exdatesByUid[uid]) exdatesByUid[uid] = new Set();

	for (const ex of exs) {
	    const values = ex.getValues();
	    for (const dt of values) {
		exdatesByUid[uid].add(new Date(dt).getTime());
	    }
	}
    }

    // Step 3: process master events and expand RRULEs
    for (const comp of vevents) {
	const event = new ICAL.Event(comp);
	const uid = event.uid;

	// skip overrides (already processed)
	if (event.recurrenceId) continue;

	const dtstart = event.startDate?.toJSDate();
	const dtend = event.endDate?.toJSDate();
	if (!dtstart || !dtend) continue;

	if (event.isRecurring()) {
	    const iterator = event.iterator();
	    let next;
	    while ((next = iterator.next())) {
		const occJs = next.toJSDate();
		const occ = DateTime.fromJSDate(occJs, { zone: timezone });

		if (occ > endOfDay) break;
		if (!occ.hasSame(localDate, "day")) continue;

		const timestamp = occJs.getTime();

		// skip if overridden or excluded
		if (overriddenByUid[uid]?.has(timestamp)) continue;
		if (exdatesByUid[uid]?.has(timestamp)) continue;

		const durationSecs = event.duration.toSeconds();
		events.push({
		    summary: event.summary,
		    start: occ,
		    end: occ.plus({ seconds: durationSecs }),
		    uid,
		});
	    }
	} else {
	    const start = DateTime.fromJSDate(dtstart, { zone: timezone });
	    if (start.hasSame(localDate, "day")) {
		const end = DateTime.fromJSDate(dtend, { zone: timezone });
		events.push({ summary: event.summary, start, end, uid });
	    }
	}
    }

    // Step 4: add all overrides that now fall on this date
    for (const list of Object.values(overridesByUid)) {
	for (const event of list) {
	    const dtstart = event.startDate?.toJSDate();
	    const dtend = event.endDate?.toJSDate();
	    if (!dtstart || !dtend) continue;

	    const start = DateTime.fromJSDate(dtstart, { zone: timezone });
	    if (start.hasSame(localDate, "day")) {
		const end = DateTime.fromJSDate(dtend, { zone: timezone });
		events.push({ summary: event.summary, start, end, uid: event.uid });
	    }
	}
    }

    return events;
}

function extractTascalSection(content: string): {
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
        // fallback
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

function extractCheckboxStateMap(timelineLines: string[]): Map<string, boolean> {
    const checkboxMap = new Map<string, boolean>();
    // Updated pattern to handle ">" symbol after checkbox but before time
    const pattern = /^- \[( |x)]\s*(>?\s*)(\d{1,2}:\d{2})–(\d{1,2}:\d{2}) (.+?)(?:\s*\{TT:[^}]*\})?$/;

    for (const line of timelineLines) {
	const match = line.match(pattern);
	if (match) {
	    const checked = match[1] === "x";
	    const start = match[3];
	    const end = match[4];
	    const summary = match[5];
	    const key = `${start}-${summary}`;
	    checkboxMap.set(key, checked);
	}
    }

    return checkboxMap;
}

function extractTimeTrackingData(timelineLines: string[]): Map<string, string> {
    const timeTrackingMap = new Map<string, string>();
    const pattern = /^- \[( |x)]\s*(>?\s*)(\d{1,2}:\d{2})–(\d{1,2}:\d{2}) (.+?)(?:\s*\{TT:([^}]*)\})?$/;

    for (const line of timelineLines) {
	const match = line.match(pattern);
	if (match) {
	    const start = match[3];
	    const end = match[4];
	    const summary = match[5];
	    const timeTracking = match[6];
	    
	    if (timeTracking) {
		const key = `${start}-${summary}`;
		timeTrackingMap.set(key, timeTracking.trim());
	    }
	}
    }

    return timeTrackingMap;
}

// Helper function to generate event ID from EventData block
function generateEventIdFromBlock(block: EventData): string {
    return block.uid;
}

function generateSafeTimelineLines(
    calendarEvents: EventData[],
    manualBlocks: EventData[],
    date: DateTime,
    previousTimelineLines: string[],
    settings: TascalSettings,
    jsonTimeTrackingData?: TimeTrackingData
): string[] {
    const timeline: string[] = [];

    const checkboxMap = extractCheckboxStateMap(previousTimelineLines);
    const timeTrackingMap = extractTimeTrackingData(previousTimelineLines);

    const allBlocks = [...calendarEvents, ...manualBlocks];

    const seen = new Set<string>();
    const uniqueBlocks: EventData[] = [];

    for (const block of allBlocks) {
	const key = `${block.start.toISO()}-${block.end.toISO()}-${block.summary}`;
	if (!seen.has(key)) {
            uniqueBlocks.push(block);
            seen.add(key);
	}
    }
    
    uniqueBlocks.sort((a, b) => a.start.toMillis() - b.start.toMillis());

    const dayName = date.toFormat("EEEE");
    const override = settings.dayOverrides[dayName];

    const startStr = override?.start || settings.defaultDayStart;
    const endStr = override?.end || settings.defaultDayEnd;

    let cursor = DateTime.fromFormat(`${date.toISODate()} ${startStr}`, "yyyy-MM-dd HH:mm", { zone: settings.timezone });
    const endOfDay = DateTime.fromFormat(`${date.toISODate()} ${endStr}`, "yyyy-MM-dd HH:mm", { zone: settings.timezone });

    // 🛠 Collect statistics
    let totalTasks = 0;
    let completedTasks = 0;
    let totalMinutes = 0;
    let elapsedMinutes = 0;
    let remainingMinutes = 0;

    const eventLines: string[] = [];

    for (const block of uniqueBlocks) {
	if (block.start > cursor) {
            eventLines.push(`- *${cursor.toFormat("HH:mm")}–${block.start.toFormat("HH:mm")} (free)*`);
	}

	const key = `${block.start.toFormat("HH:mm")}-${block.summary}`;
	const checked = block.done === true || checkboxMap.get(key) === true ? "x" : " ";
	
	// Check if this event should have the tracking pointer
	const shouldTrack = settings.currentTrackingEventId === generateEventIdFromBlock(block);

	// Get time tracking data from settings for this event using UID
	const eventId = generateEventIdFromBlock(block);
	const settingsTimeTracking = settings.timeTrackingData[eventId];
	
	// Also check timeline data for backward compatibility
	const timeTracking = timeTrackingMap.get(key) || "";
	
	// Check JSON file data for this event (using summary as key)
	const jsonTimeTracking = jsonTimeTrackingData?.[block.summary];
	
	// Merge time tracking data: use settings data if available, otherwise use timeline data, then JSON data
	let finalTimeTracking = timeTracking;
	if (settingsTimeTracking && settingsTimeTracking.length > 0) {
	    const trackingEntries = settingsTimeTracking
		.filter(entry => entry.duration !== "")
		.map(entry => `${entry.start}::${entry.duration}`)
		.join(", ");
	    finalTimeTracking = trackingEntries;
	} else if (jsonTimeTracking && jsonTimeTracking.length > 0) {
	    const trackingEntries = jsonTimeTracking
		.filter(entry => entry.duration !== "")
		.map(entry => `${entry.start}::${entry.duration}`)
		.join(", ");
	    finalTimeTracking = trackingEntries;
	}

	// Preserve time tracking data if it exists
	const trackingInfo = finalTimeTracking ? ` {TT: ${finalTimeTracking}}` : "";
	const trackingSymbol = shouldTrack ? " >" : "";
	eventLines.push(`- [${checked}]${trackingSymbol} ${block.start.toFormat("HH:mm")}–${block.end.toFormat("HH:mm")} ${block.summary}${trackingInfo}`);

	if (block.end > cursor) {
            cursor = block.end;
	}

	totalTasks++;
	if (checked === "x") completedTasks++;

	const blockDurationMinutes = block.end.diff(block.start, "minutes").minutes;
	totalMinutes += blockDurationMinutes;

	// 🛠 only based on checkbox
	if (checked === "x") {
            elapsedMinutes += blockDurationMinutes;
	} else {
            remainingMinutes += blockDurationMinutes;
	}
    }

    if (cursor < endOfDay) {
        eventLines.push(`- *${cursor.toFormat("HH:mm")}–${endOfDay.toFormat("HH:mm")} (free)*`);
    }

    // ✨ Build the stats line
    const remainingTasks = totalTasks - completedTasks;
    const totalTimeStr = formatDuration(totalMinutes);
    const elapsedTimeStr = formatDuration(elapsedMinutes);
    const leftTimeStr = formatDuration(remainingMinutes);

    // Calculate total tracked time from time tracking data
    let totalTrackedMinutes = 0;
    if (jsonTimeTrackingData) {
        for (const [eventId, entries] of Object.entries(jsonTimeTrackingData)) {
            for (const entry of entries) {
                if (entry.duration && entry.duration !== "") {
                    const [hours, minutes] = entry.duration.split(":").map(Number);
                    totalTrackedMinutes += hours * 60 + minutes;
                }
            }
        }
    }
    const totalTrackedStr = formatDuration(totalTrackedMinutes);

    const statsLine = `**${completedTasks}/${totalTasks}** done | ${elapsedTimeStr}/${totalTimeStr} | **Total TT: ${totalTrackedStr}**`;

    return [statsLine, "", ...eventLines];
}

function updateTascalSection(
    content: string,
    timelineLines: string[],
    manualBlockLines: string[]
): string {
    const startTag = "<!--tascal-->";
    const endTag = "<!--/tascal-->";
    const newSection =
        `${startTag}\n` +
        `### Timeline\n` +
        timelineLines.join("\n") +
        `\n\n<!--manual\n` +
        manualBlockLines.join("\n") +
        `\n-->\n` +
        `${endTag}`;

    const { start, end } = extractTascalSection(content);
    if (start === -1 || end === -1) {
        return content + `\n\n${newSection}`;
    }

    return content.slice(0, start) + newSection + content.slice(end);
}

function parseManualBlocksFromLines(
    lines: string[],
    date: DateTime,
    timezone: string
): { blocks: EventData[]; rescheduled: { target: string, line: string }[] } {
    const blocks: EventData[] = [];
    const rescheduled: { target: string; line: string }[] = [];

    const startEndRegex = /^@(\d{1,2}(?::\d{2})?)\s*[-–—]\s*(\d{1,2}(?::\d{2})?)\s+(.*?)(?:\s+@(\d{4}-\d{2}-\d{2}))?$/;
    const startDurationRegex = /^@(\d{1,2}(?::\d{2})?)\s*\(([\dhm]+)\)\s+(.*?)(?:\s+@(\d{4}-\d{2}-\d{2}))?$/;


    for (const line of lines) {
	let match;
	let isRescheduled = false;
	let rescheduleDate = null;
	let rescheduleTime = null;

	const rescheduleMatch = line.match(/@(\d{4}-\d{2}-\d{2})(?:@(\d{2}:\d{2}))?/);
	if (rescheduleMatch) {
	    isRescheduled = true;
	    rescheduleDate = rescheduleMatch[1];
	    rescheduleTime = rescheduleMatch[2] || null;
	}

	if ((match = line.match(startEndRegex))) {
	    const [_, startStr, endStr, summary, rescheduleDate] = match;
	    const start = DateTime.fromFormat(`${date.toISODate()} ${formatTime(startStr)}`, "yyyy-MM-dd HH:mm", { zone: timezone });
	    const end = DateTime.fromFormat(`${date.toISODate()} ${formatTime(endStr)}`, "yyyy-MM-dd HH:mm", { zone: timezone });

	    if (isRescheduled && !rescheduleTime) {
		rescheduled.push({ target: rescheduleDate!, line });
		continue;
	    }

	    blocks.push({ summary, start, end, uid: `manual-${date.toISODate()}-${summary.trim().replace(/[^a-zA-Z0-9]/g, '-')}` });

	} else if ((match = line.match(startDurationRegex))) {
	    const [_, startStr, durationStr, summary, rescheduleDate] = match;
	    const start = DateTime.fromFormat(`${date.toISODate()} ${formatTime(startStr)}`, "yyyy-MM-dd HH:mm", { zone: timezone });
	    const durationMinutes = parseDuration(durationStr);
	    const end = start.plus({ minutes: durationMinutes });

	    if (isRescheduled && !rescheduleTime) {
		rescheduled.push({ target: rescheduleDate!, line });
		continue;
	    }

	    blocks.push({ summary, start, end, uid: `manual-${date.toISODate()}-${summary.trim().replace(/[^a-zA-Z0-9]/g, '-')}` });
	}
    }

    return { blocks, rescheduled };
}

async function writeCalendarCache(app: App, date: DateTime, events: EventData[]) {
    const filePath = `.tascal/${date.toISODate()}.json`;
    const folderPath = `.tascal`;
    const adapter = app.vault.adapter;

    if (!(await adapter.exists(folderPath))) {
	await adapter.mkdir(folderPath);
    }

    const serializable = events.map(ev => ({
	summary: ev.summary,
	start: ev.start.toISO(),
	end: ev.end.toISO(),
	uid: ev.uid,
	source: ev.source ?? "calendar",
	done: ev.done ?? false,
    }));

    await adapter.write(filePath, JSON.stringify(serializable, null, 2));
}

async function readCalendarCache(app: App, date: DateTime): Promise<EventData[] | null> {
    const filePath = `.tascal/${date.toISODate()}.json`;
    const adapter = app.vault.adapter;

    if (!(await adapter.exists(filePath))) return null;

    const text = await adapter.read(filePath);
    const raw = JSON.parse(text);
    return raw.map((item: any) => ({
	summary: item.summary,
	start: DateTime.fromISO(item.start),
	end: DateTime.fromISO(item.end),
	uid: item.uid,
	done: item.done ?? false,
	source: item.source ?? "calendar",
    }));
}

function parseDuration(text: string): number {
    const regex = /(\d+)(h|m)/g;
    let match;
    let totalMinutes = 0;

    while ((match = regex.exec(text)) !== null) {
	const value = parseInt(match[1]);
	const unit = match[2];

	if (unit === "h") totalMinutes += value * 60;
	if (unit === "m") totalMinutes += value;
    }

    return totalMinutes;
}

function formatDuration(minutes: number): string {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (hours > 0 && mins > 0) return `${hours}h${mins}m`;
    if (hours > 0) return `${hours}h`;
    return `${mins}m`;
}

function formatTime(time: string): string {
    // If time is already in HH:MM format, return as is
    if (time.includes(':')) {
        // Ensure hours are padded with leading zero
        const [hours, minutes] = time.split(':');
        return `${hours.padStart(2, '0')}:${minutes}`;
    }
    // Otherwise, assume it's just hours and add :00
    // Pad single-digit hours with leading zero
    const hour = time.padStart(2, '0');
    return `${hour}:00`;
}

async function appendRescheduledTask(app: App, globalPath: string, targetDate: string, originalDate: string, line: string) {
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

async function loadRescheduledTasks(
    app: App,
    folder: string,
    targetDate: string,
    timezone: string,
    dateObj: DateTime
): Promise<string[]> {
    const filePath = `${folder}/rescheduled.md`;
    const adapter = app.vault.adapter;
    const blocks: string[] = [];
    
    if (!(await adapter.exists(filePath))) return [];

    const text = await adapter.read(filePath);
    const lines = text.split("\n");
    
    const updatedLines: string[] = [];
    for (const line of lines) {
        if (line.startsWith("%%processed%%")) {
            updatedLines.push(line);
            continue;
        }

        const matchRange = line.match(/^@(\d{4}-\d{2}-\d{2}) from (\d{4}-\d{2}-\d{2}): @(\d{1,2}(?::\d{2})?)[-–—](\d{1,2}(?::\d{2})?) (.+)$/);
        const matchDuration = line.match(/^@(\d{4}-\d{2}-\d{2}) from (\d{4}-\d{2}-\d{2}): @(\d{1,2}(?::\d{2})?)\s*\(([\dhm\s]+)\) (.+)$/);

        if (!matchRange && !matchDuration) {
            updatedLines.push(line);
            continue;
        }

	if (matchRange) {
	    const [_, reschedDate, fromDate, startStr, endStr, summaryRaw] = matchRange;
	    if (reschedDate !== targetDate) {
		updatedLines.push(line);
		continue;
	    }

            const summary = summaryRaw
                .replace(/\[[^\]]+\]/, "") // Remove recurring markers
                .replace(/@\d{4}-\d{2}-\d{2}/, "") // Remove @YYYY-MM-DD
                .trim();
            blocks.push(`@${startStr}–${endStr} ${summary} [rs:${fromDate}]`);
	    updatedLines.push(`%%processed%% ${line}`);
	    continue;
	}

	if (matchDuration) {
	    const [_, reschedDate, fromDate, startStr, durationStr, summaryRaw] = matchDuration;
	    if (reschedDate !== targetDate) {
		updatedLines.push(line);
		continue;
	    }

            const summary = summaryRaw
                .replace(/\[[^\]]+\]/, "") // Remove recurring markers
                .replace(/@\d{4}-\d{2}-\d{2}/, "") // Remove @YYYY-MM-DD
                .trim();
            blocks.push(`@${startStr} (${durationStr}) ${summary} [rs:${fromDate}]`);
	    updatedLines.push(`%%processed%% ${line}`);
	    continue;
	}
    }

    await adapter.write(filePath, updatedLines.join("\n") + "\n");
    return blocks;
}

async function loadRecurringTasks(app: App, recurringEvents: string[], date: DateTime, plugin?: any): Promise<string[]> {
    const result: string[] = [];
    const adapter = app.vault.adapter;
    const recurringFilePath = ".tascal/recurring.md";
    
    // Load existing markers from file
    let existingMarkers: Record<string, string[]> = {};
    if (await adapter.exists(recurringFilePath)) {
        try {
            const content = await adapter.read(recurringFilePath);
            const lines = content.split("\n").filter(line => line.trim());
            
            for (const line of lines) {
                const markerMatch = line.match(/^(.+?)\s*<!--\s*added:(\d{4}-\d{2}-\d{2})\s*-->$/);
                if (markerMatch) {
                    const [_, eventKey, dateStr] = markerMatch;
                    if (!existingMarkers[eventKey]) {
                        existingMarkers[eventKey] = [];
                    }
                    existingMarkers[eventKey].push(dateStr);
                }
            }
        } catch (error) {
            console.error("Error loading recurring markers:", error);
        }
    }

    const updatedMarkers: string[] = [];

    for (let line of recurringEvents) {
        const repeatMatch = line.match(/\[(w|m):([^\]]+)\]/);
        const dateStr = date.toISODate();
        
        // Check if this event has already been added for this date
        const eventKey = line.replace(/\s*\[(rc:[wm]|[wm]:[^\]]+)\]$/, "").trim();
        const alreadyAdded = dateStr ? existingMarkers[eventKey]?.includes(dateStr) || false : false;

        if (!repeatMatch) {
            continue;
        }

        const [_, type, rule] = repeatMatch;

        if (alreadyAdded) {
            continue;
        }

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
            // Remove only the last [m:19] or [rc:m] marker, keep [[...]] links
            let taskLine = line.replace(/\s*<!--.*$/, "").trim();
            // Remove the last [rc:w], [rc:m], [m:19], [w:Mon,Wed] etc. marker
            taskLine = taskLine.replace(/\s*\[(rc:[wm]|[wm]:[^\]]+)\]$/, "");
            // Add source indicator based on type
            const sourceIndicator = type === "w" ? "[rc:w]" : "[rc:m]";
            result.push(`${taskLine} ${sourceIndicator}`.trim());

            // Add marker to the list
            updatedMarkers.push(`${eventKey} <!-- added:${dateStr} -->`);
        }
    }

    // Save updated markers to file
    if (updatedMarkers.length > 0) {
        const folderPath = ".tascal";
        if (!(await adapter.exists(folderPath))) {
            await adapter.mkdir(folderPath);
        }
        
        // Read existing content and append new markers
        let existingContent = "";
        if (await adapter.exists(recurringFilePath)) {
            existingContent = await adapter.read(recurringFilePath);
        }
        
        const newContent = existingContent + "\n" + updatedMarkers.join("\n");
        await adapter.write(recurringFilePath, newContent.trim() + "\n");
    }

    return result;
}

class TascalSettingTab extends PluginSettingTab {
    plugin: TascalPlugin;

    constructor(app: App, plugin: TascalPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;

        containerEl.empty();
        containerEl.createEl("h2", { text: "Tascal Settings" });

        // ===== Timezone =====
        new Setting(containerEl)
            .setName('Timezone')
            .setDesc('Time zone for event formatting (e.g. Europe/Warsaw)')
            .addText(text =>
                text
                    .setPlaceholder('UTC')
                    .setValue(this.plugin.settings.timezone)
                    .onChange(async (value) => {
                        this.plugin.settings.timezone = value;
                        await this.plugin.saveSettings();
                    })
            );

        // ===== Calendars =====
        containerEl.createEl("h3", { text: "Calendars" });

        this.plugin.settings.calendars.forEach((cal, index) => {
            new Setting(containerEl)
                .setName(`Calendar ${index + 1}`)
                .addText((text) =>
                    text
                        .setPlaceholder("calendar name")
                        .setValue(cal.id)
                        .onChange(async (value) => {
                            this.plugin.settings.calendars[index].id = value;
                            await this.plugin.saveSettings();
                        })
                )
                .addText((text) =>
                    text
                        .setPlaceholder("https://...")
                        .setValue(cal.url)
                        .onChange(async (value) => {
                            this.plugin.settings.calendars[index].url = value;
                            await this.plugin.saveSettings();
                        })
                )
                .addExtraButton((btn) =>
                    btn
                        .setIcon("trash")
                        .setTooltip("Remove")
                        .onClick(async () => {
                            this.plugin.settings.calendars.splice(index, 1);
                            await this.plugin.saveSettings();
                            this.display();
                        })
                );
        });

        new Setting(containerEl)
            .addButton((btn) =>
                btn
                    .setButtonText("+ Add Calendar")
                    .setCta()
                    .onClick(async () => {
                        this.plugin.settings.calendars.push({ id: "", url: "" });
                        await this.plugin.saveSettings();
                        this.display();
                    })
            );

        // ===== Default working hours =====
        containerEl.createEl("h3", { text: "Default Working Hours" });

        new Setting(containerEl)
            .setName("Default Day Start")
            .setDesc("When should the day start (default for all days)?")
            .addText(text => text
                .setPlaceholder("08:00")
                .setValue(this.plugin.settings.defaultDayStart)
                .onChange(async (value) => {
                    this.plugin.settings.defaultDayStart = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName("Default Day End")
            .setDesc("When should the day end (default for all days)?")
            .addText(text => text
                .setPlaceholder("22:00")
                .setValue(this.plugin.settings.defaultDayEnd)
                .onChange(async (value) => {
                    this.plugin.settings.defaultDayEnd = value;
                    await this.plugin.saveSettings();
                }));

        // ===== Day overrides =====
        containerEl.createEl("h3", { text: "Day Overrides" });

        ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].forEach(day => {
            const override = this.plugin.settings.dayOverrides[day] || { start: "", end: "" };

            new Setting(containerEl)
                .setName(`${day}`)
                .addText(text =>
                    text
                        .setPlaceholder("Start time (08:00)")
                        .setValue(override.start)
                        .onChange(async (value) => {
                            this.plugin.settings.dayOverrides[day] = this.plugin.settings.dayOverrides[day] || { start: "", end: "" };
                            this.plugin.settings.dayOverrides[day].start = value;
                            await this.plugin.saveSettings();
                        }))
                .addText(text =>
                    text
                        .setPlaceholder("End time (22:00)")
                        .setValue(override.end)
                        .onChange(async (value) => {
                            this.plugin.settings.dayOverrides[day] = this.plugin.settings.dayOverrides[day] || { start: "", end: "" };
                            this.plugin.settings.dayOverrides[day].end = value;
                            await this.plugin.saveSettings();
                        }));
        });
	




	// ===== Recurring Events =====
	containerEl.createEl("h3", { text: "Recurring Events" });

	const recurringContainer = containerEl.createEl("div", { cls: "recurring-events-container" });
	
	// Add description
	recurringContainer.createEl("p", { 
	    text: "Define recurring events here. Use [w:Mon,Wed] for weekly or [m:15] for monthly recurrence.",
	    cls: "setting-item-description"
	});

	// Container for individual event inputs
	const eventsContainer = recurringContainer.createEl("div", { cls: "recurring-events-list" });

	// Function to create a new event input
	const createEventInput = (value: string = "", index?: number) => {
	    const eventDiv = eventsContainer.createEl("div", { cls: "recurring-event-item" });
	    
	    const input = eventDiv.createEl("input", {
		type: "text",
		cls: "recurring-event-input",
		attr: {
		    placeholder: "@09:00 (1h) Daily standup [w:Mon,Tue,Wed,Thu,Fri]"
		}
	    });
	    
	    input.value = value;
	    
	    // Handle input changes
	    input.addEventListener("input", async (evt) => {
		const target = evt.target as HTMLInputElement;
		const currentEvents = [...this.plugin.settings.recurringEvents];
		const inputIndex = Array.from(eventsContainer.children).indexOf(eventDiv);
		currentEvents[inputIndex] = target.value;
		this.plugin.settings.recurringEvents = currentEvents.filter(event => event.trim());
		await this.plugin.saveSettings();
	    });
	    
	    // Add remove button
	    const removeBtn = eventDiv.createEl("button", {
		text: "×",
		cls: "remove-event-btn"
	    });
	    
	    removeBtn.addEventListener("click", async () => {
		const currentEvents = [...this.plugin.settings.recurringEvents];
		const inputIndex = Array.from(eventsContainer.children).indexOf(eventDiv);
		currentEvents.splice(inputIndex, 1);
		this.plugin.settings.recurringEvents = currentEvents;
		await this.plugin.saveSettings();
		eventDiv.remove();
	    });
	    
	    return eventDiv;
	};

	// Add existing events
	this.plugin.settings.recurringEvents.forEach(event => {
	    createEventInput(event);
	});

	// Add + button to create new events
	const addButton = recurringContainer.createEl("button", {
	    text: "+ Add Recurring Event",
	    cls: "add-recurring-event-btn"
	});
	
	addButton.addEventListener("click", async () => {
	    createEventInput();
	    this.plugin.settings.recurringEvents.push("");
	    await this.plugin.saveSettings();
	});

    }
}

async function saveTimeTrackingData(app: App, filePath: string, timeTrackingData: TimeTrackingData) {
    const adapter = app.vault.adapter;
    const folderPath = filePath.substring(0, filePath.lastIndexOf('/'));

    if (!(await adapter.exists(folderPath))) {
        await adapter.mkdir(folderPath);
    }

    await adapter.write(filePath, JSON.stringify(timeTrackingData, null, 2));
}

async function loadTimeTrackingData(app: App, filePath: string): Promise<TimeTrackingData> {
    const adapter = app.vault.adapter;

    if (!(await adapter.exists(filePath))) {
        return {};
    }

    try {
        const text = await adapter.read(filePath);
        return JSON.parse(text);
    } catch (error) {
        console.error("Error loading time tracking data:", error);
        return {};
    }
}

function extractTimeTrackingFromTimeline(timelineLines: string[]): TimeTrackingData {
    const timeTrackingData: TimeTrackingData = {};
    const pattern = /^- \[( |x)]\s*(>?\s*)(\d{1,2}:\d{2})–(\d{1,2}:\d{2}) (.+?)(?:\s*\{TT:([^}]*)\})?$/;

    for (const line of timelineLines) {
	const match = line.match(pattern);
	if (match) {
	    const summary = match[5].trim();
	    const timeTracking = match[6];
	    if (timeTracking) {
		const eventId = summary;
		const entries = timeTracking.split(',').map((e: string) => {
		    const [startTime, duration] = e.trim().split('::');
		    return { start: startTime.trim(), duration: duration.trim() };
		});
		timeTrackingData[eventId] = entries;
	    }
	}
    }
    return timeTrackingData;
}

// Helper function to migrate time tracking data from time-based IDs to summary-only keys
function migrateTimeTrackingData(
    timeTrackingData: TimeTrackingData,
    calendarEvents: EventData[],
    manualBlocks: EventData[],
    dateStr: string
): TimeTrackingData {
    const migratedData: TimeTrackingData = {};
    for (const [oldId, entries] of Object.entries(timeTrackingData)) {
        // Try to parse the old ID and extract the summary
        const match = oldId.match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})-(.+)$/);
        if (match) {
            const summary = match[3].trim();
            migratedData[summary] = entries;
        } else {
            // If it's already a summary, keep as is
            migratedData[oldId] = entries;
        }
    }
    return migratedData;
}



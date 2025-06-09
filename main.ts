import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, requestUrl } from 'obsidian';
import ICAL from "ical.js";
import { requestUrl } from "obsidian";
import { DateTime } from "luxon";

// Remember to rename these classes and interfaces!

interface IcsPluginSettings {
    calendars: { id: string; url: string }[];
    timezone: string;
}

interface EventData {
    summary: string;
    start: DateTime;
    end: DateTime;
    uid: string;
}

interface TascalSettings {
    timezone: string;
    calendars: CalendarInfo[];
    defaultDayStart: string; // e.g., "08:00"
    defaultDayEnd: string;   // e.g., "22:00"
    dayOverrides: Record<string, { start: string; end: string }>; // e.g., { "Saturday": { start: "10:00", end: "18:00" } }
    rescheduledFolder: string;
    recurringFilePath: string;
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
    rescheduledFolder: "tascal",
    recurringFilePath: "tascal/recurring.md"
};


export default class IcsImporterPlugin extends Plugin {
    settings: TascalSettings;

    async onload() {
	await this.loadSettings();

	// This adds a settings tab so the user can configure various aspects of the plugin
	//this.addSettingTab(new IcsSettingTab(this.app, this));
	this.addSettingTab(new TascalSettingTab(this.app, this));

	// If the plugin hooks up any global DOM events (on parts of the app that doesn't belong to this plugin)
	// Using this function will automatically remove the event listener when this plugin is disabled.
	// test command

	this.addCommand({
	    id: "insert-events-from-ics",
	    name: "Insert/update calendar events from ICS",
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

		    const rescheduledLines = await loadRescheduledTasks(
			this.settings.rescheduledFolder,
			dateStr,
			this.settings.timezone,
			localDate
		    );
		    console.log(this.settings.rescheduledFolder, dateStr, this.settings.timezone, localDate);
		    console.log("rescheduledLines: ", rescheduledLines);
		    
		    manualBlockLines.push(...rescheduledLines);

		    const recurringPath = `${this.settings.recurringFilePath ?? 'tascal/recurring'}`;

		    const recurringLines = await loadRecurringTasks(recurringPath, localDate);
		    manualBlockLines.push(...recurringLines);


		    const { blocks: finalManualBlocks } = parseManualBlocksFromLines(
			manualBlockLines,
			localDate,
			this.settings.timezone
		    );

		    const allManualBlocks = [...finalManualBlocks];

		    const timelineLines = generateSafeTimelineLines(allEvents, allManualBlocks, localDate, timeline || [], this.settings);
		    const updatedNote = updateTascalSection(note, timelineLines, manualBlockLines);

		    await writeCalendarCache(localDate, allEvents);
		    await this.app.vault.modify(activeFile, updatedNote);
		    new Notice(`Inserted ${allEvents.length} event(s) for ${dateStr}.`);
		} catch (error) {
		    console.error("Failed to insert ICS events:", error);
		    new Notice("Error occurred. See console.");
		}
	    }
	});

	this.addCommand({
	    id: "update-timeline-view",
	    name: "Update timeline with manual and calendar events",
	    callback: async () => {
		const file = this.app.workspace.getActiveFile();
		if (!file) return new Notice("No active file.");

		const note = await this.app.vault.read(file);
		const dateStr = extractDateFromFilename(file.name);
		if (!dateStr) return new Notice("Note must start with a date (YYYY-MM-DD)");

		const localDate = DateTime.fromISO(dateStr, { zone: this.settings.timezone });
		let calendarEvents = this.calendarCache || [];

		if (calendarEvents.length === 0) {
		    const cached = await readCalendarCache(localDate);
		    if (cached) {
			calendarEvents = cached;
			this.calendarCache = cached;
			new Notice(`Loaded calendar events from cache for ${localDate.toISODate()}.`);
		    } else {
			new Notice("No cached calendar events found. Run ICS import first.");
		    }
		}

		const { timeline, manualBlockLines } = extractTascalSection(note);

		const rescheduledLines = await loadRescheduledTasks(
		    this.settings.rescheduledFolder,
		    dateStr,
		    this.settings.timezone,
		    localDate
		);
		manualBlockLines.push(...rescheduledLines);

		const recurringPath = `${this.settings.recurringFilePath ?? 'tascal/recurring.md'}`;

		const recurringLines = await loadRecurringTasks(recurringPath, localDate);
		manualBlockLines.push(...recurringLines);


		const { blocks: finalManualBlocks, rescheduled } = parseManualBlocksFromLines(
		    manualBlockLines,
		    localDate,
		    this.settings.timezone
		);

		const allManualBlocks = [...finalManualBlocks];

		// Save newly rescheduled entries to the persistent file
		for (const task of rescheduled) {
		    await appendRescheduledTask(this.settings.rescheduledFolder, task.target, dateStr, task.line);
		}

		const allBlocks = [...calendarEvents, ...allManualBlocks];
		allBlocks.sort((a, b) => a.start.toMillis() - b.start.toMillis());

		const timelineLines = generateSafeTimelineLines(
		    allBlocks,
		    [],
		    localDate,
		    timeline || [],
		    this.settings
		);

		const updatedNote = updateTascalSection(note, timelineLines, manualBlockLines);
		await this.app.vault.modify(file, updatedNote);
		new Notice("✅ Timeline updated.");
	    }
	});


	this.addCommand({
	    id: "format-manual-blocks",
	    name: "Format manual blocks",
	    callback: async () => {
		await this.formatManualBlocks();
	    }
	});

	
	this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
	    console.log('click', evt);
	});

	// When registering intervals, this function will automatically clear the interval when the plugin is disabled.
	this.registerInterval(window.setInterval(() => console.log('setInterval'), 5 * 60 * 1000));
    }

    onunload() {

    }

    async loadSettings() {
	this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
	await this.saveData(this.settings);
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

	//const manualBlocks = parseManualBlocksFromLines(manualBlockLines, localDate, this.settings.timezone);

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
}

class SampleModal extends Modal {
    constructor(app: App) {
	super(app);
    }

    onOpen() {
	const {contentEl} = this;
	contentEl.setText('Woah!');
    }

    onClose() {
	const {contentEl} = this;
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
    const startTag = "<!--TASCAL-START-->";
    const endTag = "<!--TASCAL-END-->";
    const manualTag = "<!--TASCAL-MANUAL-BLOCKS-SECTION";

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

function buildPlainTimeline(
    calendarEvents: EventData[],
    manualBlocks: EventData[],
    date: DateTime
): string[] {
    const allBlocks = [...calendarEvents, ...manualBlocks];
    allBlocks.sort((a, b) => a.start.toMillis() - b.start.toMillis());

    const timeline: string[] = [];
    let cursor = date.startOf("day");

    for (const block of allBlocks) {
	if (block.start > cursor) {
	    timeline.push(`*${cursor.toFormat("HH:mm")}–${block.start.toFormat("HH:mm")} available*`);
	}

	timeline.push(`- [ ] *${block.start.toFormat("HH:mm")}–${block.end.toFormat("HH:mm")} ${block.summary}*`);

	if (block.end > cursor) {
	    cursor = block.end;
	}
    }

    const endOfDay = date.endOf("day").startOf("minute");
    if (cursor < endOfDay) {
	timeline.push(`*${cursor.toFormat("HH:mm")}–${endOfDay.toFormat("HH:mm")} available*`);
    }

    return timeline;
}

function generateSafeTimelineLines(
    calendarEvents: EventData[],
    manualBlocks: EventData[],
    date: DateTime,
    previousTimelineLines: string[],
    settings: TascalSettings
): string[] {
    const timeline: string[] = [];

    const checkboxMap = extractCheckboxStateMap(previousTimelineLines);

    const allBlocks = [...calendarEvents, ...manualBlocks];

    //onst seen = new Set<string>();
    //onst uniqueBlocks: EventData[] = [];
    //
    //or (const block of allBlocks) {
    //   const key = `${block.uid}@${block.start.toISO()}`;
    //   if (!seen.has(key)) {
    //       uniqueBlocks.push(block);
    //       seen.add(key);
    //   }
    //

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

    //const now = DateTime.now().setZone(settings.timezone);

    const eventLines: string[] = [];

    for (const block of uniqueBlocks) {
	if (block.start > cursor) {
            eventLines.push(`${cursor.toFormat("HH:mm")}–${block.start.toFormat("HH:mm")} available`);
	}

	const key = `${block.start.toFormat("HH:mm")}-${block.summary}`;
	const checked = block.done === true || checkboxMap.get(key) === true ? "x" : " ";

	eventLines.push(`- [${checked}] ${block.start.toFormat("HH:mm")}–${block.end.toFormat("HH:mm")} ${block.summary}`);

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
        eventLines.push(`${cursor.toFormat("HH:mm")}–${endOfDay.toFormat("HH:mm")} available`);
    }

    // ✨ Build the stats line
    const remainingTasks = totalTasks - completedTasks;
    const totalTimeStr = formatDuration(totalMinutes);
    const elapsedTimeStr = formatDuration(elapsedMinutes);
    const leftTimeStr = formatDuration(remainingMinutes);

    const statsLine = `🕐 Total: ${totalTasks} | ✅ Completed: ${completedTasks} | ⏳ Elapsed: ${elapsedTimeStr} | 🏃 Left: ${leftTimeStr} | 📅 Total time: ${totalTimeStr}`;

    return [statsLine, ...eventLines];
}


function replaceTimelineSection(note: string, newTimeline: string): string {
    const lines = note.split("\n");
    const startIndex = lines.findIndex((line) => line.trim() === "### Timeline");

    if (startIndex === -1) {
	return note + `\n\n${newTimeline}`;
    }

    const endIndex = lines.findIndex((line, i) => i > startIndex && line.startsWith("### "));

    const before = lines.slice(0, startIndex);
    const after = endIndex !== -1 ? lines.slice(endIndex) : [];
    return [...before, newTimeline, ...after].join("\n");
}

function updateTascalSection(
    content: string,
    timelineLines: string[],
    manualBlockLines: string[]
): string {
    const startTag = "<!--TASCAL-START-->";
    const endTag = "<!--TASCAL-END-->";
    const newSection =
        `${startTag}\n` +
        `### Timeline\n` +
        timelineLines.join("\n") +
        `\n\n<!--TASCAL-MANUAL-BLOCKS-SECTION\n` +
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

	    blocks.push({ summary, start, end, uid: `manual-${start.toMillis()}` });

	} else if ((match = line.match(startDurationRegex))) {
	    const [_, startStr, durationStr, summary, rescheduleDate] = match;
	    const start = DateTime.fromFormat(`${date.toISODate()} ${formatTime(startStr)}`, "yyyy-MM-dd HH:mm", { zone: timezone });
	    const durationMinutes = parseDuration(durationStr);
	    const end = start.plus({ minutes: durationMinutes });

	    if (isRescheduled && !rescheduleTime) {
		rescheduled.push({ target: rescheduleDate!, line });
		continue;
	    }

	    blocks.push({ summary, start, end, uid: `manual-${start.toMillis()}` });
	}
    }

    return { blocks, rescheduled };
}

function extractCheckboxStateMap(timelineLines: string[]): Map<string, boolean> {
    const checkboxMap = new Map<string, boolean>();
    const pattern = /^- \[( |x)] (\d{1,2}:\d{2})–(\d{1,2}:\d{2}) (.+)$/;

    for (const line of timelineLines) {
	const match = line.match(pattern);
	if (match) {
	    const checked = match[1] === "x";
	    const start = match[2];
	    const end = match[3];
	    const summary = match[4];
	    const key = `${start}-${summary}`;
	    checkboxMap.set(key, checked);
	}
    }

    return checkboxMap;
}

async function writeCalendarCache(date: DateTime, events: EventData[]) {
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

async function readCalendarCache(date: DateTime): Promise<EventData[] | null> {
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

async function appendRescheduledTask(globalPath: string, targetDate: string, originalDate: string, line: string) {
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

async function loadRescheduledLinesForDate(
    folder: string,
    targetDate: string
): Promise<string[]> {
    const filePath = `${folder}/rescheduled.md`;
    const adapter = app.vault.adapter;
    if (!(await adapter.exists(filePath))) return [];

    const text = await adapter.read(filePath);
    return text
        .split("\n")
        .filter(line => line.includes(`@${targetDate}`))
        .map(line => line.replace(/^@[^\s]+\s+from\s+[^\s]+:\s*/, "").trim());
}

async function loadRescheduledTasks(
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

function shouldInsertRecurring(line: string, targetDate: DateTime): boolean {
    const repeatRegex = /\[(w|m):([^\]]+)\]/;
    const addedRegex = /<!--\s*added:(\d{4}-\d{2}-\d{2})\s*-->/;

    const repeatMatch = line.match(repeatRegex);
    if (!repeatMatch) return false;

    const [_, type, rule] = repeatMatch;

    const alreadyAdded = line.includes(`<!-- added:${targetDate.toISODate()} -->`);
    if (alreadyAdded) return false;

    if (type === "w") {
        const dayMap: Record<string, number> = {
            Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7
        };
        const days = rule.split(",").map(d => dayMap[d.trim()]);
        return days.includes(targetDate.weekday);
    }

    if (type === "m") {
        const dayOffset = parseInt(rule);
        const lastDay = targetDate.endOf("month").day;
        const matchDay = dayOffset < 0 ? lastDay + 1 + dayOffset : dayOffset;
        return targetDate.day === matchDay;
    }

    return false;
}

async function loadRecurringTasks(recurringPath: string, date: DateTime): Promise<string[]> {
    const adapter = app.vault.adapter;
    const result: string[] = [];

    if (!(await adapter.exists(recurringPath))) return result;

    const lines = (await adapter.read(recurringPath)).split("\n");
    const updatedLines: string[] = [];

    for (let line of lines) {
        const repeatMatch = line.match(/\[(w|m):([^\]]+)\]/);
        const addedMatch = line.match(/<!-- added:(\d{4}-\d{2}-\d{2}) -->/g);
        const alreadyAdded = addedMatch?.some(m => m.includes(date.toISODate())) ?? false;

        if (!repeatMatch) {
            updatedLines.push(line);
            continue;
        }

        const [_, type, rule] = repeatMatch;

        if (alreadyAdded) {
            updatedLines.push(line);
            continue;
        }

        let shouldAdd = false;

        if (type === "w") {
            const days = rule.split(",").map(d => d.trim());
            if (days.includes(date.toFormat("ccc"))) shouldAdd = true;
        }

        if (type === "m") {
            const day = parseInt(rule);
            const lastDay = date.endOf("month").day;
            const targetDay = day > 0 ? day : lastDay + 1 + day;
            if (date.day === targetDay) shouldAdd = true;
        }

        if (shouldAdd) {
            // add to result
            const taskLine = line.replace(/\[[^\]]+\]/, "").replace(/\s*<!--.*$/, "").trim();
            // Add source indicator based on type
            const sourceIndicator = type === "w" ? "[rc:w]" : "[rc:m]";
            result.push(`${taskLine} ${sourceIndicator}`);

            // append marker to the line
            line += ` <!-- added:${date.toISODate()} -->`;
        }

        updatedLines.push(line);
    }

    // overwrite the recurring file with updated markers
    await adapter.write(recurringPath, updatedLines.join("\n"));

    return result;
}

class IcsSettingTab extends PluginSettingTab {
    plugin: IcsImporterPlugin;

    constructor(app: App, plugin: IcsImporterPlugin) {
	super(app, plugin);
	this.plugin = plugin;
    }

    display(): void {
	const { containerEl } = this;

	containerEl.empty();
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
    }
}

class TascalSettingTab extends PluginSettingTab {
    plugin: IcsImporterPlugin;

    constructor(app: App, plugin: IcsImporterPlugin) {
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
	
	new Setting(containerEl)
	    .setName("Rescheduled folder")
	    .setDesc("Path to store rescheduled tasks")
	    .addText(text =>
		text.setPlaceholder("tascal/rescheduled")
		    .setValue(this.plugin.settings.rescheduledFolder)
		    .onChange(async (value) => {
			this.plugin.settings.rescheduledFolder = value;
			await this.plugin.saveSettings();
		    }));

	new Setting(containerEl)
	    .setName("Recurring file path")
	    .setDesc("Path to the recurring tasks definition file")
	    .addText(text =>
		text.setPlaceholder("tascal/recurring")
		    .setValue(this.plugin.settings.recurringFilePath)
		    .onChange(async (value) => {
			this.plugin.settings.recurringFilePath = value;
			await this.plugin.saveSettings();
		    }));

    }
}



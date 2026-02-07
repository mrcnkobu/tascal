import { App } from "obsidian";
import { DateTime } from "luxon";
import { EventData, TimeTrackingData, TascalSettings } from "./types";
import { formatDuration, formatTime, parseDuration } from "./utils";
import { loadTimeTrackingData, extractTimeTrackingFromTimeline, migrateTimeTrackingData } from "./time-tracking";

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

function extractTimeTrackingDataMap(timelineLines: string[]): Map<string, string> {
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

function generateEventIdFromBlock(block: EventData): string {
    return block.uid;
}

export function generateSafeTimelineLines(
    calendarEvents: EventData[],
    manualBlocks: EventData[],
    date: DateTime,
    previousTimelineLines: string[],
    settings: TascalSettings,
    jsonTimeTrackingData?: TimeTrackingData
): string[] {
    const timeline: string[] = [];

    const checkboxMap = extractCheckboxStateMap(previousTimelineLines);
    const timeTrackingMap = extractTimeTrackingDataMap(previousTimelineLines);

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

	if (checked === "x") {
            elapsedMinutes += blockDurationMinutes;
	} else {
            remainingMinutes += blockDurationMinutes;
	}
    }

    if (cursor < endOfDay) {
        eventLines.push(`- *${cursor.toFormat("HH:mm")}–${endOfDay.toFormat("HH:mm")} (free)*`);
    }

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

export function updateTascalSection(
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

export function parseManualBlocksFromLines(
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

export async function loadRescheduledTasks(
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

export async function loadRecurringTasks(app: App, recurringEvents: string[], date: DateTime): Promise<string[]> {
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

export interface BuildTimelineResult {
    updatedNote: string;
    manualBlockLines: string[];
    calendarEvents: EventData[];
    finalManualBlocks: EventData[];
    rescheduled: { target: string; line: string }[];
    fileTimeTrackingData: TimeTrackingData;
    refreshedTimeTracking: TimeTrackingData;
}

export async function buildTimeline(
    app: App,
    note: string,
    dateStr: string,
    calendarEvents: EventData[],
    settings: TascalSettings
): Promise<BuildTimelineResult> {
    const localDate = DateTime.fromISO(dateStr, { zone: settings.timezone });
    const { timeline, manualBlockLines } = extractTascalSection(note);

    // Load time tracking data from daily JSON file
    const timeTrackingFilePath = `.tascal/tt-${dateStr}.json`;
    const fileTimeTrackingData = await loadTimeTrackingData(app, timeTrackingFilePath);

    const rescheduledLines = await loadRescheduledTasks(
	app,
	".tascal",
	dateStr,
	settings.timezone,
	localDate
    );
    manualBlockLines.push(...rescheduledLines);

    const recurringLines = await loadRecurringTasks(app, settings.recurringEvents, localDate);
    manualBlockLines.push(...recurringLines);

    const { blocks: finalManualBlocks, rescheduled } = parseManualBlocksFromLines(
	manualBlockLines,
	localDate,
	settings.timezone
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
    if (settings.currentTrackingEventId && settings.timeTrackingData[settings.currentTrackingEventId]) {
	refreshedTimeTracking[settings.currentTrackingEventId] = settings.timeTrackingData[settings.currentTrackingEventId];
    }
    Object.assign(refreshedTimeTracking, migratedTimeTrackingData);

    const timelineLines = generateSafeTimelineLines(
	calendarEvents, finalManualBlocks, localDate,
	timeline || [], settings, fileTimeTrackingData
    );
    const updatedNote = updateTascalSection(note, timelineLines, manualBlockLines);

    return {
	updatedNote,
	manualBlockLines,
	calendarEvents,
	finalManualBlocks,
	rescheduled,
	fileTimeTrackingData,
	refreshedTimeTracking,
    };
}

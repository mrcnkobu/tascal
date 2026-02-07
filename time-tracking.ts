import { App } from "obsidian";
import { EventData, TimeTrackingData } from "./types";

export async function saveTimeTrackingData(app: App, filePath: string, timeTrackingData: TimeTrackingData) {
    const adapter = app.vault.adapter;
    const folderPath = filePath.substring(0, filePath.lastIndexOf('/'));

    if (!(await adapter.exists(folderPath))) {
        await adapter.mkdir(folderPath);
    }

    await adapter.write(filePath, JSON.stringify(timeTrackingData, null, 2));
}

export async function loadTimeTrackingData(app: App, filePath: string): Promise<TimeTrackingData> {
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

export function extractTimeTrackingFromTimeline(timelineLines: string[]): TimeTrackingData {
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

export function migrateTimeTrackingData(
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

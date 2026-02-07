import { DateTime } from "luxon";

export interface EventData {
    summary: string;
    start: DateTime;
    end: DateTime;
    uid: string;
    done?: boolean;
    source?: string;
}

export interface TimeTrackingEntry {
    start: string; // "15:30"
    duration: string; // "00:34"
}

export interface TimeTrackingData {
    [eventId: string]: TimeTrackingEntry[];
}

export interface TascalSettings {
    timezone: string;
    calendars: { id: string; url: string }[];
    defaultDayStart: string; // e.g., "08:00"
    defaultDayEnd: string;   // e.g., "22:00"
    dayOverrides: Record<string, { start: string; end: string }>; // e.g., { "Saturday": { start: "10:00", end: "18:00" } }
    recurringEvents: string[]; // Array of recurring event definitions
    timeTrackingData: TimeTrackingData;
    currentTrackingEventId: string | null;
}

export const DEFAULT_SETTINGS: TascalSettings = {
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

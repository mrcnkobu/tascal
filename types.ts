import { DateTime } from "luxon";

// ===== Legacy types (still used by existing code) =====

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

// ===== New unified store types =====

export interface StoredEvent {
    id: string;              // crypto.randomUUID()
    summary: string;         // supports [[wiki-links]]
    start: string;           // "HH:MM"
    end: string;             // "HH:MM"
    source: "calendar" | "manual" | "recurring" | "rescheduled";
    sourceRef?: string;      // ICS UID, recurring rule ID, origin date
    done: boolean;
    timeTracking: TimeTrackingEntry[];
    linkedNotePath?: string;     // vault path to linked note
    linkedNoteMarkdown?: string; // Obsidian-generated markdown link (respects vault settings)
    templateId?: string;         // template used to create this event
}

export interface UnscheduledTask {
    id: string;
    summary: string;
    done: boolean;
    estimateMinutes?: number;
}

export interface DayStore {
    version: 1;
    events: StoredEvent[];
    unscheduledTasks?: UnscheduledTask[];
    suppressions?: string[]; // sourceRefs of events explicitly deleted/rescheduled
    lastCalendarSync?: string; // ISO datetime of last sync
}

export interface RecurringRule {
    id: string;
    summary: string;
    start: string;           // "HH:MM"
    duration: number;        // minutes
    recurrence: { type: "weekly"; days: string[] } | { type: "monthly"; day: number };
    exceptions?: string[];   // ISO dates to skip
}

export interface EventTemplate {
    id: string;
    shortcode: string;       // "gym"
    label: string;           // "Gym Session"
    namePattern: string;     // "{{date}} Gym"
    folder?: string;         // "notes/gym/{{date:yyyy-MM}}"
    noteTemplate?: string;   // vault path to template note
    defaultStart?: string;
    defaultDuration?: number;
    createNote?: boolean;
}

export interface TascalUiState {
    settingsSections: Record<string, boolean>;
}

// ===== Settings =====

export interface TascalSettings {
    timezone: string;
    timelineHeading: string;
    unscheduledHeading: string;
    calendars: { id: string; url: string }[];
    defaultDayStart: string; // e.g., "08:00"
    defaultDayEnd: string;   // e.g., "22:00"
    dayOverrides: Record<string, { start: string; end: string }>; // e.g., { "Saturday": { start: "10:00", end: "18:00" } }
    recurringEvents: string[]; // Array of recurring event definitions (legacy)
    timeTrackingData: TimeTrackingData;
    currentTrackingEventId: string | null;
    storeMigrationDone?: boolean;
    eventTemplates: EventTemplate[];
    recurringRules: RecurringRule[];
    pendingLinkedNotes?: Record<string, { templateId: string; dateStr: string; targetPath: string }>; // deprecated, kept for migration
    uiState: TascalUiState;
}

export const DEFAULT_SETTINGS: TascalSettings = {
    timezone: "Europe/Warsaw",
    timelineHeading: "Timeline",
    unscheduledHeading: "Unscheduled",
    calendars: [],
    defaultDayStart: "08:00",
    defaultDayEnd: "22:00",
    dayOverrides: {
	"Saturday": { start: "10:00", end: "18:00" },
	"Sunday": { start: "10:00", end: "20:00" }
    },
    recurringEvents: [],
    timeTrackingData: {},
    currentTrackingEventId: null,
    storeMigrationDone: false,
    eventTemplates: [],
    recurringRules: [],
    pendingLinkedNotes: undefined,
    uiState: {
	settingsSections: {
	    general: true,
	    calendars: true,
	    workingHours: true,
	    recurringRules: true,
	    templates: true,
	}
    }
};

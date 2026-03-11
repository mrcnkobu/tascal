import { App, TFile } from "obsidian";
import { DateTime } from "luxon";
import { EventTemplate, StoredEvent } from "./types";

export function expandVariables(pattern: string, dateStr: string, timezone: string): string {
    const date = DateTime.fromISO(dateStr, { zone: timezone });

    return pattern.replace(/\{\{([^}]+)\}\}/g, (_, expr: string) => {
	const trimmed = expr.trim();

	if (trimmed === "date") {
	    return dateStr;
	}

	if (trimmed === "weekday") {
	    return date.toFormat("EEEE");
	}

	// {{date:format}} — Luxon format string
	const formatMatch = trimmed.match(/^date:(.+)$/);
	if (formatMatch) {
	    return date.toFormat(formatMatch[1]);
	}

	return `{{${expr}}}`;
    });
}

export function expandFolderPath(folderPattern: string, dateStr: string, timezone: string): string {
    const expanded = expandVariables(folderPattern, dateStr, timezone);
    // Normalize: remove trailing slashes, collapse double slashes
    return expanded.replace(/\/+/g, "/").replace(/\/$/, "");
}

export function expandTemplate(
    template: EventTemplate,
    dateStr: string,
    timezone: string,
    overrides?: { summary?: string; start?: string; duration?: number }
): Omit<StoredEvent, "id"> {
    const summary = overrides?.summary
	? expandVariables(overrides.summary, dateStr, timezone)
	: expandVariables(template.label, dateStr, timezone);

    const start = overrides?.start || template.defaultStart || "09:00";
    const durationMinutes = overrides?.duration || template.defaultDuration || 60;
    const startDt = DateTime.fromFormat(start, "HH:mm");
    const end = startDt.plus({ minutes: durationMinutes }).toFormat("HH:mm");

    return {
	summary,
	start,
	end,
	source: "manual",
	done: false,
	timeTracking: [],
    };
}

/**
 * Compute the vault path for a linked note (does NOT create it).
 */
export function resolveLinkedNotePath(
    template: EventTemplate,
    dateStr: string,
    timezone: string
): string {
    const noteName = expandVariables(template.namePattern, dateStr, timezone);
    const folder = template.folder
	? expandFolderPath(template.folder, dateStr, timezone)
	: "";
    return folder ? `${folder}/${noteName}.md` : `${noteName}.md`;
}

/**
 * Create a linked note at the resolved path, populating it with template content.
 * Creates intermediate folders as needed. Returns the created TFile.
 */
export interface LinkedNoteResult {
    file: TFile;
    status: "created" | "existing";
}

export async function createLinkedNote(
    app: App,
    template: EventTemplate,
    dateStr: string,
    timezone: string
): Promise<LinkedNoteResult> {
    const notePath = resolveLinkedNotePath(template, dateStr, timezone);

    const existing = app.vault.getAbstractFileByPath(notePath);
    if (existing instanceof TFile) {
	return { file: existing, status: "existing" };
    }

    // Ensure folder exists
    const folderPath = notePath.substring(0, notePath.lastIndexOf("/"));
    if (folderPath && !app.vault.getAbstractFileByPath(folderPath)) {
	await app.vault.createFolder(folderPath);
    }

    // Build initial content from note template (if configured)
    let content = "";
    if (template.noteTemplate) {
	try {
	    const tmplFile = app.vault.getAbstractFileByPath(template.noteTemplate);
	    if (tmplFile) {
		const raw = await app.vault.adapter.read(template.noteTemplate);
		content = expandVariables(raw, dateStr, timezone);
	    }
	} catch (e) {
	    console.error(`Failed to read note template ${template.noteTemplate}:`, e);
	}
    }

    const file = await app.vault.create(notePath, content);
    return { file, status: "created" };
}

export function findTemplateByShortcode(templates: EventTemplate[], shortcode: string): EventTemplate | undefined {
    return templates.find(t => t.shortcode.toLowerCase() === shortcode.toLowerCase());
}

import { App, TFile } from "obsidian";
import { DateTime } from "luxon";
import { parseDuration } from "./utils";
import { SourceTaskCandidate } from "./types";

const INBOX_START = "<!-- tascal:inbox:start -->";
const INBOX_END = "<!-- tascal:inbox:end -->";

type SourceTaskStatus = SourceTaskCandidate["status"];

interface ParsedSourceTaskLine {
    lineIndex: number;
    summary: string;
    status: SourceTaskStatus;
    metadata: Record<string, string>;
}

interface ParsedSourceNote {
    projectId?: string;
    lines: string[];
    tasks: ParsedSourceTaskLine[];
}

export async function scanSourceTaskCandidates(
    app: App,
    directories: string[],
    todayDate: string
): Promise<SourceTaskCandidate[]> {
    const files = getSourceFiles(app, directories);
    const candidates: SourceTaskCandidate[] = [];

    for (const file of files) {
	const content = await app.vault.cachedRead(file);
	const parsed = parseSourceNote(content);
	if (!parsed.projectId) continue;

	for (const task of parsed.tasks) {
	    const availableFrom = task.metadata.av;
	    if (availableFrom && availableFrom > todayDate) {
		continue;
	    }

	    candidates.push({
		projectId: parsed.projectId,
		sourcePath: file.path,
		summary: task.summary,
		status: task.status,
		sourceTaskId: task.metadata.id,
		estimateMinutes: task.metadata.est ? parseDuration(task.metadata.est) : undefined,
		availableFrom,
		doneAt: task.metadata.doneAt,
		loadedAt: task.metadata.loadedAt,
		metadata: { ...task.metadata },
		lineNumber: task.lineIndex + 1,
	    });
	}
    }

    return candidates.sort((a, b) =>
	a.projectId.localeCompare(b.projectId) ||
	a.sourcePath.localeCompare(b.sourcePath) ||
	a.summary.localeCompare(b.summary)
    );
}

export async function markSourceTaskImported(
    app: App,
    directories: string[],
    candidate: SourceTaskCandidate,
    generatedSourceTaskId: string,
    loadedAt: string
): Promise<{ ok: boolean; sourcePath: string; sourceTaskId: string }> {
    const result = await updateSourceTaskByCandidate(
	app,
	directories,
	candidate,
	"imported",
	{
	    id: generatedSourceTaskId,
	    doneAt: undefined,
	    loadedAt,
	}
    );

    return {
	ok: result.ok,
	sourcePath: result.sourcePath,
	sourceTaskId: generatedSourceTaskId,
    };
}

export async function markSourceTaskDone(
    app: App,
    directories: string[],
    projectId: string,
    sourceTaskId: string,
    doneDate: string,
    preferredPath?: string
): Promise<boolean> {
    const result = await updateSourceTaskById(app, directories, projectId, sourceTaskId, "done", {
	doneAt: doneDate,
    }, preferredPath);
    return result.ok;
}

export async function markSourceTaskOpen(
    app: App,
    directories: string[],
    projectId: string,
    sourceTaskId: string,
    preferredPath?: string
): Promise<boolean> {
    const result = await updateSourceTaskById(app, directories, projectId, sourceTaskId, "imported", {
	doneAt: undefined,
    }, preferredPath);
    return result.ok;
}

export async function resetSourceTaskAvailable(
    app: App,
    directories: string[],
    projectId: string,
    sourceTaskId: string,
    preferredPath?: string
): Promise<boolean> {
    const result = await updateSourceTaskById(app, directories, projectId, sourceTaskId, "available", {
	doneAt: undefined,
	loadedAt: undefined,
    }, preferredPath);
    return result.ok;
}

export async function resolveProjectNotePath(
    app: App,
    directories: string[],
    projectId: string,
    preferredPath?: string
): Promise<string | null> {
    if (preferredPath) {
	const file = app.vault.getAbstractFileByPath(preferredPath);
	if (file instanceof TFile) {
	    const content = await app.vault.cachedRead(file);
	    if (parseSourceNote(content).projectId === projectId) {
		return file.path;
	    }
	}
    }

    for (const file of getSourceFiles(app, directories)) {
	const content = await app.vault.cachedRead(file);
	if (parseSourceNote(content).projectId === projectId) {
	    return file.path;
	}
    }

    return null;
}

function getSourceFiles(app: App, directories: string[]): TFile[] {
    const normalized = directories
	.map(dir => dir.trim().replace(/^\/+|\/+$/g, ""))
	.filter(Boolean);

    return app.vault.getMarkdownFiles().filter(file => {
	if (normalized.length === 0) return false;
	return normalized.some(dir => file.path === dir || file.path.startsWith(`${dir}/`));
    });
}

function parseSourceNote(content: string): ParsedSourceNote {
    const lines = content.split("\n");
    const projectId = parseProjectId(content);
    const startIndex = lines.findIndex(line => line.trim() === INBOX_START);
    const endIndex = lines.findIndex((line, index) => index > startIndex && line.trim() === INBOX_END);

    if (!projectId || startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
	return { projectId, lines, tasks: [] };
    }

    const tasks: ParsedSourceTaskLine[] = [];
    for (let index = startIndex + 1; index < endIndex; index++) {
	const task = parseSourceTaskLine(lines[index], index);
	if (task) {
	    tasks.push(task);
	}
    }

    return { projectId, lines, tasks };
}

function parseProjectId(content: string): string | undefined {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return undefined;
    const line = match[1].split("\n").find(entry => entry.trim().startsWith("tascal-project-id:"));
    if (!line) return undefined;
    const value = line.split(":").slice(1).join(":").trim();
    return value || undefined;
}

function parseSourceTaskLine(line: string, lineIndex: number): ParsedSourceTaskLine | null {
    const match = line.match(/^- \[( |-|x)\]\s+(.+)$/);
    if (!match) return null;

    const rawStatus = match[1];
    const status: SourceTaskStatus = rawStatus === "x"
	? "done"
	: rawStatus === "-"
	    ? "imported"
	    : "available";

    let body = match[2].trim();
    let metadata: Record<string, string> = {};

    const metadataMatch = body.match(/^(.*?)(?:\s+\{([^}]*)\})$/);
    if (metadataMatch) {
	body = metadataMatch[1].trim();
	metadata = parseMetadata(metadataMatch[2]);
    }

    if (!body) return null;

    return {
	lineIndex,
	summary: body,
	status,
	metadata,
    };
}

function parseMetadata(raw: string): Record<string, string> {
    const metadata: Record<string, string> = {};
    for (const part of raw.split(",")) {
	const trimmed = part.trim();
	if (!trimmed) continue;
	const match = trimmed.match(/^([A-Za-z][A-Za-z0-9_-]*)(?:\s*:\s*|\s+)(.+)$/);
	if (!match) continue;
	const key = normalizeMetadataKey(match[1].trim());
	const value = match[2].trim();
	if (!key || !value) continue;
	metadata[key] = value;
    }
    return metadata;
}

function normalizeMetadataKey(key: string): string {
    switch (key.trim().toLowerCase()) {
	case "estimate":
	    return "est";
	case "est":
	    return "est";
	case "available":
	    return "av";
	case "av":
	    return "av";
	case "id":
	    return "id";
	case "doneat":
	    return "doneAt";
	case "loadedat":
	    return "loadedAt";
	default:
	    return key.trim().toLowerCase();
    }
}

function formatMetadata(metadata: Record<string, string>): string {
    const entries = Object.entries(metadata)
	.filter(([, value]) => value && value.trim())
	.sort(([a], [b]) => metadataSortIndex(a) - metadataSortIndex(b) || a.localeCompare(b))
	.map(([key, value]) => `${key}: ${value}`);
    return entries.length > 0 ? ` {${entries.join(", ")}}` : "";
}

function metadataSortIndex(key: string): number {
    switch (key) {
	case "id":
	    return 0;
	case "av":
	    return 1;
	case "est":
	    return 2;
	case "doneAt":
	    return 3;
	case "loadedAt":
	    return 4;
	default:
	    return 10;
    }
}

async function updateSourceTaskByCandidate(
    app: App,
    directories: string[],
    candidate: SourceTaskCandidate,
    nextStatus: SourceTaskStatus,
    metadataUpdates: Record<string, string | undefined>
): Promise<{ ok: boolean; sourcePath: string }> {
    const file = app.vault.getAbstractFileByPath(candidate.sourcePath);
    if (!(file instanceof TFile)) {
	return { ok: false, sourcePath: candidate.sourcePath };
    }

    const content = await app.vault.cachedRead(file);
    const parsed = parseSourceNote(content);
    if (parsed.projectId !== candidate.projectId) {
	return { ok: false, sourcePath: candidate.sourcePath };
    }

    const target = parsed.tasks.find(task => task.lineIndex + 1 === candidate.lineNumber);
    if (!target) {
	return { ok: false, sourcePath: candidate.sourcePath };
    }

    const nextMetadata: Record<string, string> = {};
    for (const [key, value] of Object.entries({
	...target.metadata,
	...metadataUpdates,
    })) {
	if (value !== undefined) {
	    nextMetadata[key] = value;
	}
    }

    const line = renderSourceTaskLine(target.summary, nextStatus, nextMetadata);

    parsed.lines[target.lineIndex] = line;
    await app.vault.modify(file, parsed.lines.join("\n"));
    return { ok: true, sourcePath: file.path };
}

async function updateSourceTaskById(
    app: App,
    directories: string[],
    projectId: string,
    sourceTaskId: string,
    nextStatus: SourceTaskStatus,
    metadataUpdates: Record<string, string | undefined>,
    preferredPath?: string
): Promise<{ ok: boolean; sourcePath: string }> {
    const sourcePath = await resolveProjectNotePath(app, directories, projectId, preferredPath);
    if (!sourcePath) {
	return { ok: false, sourcePath: preferredPath || "" };
    }

    const file = app.vault.getAbstractFileByPath(sourcePath);
    if (!(file instanceof TFile)) {
	return { ok: false, sourcePath };
    }

    const content = await app.vault.cachedRead(file);
    const parsed = parseSourceNote(content);
    const target = parsed.tasks.find(task => task.metadata.id === sourceTaskId);
    if (!target) {
	return { ok: false, sourcePath };
    }

    const nextMetadata: Record<string, string> = { ...target.metadata };
    for (const [key, value] of Object.entries(metadataUpdates)) {
	if (value === undefined) {
	    delete nextMetadata[key];
	} else {
	    nextMetadata[key] = value;
	}
    }

    parsed.lines[target.lineIndex] = renderSourceTaskLine(target.summary, nextStatus, nextMetadata);
    await app.vault.modify(file, parsed.lines.join("\n"));
    return { ok: true, sourcePath };
}

function renderSourceTaskLine(
    summary: string,
    status: SourceTaskStatus,
    metadata: Record<string, string>
): string {
    const checkbox = status === "done" ? "x" : status === "imported" ? "-" : " ";
    return `- [${checkbox}] ${summary}${formatMetadata(metadata)}`;
}

export function currentDateString(timezone: string): string {
    return DateTime.now().setZone(timezone).toISODate()!;
}

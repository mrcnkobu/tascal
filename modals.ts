import { App, Modal, Notice, Setting } from "obsidian";
import { DateTime } from "luxon";
import { StoredEvent, DayStore, EventTemplate } from "./types";
import { formatTime, parseDuration } from "./utils";
import { expandTemplate, findTemplateByShortcode } from "./templates";

// ===== Event Selection Modal (for tracking, editing, deleting, rescheduling) =====

export class EventSelectionModal extends Modal {
    private events: StoredEvent[];
    private onSelect: (event: StoredEvent) => void;
    private title: string;
    private actionLabel: string;

    constructor(
	app: App,
	events: StoredEvent[],
	onSelect: (event: StoredEvent) => void,
	title = "Select Event",
	actionLabel = "Select"
    ) {
	super(app);
	this.events = events;
	this.onSelect = onSelect;
	this.title = title;
	this.actionLabel = actionLabel;
    }

    onOpen() {
	const { contentEl } = this;
	contentEl.empty();

	contentEl.createEl("h2", { text: this.title });

	const container = contentEl.createEl("div", { cls: "event-selection-container" });

	const sorted = [...this.events].sort((a, b) => a.start.localeCompare(b.start));

	if (sorted.length === 0) {
	    container.createEl("p", {
		text: "No events found.",
		cls: "no-events-message"
	    });
	} else {
	    sorted.forEach(event => {
		const eventDiv = container.createEl("div", { cls: "event-option" });

		const timeDiv = eventDiv.createEl("div", { cls: "event-time" });
		timeDiv.setText(`${event.start}–${event.end}`);

		const summaryDiv = eventDiv.createEl("div", { cls: "event-summary" });
		summaryDiv.setText(event.summary);

		const statusDiv = eventDiv.createEl("div", { cls: "event-status" });
		if (event.done) {
		    statusDiv.createEl("span", {
			text: "done",
			cls: "status-completed",
		    });
		}

		const selectBtn = eventDiv.createEl("button", {
		    text: this.actionLabel,
		    cls: "track-button"
		});
		selectBtn.addEventListener("click", () => {
		    this.onSelect(event);
		    this.close();
		});
	    });
	}

	const cancelBtn = contentEl.createEl("button", {
	    text: "Cancel",
	    cls: "cancel-button"
	});
	cancelBtn.addEventListener("click", () => this.close());
    }

    onClose() {
	this.contentEl.empty();
    }
}

// ===== Add Event Modal =====

export interface AddEventResult {
    summary: string;
    start: string; // "HH:MM"
    end: string;   // "HH:MM"
    templateId?: string;
    createNote?: boolean;
}

export class AddEventModal extends Modal {
    private onSubmit: (result: AddEventResult) => void;
    private timezone: string;
    private dateStr: string;
    private templates: EventTemplate[];

    constructor(
	app: App,
	timezone: string,
	dateStr: string,
	templates: EventTemplate[],
	onSubmit: (result: AddEventResult) => void
    ) {
	super(app);
	this.timezone = timezone;
	this.dateStr = dateStr;
	this.templates = templates;
	this.onSubmit = onSubmit;
    }

    onOpen() {
	const { contentEl } = this;
	contentEl.empty();
	contentEl.addClass("tascal-modal");

	contentEl.createEl("h2", { text: "Add Event" });

	// Quick-add input
	const quickAddContainer = contentEl.createEl("div", { cls: "tascal-quick-add" });
	quickAddContainer.createEl("label", { text: "Quick add:", cls: "tascal-label" });
	const quickInput = quickAddContainer.createEl("input", {
	    type: "text",
	    cls: "tascal-input",
	    attr: { placeholder: "@09:00 (1h) Meeting" }
	});
	quickInput.addEventListener("keydown", (e) => {
	    if (e.key === "Enter") {
		const result = this.parseQuickAdd(quickInput.value);
		if (result) {
		    this.onSubmit(result);
		    this.close();
		} else {
		    new Notice("Could not parse. Use: @HH:MM (duration) Summary");
		}
	    }
	});

	contentEl.createEl("hr", { cls: "tascal-divider" });

	// Manual form
	let summary = "";
	let startVal = "";
	let endVal = "";
	let durationVal = "";
	let selectedTemplate: EventTemplate | null = null;
	let createNote = false;

	// Template dropdown (only if templates exist)
	if (this.templates.length > 0) {
	    new Setting(contentEl)
		.setName("Template")
		.addDropdown(dd => {
		    dd.addOption("", "-- None --");
		    for (const t of this.templates) {
			dd.addOption(t.id, t.label || t.shortcode);
		    }
		    dd.onChange(v => {
			selectedTemplate = this.templates.find(t => t.id === v) || null;
			if (selectedTemplate) {
			    // Pre-fill fields from template
			    const expanded = expandTemplate(selectedTemplate, this.dateStr, this.timezone);
			    summary = expanded.summary;
			    startVal = expanded.start;
			    endVal = expanded.end;
			    createNote = selectedTemplate.createNote || false;
			    // Re-render form would be complex; user can override in fields
			}
		    });
		});
	}

	const summaryField = new Setting(contentEl)
	    .setName("Summary")
	    .addText(text => text
		.setPlaceholder("Event name")
		.onChange(v => { summary = v; }));

	new Setting(contentEl)
	    .setName("Start")
	    .addText(text => text
		.setPlaceholder("09:00")
		.onChange(v => { startVal = v; }));

	new Setting(contentEl)
	    .setName("End (or duration)")
	    .setDesc("End time like 10:00 or duration like 1h30m")
	    .addText(text => text
		.setPlaceholder("10:00 or 1h30m")
		.onChange(v => {
		    if (v.match(/^\d{1,2}:\d{2}$/)) {
			endVal = v;
			durationVal = "";
		    } else {
			durationVal = v;
			endVal = "";
		    }
		}));

	// Submit button
	const btnContainer = contentEl.createEl("div", { cls: "tascal-btn-row" });
	const submitBtn = btnContainer.createEl("button", {
	    text: "Add Event",
	    cls: "mod-cta"
	});
	submitBtn.addEventListener("click", () => {
	    // Try quick-add input first
	    const quickVal = quickInput.value.trim();
	    if (quickVal) {
		const result = this.parseQuickAdd(quickVal);
		if (result) {
		    this.onSubmit(result);
		    this.close();
		    return;
		}
		new Notice("Could not parse quick add. Use: @HH:MM (duration) Summary");
		return;
	    }

	    // Fall back to form fields
	    if (!summary.trim()) {
		new Notice("Summary is required.");
		return;
	    }
	    if (!startVal.trim()) {
		new Notice("Start time is required.");
		return;
	    }

	    const formattedStart = formatTime(startVal);
	    let formattedEnd: string;

	    if (endVal) {
		formattedEnd = formatTime(endVal);
	    } else if (durationVal) {
		const minutes = parseDuration(durationVal);
		if (minutes <= 0) {
		    new Notice("Invalid duration.");
		    return;
		}
		const startDt = DateTime.fromFormat(formattedStart, "HH:mm");
		formattedEnd = startDt.plus({ minutes }).toFormat("HH:mm");
	    } else {
		new Notice("End time or duration is required.");
		return;
	    }

	    this.onSubmit({
		summary: summary.trim(),
		start: formattedStart,
		end: formattedEnd,
		templateId: selectedTemplate?.id,
		createNote,
	    });
	    this.close();
	});

	const cancelBtn = btnContainer.createEl("button", {
	    text: "Cancel",
	    cls: "cancel-button"
	});
	cancelBtn.addEventListener("click", () => this.close());

	// Focus quick-add on open
	setTimeout(() => quickInput.focus(), 50);
    }

    private parseQuickAdd(text: string): AddEventResult | null {
	text = text.trim();

	// Check for template shortcode first (single word)
	if (!text.includes("@") && !text.includes("(") && this.templates.length > 0) {
	    const tmpl = findTemplateByShortcode(this.templates, text);
	    if (tmpl) {
		const expanded = expandTemplate(tmpl, this.dateStr, this.timezone);
		return {
		    summary: expanded.summary,
		    start: expanded.start,
		    end: expanded.end,
		    templateId: tmpl.id,
		    createNote: tmpl.createNote,
		};
	    }
	}

	// "@09:00 (1h30m) Meeting" format
	const durMatch = text.match(/^@?(\d{1,2}(?::\d{2})?)\s*\(([\dhm]+)\)\s+(.+)$/);
	if (durMatch) {
	    const start = formatTime(durMatch[1]);
	    const minutes = parseDuration(durMatch[2]);
	    const startDt = DateTime.fromFormat(start, "HH:mm");
	    return {
		summary: durMatch[3].trim(),
		start,
		end: startDt.plus({ minutes }).toFormat("HH:mm"),
	    };
	}

	// "@09:00-10:00 Meeting" format
	const rangeMatch = text.match(/^@?(\d{1,2}(?::\d{2})?)\s*[-–—]\s*(\d{1,2}(?::\d{2})?)\s+(.+)$/);
	if (rangeMatch) {
	    return {
		summary: rangeMatch[3].trim(),
		start: formatTime(rangeMatch[1]),
		end: formatTime(rangeMatch[2]),
	    };
	}

	return null;
    }

    onClose() {
	this.contentEl.empty();
    }
}

// ===== Edit Event Modal =====

export class EditEventModal extends Modal {
    private event: StoredEvent;
    private onSave: (updates: Partial<Pick<StoredEvent, "summary" | "start" | "end" | "done">>) => void;
    private onDelete: () => void;

    constructor(
	app: App,
	event: StoredEvent,
	onSave: (updates: Partial<Pick<StoredEvent, "summary" | "start" | "end" | "done">>) => void,
	onDelete: () => void
    ) {
	super(app);
	this.event = event;
	this.onSave = onSave;
	this.onDelete = onDelete;
    }

    onOpen() {
	const { contentEl } = this;
	contentEl.empty();
	contentEl.addClass("tascal-modal");

	contentEl.createEl("h2", { text: "Edit Event" });

	let summary = this.event.summary;
	let startVal = this.event.start;
	let endVal = this.event.end;
	let done = this.event.done;

	new Setting(contentEl)
	    .setName("Summary")
	    .addText(text => text
		.setValue(summary)
		.onChange(v => { summary = v; }));

	new Setting(contentEl)
	    .setName("Start")
	    .addText(text => text
		.setValue(startVal)
		.onChange(v => { startVal = v; }));

	new Setting(contentEl)
	    .setName("End")
	    .addText(text => text
		.setValue(endVal)
		.onChange(v => { endVal = v; }));

	new Setting(contentEl)
	    .setName("Completed")
	    .addToggle(toggle => toggle
		.setValue(done)
		.onChange(v => { done = v; }));

	// Source info (read-only)
	contentEl.createEl("p", {
	    text: `Source: ${this.event.source}${this.event.sourceRef ? ` (${this.event.sourceRef})` : ""}`,
	    cls: "tascal-source-info"
	});

	const btnContainer = contentEl.createEl("div", { cls: "tascal-btn-row" });

	const saveBtn = btnContainer.createEl("button", {
	    text: "Save",
	    cls: "mod-cta"
	});
	saveBtn.addEventListener("click", () => {
	    this.onSave({
		summary: summary.trim(),
		start: formatTime(startVal),
		end: formatTime(endVal),
		done,
	    });
	    this.close();
	});

	const cancelBtn = btnContainer.createEl("button", {
	    text: "Cancel",
	    cls: "cancel-button"
	});
	cancelBtn.addEventListener("click", () => this.close());

	// Delete button
	const deleteBtn = contentEl.createEl("button", {
	    text: "Delete Event",
	    cls: "tascal-delete-btn"
	});
	deleteBtn.addEventListener("click", () => {
	    this.onDelete();
	    this.close();
	});
    }

    onClose() {
	this.contentEl.empty();
    }
}

// ===== Reschedule Modal =====

export class RescheduleModal extends Modal {
    private event: StoredEvent;
    private timezone: string;
    private onReschedule: (targetDate: string, newStart?: string) => void;

    constructor(
	app: App,
	event: StoredEvent,
	timezone: string,
	onReschedule: (targetDate: string, newStart?: string) => void
    ) {
	super(app);
	this.event = event;
	this.timezone = timezone;
	this.onReschedule = onReschedule;
    }

    onOpen() {
	const { contentEl } = this;
	contentEl.empty();
	contentEl.addClass("tascal-modal");

	contentEl.createEl("h2", { text: "Reschedule Event" });
	contentEl.createEl("p", {
	    text: `Moving: ${this.event.start}–${this.event.end} ${this.event.summary}`,
	    cls: "modal-description"
	});

	let targetDate = DateTime.now().setZone(this.timezone).plus({ days: 1 }).toISODate()!;
	let newStart = "";

	new Setting(contentEl)
	    .setName("Target date")
	    .addText(text => text
		.setPlaceholder("YYYY-MM-DD")
		.setValue(targetDate)
		.onChange(v => { targetDate = v; }));

	new Setting(contentEl)
	    .setName("New start time (optional)")
	    .setDesc("Leave empty to keep the same time")
	    .addText(text => text
		.setPlaceholder(this.event.start)
		.onChange(v => { newStart = v; }));

	const btnContainer = contentEl.createEl("div", { cls: "tascal-btn-row" });

	const submitBtn = btnContainer.createEl("button", {
	    text: "Reschedule",
	    cls: "mod-cta"
	});
	submitBtn.addEventListener("click", () => {
	    if (!targetDate.match(/^\d{4}-\d{2}-\d{2}$/)) {
		new Notice("Invalid date format. Use YYYY-MM-DD.");
		return;
	    }
	    this.onReschedule(targetDate, newStart || undefined);
	    this.close();
	});

	const cancelBtn = btnContainer.createEl("button", {
	    text: "Cancel",
	    cls: "cancel-button"
	});
	cancelBtn.addEventListener("click", () => this.close());
    }

    onClose() {
	this.contentEl.empty();
    }
}

// ===== Rescheduled Events Modal =====

export interface RescheduledEventEntry {
    event: StoredEvent;
    targetDate: string; // the date this event is scheduled on
}

export class RescheduledEventsModal extends Modal {
    private entries: RescheduledEventEntry[];
    private onReschedule: (entry: RescheduledEventEntry) => void;
    private onDelete: (entry: RescheduledEventEntry) => void;

    constructor(
	app: App,
	entries: RescheduledEventEntry[],
	onReschedule: (entry: RescheduledEventEntry) => void,
	onDelete: (entry: RescheduledEventEntry) => void
    ) {
	super(app);
	this.entries = entries;
	this.onReschedule = onReschedule;
	this.onDelete = onDelete;
    }

    onOpen() {
	const { contentEl } = this;
	contentEl.empty();

	contentEl.createEl("h2", { text: "Rescheduled Events" });

	const container = contentEl.createEl("div", { cls: "event-selection-container" });

	if (this.entries.length === 0) {
	    container.createEl("p", {
		text: "No pending rescheduled events.",
		cls: "no-events-message"
	    });
	} else {
	    // Sort by target date, then start time
	    const sorted = [...this.entries].sort((a, b) =>
		a.targetDate.localeCompare(b.targetDate) || a.event.start.localeCompare(b.event.start)
	    );

	    for (const entry of sorted) {
		const eventDiv = container.createEl("div", { cls: "event-option" });

		const dateDiv = eventDiv.createEl("div", { cls: "event-date" });
		dateDiv.setText(entry.targetDate);

		const timeDiv = eventDiv.createEl("div", { cls: "event-time" });
		timeDiv.setText(`${entry.event.start}–${entry.event.end}`);

		const summaryDiv = eventDiv.createEl("div", { cls: "event-summary" });
		const originLabel = entry.event.sourceRef ? ` (from ${entry.event.sourceRef})` : "";
		summaryDiv.setText(`${entry.event.summary}${originLabel}`);

		const btnGroup = eventDiv.createEl("div", { cls: "event-actions" });

		const rescheduleBtn = btnGroup.createEl("button", {
		    text: "Reschedule",
		    cls: "track-button"
		});
		rescheduleBtn.addEventListener("click", () => {
		    this.onReschedule(entry);
		    this.close();
		});

		const deleteBtn = btnGroup.createEl("button", {
		    text: "Delete",
		    cls: "tascal-delete-btn"
		});
		deleteBtn.addEventListener("click", () => {
		    this.onDelete(entry);
		    this.close();
		});
	    }
	}

	const cancelBtn = contentEl.createEl("button", {
	    text: "Close",
	    cls: "cancel-button"
	});
	cancelBtn.addEventListener("click", () => this.close());
    }

    onClose() {
	this.contentEl.empty();
    }
}

// ===== Quick Add Modal =====

export class QuickAddModal extends Modal {
    private onSubmit: (result: AddEventResult) => void;
    private templates: EventTemplate[];
    private dateStr: string;
    private timezone: string;

    constructor(
	app: App,
	dateStr: string,
	timezone: string,
	templates: EventTemplate[],
	onSubmit: (result: AddEventResult) => void
    ) {
	super(app);
	this.dateStr = dateStr;
	this.timezone = timezone;
	this.templates = templates;
	this.onSubmit = onSubmit;
    }

    onOpen() {
	const { contentEl } = this;
	contentEl.empty();
	contentEl.addClass("tascal-modal");

	contentEl.createEl("h2", { text: "Quick Add Event" });

	const shortcodes = this.templates
	    .filter(t => t.shortcode)
	    .map(t => t.shortcode)
	    .join(", ");
	const placeholder = shortcodes
	    ? `@09:00 (1h) Meeting  or  shortcode (${shortcodes})`
	    : "@09:00 (1h) Meeting  or  @09:00-10:00 Meeting";

	const input = contentEl.createEl("input", {
	    type: "text",
	    cls: "tascal-input tascal-quick-add-full",
	    attr: { placeholder }
	});

	input.addEventListener("keydown", (e) => {
	    if (e.key === "Enter") {
		const result = this.parseQuickAdd(input.value);
		if (result) {
		    this.onSubmit(result);
		    this.close();
		} else {
		    new Notice("Could not parse. Use: @HH:MM (duration) Summary");
		}
	    }
	    if (e.key === "Escape") {
		this.close();
	    }
	});

	setTimeout(() => input.focus(), 50);
    }

    private parseQuickAdd(text: string): AddEventResult | null {
	text = text.trim();

	// Check for template shortcode first
	if (!text.includes("@") && !text.includes("(") && this.templates.length > 0) {
	    const tmpl = findTemplateByShortcode(this.templates, text);
	    if (tmpl) {
		const expanded = expandTemplate(tmpl, this.dateStr, this.timezone);
		return {
		    summary: expanded.summary,
		    start: expanded.start,
		    end: expanded.end,
		    templateId: tmpl.id,
		    createNote: tmpl.createNote,
		};
	    }
	}

	const durMatch = text.match(/^@?(\d{1,2}(?::\d{2})?)\s*\(([\dhm]+)\)\s+(.+)$/);
	if (durMatch) {
	    const start = formatTime(durMatch[1]);
	    const minutes = parseDuration(durMatch[2]);
	    const startDt = DateTime.fromFormat(start, "HH:mm");
	    return {
		summary: durMatch[3].trim(),
		start,
		end: startDt.plus({ minutes }).toFormat("HH:mm"),
	    };
	}

	const rangeMatch = text.match(/^@?(\d{1,2}(?::\d{2})?)\s*[-–—]\s*(\d{1,2}(?::\d{2})?)\s+(.+)$/);
	if (rangeMatch) {
	    return {
		summary: rangeMatch[3].trim(),
		start: formatTime(rangeMatch[1]),
		end: formatTime(rangeMatch[2]),
	    };
	}

	return null;
    }

    onClose() {
	this.contentEl.empty();
    }
}

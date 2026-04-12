import { App, Plugin, PluginSettingTab, Setting } from "obsidian";
import { DateTime } from "luxon";
import { TascalSettings, EventTemplate, RecurringRule } from "./types";
import { getLatestCalendarSync } from "./store";
import {
    buildTemplatePreview,
    summarizeRule,
    validateCalendarId,
    validateCalendarUrl,
    validateDurationMinutes,
    validateExceptionDates,
    validateMonthlyDay,
    validateTemplatePath,
    validateTemplateShortcode,
    validateTime,
    validateTimeRange,
    validateTimezone,
    validateWeeklyDays,
    ValidationMessage,
} from "./validation";

export interface TascalPluginInterface extends Plugin {
    settings: TascalSettings;
    saveSettings(): Promise<void>;
}

const WEEK_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
const WEEKDAY_ABBRS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

type SectionKey = "general" | "sources" | "calendars" | "workingHours" | "recurringRules" | "templates";

export class TascalSettingTab extends PluginSettingTab {
    plugin: TascalPluginInterface;
    private saveTimer: number | null = null;
    private latestCalendarSync: string | null = null;

    constructor(app: App, plugin: TascalPluginInterface) {
	super(app, plugin);
	this.plugin = plugin;
    }

    hide(): void {
	if (this.saveTimer !== null) {
	    window.clearTimeout(this.saveTimer);
	    this.saveTimer = null;
	    void this.plugin.saveSettings();
	}
    }

    display(): void {
	const { containerEl } = this;
	containerEl.empty();
	containerEl.addClass("tascal-settings-root");

	containerEl.createEl("h2", { text: "Tascal Settings" });

	this.renderSection(
	    containerEl,
	    "general",
	    "General",
	    this.buildGeneralSummary(),
	    "Core timezone and plugin status.",
	    (body) => this.renderGeneral(body)
	);

	this.renderSection(
	    containerEl,
	    "sources",
	    "Project Sources",
	    this.buildSourcesSummary(),
	    "Vault-relative directories Tascal scans for project inbox notes.",
	    (body) => this.renderSources(body)
	);

	this.renderSection(
	    containerEl,
	    "calendars",
	    "Calendars",
	    this.buildCalendarsSummary(),
	    "ICS feeds used by the Sync calendar command.",
	    (body) => this.renderCalendars(body)
	);

	this.renderSection(
	    containerEl,
	    "workingHours",
	    "Working Hours",
	    this.buildWorkingHoursSummary(),
	    "Default day bounds and per-day overrides.",
	    (body) => this.renderWorkingHours(body)
	);

	this.renderSection(
	    containerEl,
	    "recurringRules",
	    "Recurring Rules",
	    this.buildRecurringRulesSummary(),
	    "Structured recurring events that Tascal can inject into your timeline.",
	    (body) => this.renderRecurringRules(body)
	);

	this.renderSection(
	    containerEl,
	    "templates",
	    "Templates",
	    this.buildTemplatesSummary(),
	    "Quick-add templates and linked-note defaults.",
	    (body) => this.renderTemplates(body)
	);

	void this.refreshLastCalendarSync();
    }

    private scheduleSave() {
	if (this.saveTimer !== null) {
	    window.clearTimeout(this.saveTimer);
	}
	this.saveTimer = window.setTimeout(async () => {
	    this.saveTimer = null;
	    await this.plugin.saveSettings();
	}, 400);
    }

    private ensureSectionState(section: SectionKey): boolean {
	const sections = this.plugin.settings.uiState.settingsSections;
	if (sections[section] === undefined) {
	    sections[section] = true;
	}
	return sections[section];
    }

    private renderSection(
	containerEl: HTMLElement,
	section: SectionKey,
	title: string,
	summary: string,
	description: string,
	renderBody: (body: HTMLElement) => void
    ) {
	const card = containerEl.createDiv({ cls: "tascal-settings-section" });
	const open = this.ensureSectionState(section);

	const header = card.createDiv({
	    cls: `tascal-settings-section-header${open ? " is-open" : ""}`
	});
	const headingGroup = header.createDiv({ cls: "tascal-settings-section-heading" });
	headingGroup.createEl("span", { text: title, cls: "tascal-settings-section-title" });
	headingGroup.createEl("span", { text: summary, cls: "tascal-settings-section-summary" });
	header.createEl("span", {
	    text: open ? "−" : "+",
	    cls: "tascal-settings-section-toggle"
	});

	const descriptionEl = card.createEl("p", {
	    text: description,
	    cls: "tascal-settings-section-description"
	});

	if (open) {
	    const body = card.createDiv({ cls: "tascal-settings-section-body" });
	    renderBody(body);
	}

	header.addEventListener("click", () => {
	    const next = !this.plugin.settings.uiState.settingsSections[section];
	    this.plugin.settings.uiState.settingsSections[section] = next;
	    this.scheduleSave();
	    this.display();
	});

	descriptionEl.toggleClass("is-collapsed", !open);
    }

    private renderGeneral(containerEl: HTMLElement) {
	const timezoneSetting = new Setting(containerEl)
	    .setName("Timezone")
	    .setDesc("Used for calendar sync, recurring rules, and time tracking.");

	const timezoneStatus = this.createStatusHost(timezoneSetting);
	timezoneSetting.addText((text) => {
	    text
		.setPlaceholder("Europe/Warsaw")
		.setValue(this.plugin.settings.timezone)
		.onChange((value) => {
		    const validation = validateTimezone(value);
		    this.renderMessages(timezoneStatus, validation.messages);
		    if (validation.ok && validation.normalized) {
			this.plugin.settings.timezone = validation.normalized;
			this.scheduleSave();
		    }
		});

	    this.renderMessages(timezoneStatus, validateTimezone(this.plugin.settings.timezone).messages);
	});

	const headingSetting = new Setting(containerEl)
	    .setName("Timeline heading")
	    .setDesc("Tascal renders generated output under the first matching heading in the daily note.");
	const headingStatus = this.createStatusHost(headingSetting);
	headingSetting.addText((text) => {
	    text
		.setPlaceholder("Timeline")
		.setValue(this.plugin.settings.timelineHeading)
		.onChange((value) => {
		    const normalized = value.trim();
		    if (!normalized) {
			this.renderMessages(headingStatus, [{ level: "error", text: "Heading name cannot be empty." }]);
			return;
		    }
		    this.plugin.settings.timelineHeading = normalized;
		    this.renderMessages(headingStatus, [{ level: "info", text: `Tascal will manage the "${normalized}" heading.` }]);
		    this.scheduleSave();
		});

	    this.renderMessages(headingStatus, [{ level: "info", text: `Tascal will manage the "${this.plugin.settings.timelineHeading}" heading.` }]);
	});

	const unscheduledHeadingSetting = new Setting(containerEl)
	    .setName("Unscheduled heading")
	    .setDesc("Used for the secondary section that lists date-scoped tasks without a start time.");
	const unscheduledHeadingStatus = this.createStatusHost(unscheduledHeadingSetting);
	unscheduledHeadingSetting.addText((text) => {
	    text
		.setPlaceholder("Unscheduled")
		.setValue(this.plugin.settings.unscheduledHeading)
		.onChange((value) => {
		    const normalized = value.trim();
		    if (!normalized) {
			this.renderMessages(unscheduledHeadingStatus, [{ level: "error", text: "Heading name cannot be empty." }]);
			return;
		    }
		    this.plugin.settings.unscheduledHeading = normalized;
		    this.renderMessages(unscheduledHeadingStatus, [{ level: "info", text: `Tascal will manage the "${normalized}" heading.` }]);
		    this.scheduleSave();
		});

	    this.renderMessages(unscheduledHeadingStatus, [{ level: "info", text: `Tascal will manage the "${this.plugin.settings.unscheduledHeading}" heading.` }]);
	});

	const status = containerEl.createDiv({ cls: "tascal-status-grid" });
	const tzValid = validateTimezone(this.plugin.settings.timezone).ok;
	this.renderStatusChip(status, tzValid ? "Timezone OK" : "Timezone needs attention", tzValid ? "info" : "warning");

	const lastSync = this.latestCalendarSync;
	this.renderStatusChip(status, lastSync ? `Last sync ${lastSync}` : "No calendar sync recorded yet", lastSync ? "info" : "warning");
    }

    private renderSources(containerEl: HTMLElement) {
	const dirs = this.plugin.settings.sourceDirectories || [];
	const setting = new Setting(containerEl)
	    .setName("Source directories")
	    .setDesc("One vault-relative directory per line. Tascal scans these locations for notes with tascal-project-id frontmatter.");
	const status = this.createStatusHost(setting);

	setting.addTextArea((text) => {
	    text
		.setPlaceholder("Projects\nWork/Projects")
		.setValue(dirs.join("\n"))
		.onChange((value) => {
		    const normalized = value
			.split("\n")
			.map(line => line.trim().replace(/^\/+|\/+$/g, ""))
			.filter(Boolean);

		    this.plugin.settings.sourceDirectories = normalized;
		    const duplicates = this.collectDuplicates(normalized);
		    const messages: ValidationMessage[] = [];
		    if (normalized.length === 0) {
			messages.push({ level: "warning", text: "No source directories configured. Project task import will be unavailable." });
		    } else {
			messages.push({ level: "info", text: `${normalized.length} director${normalized.length === 1 ? "y" : "ies"} configured.` });
		    }
		    if (duplicates.size > 0) {
			messages.push({ level: "warning", text: "Duplicate directory entries will be ignored during scanning." });
		    }
		    this.renderMessages(status, messages);
		    this.scheduleSave();
		});

	    text.inputEl.rows = Math.max(4, dirs.length || 4);
	});

	const initialMessages: ValidationMessage[] = dirs.length === 0
	    ? [{ level: "warning", text: "No source directories configured. Project task import will be unavailable." }]
	    : [{ level: "info", text: `${dirs.length} director${dirs.length === 1 ? "y" : "ies"} configured.` }];
	this.renderMessages(status, initialMessages);
    }

    private renderCalendars(containerEl: HTMLElement) {
	if (this.plugin.settings.calendars.length === 0) {
	    containerEl.createEl("p", {
		text: "No calendars configured yet. Add an ICS feed to start syncing events.",
		cls: "tascal-empty-state"
	    });
	}

	const duplicateIds = this.collectDuplicates(this.plugin.settings.calendars.map(cal => cal.id));

	this.plugin.settings.calendars.forEach((cal, index) => {
	    const card = containerEl.createDiv({ cls: "tascal-template-card tascal-settings-card" });
	    card.createEl("h4", {
		text: cal.id.trim() || `Calendar ${index + 1}`,
		cls: "tascal-template-title"
	    });

	    const idSetting = new Setting(card).setName("Label").setDesc("Shown as the calendar prefix in timeline entries.");
	    const idStatus = this.createStatusHost(idSetting);
	    idSetting.addText((text) => {
		text.setPlaceholder("work").setValue(cal.id).onChange((value) => {
		    const validation = validateCalendarId(value, duplicateIds);
		    this.renderMessages(idStatus, validation.messages);
		    this.plugin.settings.calendars[index].id = validation.normalized ?? value.trim();
		    this.scheduleSave();
		});
		this.renderMessages(idStatus, validateCalendarId(cal.id, duplicateIds).messages);
	    });

	    const urlSetting = new Setting(card).setName("ICS URL").setDesc("Vault-safe web URL for the remote calendar feed.");
	    const urlStatus = this.createStatusHost(urlSetting);
	    urlSetting.addText((text) => {
		text.setPlaceholder("https://...").setValue(cal.url).onChange((value) => {
		    const validation = validateCalendarUrl(value);
		    this.renderMessages(urlStatus, validation.messages);
		    if (validation.ok && validation.normalized) {
			this.plugin.settings.calendars[index].url = validation.normalized;
			this.scheduleSave();
		    }
		});
		this.renderMessages(urlStatus, validateCalendarUrl(cal.url).messages);
	    });

	    new Setting(card)
		.addExtraButton((btn) =>
		    btn
			.setIcon("trash")
			.setTooltip("Remove calendar")
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
    }

    private renderWorkingHours(containerEl: HTMLElement) {
	const defaultStatusHost = containerEl.createDiv();

	const startSetting = new Setting(containerEl)
	    .setName("Default Day Start")
	    .setDesc("Used when a day has no specific override.");
	startSetting.addText((text) => {
	    text.setPlaceholder("08:00").setValue(this.plugin.settings.defaultDayStart).onChange((value) => {
		const validation = validateTimeRange(value, this.plugin.settings.defaultDayEnd);
		this.renderMessages(defaultStatusHost, validation.messages);
		if (validation.ok && validation.normalized) {
		    this.plugin.settings.defaultDayStart = validation.normalized.start;
		    this.scheduleSave();
		}
	    });
	});

	const endSetting = new Setting(containerEl).setName("Default Day End");
	endSetting.addText((text) => {
	    text.setPlaceholder("22:00").setValue(this.plugin.settings.defaultDayEnd).onChange((value) => {
		const validation = validateTimeRange(this.plugin.settings.defaultDayStart, value);
		this.renderMessages(defaultStatusHost, validation.messages);
		if (validation.ok && validation.normalized) {
		    this.plugin.settings.defaultDayEnd = validation.normalized.end;
		    this.scheduleSave();
		}
	    });
	});
	this.renderMessages(defaultStatusHost, validateTimeRange(this.plugin.settings.defaultDayStart, this.plugin.settings.defaultDayEnd).messages);
	defaultStatusHost.addClass("tascal-setting-status");

	containerEl.createEl("h4", { text: "Per-day overrides", cls: "tascal-subheading" });
	for (const day of WEEK_DAYS) {
	    const override = this.plugin.settings.dayOverrides[day] || { start: "", end: "" };
	    const setting = new Setting(containerEl).setName(day);
	    const status = this.createStatusHost(setting);

	    setting.addText((text) => {
		text.setPlaceholder("Start").setValue(override.start).onChange((value) => {
		    const candidateStart = value.trim();
		    const candidateEnd = this.plugin.settings.dayOverrides[day]?.end || "";
		    const validation = this.validateOptionalRange(candidateStart, candidateEnd);
		    this.renderMessages(status, validation.messages);
		    if (validation.ok) {
			this.plugin.settings.dayOverrides[day] = {
			    start: candidateStart,
			    end: candidateEnd,
			};
			this.scheduleSave();
		    }
		});
	    });

	    setting.addText((text) => {
		text.setPlaceholder("End").setValue(override.end).onChange((value) => {
		    const candidateStart = this.plugin.settings.dayOverrides[day]?.start || "";
		    const candidateEnd = value.trim();
		    const validation = this.validateOptionalRange(candidateStart, candidateEnd);
		    this.renderMessages(status, validation.messages);
		    if (validation.ok) {
			this.plugin.settings.dayOverrides[day] = {
			    start: candidateStart,
			    end: candidateEnd,
			};
			this.scheduleSave();
		    }
		});
	    });

	    this.renderMessages(status, this.validateOptionalRange(override.start, override.end).messages);
	}
    }

    private renderRecurringRules(containerEl: HTMLElement) {
	const rules = this.plugin.settings.recurringRules || [];
	if (rules.length === 0) {
	    containerEl.createEl("p", {
		text: "No recurring rules yet. Add one to generate recurring events without editing note markup.",
		cls: "tascal-empty-state"
	    });
	}

	rules.forEach((rule, index) => {
	    const card = containerEl.createDiv({ cls: "tascal-template-card tascal-settings-card" });
	    card.createEl("h4", {
		text: rule.summary || `Rule ${index + 1}`,
		cls: "tascal-template-title"
	    });

	    const preview = card.createEl("p", {
		text: summarizeRule(rule),
		cls: "tascal-preview-text"
	    });

	    const summarySetting = new Setting(card).setName("Summary");
	    const summaryStatus = this.createStatusHost(summarySetting);
	    summarySetting.addText((text) => {
		text.setPlaceholder("Daily standup").setValue(rule.summary).onChange((value) => {
		    const normalized = value.trim();
		    this.renderMessages(summaryStatus, normalized ? [{ level: "info", text: "Rule summary looks fine." }] : [{ level: "warning", text: "Summary is empty." }]);
		    this.plugin.settings.recurringRules[index].summary = normalized;
		    preview.setText(summarizeRule(this.plugin.settings.recurringRules[index]));
		    this.scheduleSave();
		});
		this.renderMessages(summaryStatus, rule.summary.trim() ? [{ level: "info", text: "Rule summary looks fine." }] : [{ level: "warning", text: "Summary is empty." }]);
	    });

	    const startSetting = new Setting(card).setName("Start");
	    const startStatus = this.createStatusHost(startSetting);
	    startSetting.addText((text) => {
		text.setPlaceholder("09:00").setValue(rule.start).onChange((value) => {
		    const validation = validateTime(value);
		    this.renderMessages(startStatus, validation.messages);
		    if (validation.ok && validation.normalized) {
			this.plugin.settings.recurringRules[index].start = validation.normalized;
			preview.setText(summarizeRule(this.plugin.settings.recurringRules[index]));
			this.scheduleSave();
		    }
		});
		this.renderMessages(startStatus, validateTime(rule.start).messages);
	    });

	    const durationSetting = new Setting(card).setName("Duration (minutes)");
	    const durationStatus = this.createStatusHost(durationSetting);
	    durationSetting.addText((text) => {
		text.setPlaceholder("60").setValue(String(rule.duration || "")).onChange((value) => {
		    const validation = validateDurationMinutes(value);
		    this.renderMessages(durationStatus, validation.messages);
		    if (validation.ok && validation.normalized !== undefined) {
			this.plugin.settings.recurringRules[index].duration = validation.normalized;
			preview.setText(summarizeRule(this.plugin.settings.recurringRules[index]));
			this.scheduleSave();
		    }
		});
		this.renderMessages(durationStatus, validateDurationMinutes(rule.duration).messages);
	    });

	    new Setting(card)
		.setName("Recurrence type")
		.addDropdown((dd) => {
		    dd.addOption("weekly", "Weekly");
		    dd.addOption("monthly", "Monthly");
		    dd.setValue(rule.recurrence.type);
		    dd.onChange(async (value) => {
			this.plugin.settings.recurringRules[index].recurrence = value === "weekly"
			    ? { type: "weekly", days: [] }
			    : { type: "monthly", day: 1 };
			await this.plugin.saveSettings();
			this.display();
		    });
		});

	    if (rule.recurrence.type === "weekly") {
		const daysWrap = card.createDiv({ cls: "tascal-days-checkboxes" });
		daysWrap.createEl("label", { text: "Days", cls: "tascal-label" });
		const daysRow = daysWrap.createDiv({ cls: "tascal-days-row" });
		const daysStatus = daysWrap.createDiv({ cls: "tascal-setting-status" });

		for (const day of WEEKDAY_ABBRS) {
		    const label = daysRow.createEl("label", { cls: "tascal-day-checkbox" });
		    const checkbox = label.createEl("input", { type: "checkbox" });
		    checkbox.checked = rule.recurrence.days.includes(day);
		    label.appendText(day);
		    checkbox.addEventListener("change", () => {
			const rec = this.plugin.settings.recurringRules[index].recurrence;
			if (rec.type !== "weekly") return;
			rec.days = checkbox.checked
			    ? [...rec.days, day].filter((value, pos, arr) => arr.indexOf(value) === pos)
			    : rec.days.filter(d => d !== day);
			const validation = validateWeeklyDays(rec.days);
			this.renderMessages(daysStatus, validation.messages);
			if (validation.ok) {
			    preview.setText(summarizeRule(this.plugin.settings.recurringRules[index]));
			    this.scheduleSave();
			}
		    });
		}
		this.renderMessages(daysStatus, validateWeeklyDays(rule.recurrence.days).messages);
	    } else {
		const monthlySetting = new Setting(card)
		    .setName("Day of month")
		    .setDesc("Negative values count backward from the end of the month.");
		const monthlyStatus = this.createStatusHost(monthlySetting);
		monthlySetting.addText((text) => {
		    text.setPlaceholder("15").setValue(String(rule.recurrence.day)).onChange((value) => {
			const validation = validateMonthlyDay(value);
			this.renderMessages(monthlyStatus, validation.messages);
			if (validation.ok && validation.normalized !== undefined) {
			    const rec = this.plugin.settings.recurringRules[index].recurrence;
			    if (rec.type === "monthly") {
				rec.day = validation.normalized;
				preview.setText(summarizeRule(this.plugin.settings.recurringRules[index]));
				this.scheduleSave();
			    }
			}
		    });
		    this.renderMessages(monthlyStatus, validateMonthlyDay(rule.recurrence.day).messages);
		});
	    }

	    const exceptionsSetting = new Setting(card)
		.setName("Exceptions")
		.setDesc("One ISO date per line.");
	    const exceptionsStatus = this.createStatusHost(exceptionsSetting);
	    exceptionsSetting.addTextArea((text) => {
		text.setPlaceholder("2026-01-01\n2026-12-25").setValue((rule.exceptions || []).join("\n")).onChange((value) => {
		    const validation = validateExceptionDates(value);
		    this.renderMessages(exceptionsStatus, validation.messages);
		    if (validation.ok) {
			this.plugin.settings.recurringRules[index].exceptions = validation.normalized;
			this.scheduleSave();
		    }
		});
		this.renderMessages(exceptionsStatus, validateExceptionDates((rule.exceptions || []).join("\n")).messages);
	    });

	    new Setting(card)
		.addButton((btn) =>
		    btn
			.setButtonText("Remove Rule")
			.setWarning()
			.onClick(async () => {
			    this.plugin.settings.recurringRules.splice(index, 1);
			    await this.plugin.saveSettings();
			    this.display();
			})
		);
	});

	new Setting(containerEl)
	    .addButton((btn) =>
		btn
		    .setButtonText("+ Add Recurring Rule")
		    .setCta()
		    .onClick(async () => {
			this.plugin.settings.recurringRules.push({
			    id: crypto.randomUUID(),
			    summary: "",
			    start: "09:00",
			    duration: 60,
			    recurrence: { type: "weekly", days: [] },
			});
			await this.plugin.saveSettings();
			this.display();
		    })
	    );
    }

    private renderTemplates(containerEl: HTMLElement) {
	const templates = this.plugin.settings.eventTemplates || [];
	if (templates.length === 0) {
	    containerEl.createEl("p", {
		text: "No templates yet. Add one to speed up event creation and optional note linking.",
		cls: "tascal-empty-state"
	    });
	}

	const duplicateShortcodes = this.collectDuplicates(templates.map(template => template.shortcode));

	templates.forEach((template, index) => {
	    const card = containerEl.createDiv({ cls: "tascal-template-card tascal-settings-card" });
	    card.createEl("h4", {
		text: template.label || `Template ${index + 1}`,
		cls: "tascal-template-title"
	    });

	    let namePatternDraft = template.namePattern;
	    let folderDraft = template.folder;

	    const buildCandidateTemplate = (): EventTemplate => ({
		...this.plugin.settings.eventTemplates[index],
		namePattern: namePatternDraft,
		folder: folderDraft,
	    });

	    const previewEl = card.createDiv({ cls: "tascal-preview-box" });
	    const refreshPreview = () => {
		previewEl.empty();
		const previewTemplate = buildCandidateTemplate();
		const preview = buildTemplatePreview(previewTemplate, DateTime.now().toISODate()!, this.plugin.settings.timezone);
		previewEl.createEl("div", { text: `${preview.start}-${preview.end} ${preview.summary}`, cls: "tascal-preview-line" });
		previewEl.createEl("div", { text: preview.path, cls: "tascal-preview-line tascal-preview-line-muted" });
	    };
	    refreshPreview();

	    const shortcodeSetting = new Setting(card).setName("Shortcode").setDesc("Quick-add token such as gym.");
	    const shortcodeStatus = this.createStatusHost(shortcodeSetting);
	    shortcodeSetting.addText((text) => {
		text.setPlaceholder("gym").setValue(template.shortcode).onChange((value) => {
		    const validation = validateTemplateShortcode(value, duplicateShortcodes);
		    this.renderMessages(shortcodeStatus, validation.messages);
		    this.plugin.settings.eventTemplates[index].shortcode = validation.normalized ?? value.trim();
		    this.scheduleSave();
		});
		this.renderMessages(shortcodeStatus, validateTemplateShortcode(template.shortcode, duplicateShortcodes).messages);
	    });

	    const labelSetting = new Setting(card).setName("Label").setDesc("Used for the created event title by default.");
	    const labelStatus = this.createStatusHost(labelSetting);
	    labelSetting.addText((text) => {
		text.setPlaceholder("Gym Session").setValue(template.label).onChange((value) => {
		    this.plugin.settings.eventTemplates[index].label = value;
		    this.renderMessages(labelStatus, value.trim() ? [{ level: "info", text: "Label looks fine." }] : [{ level: "warning", text: "Label is empty." }]);
		    refreshPreview();
		    this.scheduleSave();
		});
		this.renderMessages(labelStatus, template.label.trim() ? [{ level: "info", text: "Label looks fine." }] : [{ level: "warning", text: "Label is empty." }]);
	    });

	    const namePatternSetting = new Setting(card).setName("Note name pattern").setDesc("Supports {{date}}, {{date:yyyy-MM}}, and {{weekday}}.");
	    const pathStatus = this.createStatusHost(namePatternSetting);
	    namePatternSetting.addText((text) => {
		text.setPlaceholder("{{date}} Gym").setValue(template.namePattern).onChange((value) => {
		    namePatternDraft = value;
		    const valid = this.renderTemplatePathStatus(buildCandidateTemplate(), pathStatus);
		    if (valid) {
			this.plugin.settings.eventTemplates[index].namePattern = value;
			this.scheduleSave();
		    }
		    refreshPreview();
		});
		this.renderTemplatePathStatus(buildCandidateTemplate(), pathStatus);
	    });

	    const folderSetting = new Setting(card).setName("Folder").setDesc("Optional vault-relative folder path.");
	    folderSetting.addText((text) => {
		text.setPlaceholder("notes/gym/{{date:yyyy-MM}}").setValue(template.folder || "").onChange((value) => {
		    folderDraft = value || undefined;
		    const valid = this.renderTemplatePathStatus(buildCandidateTemplate(), pathStatus);
		    if (valid) {
			this.plugin.settings.eventTemplates[index].folder = value || undefined;
			this.scheduleSave();
		    }
		    refreshPreview();
		});
	    });

	    const noteTemplateSetting = new Setting(card).setName("Note template").setDesc("Optional vault file used as initial note content.");
	    const noteTemplateStatus = this.createStatusHost(noteTemplateSetting);
	    noteTemplateSetting.addText((text) => {
		text.setPlaceholder("templates/gym.md").setValue(template.noteTemplate || "").onChange((value) => {
		    this.plugin.settings.eventTemplates[index].noteTemplate = value || undefined;
		    const messages = value.trim()
			? [{ level: "info", text: `Template source: ${value.trim()}` } as ValidationMessage]
			: [{ level: "info", text: "No template note configured." } as ValidationMessage];
		    this.renderMessages(noteTemplateStatus, messages);
		    this.scheduleSave();
		});
		this.renderMessages(noteTemplateStatus, template.noteTemplate ? [{ level: "info", text: `Template source: ${template.noteTemplate}` }] : [{ level: "info", text: "No template note configured." }]);
	    });

	    const startSetting = new Setting(card).setName("Default start");
	    const startStatus = this.createStatusHost(startSetting);
	    startSetting.addText((text) => {
		text.setPlaceholder("09:00").setValue(template.defaultStart || "").onChange((value) => {
		    const validation = validateTime(value, false);
		    this.renderMessages(startStatus, validation.messages.length > 0 ? validation.messages : [{ level: "info", text: "Falls back to 09:00 when empty." }]);
		    if (validation.ok) {
			this.plugin.settings.eventTemplates[index].defaultStart = validation.normalized;
			refreshPreview();
			this.scheduleSave();
		    }
		});
		const initial = validateTime(template.defaultStart || "", false);
		this.renderMessages(startStatus, initial.messages.length > 0 ? initial.messages : [{ level: "info", text: "Falls back to 09:00 when empty." }]);
	    });

	    const durationSetting = new Setting(card).setName("Default duration (minutes)");
	    const durationStatus = this.createStatusHost(durationSetting);
	    durationSetting.addText((text) => {
		text.setPlaceholder("60").setValue(template.defaultDuration ? String(template.defaultDuration) : "").onChange((value) => {
		    if (!value.trim()) {
			this.plugin.settings.eventTemplates[index].defaultDuration = undefined;
			this.renderMessages(durationStatus, [{ level: "info", text: "Falls back to 60 minutes when empty." }]);
			refreshPreview();
			this.scheduleSave();
			return;
		    }
		    const validation = validateDurationMinutes(value);
		    this.renderMessages(durationStatus, validation.messages);
		    if (validation.ok && validation.normalized !== undefined) {
			this.plugin.settings.eventTemplates[index].defaultDuration = validation.normalized;
			refreshPreview();
			this.scheduleSave();
		    }
		});
		this.renderMessages(durationStatus, template.defaultDuration ? validateDurationMinutes(template.defaultDuration).messages : [{ level: "info", text: "Falls back to 60 minutes when empty." }]);
	    });

	    new Setting(card)
		.setName("Create linked note")
		.setDesc("Enabled templates can create a linked note during event creation.")
		.addToggle((toggle) => {
		    toggle.setValue(template.createNote || false).onChange((value) => {
			this.plugin.settings.eventTemplates[index].createNote = value;
			this.scheduleSave();
		    });
		});

	    new Setting(card)
		.addButton((btn) =>
		    btn
			.setButtonText("Remove Template")
			.setWarning()
			.onClick(async () => {
			    this.plugin.settings.eventTemplates.splice(index, 1);
			    await this.plugin.saveSettings();
			    this.display();
			})
		);
	});

	new Setting(containerEl)
	    .addButton((btn) =>
		btn
		    .setButtonText("+ Add Template")
		    .setCta()
		    .onClick(async () => {
			this.plugin.settings.eventTemplates.push({
			    id: crypto.randomUUID(),
			    shortcode: "",
			    label: "",
			    namePattern: "{{date}}",
			    createNote: false,
			});
			await this.plugin.saveSettings();
			this.display();
		    })
	    );
    }

    private renderTemplatePathStatus(template: EventTemplate, host: HTMLElement): boolean {
	const validation = validateTemplatePath(template, DateTime.now().toISODate()!, this.plugin.settings.timezone);
	this.renderMessages(host, validation.messages);
	return validation.ok;
    }

    private collectDuplicates(values: string[]): Set<string> {
	const counts = new Map<string, number>();
	for (const value of values.map(v => v.trim().toLowerCase()).filter(Boolean)) {
	    counts.set(value, (counts.get(value) || 0) + 1);
	}
	return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([value]) => value));
    }

    private buildGeneralSummary(): string {
	const tz = validateTimezone(this.plugin.settings.timezone);
	return tz.ok ? this.plugin.settings.timezone : "Timezone needs attention";
    }

    private buildCalendarsSummary(): string {
	const total = this.plugin.settings.calendars.length;
	const valid = this.plugin.settings.calendars.filter(cal => validateCalendarUrl(cal.url).ok).length;
	if (total === 0) return "No calendars";
	return `${total} calendar${total === 1 ? "" : "s"}, ${valid} valid`;
    }

    private buildWorkingHoursSummary(): string {
	const overrides = Object.values(this.plugin.settings.dayOverrides).filter(override => override.start || override.end).length;
	return `${this.plugin.settings.defaultDayStart}-${this.plugin.settings.defaultDayEnd}, ${overrides} override${overrides === 1 ? "" : "s"}`;
    }

    private buildSourcesSummary(): string {
	const total = this.plugin.settings.sourceDirectories.length;
	if (total === 0) return "No directories";
	return `${total} director${total === 1 ? "y" : "ies"}`;
    }

    private buildRecurringRulesSummary(): string {
	const total = this.plugin.settings.recurringRules.length;
	const invalid = this.plugin.settings.recurringRules.filter(rule =>
	    !validateTime(rule.start).ok ||
	    !validateDurationMinutes(rule.duration).ok ||
	    (rule.recurrence.type === "weekly" ? !validateWeeklyDays(rule.recurrence.days).ok : !validateMonthlyDay(rule.recurrence.day).ok)
	).length;
	if (total === 0) return "No recurring rules";
	return invalid > 0 ? `${total} rules, ${invalid} invalid` : `${total} rules`;
    }

    private buildTemplatesSummary(): string {
	const total = this.plugin.settings.eventTemplates.length;
	const duplicates = this.collectDuplicates(this.plugin.settings.eventTemplates.map(template => template.shortcode)).size;
	if (total === 0) return "No templates";
	return duplicates > 0 ? `${total} templates, duplicate shortcodes` : `${total} templates`;
    }

    private async refreshLastCalendarSync() {
	const latest = await getLatestCalendarSync(this.app);
	const formatted = latest
	    ? DateTime.fromISO(latest, { zone: this.plugin.settings.timezone }).toFormat("yyyy-MM-dd HH:mm")
	    : null;

	if (formatted !== this.latestCalendarSync) {
	    this.latestCalendarSync = formatted;
	    this.display();
	}
    }

    private validateOptionalRange(start: string, end: string): { ok: boolean; messages: ValidationMessage[] } {
	if (!start.trim() && !end.trim()) {
	    return { ok: true, messages: [{ level: "info", text: "Uses default working hours." }] };
	}
	if (!start.trim() || !end.trim()) {
	    return { ok: false, messages: [{ level: "error", text: "Provide both start and end or leave both empty." }] };
	}
	const validation = validateTimeRange(start, end);
	return { ok: validation.ok, messages: validation.messages };
    }

    private createStatusHost(setting: Setting): HTMLElement {
	return setting.settingEl.createDiv({ cls: "tascal-setting-status" });
    }

    private renderMessages(host: HTMLElement, messages: ValidationMessage[]) {
	host.empty();
	if (messages.length === 0) return;
	for (const message of messages) {
	    host.createEl("div", {
		text: message.text,
		cls: `tascal-validation tascal-validation-${message.level}`
	    });
	}
    }

    private renderStatusChip(host: HTMLElement, text: string, level: "info" | "warning") {
	host.createEl("span", {
	    text,
	    cls: `tascal-status-chip tascal-status-chip-${level}`
	});
    }
}

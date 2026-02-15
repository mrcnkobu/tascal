import { App, Plugin, PluginSettingTab, Setting } from "obsidian";
import { TascalSettings, EventTemplate, RecurringRule } from "./types";

export interface TascalPluginInterface extends Plugin {
    settings: TascalSettings;
    saveSettings(): Promise<void>;
}

export class TascalSettingTab extends PluginSettingTab {
    plugin: TascalPluginInterface;

    constructor(app: App, plugin: TascalPluginInterface) {
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

	// ===== Recurring Rules =====
	containerEl.createEl("h3", { text: "Recurring Events" });

	const rules = this.plugin.settings.recurringRules || [];

	rules.forEach((rule, index) => {
	    const ruleContainer = containerEl.createEl("div", { cls: "tascal-template-card" });

	    ruleContainer.createEl("h4", {
		text: rule.summary || `Rule ${index + 1}`,
		cls: "tascal-template-title"
	    });

	    new Setting(ruleContainer)
		.setName("Summary")
		.addText(text => text
		    .setPlaceholder("Daily standup")
		    .setValue(rule.summary)
		    .onChange(async (v) => {
			this.plugin.settings.recurringRules[index].summary = v;
			await this.plugin.saveSettings();
		    }));

	    new Setting(ruleContainer)
		.setName("Start time")
		.addText(text => text
		    .setPlaceholder("09:00")
		    .setValue(rule.start)
		    .onChange(async (v) => {
			this.plugin.settings.recurringRules[index].start = v;
			await this.plugin.saveSettings();
		    }));

	    new Setting(ruleContainer)
		.setName("Duration (minutes)")
		.addText(text => text
		    .setPlaceholder("60")
		    .setValue(String(rule.duration || ""))
		    .onChange(async (v) => {
			this.plugin.settings.recurringRules[index].duration = parseInt(v) || 0;
			await this.plugin.saveSettings();
		    }));

	    new Setting(ruleContainer)
		.setName("Recurrence type")
		.addDropdown(dd => {
		    dd.addOption("weekly", "Weekly");
		    dd.addOption("monthly", "Monthly");
		    dd.setValue(rule.recurrence.type);
		    dd.onChange(async (v) => {
			if (v === "weekly") {
			    this.plugin.settings.recurringRules[index].recurrence = { type: "weekly", days: [] };
			} else {
			    this.plugin.settings.recurringRules[index].recurrence = { type: "monthly", day: 1 };
			}
			await this.plugin.saveSettings();
			this.display();
		    });
		});

	    if (rule.recurrence.type === "weekly") {
		const daysContainer = ruleContainer.createEl("div", { cls: "tascal-days-checkboxes" });
		daysContainer.createEl("label", { text: "Days:", cls: "tascal-label" });
		const daysRow = daysContainer.createEl("div", { cls: "tascal-days-row" });

		for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) {
		    const label = daysRow.createEl("label", { cls: "tascal-day-checkbox" });
		    const checkbox = label.createEl("input", { type: "checkbox" });
		    checkbox.checked = rule.recurrence.days.includes(day);
		    label.appendText(day);
		    checkbox.addEventListener("change", async () => {
			const rec = this.plugin.settings.recurringRules[index].recurrence;
			if (rec.type === "weekly") {
			    if (checkbox.checked) {
				rec.days.push(day);
			    } else {
				rec.days = rec.days.filter(d => d !== day);
			    }
			}
			await this.plugin.saveSettings();
		    });
		}
	    } else {
		new Setting(ruleContainer)
		    .setName("Day of month")
		    .setDesc("Use negative values for end-of-month (e.g. -1 = last day)")
		    .addText(text => text
			.setPlaceholder("15")
			.setValue(String(rule.recurrence.day))
			.onChange(async (v) => {
			    const rec = this.plugin.settings.recurringRules[index].recurrence;
			    if (rec.type === "monthly") {
				rec.day = parseInt(v) || 1;
			    }
			    await this.plugin.saveSettings();
			}));
	    }

	    new Setting(ruleContainer)
		.setName("Exceptions")
		.setDesc("ISO dates to skip (one per line)")
		.addTextArea(text => text
		    .setPlaceholder("2026-01-01\n2026-12-25")
		    .setValue((rule.exceptions || []).join("\n"))
		    .onChange(async (v) => {
			this.plugin.settings.recurringRules[index].exceptions =
			    v.split("\n").map(d => d.trim()).filter(d => d);
			await this.plugin.saveSettings();
		    }));

	    new Setting(ruleContainer)
		.addButton(btn => btn
		    .setButtonText("Remove Rule")
		    .setWarning()
		    .onClick(async () => {
			this.plugin.settings.recurringRules.splice(index, 1);
			await this.plugin.saveSettings();
			this.display();
		    }));
	});

	new Setting(containerEl)
	    .addButton(btn => btn
		.setButtonText("+ Add Recurring Rule")
		.setCta()
		.onClick(async () => {
		    if (!this.plugin.settings.recurringRules) {
			this.plugin.settings.recurringRules = [];
		    }
		    this.plugin.settings.recurringRules.push({
			id: crypto.randomUUID(),
			summary: "",
			start: "09:00",
			duration: 60,
			recurrence: { type: "weekly", days: [] },
		    });
		    await this.plugin.saveSettings();
		    this.display();
		}));

	// Legacy recurring events (read-only, for reference)
	if (this.plugin.settings.recurringEvents.length > 0) {
	    containerEl.createEl("h4", { text: "Legacy Recurring Events (migrated)" });
	    containerEl.createEl("p", {
		text: "These have been migrated to structured rules above. They are kept for backward compatibility.",
		cls: "setting-item-description"
	    });
	    for (const ev of this.plugin.settings.recurringEvents) {
		containerEl.createEl("code", { text: ev, cls: "tascal-legacy-rule" });
	    }
	}

	// ===== Event Templates =====
	containerEl.createEl("h3", { text: "Event Templates" });

	containerEl.createEl("p", {
	    text: "Define templates for frequently created events. Use {{date}}, {{date:yyyy-MM}}, {{weekday}} in patterns.",
	    cls: "setting-item-description"
	});

	const templates = this.plugin.settings.eventTemplates || [];

	templates.forEach((tmpl, index) => {
	    const tmplContainer = containerEl.createEl("div", { cls: "tascal-template-card" });

	    tmplContainer.createEl("h4", {
		text: tmpl.label || `Template ${index + 1}`,
		cls: "tascal-template-title"
	    });

	    new Setting(tmplContainer)
		.setName("Shortcode")
		.setDesc("Quick-add trigger (e.g. \"gym\")")
		.addText(text => text
		    .setPlaceholder("gym")
		    .setValue(tmpl.shortcode)
		    .onChange(async (v) => {
			this.plugin.settings.eventTemplates[index].shortcode = v;
			await this.plugin.saveSettings();
		    }));

	    new Setting(tmplContainer)
		.setName("Label")
		.setDesc("Display name")
		.addText(text => text
		    .setPlaceholder("Gym Session")
		    .setValue(tmpl.label)
		    .onChange(async (v) => {
			this.plugin.settings.eventTemplates[index].label = v;
			await this.plugin.saveSettings();
		    }));

	    new Setting(tmplContainer)
		.setName("Note name pattern")
		.setDesc("{{date}}, {{date:yyyy-MM}}, {{weekday}} supported")
		.addText(text => text
		    .setPlaceholder("{{date}} Gym")
		    .setValue(tmpl.namePattern)
		    .onChange(async (v) => {
			this.plugin.settings.eventTemplates[index].namePattern = v;
			await this.plugin.saveSettings();
		    }));

	    new Setting(tmplContainer)
		.setName("Folder")
		.setDesc("Vault path with {{date:...}} support")
		.addText(text => text
		    .setPlaceholder("notes/gym/{{date:yyyy-MM}}")
		    .setValue(tmpl.folder || "")
		    .onChange(async (v) => {
			this.plugin.settings.eventTemplates[index].folder = v || undefined;
			await this.plugin.saveSettings();
		    }));

	    new Setting(tmplContainer)
		.setName("Note template")
		.setDesc("Vault path to a template file")
		.addText(text => text
		    .setPlaceholder("templates/gym.md")
		    .setValue(tmpl.noteTemplate || "")
		    .onChange(async (v) => {
			this.plugin.settings.eventTemplates[index].noteTemplate = v || undefined;
			await this.plugin.saveSettings();
		    }));

	    new Setting(tmplContainer)
		.setName("Default start")
		.addText(text => text
		    .setPlaceholder("09:00")
		    .setValue(tmpl.defaultStart || "")
		    .onChange(async (v) => {
			this.plugin.settings.eventTemplates[index].defaultStart = v || undefined;
			await this.plugin.saveSettings();
		    }));

	    new Setting(tmplContainer)
		.setName("Default duration (minutes)")
		.addText(text => text
		    .setPlaceholder("60")
		    .setValue(tmpl.defaultDuration ? String(tmpl.defaultDuration) : "")
		    .onChange(async (v) => {
			this.plugin.settings.eventTemplates[index].defaultDuration = v ? parseInt(v) : undefined;
			await this.plugin.saveSettings();
		    }));

	    new Setting(tmplContainer)
		.setName("Create linked note")
		.addToggle(toggle => toggle
		    .setValue(tmpl.createNote || false)
		    .onChange(async (v) => {
			this.plugin.settings.eventTemplates[index].createNote = v;
			await this.plugin.saveSettings();
		    }));

	    new Setting(tmplContainer)
		.addButton(btn => btn
		    .setButtonText("Remove Template")
		    .setWarning()
		    .onClick(async () => {
			this.plugin.settings.eventTemplates.splice(index, 1);
			await this.plugin.saveSettings();
			this.display();
		    }));
	});

	new Setting(containerEl)
	    .addButton(btn => btn
		.setButtonText("+ Add Template")
		.setCta()
		.onClick(async () => {
		    if (!this.plugin.settings.eventTemplates) {
			this.plugin.settings.eventTemplates = [];
		    }
		    this.plugin.settings.eventTemplates.push({
			id: crypto.randomUUID(),
			shortcode: "",
			label: "",
			namePattern: "{{date}} ",
			createNote: false,
		    });
		    await this.plugin.saveSettings();
		    this.display();
		}));

    }
}

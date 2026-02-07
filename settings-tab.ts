import { App, Plugin, PluginSettingTab, Setting } from "obsidian";
import { TascalSettings } from "./types";

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

	// ===== Recurring Events =====
	containerEl.createEl("h3", { text: "Recurring Events" });

	const recurringContainer = containerEl.createEl("div", { cls: "recurring-events-container" });

	// Add description
	recurringContainer.createEl("p", {
	    text: "Define recurring events here. Use [w:Mon,Wed] for weekly or [m:15] for monthly recurrence.",
	    cls: "setting-item-description"
	});

	// Container for individual event inputs
	const eventsContainer = recurringContainer.createEl("div", { cls: "recurring-events-list" });

	// Function to create a new event input
	const createEventInput = (value: string = "", index?: number) => {
	    const eventDiv = eventsContainer.createEl("div", { cls: "recurring-event-item" });

	    const input = eventDiv.createEl("input", {
		type: "text",
		cls: "recurring-event-input",
		attr: {
		    placeholder: "@09:00 (1h) Daily standup [w:Mon,Tue,Wed,Thu,Fri]"
		}
	    });

	    input.value = value;

	    // Handle input changes
	    input.addEventListener("input", async (evt) => {
		const target = evt.target as HTMLInputElement;
		const currentEvents = [...this.plugin.settings.recurringEvents];
		const inputIndex = Array.from(eventsContainer.children).indexOf(eventDiv);
		currentEvents[inputIndex] = target.value;
		this.plugin.settings.recurringEvents = currentEvents.filter(event => event.trim());
		await this.plugin.saveSettings();
	    });

	    // Add remove button
	    const removeBtn = eventDiv.createEl("button", {
		text: "×",
		cls: "remove-event-btn"
	    });

	    removeBtn.addEventListener("click", async () => {
		const currentEvents = [...this.plugin.settings.recurringEvents];
		const inputIndex = Array.from(eventsContainer.children).indexOf(eventDiv);
		currentEvents.splice(inputIndex, 1);
		this.plugin.settings.recurringEvents = currentEvents;
		await this.plugin.saveSettings();
		eventDiv.remove();
	    });

	    return eventDiv;
	};

	// Add existing events
	this.plugin.settings.recurringEvents.forEach(event => {
	    createEventInput(event);
	});

	// Add + button to create new events
	const addButton = recurringContainer.createEl("button", {
	    text: "+ Add Recurring Event",
	    cls: "add-recurring-event-btn"
	});

	addButton.addEventListener("click", async () => {
	    createEventInput();
	    this.plugin.settings.recurringEvents.push("");
	    await this.plugin.saveSettings();
	});

    }
}

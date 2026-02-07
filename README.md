# Tascal

A calendar-driven daily planner and time tracker for [Obsidian](https://obsidian.md). Syncs ICS calendars, renders a visual timeline in your daily notes, and tracks how you spend your time.

## Features

### Calendar sync

Tascal fetches events from ICS calendar URLs (Google Calendar, Outlook, iCloud, etc.) and renders them as a timeline in your daily note. It handles recurring events with full RRULE expansion, including overrides and exceptions.

Each calendar gets a configurable short name that prefixes event summaries, e.g. `(work) Team standup`.

**Command:** `Tascal: Sync calendar`

### Timeline

The timeline is rendered inside a `<!--tascal-->` section in your note. It shows all events as checkbox items with start/end times, free time gaps between them, and a stats line at the top:

```
<!--tascal-->
### Timeline
**2/5** done | 2h/8h30m | **Total TT: 1h15m**

- *08:00-09:00 (free)*
- [x] 09:00-10:00 (work) Team standup
- [ ] 10:00-11:30 (work) Deep work block
- *11:30-12:00 (free)*
- [ ] 12:00-12:30 Lunch [rc:w]
- [ ] 12:30-14:00 (work) Project review
- [x] 14:00-15:00 Code review [rs:2026-02-05]
- *15:00-22:00 (free)*

<!--manual
@12:00 (30m) Lunch [w:Mon,Tue,Wed,Thu,Fri]
-->
<!--/tascal-->
```

The stats line shows: completed/total tasks, elapsed/total scheduled time, and total tracked time.

Checkbox state is preserved across timeline rebuilds -- checking off a task and then syncing again won't lose your progress.

**Command:** `Tascal: Update timeline` -- rebuilds the timeline using cached calendar data, recurring events, and manual blocks.

### Manual tasks

Define your own tasks inside the `<!--manual ... -->` block using two formats:

**Start-end format:**
```
@09:00-17:00 Deep work
@14:00-15:30 Meeting with client
```

**Start-duration format:**
```
@09:00 (1h) Morning review
@14:00 (30m) Quick call
@8 (2h) Reading
```

Hours can be written without minutes (`@8` = `@08:00`). Durations use `h` and `m` notation (`1h30m`, `2h`, `45m`).

### Recurring events

Define events that repeat on a schedule directly in Tascal settings:

**Weekly recurrence** -- specify days of the week:
```
@09:00 (1h) Daily standup [w:Mon,Tue,Wed,Thu,Fri]
@10:00 (30m) 1:1 with manager [w:Wed]
```

**Monthly recurrence** -- specify the day of the month:
```
@14:00 (1h) Monthly retrospective [m:1]
@10:00 (2h) Budget review [m:15]
```

Recurring events are automatically added to the manual blocks when you sync or update the timeline. They're marked with `[rc:w]` or `[rc:m]` in the timeline so you can tell them apart. Each occurrence is tracked to prevent duplicates.

### Rescheduling

Append `@YYYY-MM-DD` to any manual task to move it to another date:

```
@14:00 (1h) Dentist appointment @2026-02-10
```

When the timeline is updated, this task is removed from today and saved to `.tascal/rescheduled.md`. On the target date, it appears automatically with a `[rs:YYYY-MM-DD]` marker showing where it came from.

### Time tracking

Track time spent on individual events with start/stop controls. Tracked time is stored inline as `{TT: HH:MM::HH:MM}` notation and persisted to `.tascal/tt-YYYY-MM-DD.json` files.

**Starting tracking:**
- Place `>` after the checkbox on a timeline item, then run the start command
- Or run the command with no `>` marker to get a selection modal

**Commands:**
- `Tascal: Start time tracking` -- begins a tracking session for the marked event
- `Tascal: Stop time tracking` -- ends the current session and records the duration
- `Tascal: Save time tracking data` -- extracts `{TT:}` data from the timeline and saves it to the JSON file

Multiple tracking sessions per event are supported. The total tracked time across all events is shown in the stats line.

### Format tasks

Sorts manual blocks by start time and normalizes their format: short tasks (<=90 min) use duration notation, longer ones use start-end notation.

**Command:** `Tascal: Format tasks`

### Working hours

Configure your default day start and end times, plus per-day overrides. Free time slots are only shown within your configured working hours.

Default: 08:00-22:00, with Saturday 10:00-18:00 and Sunday 10:00-20:00.

## Settings

| Setting | Description |
|---|---|
| Timezone | IANA timezone for all date/time operations (e.g. `Europe/Warsaw`) |
| Calendars | List of ICS calendar URLs with short names |
| Default Day Start/End | Working hours boundaries for the timeline |
| Day Overrides | Per-day-of-week start/end overrides |
| Recurring Events | Repeating task definitions with `[w:]` or `[m:]` patterns |

## Data storage

| Path | Contents |
|---|---|
| `.tascal/YYYY-MM-DD.json` | Cached calendar events for each synced date |
| `.tascal/tt-YYYY-MM-DD.json` | Time tracking data per day |
| `.tascal/rescheduled.md` | Rescheduled task entries |
| `.tascal/recurring.md` | Markers tracking which recurring events have been added to which dates |

## Installation

### From release

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](../../releases/latest)
2. Create a folder `your-vault/.obsidian/plugins/tascal/`
3. Copy the three files into that folder
4. Restart Obsidian and enable Tascal in Settings > Community Plugins

### From source

```bash
git clone <repo-url>
cd tascal
npm install
npm run build
```

Copy `main.js`, `manifest.json`, and `styles.css` to your vault's plugin directory, or configure `.env` and use `npm run deploy`:

```bash
cp .env.example .env
# Edit .env to set OBSIDIAN_VAULT to your vault path
npm run deploy
```

## Commands

| Command | Description |
|---|---|
| Sync calendar | Fetch ICS calendars and rebuild the timeline |
| Update timeline | Rebuild timeline from cache, recurring events, and manual blocks |
| Format tasks | Sort and normalize manual block formatting |
| Start time tracking | Begin tracking time for a selected event |
| Stop time tracking | End the current tracking session |
| Save time tracking data | Persist timeline tracking data to JSON |

## License

MIT

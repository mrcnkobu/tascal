# Tascal

Tascal is an Obsidian plugin for day planning around a generated timeline. It syncs ICS calendars, manages scheduled and unscheduled tasks in daily notes, tracks time spent on tasks, and can import backlog items from project notes.

## What Tascal Does

- syncs events from ICS calendar feeds into a daily timeline
- renders scheduled work and free-time gaps under a managed heading in your daily note
- keeps date-scoped unscheduled tasks in a second managed section
- supports recurring rules defined in plugin settings
- lets you add manual events with optional linked notes created from templates
- tracks time spent on scheduled events
- imports project backlog items from configured source directories into the active daily note's unscheduled task list

## Daily Note Output

Tascal treats the daily note as rendered output. It manages the content beneath the configured headings and preserves checkbox changes when the note is rebuilt.

Example timeline:

```md
## Timeline
<!-- tascal:start -->
**2/5** done | 2h/8h30m | **TT 1h15m** | *sync 09:10*

- *08:00–09:00 (free)*
- [x] 09:00–10:00 *(work)* Team standup
- [ ] > 10:00–11:30 Deep work *· tracking*
- *11:30–12:00 (free)*
- [ ] 12:00–12:30 Lunch *· rc*
- [ ] 12:30–14:00 Project review
- [x] 14:00–15:00 Code review *· rs:2026-02-05*
- *15:00–22:00 (free)*
<!-- tascal:end -->
```

Example unscheduled section:

```md
## Unscheduled
<!-- tascal:unscheduled:start -->
- [ ] Send invoice *(20m)*
- [ ] Prepare slides *(45m)*
<!-- tascal:unscheduled:end -->
```

## Features

### Calendar Sync

Tascal fetches events from ICS calendar URLs such as Google Calendar, Outlook, or iCloud and merges them into the day store for the active daily note.

- each calendar gets a short label used as a prefix in rendered timeline items
- sync status is shown in the timeline stats line
- rebuilding the timeline preserves completion state for existing items

Command: `Tascal: Sync calendar`

### Timeline

The timeline is rendered under the configured heading, `Timeline` by default.

- shows scheduled blocks in time order
- inserts free-time gaps within configured working hours
- marks recurring items with `*· rc*`
- marks rescheduled items with `*· rs:YYYY-MM-DD*`
- shows total tasks done, scheduled time done, and total tracked time

Command: `Tascal: Update timeline`

### Manual Events

Manual events are created through Tascal modals and stored in the day store.

- add events with a start/end range or start plus duration
- optionally start from an event template
- optionally create and link a note when using a template
- edit, delete, or reschedule existing events

Command: `Tascal: Add event`

### Unscheduled Tasks

Unscheduled tasks belong to a specific date but do not have a time slot yet.

- add tasks manually
- complete or reopen them from the note or management modal
- move them to another date
- schedule them onto the timeline
- import them from project notes

Commands:

- `Tascal: Add unscheduled task`
- `Tascal: Manage unscheduled tasks`

### Project Inbox Import

Tascal can scan configured source directories for project notes and import backlog items into the active daily note's unscheduled tasks.

Each project note must contain frontmatter with a stable project id:

```md
---
tascal-project-id: tascal
---
```

and an inbox block:

```md
## Tascal Inbox
<!-- tascal:inbox:start -->
- [ ] Draft release notes {est: 30m}
- [ ] Review sync errors {av: 2026-03-25, est: 45m}
- [ ] Clean up timeline parsing
<!-- tascal:inbox:end -->
```

Supported inbox syntax:

- `[ ]` available and not yet imported
- `[-]` imported into Tascal and still open
- `[x]` completed in Tascal

Supported metadata:

- `est`: estimate such as `20m`, `1h`, `1h30m`
- `av`: make the item importable on or after a date in `YYYY-MM-DD`
- `id`: stable task id, added automatically by Tascal on first import when missing
- `doneAt`: completion date written back by Tascal

Metadata parsing is forgiving:

- `:` after the key is optional, so both `{est: 30m}` and `{est 30m}` work
- keys are case-insensitive, so `AV`, `Est`, and `doneAt` are all accepted
- when Tascal rewrites the line, it normalizes metadata back to the canonical lowercase form with `:`

Workflow:

1. Add backlog items to a project inbox block.
2. Run `Tascal: Import project tasks` from a dated daily note.
3. Import available items into the active daily note's unscheduled list.
4. Schedule or complete them in Tascal.
5. Tascal writes status back to the source note, adds a `loadedAt` timestamp on import, and tracks the imported item in a persistent registry.

Command: `Tascal: Import project tasks`

### Recurring Rules

Recurring scheduled items are defined in settings rather than in the note.

- weekly rules specify a set of weekdays
- monthly rules specify a day number
- rules are injected when the timeline is rebuilt
- recurring items can be skipped through exceptions

Example weekly rules:

```text
09:00, 60m on Mon, Tue, Wed, Thu, Fri
10:00, 30m on Wed
```

### Rescheduling

Events can be moved to another date and optional new start time.

- rescheduled events are stored in the target day store
- origin dates are shown in rendered output
- a separate management command lists future rescheduled events

Command: `Tascal: Manage rescheduled events`

### Time Tracking

Tascal records time tracking entries directly on scheduled events.

- start tracking from the selection modal
- stop tracking to record the elapsed duration
- multiple tracking sessions per event are supported
- total tracked time appears in the timeline stats line

Commands:

- `Tascal: Start time tracking`
- `Tascal: Stop time tracking`

### Event Templates And Linked Notes

Templates make repeated manual events faster to create.

- define a shortcode, label, note name pattern, and optional folder
- configure a template note as initial content
- set default start and duration
- optionally create a linked note immediately when adding the event

## Settings

Current settings areas:

- `General`: timezone, managed heading names, plugin status
- `Project Sources`: directories scanned for project inbox notes
- `Calendars`: ICS feed URLs and labels
- `Working Hours`: default day bounds and per-day overrides
- `Recurring Rules`: structured weekly and monthly recurring items
- `Templates`: manual-event presets and linked-note defaults

## Commands

| Command | Description |
|---|---|
| Sync calendar | Fetch ICS calendars and rebuild the timeline |
| Update timeline | Rebuild timeline from cached data, recurring rules, and current store state |
| Add event | Add a manual scheduled event, optionally from a template |
| Edit event | Edit, delete, or reschedule an existing scheduled event |
| Add unscheduled task | Add a date-scoped task without a time slot |
| Manage unscheduled tasks | Complete, move, schedule, reopen, or delete unscheduled tasks |
| Manage rescheduled events | Review and re-reschedule future rescheduled events |
| Start time tracking | Begin tracking time for a selected event |
| Stop time tracking | End the current tracking session |
| Import project tasks | Import available backlog items from project inbox notes |

## Data Storage

| Path | Contents |
|---|---|
| `.tascal/days/YYYY-MM-DD.json` | Per-day store for scheduled events, unscheduled tasks, tracking, suppressions, and sync metadata |
| `.tascal/source-task-registry.json` | Persistent registry for imported source-backed project tasks |
| `.tascal/rescheduled.md` | Legacy rescheduled task entries used during rebuild/import flows |
| `.tascal/recurring.md` | Legacy recurring markers used for older recurring-event compatibility |

## Installation

### From Release

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release.
2. Create `your-vault/.obsidian/plugins/tascal/`.
3. Copy those files into that folder.
4. Restart Obsidian and enable Tascal in Community Plugins.

### From Source

```bash
git clone <repo-url>
cd tascal
npm install
npm run build
```

Copy `main.js`, `manifest.json`, and `styles.css` into your vault's plugin directory.

## Notes

- Tascal expects the active note name to start with a date in `YYYY-MM-DD` format.
- Daily-note sections managed by Tascal should be treated as generated output.
- Project inbox scanning is intentionally strict: only configured directories, only notes with `tascal-project-id`, and only tasks inside inbox markers are considered.

## Changelog

### 1.0.5

- Type-checking hygiene: widened the TypeScript `lib` to ES2020 so modern APIs (`Object.entries`, `String.padStart`, `String.trimEnd`, etc.) are properly typed, clearing the community-scan `no-unsafe-*` warnings.
- Cleaned up remaining lint findings (`prefer-const`, `require-await`, template-expression typing) and added an `npm run lint` script wired to the same type-checked ruleset. No runtime changes.

### 1.0.4

- Modal polish: consistent modal widths and header spacing, live event/reschedule previews moved below their input fields, and fixed delete-button placement in the unscheduled-task and rescheduled-event lists.
- Import Project Tasks: group headers now show the source note name (falling back to the project id) for easier scanning.
- Performance: calendar feeds are now fetched in parallel during sync, and recurring-event expansion skips unnecessary work for out-of-range occurrences.

## License

MIT

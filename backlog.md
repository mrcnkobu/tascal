# Tascal Backlog

This file captures issues and improvements identified during a code review of the current plugin state. It is organized as future work, not as a release commitment.

## Critical

- Preserve manual blocks when rewriting the `<!--tascal-->` section.
- Stop removing user-authored task definitions from notes during timeline updates.
- Introduce stable event identity beyond `start + summary` matching so duplicate titles/times do not corrupt state.
- Rework calendar event identity so recurring ICS instances and cross-calendar UID collisions are handled correctly.

## Security

- Validate calendar URLs before saving or syncing.
- Default to `https` calendars and warn or reject insecure or unsupported URL schemes.
- Add fetch safeguards for remote ICS sources: timeout, response size cap, and clearer per-calendar failure handling.
- Escape or sanitize externally sourced calendar summaries before rendering them back into markdown.
- Sanitize template-derived note paths and reject unsafe path segments.
- Validate template folder and filename patterns before attempting note creation.

## Data Integrity

- Replace fragile checkbox sync logic that matches events by rendered text.
- Ensure edits, deletions, and reschedules target the correct event even when multiple events share the same title.
- Make recurring-event suppression and migration rules deterministic and easier to reason about.
- Add schema validation when reading stored JSON so malformed files do not silently degrade into partial state.
- Clarify how overlapping events should be represented and counted in timeline statistics.
- Handle duplicate linked-note creation attempts gracefully instead of failing mid-flow.

## Performance

- Fetch multiple calendars in parallel instead of sequentially.
- Reduce unnecessary note rereads and whole-section rewrites after small state changes.
- Optimize RRULE expansion for long-running recurring events so sync cost does not grow with calendar age.
- Debounce settings saves instead of writing to disk on every keystroke.
- Consider incremental timeline rebuilds or cheaper store updates for common actions like tracking start/stop.
- Add tests or profiling around large ICS files and long event histories.

## UX

- Align the README with the actual command surface and remove or implement undocumented gaps.
- Update plugin metadata and manifest description to reflect the current feature set.
- Improve validation and user feedback for invalid times, durations, dates, recurrence rules, and template configuration.
- Show users what changed when they select an event template in the Add Event modal.
- Make linked-note creation outcomes explicit: created, already exists, failed, or skipped.
- Improve rescheduling UX with previews for new date/time and conflict warnings.
- Surface last successful calendar sync time and stale-calendar status in the UI.
- Make destructive actions clearer, especially delete and reschedule flows.

## Settings UX

- Break the settings screen into clearer sections or collapsible groups.
- Add inline validation for timezone, working hours, recurrence values, and calendar URLs.
- Prevent invalid recurring rules such as zero-minute duration or empty weekly selections.
- Provide better affordances for editing large numbers of calendars or templates.
- Add examples and helper text where the plugin expects specific syntax.

## UI / Design

- Improve mobile layout behavior for modals and settings controls.
- Revisit button hierarchy, spacing, and typography for long forms and action-heavy dialogs.
- Make tracking state more visible in event lists and the rendered timeline.
- Improve rendering of overlaps, free-time gaps, and linked-note indicators.
- Review CSS for accessibility, contrast, and reduced-motion friendliness.

## Reliability / Maintenance

- Add automated tests for timeline parsing, manual block import, recurring rules, and rescheduling.
- Add regression tests for note rewrite behavior so user-authored blocks are not lost again.
- Introduce a small validation layer for settings and persisted store data.
- Reduce use of `any` in core plugin flows and tighten TypeScript types.
- Review migration paths and make them idempotent and easier to audit.
- Add lightweight logging around sync/migration failures that helps users recover without opening dev tools.

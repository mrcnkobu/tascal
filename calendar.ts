import ICAL from "ical.js";
import { DateTime } from "luxon";
import { EventData } from "./types";

export function extractEventsForDate(
    calendar: ICAL.Component,
    localDate: DateTime,
    timezone: string
): EventData[] {
    const endOfDay = localDate.endOf("day");

    const vevents = calendar.getAllSubcomponents("vevent");
    const events: EventData[] = [];

    const overridesByUid: Record<string, ICAL.Event[]> = {};
    const overriddenByUid: Record<string, Set<number>> = {};
    const exdatesByUid: Record<string, Set<number>> = {};

    // Step 1: separate overrides and build override maps
    for (const comp of vevents) {
	const event = new ICAL.Event(comp);

	if (event.recurrenceId) {
	    const uid = event.uid;
	    if (!overridesByUid[uid]) overridesByUid[uid] = [];
	    overridesByUid[uid].push(event);

	    const originalDate = event.recurrenceId.toJSDate().getTime();
	    if (!overriddenByUid[uid]) overriddenByUid[uid] = new Set();
	    overriddenByUid[uid].add(originalDate);
	}
    }

    // Step 2: collect EXDATEs per UID
    for (const comp of vevents) {
	const event = new ICAL.Event(comp);
	const uid = event.uid;
	const exs = comp.getAllProperties("exdate");
	if (!exdatesByUid[uid]) exdatesByUid[uid] = new Set();

	for (const ex of exs) {
		const values = ex.getValues() as unknown[];
		for (const dt of values) {
			const date = toDate(dt);
			if (date) {
			    exdatesByUid[uid].add(date.getTime());
			}
		}
	    }
	}

    // Step 3: process master events and expand RRULEs
    for (const comp of vevents) {
	const event = new ICAL.Event(comp);
	const uid = event.uid;

	// skip overrides (already processed)
	if (event.recurrenceId) continue;

	const dtstart = event.startDate?.toJSDate();
	const dtend = event.endDate?.toJSDate();
	if (!dtstart || !dtend) continue;

	if (event.isRecurring()) {
	    const iterator = event.iterator();
	    let next;
	    while ((next = iterator.next())) {
		const occJs = next.toJSDate();
		const occ = DateTime.fromJSDate(occJs, { zone: timezone });

		if (occ > endOfDay) break;
		if (!occ.hasSame(localDate, "day")) continue;

		const timestamp = occJs.getTime();

		// skip if overridden or excluded
		if (overriddenByUid[uid]?.has(timestamp)) continue;
		if (exdatesByUid[uid]?.has(timestamp)) continue;

		const durationSecs = event.duration.toSeconds();
		events.push({
		    summary: event.summary,
		    start: occ,
		    end: occ.plus({ seconds: durationSecs }),
		    uid,
		});
	    }
	} else {
	    const start = DateTime.fromJSDate(dtstart, { zone: timezone });
	    if (start.hasSame(localDate, "day")) {
		const end = DateTime.fromJSDate(dtend, { zone: timezone });
		events.push({ summary: event.summary, start, end, uid });
	    }
	}
    }

    // Step 4: add all overrides that now fall on this date
    for (const list of Object.values(overridesByUid)) {
	for (const event of list) {
	    const dtstart = event.startDate?.toJSDate();
	    const dtend = event.endDate?.toJSDate();
	    if (!dtstart || !dtend) continue;

	    const start = DateTime.fromJSDate(dtstart, { zone: timezone });
	    if (start.hasSame(localDate, "day")) {
		const end = DateTime.fromJSDate(dtend, { zone: timezone });
		events.push({ summary: event.summary, start, end, uid: event.uid });
	    }
	}
    }

    return events;
}

function toDate(value: unknown): Date | null {
    if (value instanceof Date) return value;
    if (typeof value === "string" || typeof value === "number") return new Date(value);
    if (value && typeof value === "object" && "toJSDate" in value) {
	const candidate = value as { toJSDate: () => Date };
	return candidate.toJSDate();
    }
    return null;
}

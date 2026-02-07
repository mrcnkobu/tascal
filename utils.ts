export function extractDateFromFilename(filename: string): string | null {
    const match = filename.match(/^(\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : null;
}

export function parseDuration(text: string): number {
    const regex = /(\d+)(h|m)/g;
    let match;
    let totalMinutes = 0;

    while ((match = regex.exec(text)) !== null) {
	const value = parseInt(match[1]);
	const unit = match[2];

	if (unit === "h") totalMinutes += value * 60;
	if (unit === "m") totalMinutes += value;
    }

    return totalMinutes;
}

export function formatDuration(minutes: number): string {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (hours > 0 && mins > 0) return `${hours}h${mins}m`;
    if (hours > 0) return `${hours}h`;
    return `${mins}m`;
}

export function formatTime(time: string): string {
    // If time is already in HH:MM format, return as is
    if (time.includes(':')) {
        // Ensure hours are padded with leading zero
        const [hours, minutes] = time.split(':');
        return `${hours.padStart(2, '0')}:${minutes}`;
    }
    // Otherwise, assume it's just hours and add :00
    // Pad single-digit hours with leading zero
    const hour = time.padStart(2, '0');
    return `${hour}:00`;
}

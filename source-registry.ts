import { App } from "obsidian";
import { SourceTaskLocation, SourceTaskRegistry, SourceTaskRegistryRecord } from "./types";

const REGISTRY_PATH = ".tascal/source-task-registry.json";

function emptyRegistry(): SourceTaskRegistry {
    return { version: 1, records: [] };
}

export async function loadSourceTaskRegistry(app: App): Promise<SourceTaskRegistry> {
    const adapter = app.vault.adapter;
    if (!(await adapter.exists(REGISTRY_PATH))) {
	return emptyRegistry();
    }

    try {
	const text = await adapter.read(REGISTRY_PATH);
	const data = JSON.parse(text) as SourceTaskRegistry;
	if (data.version !== 1 || !Array.isArray(data.records)) {
	    console.warn(`Tascal: unknown source task registry version, recreating ${REGISTRY_PATH}`);
	    return emptyRegistry();
	}
	return data;
    } catch (error) {
	console.error(`Tascal: failed to read ${REGISTRY_PATH}:`, error);
	return emptyRegistry();
    }
}

export async function saveSourceTaskRegistry(app: App, registry: SourceTaskRegistry): Promise<void> {
    const adapter = app.vault.adapter;
    if (!(await adapter.exists(".tascal"))) {
	await adapter.mkdir(".tascal");
    }
    await adapter.write(REGISTRY_PATH, JSON.stringify(registry, null, 2));
}

export function findRegistryRecordById(
    registry: SourceTaskRegistry,
    registryId: string
): SourceTaskRegistryRecord | undefined {
    return registry.records.find(record => record.registryId === registryId);
}

export function findRegistryRecordBySourceIdentity(
    registry: SourceTaskRegistry,
    projectId: string,
    sourceTaskId: string
): SourceTaskRegistryRecord | undefined {
    return registry.records.find(record =>
	record.projectId === projectId && record.sourceTaskId === sourceTaskId
    );
}

export function upsertRegistryRecord(
    registry: SourceTaskRegistry,
    record: SourceTaskRegistryRecord
): SourceTaskRegistry {
    const index = registry.records.findIndex(existing => existing.registryId === record.registryId);
    if (index === -1) {
	return { ...registry, records: [...registry.records, record] };
    }

    const nextRecords = [...registry.records];
    nextRecords[index] = record;
    return { ...registry, records: nextRecords };
}

export function createRegistryRecord(
    projectId: string,
    sourceTaskId: string,
    sourcePath: string,
    sourceSummary: string,
    importedAt: string,
    currentLocation: SourceTaskLocation
): SourceTaskRegistryRecord {
    return {
	registryId: crypto.randomUUID(),
	projectId,
	sourceTaskId,
	sourcePath,
	sourceSummary,
	state: "imported",
	currentLocation,
	importedAt,
	lastWriteBackAt: importedAt,
    };
}

export function updateRegistryLocation(
    registry: SourceTaskRegistry,
    registryId: string,
    location: SourceTaskLocation | undefined
): SourceTaskRegistry {
    const record = findRegistryRecordById(registry, registryId);
    if (!record) return registry;
    return upsertRegistryRecord(registry, {
	...record,
	currentLocation: location,
	state: location ? record.state : "available",
    });
}

export function markRegistryImported(
    registry: SourceTaskRegistry,
    registryId: string,
    sourcePath: string,
    sourceSummary: string,
    importedAt: string,
    location: SourceTaskLocation
): SourceTaskRegistry {
    const record = findRegistryRecordById(registry, registryId);
    if (!record) return registry;

    return upsertRegistryRecord(registry, {
	...record,
	sourcePath,
	sourceSummary,
	state: "imported",
	currentLocation: location,
	importedAt,
	completedAt: undefined,
	lastWriteBackAt: importedAt,
    });
}

export function markRegistryDone(
    registry: SourceTaskRegistry,
    registryId: string,
    completedAt: string
): SourceTaskRegistry {
    const record = findRegistryRecordById(registry, registryId);
    if (!record) return registry;
    return upsertRegistryRecord(registry, {
	...record,
	state: "done",
	completedAt,
	lastWriteBackAt: completedAt,
    });
}

export function markRegistryOpen(
    registry: SourceTaskRegistry,
    registryId: string,
    location: SourceTaskLocation,
    changedAt: string
): SourceTaskRegistry {
    const record = findRegistryRecordById(registry, registryId);
    if (!record) return registry;
    return upsertRegistryRecord(registry, {
	...record,
	state: "imported",
	currentLocation: location,
	completedAt: undefined,
	lastWriteBackAt: changedAt,
    });
}

export function markRegistryAvailable(
    registry: SourceTaskRegistry,
    registryId: string,
    changedAt: string
): SourceTaskRegistry {
    const record = findRegistryRecordById(registry, registryId);
    if (!record) return registry;
    return upsertRegistryRecord(registry, {
	...record,
	state: "available",
	currentLocation: undefined,
	completedAt: undefined,
	lastWriteBackAt: changedAt,
    });
}

export function markRegistryOrphaned(
    registry: SourceTaskRegistry,
    registryId: string,
    changedAt: string
): SourceTaskRegistry {
    const record = findRegistryRecordById(registry, registryId);
    if (!record) return registry;
    return upsertRegistryRecord(registry, {
	...record,
	state: "orphaned",
	lastWriteBackAt: changedAt,
    });
}

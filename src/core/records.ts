import type {
  FieldAudit,
  ItemResearchRecord,
  ResearchValue,
} from "../domain/types";

export function createEmptyRecord(
  libraryID: number,
  itemKey: string,
): ItemResearchRecord {
  return {
    schemaVersion: 1,
    libraryID,
    itemKey,
    revision: 0,
    fields: {},
    updatedAt: new Date().toISOString(),
  };
}

export function setManualValue(
  record: ItemResearchRecord,
  fieldID: string,
  value: unknown,
): ItemResearchRecord {
  return setValue(record, fieldID, {
    value,
    locked: true,
    source: "manual",
    updatedAt: new Date().toISOString(),
    audit: {
      executor: "manual",
      executorVersion: "",
      inputType: "manual",
      inputHash: "",
      generatedAt: new Date().toISOString(),
      templateVersion: 1,
    },
  });
}

export function setFieldLock(
  record: ItemResearchRecord,
  fieldID: string,
  locked: boolean,
): ItemResearchRecord {
  const existing = record.fields[fieldID];
  if (!existing) return record;
  return setValue(record, fieldID, { ...existing, locked });
}

export function applyAgentValues(
  record: ItemResearchRecord,
  values: Record<string, unknown>,
  audit: FieldAudit,
): ItemResearchRecord {
  let next = record;
  for (const [fieldID, value] of Object.entries(values)) {
    if (next.fields[fieldID]?.locked) continue;
    next = setValue(next, fieldID, {
      value,
      locked: false,
      source: "agent",
      updatedAt: audit.generatedAt,
      audit,
    });
  }
  return next;
}

function setValue(
  record: ItemResearchRecord,
  fieldID: string,
  value: ResearchValue,
): ItemResearchRecord {
  const updatedAt = new Date().toISOString();
  return {
    ...record,
    revision: record.revision + 1,
    updatedAt,
    fields: { ...record.fields, [fieldID]: value },
  };
}

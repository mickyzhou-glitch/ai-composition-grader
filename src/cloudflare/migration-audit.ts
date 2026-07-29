export interface MigrationAudit {
  tables: Record<string, number>;
  files: { registered: number; present: number; missing: number };
}

export function summarizeMigrationAudit(
  tableCounts: Iterable<readonly [string, number]>,
  fileStates: Iterable<boolean>,
): MigrationAudit {
  const tables = Object.fromEntries(tableCounts);
  let registered = 0;
  let present = 0;
  for (const exists of fileStates) {
    registered += 1;
    if (exists) present += 1;
  }
  return { tables, files: { registered, present, missing: registered - present } };
}

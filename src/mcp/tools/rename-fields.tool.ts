import { renameFields } from '@/contexts/reports/application/reportUseCases.js';
import { type FieldRename, isOverridden } from '@/contexts/reports/domain/DataSource.js';
import { renameFieldsSchema } from '@/mcp/schemas.js';
import { runWrite, text, type ToolResult, type WriteDeps } from '@/mcp/tool-helpers.js';

import type { ReportToolDeps } from './reports-deps.js';

export async function handleRenameFields(
  deps: ReportToolDeps & WriteDeps,
  raw: unknown,
): Promise<ToolResult> {
  const input = renameFieldsSchema.parse(raw);
  const renames: FieldRename[] = input.renames.map((r) => ({
    field: r.field,
    ...(r.name !== undefined ? { name: r.name } : {}),
    ...(r.id !== undefined ? { id: r.id } : {}),
  }));
  return runWrite(
    deps,
    'rename_fields',
    { ...input },
    `rename ${renames.length} field${renames.length === 1 ? '' : 's'} (${renames.map((r) => r.field).join(', ')})`,
    async () => {
      const after = await renameFields(
        deps.reportRepo,
        input.report_id,
        renames,
        input.data_source,
      );
      const changed = renames.map((r) => {
        const parts = [
          ...(r.name !== undefined ? [`name "${r.name}"`] : []),
          ...(r.id !== undefined ? [`ID \`${r.id}\``] : []),
        ];
        return `- ${r.field} → ${parts.join(', ')}`;
      });
      return text(
        `Renamed ${renames.length} field${renames.length === 1 ? '' : 's'}:\n${changed.join('\n')}\n\nThese are report-level overrides (Resource › Manage field names and IDs); the data source itself is unchanged. ${after.filter(isOverridden).length} of its ${after.length} fields are overridden in this report. Run check_report now: a new field ID can break charts, filters or formulas that use the field, and in a live test even a display-name override made other charts of the same data source fail with "System Error". Removing the override (Resource › Manage field names and IDs › Remove) restores them.`,
      );
    },
  );
}

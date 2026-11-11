import { listFieldIds } from '@/contexts/reports/application/reportUseCases.js';
import { isOverridden } from '@/contexts/reports/domain/DataSource.js';
import { listFieldIdsSchema } from '@/mcp/schemas.js';
import { text, type ToolResult } from '@/mcp/tool-helpers.js';

import type { ReportToolDeps } from './reports-deps.js';

export async function handleListFieldIds(deps: ReportToolDeps, raw: unknown): Promise<ToolResult> {
  const input = listFieldIdsSchema.parse(raw);
  const fields = await listFieldIds(deps.reportRepo, input.report_id, {
    ...(input.data_source ? { ref: input.data_source } : {}),
    suggest: input.suggest_names,
  });
  if (fields.length === 0) return text('The data source has no fields.');
  const lines = fields.map((f) => {
    const own = [
      ...(f.name !== f.originalName ? [`name ${f.originalName}`] : []),
      ...(f.id !== f.originalId ? [`ID \`${f.originalId}\``] : []),
    ];
    const base = `- \`${f.id}\` — ${f.name}${own.length ? ` (overrides ${own.join(', ')})` : ''}`;
    return f.suggestedName ? `${base}  → suggested: "${f.suggestedName}"` : base;
  });
  const overridden = fields.filter(isOverridden).length;
  const suggested = fields.filter((f) => f.suggestedName).length;
  const tail = input.suggest_names
    ? `\n\n${suggested} suggested name${suggested === 1 ? '' : 's'}. Apply the ones you want with rename_fields.`
    : '';
  return text(
    `Fields (ID — display name), ${fields.length} in all, ${overridden} with a report-level override:\n${lines.join('\n')}${tail}`,
  );
}

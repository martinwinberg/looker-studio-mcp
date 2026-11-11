import { DomainError } from '@/shared-kernel/errors/DomainError.js';

import { AGGREGATIONS, InvalidChartError } from './Report.js';

// A row of Resource › Manage added data sources.
export interface DataSourceRow {
  name: string;
  // ds0, ds1… unique in a report even when names repeat.
  alias: string;
  connector: string;
  // Embedded (lives in the report) or Reusable.
  scope: string;
  // "2 charts, 0 variables" as the panel shows it.
  usedIn: string;
  status: string;
}

export interface DataSourceField {
  name: string;
  // "Number", "Text", "Date"…
  type: string;
  aggregation: string;
  kind: 'dimension' | 'metric';
}

export interface DataSourceInfo extends DataSourceRow {
  charts: number;
  kind: 'table' | 'custom_query' | 'other';
  // project.dataset.table for a table or view.
  table?: string;
  sql?: string;
  billingProject?: string;
  credentials?: string;
  freshness?: string;
  fields?: DataSourceField[];
}

export const FRESHNESS = ['15 minutes', '1 hour', '4 hours', '12 hours'] as const;
export type Freshness = (typeof FRESHNESS)[number];

export const CREDENTIALS = ['owner', 'viewer'] as const;
export type Credentials = (typeof CREDENTIALS)[number];

export interface DataSourceChange {
  name?: string;
  // Custom queries only: the new SQL, applied with Reconnect.
  sql?: string;
  credentials?: Credentials;
  // A preset (FRESHNESS) or a custom period such as "30 minutes" or "2 hours".
  freshness?: string;
  // Resource › Manage added data sources › Make reusable.
  makeReusable?: boolean;
  // The Make reusable dialog's "Grant report editors access" (on by default).
  grantEditorAccess?: boolean;
}

export const FIELD_AGGREGATIONS = [...AGGREGATIONS, 'median', 'std_dev', 'variance'] as const;
export type FieldAggregation = (typeof FIELD_AGGREGATIONS)[number];

export interface FieldChange {
  // A type label of the field editor ("Number", "Text", "Date", "Percent", "Country"…)
  // or a menu path ("Numeric > Number", "Currency > EUR").
  type?: string;
  aggregation?: FieldAggregation;
  name?: string;
}

export class DataSourceNotFoundError extends DomainError {
  readonly code = 'DATA_SOURCE_NOT_FOUND';
  constructor(readonly userMessage: string) {
    super(userMessage);
  }
}

// Looker Studio removes a data source that charts use and leaves them broken.
export class DataSourceInUseError extends DomainError {
  readonly code = 'DATA_SOURCE_IN_USE';
  readonly userMessage: string;

  constructor(row: DataSourceRow) {
    super(`${row.name} is used: ${row.usedIn}`);
    this.userMessage = `Not removed: "${row.name}" (${row.alias}) is used in the report (${row.usedIn}); removing it would break those charts. Delete or repoint them first, or pass force: true.`;
  }
}

const ALIAS_RE = /^ds\d+$/i;

// A data source is addressed by alias (always unique) or by name; a name that
// several data sources share needs the alias.
export function findDataSource(rows: DataSourceRow[], ref: string): DataSourceRow {
  const wanted = ref.trim();
  const listed = () => rows.map((r) => `${r.name} (${r.alias})`).join(', ') || 'none';
  if (ALIAS_RE.test(wanted)) {
    const row = rows.find((r) => r.alias.toLowerCase() === wanted.toLowerCase());
    if (row) return row;
  }
  const named = rows.filter((r) => r.name === wanted);
  if (named.length === 1) return named[0]!;
  if (named.length > 1) {
    throw new DataSourceNotFoundError(
      `Several data sources are named "${wanted}" (${named.map((r) => r.alias).join(', ')}): pass the alias instead.`,
    );
  }
  throw new DataSourceNotFoundError(`No data source "${wanted}". The report has: ${listed()}.`);
}

// "1 chart, 0 variables" → 1.
export function chartsUsing(usedIn: string): number {
  const match = /(\d+)\s+charts?/i.exec(usedIn);
  return match ? Number(match[1]) : 0;
}

// Charts or variables (parameters, controls) still read it.
export function isUsed(usedIn: string): boolean {
  return [...usedIn.matchAll(/(\d+)/g)].some((m) => Number(m[1]) > 0);
}

// The BigQuery connector links each project, dataset and table to the Cloud
// console: …?project=p&p=p&d=dataset&t=table&page=table.
export function parseConsoleLink(href: string): {
  project?: string;
  dataset?: string;
  table?: string;
} {
  const query = href.includes('?') ? href.slice(href.indexOf('?') + 1) : '';
  const params = new URLSearchParams(query);
  const out: { project?: string; dataset?: string; table?: string } = {};
  const project = params.get('p') ?? params.get('project');
  if (project) out.project = project;
  const dataset = params.get('d');
  if (dataset) out.dataset = dataset;
  const table = params.get('t');
  if (table) out.table = table;
  return out;
}

export function validateDataSourceChange(change: DataSourceChange): DataSourceChange {
  const { name, sql, credentials, freshness, makeReusable, grantEditorAccess } = change;
  if (name === undefined && sql === undefined && !credentials && !freshness && !makeReusable) {
    throw new InvalidChartError('Pass name, sql, credentials, freshness or make_reusable.');
  }
  if (grantEditorAccess !== undefined && !makeReusable)
    throw new InvalidChartError('grant_editor_access only applies with make_reusable: true.');
  if (name !== undefined && !name.trim())
    throw new InvalidChartError('The data source name cannot be empty.');
  if (sql !== undefined && !sql.trim()) throw new InvalidChartError('The SQL cannot be empty.');
  const out: DataSourceChange = {};
  if (name !== undefined) out.name = name.trim();
  if (sql !== undefined) out.sql = sql.trim();
  if (credentials) out.credentials = credentials;
  if (freshness) out.freshness = freshnessLabel(parseFreshness(freshness));
  if (makeReusable) out.makeReusable = true;
  if (grantEditorAccess !== undefined) out.grantEditorAccess = grantEditorAccess;
  return out;
}

// ── data freshness ──
// The Data freshness dialog has four presets and "Custom": every N minutes
// (from a fixed list) or 1 to 12 hours. It offers nothing longer.
export const CUSTOM_FRESHNESS = {
  minutes: [1, 2, 3, 4, 5, 10, 15, 20, 25, 30, 40, 50],
  hours: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
} as const;

export type FreshnessSetting =
  { preset: Freshness } | { custom: { amount: number; unit: 'minutes' | 'hours' } };

export function parseFreshness(input: string): FreshnessSetting {
  const text = input.trim().toLowerCase();
  const match = /^(?:every\s+)?(\d+)\s*(m|mins?|minutes?|h|hrs?|hours?|d|days?)$/.exec(text);
  const allowed = `a preset (${FRESHNESS.join(', ')}) or every ${CUSTOM_FRESHNESS.minutes.join(', ')} minutes or 1 to 12 hours`;
  if (!match) throw new InvalidChartError(`freshness must be ${allowed}, not "${input}".`);
  const amount = Number(match[1]);
  const unit = match[2]!.startsWith('m') ? 'minutes' : match[2]!.startsWith('h') ? 'hours' : 'days';
  if (unit === 'days') {
    throw new InvalidChartError(
      `Looker Studio's Data freshness has no days: the longest period is 12 hours. Use ${allowed}.`,
    );
  }
  const preset = FRESHNESS.find(
    (p) => p === `${amount} ${unit}` || p === `${amount} ${unit.slice(0, -1)}`,
  );
  if (preset) return { preset };
  if (!(CUSTOM_FRESHNESS[unit] as readonly number[]).includes(amount)) {
    throw new InvalidChartError(
      `Data freshness cannot be every ${amount} ${unit}: use ${allowed}.`,
    );
  }
  return { custom: { amount, unit } };
}

// "30 minutes", "1 hour", "2 hours": what the editor's header button shows.
export function freshnessLabel(setting: FreshnessSetting): string {
  if ('preset' in setting) return setting.preset;
  const { amount, unit } = setting.custom;
  return `${amount} ${amount === 1 ? unit.slice(0, -1) : unit}`;
}

export function validateFieldChange(field: string, change: FieldChange): FieldChange {
  if (!field.trim()) throw new InvalidChartError('Name the field to change.');
  const { type, aggregation, name } = change;
  if (type === undefined && aggregation === undefined && name === undefined)
    throw new InvalidChartError('Pass type, aggregation or name.');
  if (type !== undefined && !type.trim())
    throw new InvalidChartError('The field type cannot be empty.');
  if (name !== undefined && !name.trim())
    throw new InvalidChartError('The new field name cannot be empty.');
  const out: FieldChange = {};
  if (type !== undefined) out.type = type.trim();
  if (aggregation !== undefined) out.aggregation = aggregation;
  if (name !== undefined) out.name = name.trim();
  return out;
}

// The Apply Connection Changes dialog lists one field per line under headings
// (New Fields, Missing Fields, Changed Semantic Configuration…), then Cancel and Apply.
export function parseConnectionChanges(text: string): string[] {
  const label: Record<string, string> = {
    'new fields': 'New fields',
    'removed fields': 'Removed fields',
    'missing fields': 'Missing fields',
    'changed fields': 'Changed fields',
    'changed semantic configuration': 'Fields with a new type',
  };
  const sections: Array<{ label: string; fields: string[] }> = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (/^(cancel|apply)$/i.test(line)) break;
    const heading = label[line.toLowerCase()];
    if (heading) sections.push({ label: heading, fields: [] });
    else sections.at(-1)?.fields.push(line);
  }
  return sections.filter((s) => s.fields.length).map((s) => `${s.label}: ${s.fields.join(', ')}`);
}

// "Numeric > Number" → ["Numeric", "Number"]; "Number" → ["Number"].
export function fieldTypePath(type: string): string[] {
  return type
    .split(/\s*[>›]\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ── Field names and IDs (Resource › Manage field names and IDs) ──

const fold = (s: string): string => s.trim().toLowerCase();

// A field of a data source as this report sees it: the display name charts show and the
// field ID filters and the report refer to. The dialog keeps them as report-level
// overrides of the data source's own name and ID (originalName, originalId), so the
// data source itself never changes.
export interface FieldIdentity {
  name: string;
  id: string;
  originalName: string;
  originalId: string;
  // Data type as the overrides table shows it (Text, Number…), for overridden fields.
  type?: string;
}

export const isOverridden = (f: FieldIdentity): boolean =>
  f.name !== f.originalName || f.id !== f.originalId;

// Builds the report's view of the fields: each field's own name and ID, with any
// override from the Field overrides table on top (blank cells keep the original).
export function applyFieldOverrides(
  fields: { originalName: string; originalId: string }[],
  overrides: { displayName: string; idOverride: string; originalId: string; dataType?: string }[],
): FieldIdentity[] {
  return fields.map((f) => {
    const o = overrides.find((x) => x.originalId === f.originalId);
    return {
      name: o?.displayName.trim() || f.originalName,
      id: o?.idOverride.trim() || f.originalId,
      originalName: f.originalName,
      originalId: f.originalId,
      ...(o?.dataType ? { type: o.dataType } : {}),
    };
  });
}

// The field a rename means: by current name, current ID, then the data source's own
// name or ID; exact first, then ignoring case.
export function findFieldIdentity(
  fields: FieldIdentity[],
  wanted: string,
): FieldIdentity | undefined {
  const keys = (f: FieldIdentity) => [f.name, f.id, f.originalName, f.originalId];
  for (const k of [0, 1, 2, 3]) {
    const hit = fields.find((f) => keys(f)[k] === wanted);
    if (hit) return hit;
  }
  return fields.find((f) => keys(f).some((v) => fold(v) === fold(wanted)));
}

// One change of a field, found by its current name or ID.
export interface FieldRename {
  field: string;
  name?: string;
  id?: string;
}

// Looker Studio field IDs: letters, digits and underscores, not starting with a digit.
export const FIELD_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Checks a batch of renames before any browser work: every change names a field and
// a new name or ID, IDs are well formed, and no two fields end up with the same name or ID.
// With `existing` (the dialog's list) it also checks that each field exists and that the
// new names and IDs do not collide with fields that keep theirs.
export function validateFieldRenames(
  renames: FieldRename[],
  existing?: FieldIdentity[],
): FieldRename[] {
  if (renames.length === 0) throw new InvalidChartError('Pass at least one field to rename.');
  const out = renames.map((r, i): FieldRename => {
    const at = `Rename ${i + 1}`;
    if (!r.field.trim()) throw new InvalidChartError(`${at}: name the field to change.`);
    if (r.name === undefined && r.id === undefined)
      throw new InvalidChartError(`${at} (${r.field.trim()}): pass a new name or id.`);
    if (r.name !== undefined && !r.name.trim())
      throw new InvalidChartError(`${at} (${r.field.trim()}): the new name cannot be empty.`);
    if (r.id !== undefined && !FIELD_ID_PATTERN.test(r.id.trim()))
      throw new InvalidChartError(
        `${at} (${r.field.trim()}): "${r.id}" is not a valid field ID (letters, digits and _, not starting with a digit).`,
      );
    return {
      field: r.field.trim(),
      ...(r.name !== undefined ? { name: r.name.trim() } : {}),
      ...(r.id !== undefined ? { id: r.id.trim() } : {}),
    };
  });

  const seen = new Set<string>();
  for (const r of out) {
    if (seen.has(fold(r.field)))
      throw new InvalidChartError(`The field "${r.field}" is renamed twice; merge the changes.`);
    seen.add(fold(r.field));
  }
  const dupe = (values: string[]): string | undefined => {
    const s = new Set<string>();
    for (const v of values) {
      if (s.has(fold(v))) return v;
      s.add(fold(v));
    }
    return undefined;
  };
  const newNames = out.flatMap((r) => (r.name ? [r.name] : []));
  const newIds = out.flatMap((r) => (r.id ? [r.id] : []));
  const sameName = dupe(newNames);
  if (sameName) throw new InvalidChartError(`Two fields would both be named "${sameName}".`);
  const sameId = dupe(newIds);
  if (sameId) throw new InvalidChartError(`Two fields would both get the ID "${sameId}".`);

  if (existing) {
    const targets = out.map((r) => {
      const hit = findFieldIdentity(existing, r.field);
      if (!hit)
        throw new InvalidChartError(
          `There is no field "${r.field}" (by name or ID) in the data source.`,
        );
      return hit;
    });
    targets.forEach((t, i) => {
      const j = targets.indexOf(t);
      if (j !== i)
        throw new InvalidChartError(
          `"${out[j]!.field}" and "${out[i]!.field}" are the same field (${t.originalId}); merge the changes.`,
        );
    });
    // Names and IDs after the renames, for the fields that are not changed.
    const kept = existing.filter((f) => !targets.includes(f));
    out.forEach((r, i) => {
      const self = targets[i]!;
      if (r.name && fold(r.name) !== fold(self.name)) {
        const other = kept.find((f) => fold(f.name) === fold(r.name!));
        if (other)
          throw new InvalidChartError(
            `"${r.name}" is already the name of the field ${other.id}; rename that one too or pick another name.`,
          );
      }
      if (r.id && fold(r.id) !== fold(self.id)) {
        const other = kept.find((f) => fold(f.id) === fold(r.id!));
        if (other)
          throw new InvalidChartError(
            `"${r.id}" is already the ID of the field "${other.name}"; pick another ID.`,
          );
      }
    });
  }
  return out;
}

// Short words written in capitals in suggested names.
const ACRONYMS = new Set([
  'aov',
  'cpo',
  'cpc',
  'cpm',
  'ctr',
  'eu',
  'ga4',
  'id',
  'iso',
  'kpi',
  'roas',
  'sek',
  'eur',
  'usd',
  'nok',
  'dkk',
  'gbp',
  'sku',
  'url',
  'utm',
  'vat',
  'b2b',
  'gm1',
  'yoy',
]);

// A readable display name from a column-style ID: "order_value_ex_vat_sek" → "Order value ex VAT SEK",
// "ga4_sessions" → "GA4 sessions". Only a suggestion: the caller decides what to apply.
export function suggestFieldName(id: string): string {
  const words = id
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  if (words.length === 0) return id;
  const shown = words.map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w === 'pct' ? '%' : w));
  const first = shown[0]!;
  shown[0] = first === first.toUpperCase() ? first : first[0]!.toUpperCase() + first.slice(1);
  return shown.join(' ');
}

import { readFile, writeFile } from 'node:fs/promises';

import { stringify } from 'yaml';

import { logger } from '../shared/logger.js';

import type { DriftItem } from './config-drift.js';

interface NewTableEntry {
  schema: string;
  table: string;
  columns: Array<{ name: string; strategy: string }>;
}

interface CopyOnlyPatch {
  schema: string;
  table: string;
  columns: Array<{ name: string; strategy: string }>;
}

/**
 * Categorize drift items into new tables and copyOnly patches.
 */
function categorizeDriftItems(items: DriftItem[]): {
  newTables: Map<string, NewTableEntry>;
  copyOnlyPatches: Map<string, CopyOnlyPatch>;
} {
  const newTables = new Map<string, NewTableEntry>();
  const copyOnlyPatches = new Map<string, CopyOnlyPatch>();

  for (const item of items) {
    if (!item.column || !item.detection) continue;

    if (item.type === 'copyonly_has_pii') {
      const key = `${item.schema}.${item.table}`;
      let patch = copyOnlyPatches.get(key);
      if (!patch) {
        patch = { schema: item.schema, table: item.table, columns: [] };
        copyOnlyPatches.set(key, patch);
      }
      patch.columns.push({
        name: item.column,
        strategy: item.detection.suggestedMaskingStrategy,
      });
    } else if (item.type === 'new_pii_column') {
      const key = `${item.schema}.${item.table}`;
      let entry = newTables.get(key);
      if (!entry) {
        entry = { schema: item.schema, table: item.table, columns: [] };
        newTables.set(key, entry);
      }
      entry.columns.push({
        name: item.column,
        strategy: item.detection.suggestedMaskingStrategy,
      });
    }
  }

  return { newTables, copyOnlyPatches };
}

/**
 * Generate a YAML snippet for a single table entry.
 */
function tableEntryToYaml(entry: NewTableEntry, indent: string): string {
  const obj = {
    schema: entry.schema,
    table: entry.table,
    columns: entry.columns.map((c) => ({ name: c.name, strategy: c.strategy })),
  };
  const raw = stringify(obj, { lineWidth: 120 });
  // Prefix each line with proper indentation, and add `- ` for the first line
  const lines = raw.trimEnd().split('\n');
  const result: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i === 0) {
      result.push(`${indent}- ${lines[i]}`);
    } else {
      result.push(`${indent}  ${lines[i]}`);
    }
  }
  return result.join('\n');
}

/**
 * Detect the indentation used for table entries in the YAML file.
 */
function detectIndent(content: string): string {
  const match = /^( *)- schema:/m.exec(content);
  return match ? match[1]! : '  ';
}

/**
 * Find the insertion point for new table entries (end of tables array).
 * Returns the index in the string where new entries should be inserted.
 */
function findTablesEndPosition(content: string): number {
  // Find all "- schema:" occurrences to locate the last table entry
  const pattern = /^( *)- schema:/gm;
  let lastMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    lastMatch = match;
  }

  if (!lastMatch) return content.length;

  const indent = lastMatch[1]!;
  // From the last "- schema:", find where the table block ends:
  // the next line that has same or less indentation as the "- schema:" prefix,
  // or is another "- schema:", or is a top-level key, or EOF
  const afterLastEntry = content.substring(lastMatch.index);
  const lines = afterLastEntry.split('\n');
  let offset = lastMatch.index;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    // Skip empty lines
    if (line.trim() === '') {
      offset += lines[i - 1]!.length + 1;
      continue;
    }
    // Check if this line starts a new top-level key (no indent or less indent than table items)
    const lineIndent = /^( *)/.exec(line)?.[1] ?? '';
    if (lineIndent.length <= indent.length && !line.trimStart().startsWith('-')) {
      // This is a top-level key like "customStrategies:" or "ignore:"
      break;
    }
    offset += lines[i - 1]!.length + 1;
  }

  // Include the last line of the block
  if (lines.length > 1) {
    offset += lines[lines.length - 1]!.length;
    // But only if we consumed all lines (EOF case)
    if (afterLastEntry.length === offset - lastMatch.index) {
      return content.length;
    }
  }

  return offset;
}

/**
 * Apply a copyOnly patch: remove `copyOnly: true` and add columns section.
 */
function applyCopyOnlyPatch(content: string, patch: CopyOnlyPatch, indent: string): string {
  const lines = content.split('\n');
  const schemaLine = `${indent}- schema: ${patch.schema}`;
  const tableLine = `${indent}  table: ${patch.table}`;

  // Find the table block start
  let blockStart = -1;
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i] === schemaLine && lines[i + 1] === tableLine) {
      blockStart = i;
      break;
    }
  }
  if (blockStart === -1) return content;

  // Find block end: next "- schema:" at same indent or end of content
  let blockEnd = lines.length;
  for (let i = blockStart + 2; i < lines.length; i++) {
    if (lines[i]!.startsWith(`${indent}- schema:`)) {
      blockEnd = i;
      break;
    }
    // Top-level key (no indent or less indent than table entries)
    const trimmed = lines[i]!.trimStart();
    if (trimmed.length > 0 && lines[i] === trimmed && trimmed.match(/^\w/)) {
      blockEnd = i;
      break;
    }
  }

  // Build the new block
  const newLines: string[] = [
    lines[blockStart]!, // - schema: X
    lines[blockStart + 1]!, // table: Y
  ];

  // Copy other lines from the block (skip copyOnly line)
  for (let i = blockStart + 2; i < blockEnd; i++) {
    if (!/^\s*copyOnly:\s*true/.test(lines[i]!)) {
      newLines.push(lines[i]!);
    }
  }

  // Add columns section
  const columnsYaml = patch.columns
    .map((c) => `${indent}    - name: ${c.name}\n${indent}      strategy: ${c.strategy}`)
    .join('\n');
  newLines.splice(2, 0, `${indent}  columns:`, ...columnsYaml.split('\n'));

  const result = [...lines.slice(0, blockStart), ...newLines, ...lines.slice(blockEnd)];

  return result.join('\n');
}

/**
 * Apply drift results to a config file, preserving existing content and comments.
 * Only adds new entries; never removes existing ones.
 */
export async function applyDriftToConfig(
  configPath: string,
  items: DriftItem[],
): Promise<{ added: number; filePath: string }> {
  const { newTables, copyOnlyPatches } = categorizeDriftItems(items);

  const totalPatches = newTables.size + copyOnlyPatches.size;
  if (totalPatches === 0) {
    return { added: 0, filePath: configPath };
  }

  let content = await readFile(configPath, 'utf-8');
  const indent = detectIndent(content);
  let addedCount = 0;

  // Apply copyOnly patches first (modifies existing blocks)
  for (const patch of copyOnlyPatches.values()) {
    content = applyCopyOnlyPatch(content, patch, indent);
    addedCount += patch.columns.length;
  }

  // Append new tables at end of tables array
  if (newTables.size > 0) {
    const snippets: string[] = [];
    for (const entry of newTables.values()) {
      snippets.push(tableEntryToYaml(entry, indent));
      addedCount += entry.columns.length;
    }

    const insertPos = findTablesEndPosition(content);
    const newContent = '\n' + snippets.join('\n') + '\n';

    // Ensure there's a newline before insertion
    const before = content.substring(0, insertPos);
    const after = content.substring(insertPos);
    content = before.endsWith('\n') ? before + newContent.substring(1) : before + newContent;
    content = content + after;
  }

  await writeFile(configPath, content, 'utf-8');

  logger.success(`Applied ${addedCount} column(s) to ${configPath}`);

  return { added: addedCount, filePath: configPath };
}

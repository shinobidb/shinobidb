#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import cliProgress from 'cli-progress';
import { Command } from 'commander';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as {
  version: string;
};

import { buildAuditRecord, writeAuditLog } from './core/audit-logger.js';
import { applyDriftToConfig } from './core/config-applier.js';
import { detectDrift, buildSchemaMap } from './core/config-drift.js';
import type { DriftItem, DriftResult } from './core/config-drift.js';
import { generateConfig, configToYaml } from './core/config-generator.js';
import { loadConfig, loadSourceConnection } from './core/config-loader.js';
import { validateConfigDeep } from './core/config-validator.js';
import { executeMask, executeDryRun } from './core/mask-executor.js';
import type { DryRunResult, ProgressInfo } from './core/mask-executor.js';
import { diffScans } from './core/scan-diff.js';
import { scan } from './core/scanner.js';
import { saveSnapshot, loadSnapshot } from './core/snapshot.js';
import { createAdapter } from './db/factory.js';
import { createDefaultDetectors } from './detection/detector-factory.js';
import { ContentDetector } from './detection/detectors/content-detector.js';
import { loadCustomStrategies } from './masking/custom-strategy-loader.js';
import { createDefaultRegistry } from './masking/strategy-registry.js';
import { resolveConnection } from './shared/connection-resolver.js';
import {
  ShinobiError,
  DatabaseConnectionError,
  ConfigFileError,
  ConfigValidationError,
} from './shared/errors.js';
import { logger, setLogLevel, getLogLevel } from './shared/logger.js';
import { executeSync } from './sync/pipeline.js';
import type { SyncProgress } from './sync/types.js';

const program = new Command();

program
  .name('shinobidb')
  .description('Mask production database data for staging environments')
  .version(pkg.version)
  .option('-v, --verbose', 'Enable debug logging');

program.hook('preAction', (_thisCommand, actionCommand) => {
  const opts = actionCommand.optsWithGlobals() as { verbose?: boolean };
  if (opts.verbose) {
    setLogLevel('debug');
  }
});

program
  .command('scan')
  .description('Scan database for PII columns')
  .option('-c, --config <file>', 'Read source connection from config file')
  .option('--uri <uri>', 'Connection URI (e.g. mysql://user:pass@host:3306/db)')
  .option('--host <host>', 'Database host')
  .option('--port <port>', 'Database port', parseInt)
  .option('--user <user>', 'Database user')
  .option('--password <password>', 'Database password')
  .option('--type <type>', 'Database type (mysql, postgres, mongodb)')
  .option('--database <database>', 'Database name')
  .option('--schemas <schemas>', 'Comma-separated schema names')
  .option('--tables <tables>', 'Comma-separated table names')
  .option('--json', 'Output as JSON')
  .option('--sample-content', 'Sample actual data to detect PII by content patterns')
  .option('--snapshot [file]', 'Save scan results to a snapshot file', false)
  .option('--diff [file]', 'Compare with a previous snapshot', false)
  .action(
    async (opts: {
      config?: string;
      uri?: string;
      host?: string;
      port?: number;
      user?: string;
      password?: string;
      type?: string;
      database?: string;
      schemas?: string;
      tables?: string;
      json?: boolean;
      sampleContent?: boolean;
      snapshot?: boolean | string;
      diff?: boolean | string;
    }) => {
      const snapshotPath = resolve(
        typeof opts.snapshot === 'string' ? opts.snapshot : '.shinobidb/snapshot.json',
      );
      const diffPath = resolve(
        typeof opts.diff === 'string' ? opts.diff : '.shinobidb/snapshot.json',
      );

      const configConnection = opts.config
        ? await loadSourceConnection(resolve(opts.config))
        : undefined;
      const connConfig = await resolveConnection({
        ...opts,
        configConnection,
        role: 'source',
      });
      const adapter = createAdapter(connConfig);

      try {
        await adapter.connect();

        const detectors = createDefaultDetectors();
        if (opts.sampleContent) {
          detectors.push(new ContentDetector(adapter));
        }
        const result = await scan(adapter, detectors, {
          schemas: opts.schemas?.split(','),
          tables: opts.tables?.split(','),
        });

        if (opts.json) {
          logger.output(JSON.stringify(result, null, 2));
        } else {
          logger.output(
            `Scanned ${result.tablesScanned} table(s), ${result.columnsScanned} column(s)`,
          );
          logger.output(`Found ${result.detections.length} PII column(s):\n`);

          for (const d of result.detections) {
            logger.output(
              `  ${d.schema}.${d.table}.${d.column}  [${d.category}]  confidence: ${d.confidence}  strategy: ${d.suggestedMaskingStrategy}`,
            );
          }
        }

        if (opts.diff !== false) {
          const baseline = await loadSnapshot(diffPath);
          const diff = diffScans(baseline, result);

          if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) {
            logger.success('\nNo schema changes detected.');
          } else {
            logger.output(`\n--- Schema diff (vs ${diffPath}) ---`);

            if (diff.added.length > 0) {
              logger.output(`\nNew PII columns (${diff.added.length}):`);
              for (const d of diff.added) {
                logger.output(
                  `  + ${d.schema}.${d.table}.${d.column}  [${d.category}]  confidence: ${d.confidence}  strategy: ${d.suggestedMaskingStrategy}`,
                );
              }
            }

            if (diff.removed.length > 0) {
              logger.output(`\nRemoved PII columns (${diff.removed.length}):`);
              for (const d of diff.removed) {
                logger.output(`  - ${d.schema}.${d.table}.${d.column}  [${d.category}]`);
              }
            }

            if (diff.changed.length > 0) {
              logger.output(`\nChanged PII columns (${diff.changed.length}):`);
              for (const c of diff.changed) {
                logger.output(
                  `  ~ ${c.column.schema}.${c.column.table}.${c.column.column}  [${c.before.category} -> ${c.after.category}]  confidence: ${c.before.confidence} -> ${c.after.confidence}`,
                );
              }
            }

            logger.output(`\nUnchanged: ${diff.unchanged}`);
            process.exitCode = 1;
          }
        }

        if (opts.snapshot !== false) {
          await saveSnapshot(snapshotPath, result);
          logger.success(`Snapshot saved to ${snapshotPath}`);
        }
      } finally {
        await adapter.destroy();
      }
    },
  );

program
  .command('config')
  .description('Generate masking config YAML from scan results')
  .option('-c, --config <file>', 'Read source connection from existing config file')
  .option('--uri <uri>', 'Connection URI (e.g. mysql://user:pass@host:3306/db)')
  .option('--host <host>', 'Source database host')
  .option('--port <port>', 'Source database port', parseInt)
  .option('--user <user>', 'Source database user')
  .option('--password <password>', 'Source database password')
  .option('--type <type>', 'Database type (mysql, postgres, mongodb)')
  .option('--database <database>', 'Database name')
  .option('--schemas <schemas>', 'Comma-separated schema names')
  .option('--tables <tables>', 'Comma-separated table names')
  .option('--min-confidence <value>', 'Minimum confidence threshold', parseFloat)
  .option('--include-all-tables', 'Include tables without PII detections as copyOnly')
  .option('--sample-content', 'Sample actual data to detect PII by content patterns')
  .option('-o, --output <file>', 'Output file path', 'shinobidb.yaml')
  .action(
    async (opts: {
      config?: string;
      uri?: string;
      host?: string;
      port?: number;
      user?: string;
      password?: string;
      type?: string;
      database?: string;
      schemas?: string;
      tables?: string;
      minConfidence?: number;
      includeAllTables?: boolean;
      sampleContent?: boolean;
      output: string;
    }) => {
      const configConnection = opts.config
        ? await loadSourceConnection(resolve(opts.config))
        : undefined;
      const connConfig = await resolveConnection({
        ...opts,
        configConnection,
        role: 'source',
      });
      const adapter = createAdapter(connConfig);

      try {
        await adapter.connect();

        const detectors = createDefaultDetectors();
        if (opts.sampleContent) {
          detectors.push(new ContentDetector(adapter));
        }
        const scanResult = await scan(adapter, detectors, {
          schemas: opts.schemas?.split(','),
          tables: opts.tables?.split(','),
        });

        const config = generateConfig(scanResult, {
          source: {
            type: connConfig.type,
            host: connConfig.host,
            port: connConfig.port,
            user: connConfig.user,
            password: '<SOURCE_PASSWORD>',
            database: connConfig.database,
          },
          target: {
            type: connConfig.type,
            host: '<TARGET_HOST>',
            port: connConfig.port,
            user: '<TARGET_USER>',
            password: '<TARGET_PASSWORD>',
            database: connConfig.database,
          },
          minConfidence: opts.minConfidence,
          includeAllTables: opts.includeAllTables,
        });

        const yaml = configToYaml(config);
        const outputPath = resolve(opts.output);
        await writeFile(outputPath, yaml, 'utf-8');

        logger.success(`Config written to ${outputPath}`);
      } finally {
        await adapter.destroy();
      }
    },
  );

program
  .command('validate')
  .description('Validate a config file for errors and warnings')
  .option('-c, --config <file>', 'Config file path', 'shinobidb.yaml')
  .option('--json', 'Output results as JSON')
  .action(async (opts: { config: string; json?: boolean }) => {
    const configPath = resolve(opts.config);
    const config = await loadConfig(configPath);
    const registry = createDefaultRegistry();
    const configDir = resolve(configPath, '..');

    const result = await validateConfigDeep(config, registry, configDir);

    if (opts.json) {
      logger.output(JSON.stringify(result, null, 2));
    } else {
      const errors = result.issues.filter((i) => i.level === 'error');
      const warnings = result.issues.filter((i) => i.level === 'warning');

      for (const issue of errors) {
        logger.error(`ERROR: ${issue.message}`);
      }
      for (const issue of warnings) {
        logger.warn(`WARNING: ${issue.message}`);
      }

      if (result.valid) {
        logger.success(
          `Config is valid${warnings.length > 0 ? ` (${warnings.length} warning(s))` : ''}`,
        );
      } else {
        logger.error(
          `Config has ${errors.length} error(s)${warnings.length > 0 ? ` and ${warnings.length} warning(s)` : ''}`,
        );
        process.exitCode = 1;
      }
    }
  });

program
  .command('drift')
  .description('Detect schema drift between config and current database PII')
  .argument('<config-path>', 'Path to shinobidb config file')
  .option('--schemas <schemas>', 'Comma-separated schema filter')
  .option('--tables <tables>', 'Comma-separated table filter')
  .option('--sample-content', 'Sample actual data for PII detection')
  .option('--min-confidence <value>', 'Minimum confidence threshold', parseFloat, 0.5)
  .option('--json', 'Output as JSON')
  .option('--apply', 'Auto-update config with new entries')
  .action(
    async (
      configPath: string,
      opts: {
        schemas?: string;
        tables?: string;
        sampleContent?: boolean;
        minConfidence: number;
        json?: boolean;
        apply?: boolean;
      },
    ) => {
      const resolvedPath = resolve(configPath);
      const config = await loadConfig(resolvedPath);

      const connConfig = await resolveConnection({
        role: 'source',
        configConnection: config.source,
      });
      const adapter = createAdapter(connConfig);

      try {
        await adapter.connect();

        const detectors = createDefaultDetectors();
        if (opts.sampleContent) {
          detectors.push(new ContentDetector(adapter));
        }

        const scanResult = await scan(adapter, detectors, {
          schemas: opts.schemas?.split(','),
          tables: opts.tables?.split(','),
        });

        const schemas = opts.schemas?.split(',') ?? (await adapter.getSchemas());
        const schemaMap = await buildSchemaMap(adapter, schemas);

        const driftResult = detectDrift(config, scanResult, schemaMap, {
          minConfidence: opts.minConfidence,
        });

        if (
          opts.apply &&
          driftResult.items.some(
            (i) => i.type === 'copyonly_has_pii' || i.type === 'new_pii_column',
          )
        ) {
          const applyResult = await applyDriftToConfig(resolvedPath, driftResult.items);
          if (!opts.json) {
            logger.success(`Applied ${applyResult.added} column(s) to ${applyResult.filePath}`);
          }
        }

        if (opts.json) {
          logger.output(JSON.stringify(driftResult, null, 2));
        } else {
          formatDriftOutput(driftResult);
        }

        if (driftResult.hasActionableDrift) {
          process.exitCode = 1;
        }
      } finally {
        await adapter.destroy();
      }
    },
  );

program
  .command('mask')
  .description('Execute data masking based on config file')
  .option('-c, --config <file>', 'Config file path', 'shinobidb.yaml')
  .option('--source-password <password>', 'Source database password')
  .option('--target-password <password>', 'Target database password')
  .option('--dry-run', 'Preview masking results without writing to target')
  .option('--sample-rows <n>', 'Number of sample rows for dry-run (0 for all)', parseInt)
  .option('--json', 'Output dry-run results as JSON')
  .option('--sync-schema', 'Auto-create missing tables in target from source schema')
  .option(
    '--concurrency <n>',
    'Number of tables to process in parallel',
    (v: string) => parseInt(v, 10),
    1,
  )
  .option('--full-refresh', 'Force full copy for incremental tables, resetting sync state')
  .option('--no-progress', 'Disable progress bar')
  .option('--audit-log <file>', 'Write audit log to file (JSON or CSV based on extension)')
  .action(
    async (opts: {
      config: string;
      sourcePassword?: string;
      targetPassword?: string;
      dryRun?: boolean;
      sampleRows?: number;
      json?: boolean;
      syncSchema?: boolean;
      concurrency: number;
      fullRefresh?: boolean;
      progress: boolean;
      auditLog?: string;
    }) => {
      logger.warn(
        'DEPRECATED: "shinobidb mask" will be removed in a future version. Use "shinobidb sync" instead.',
      );
      const config = await loadConfig(resolve(opts.config));

      // Resolve source password: CLI flag > env var > config file > interactive prompt
      config.source.password = (
        await resolveConnection({
          role: 'source',
          password: opts.sourcePassword,
          configConnection: config.source,
        })
      ).password;

      if (opts.dryRun) {
        const source = createAdapter(config.source);
        const registry = createDefaultRegistry();
        if (config.customStrategies) {
          const configDir = resolve(opts.config, '..');
          await loadCustomStrategies(config.customStrategies, registry, configDir);
        }

        try {
          await source.connect();
          const dryRunResult = await executeDryRun(source, config, registry, opts.sampleRows ?? 3);

          if (opts.json) {
            logger.output(JSON.stringify(dryRunResult, null, 2));
          } else {
            formatDryRunOutput(dryRunResult);
          }
        } finally {
          await source.destroy();
        }
      } else {
        // Resolve target password: CLI flag > env var > config file > interactive prompt
        config.target.password = (
          await resolveConnection({
            role: 'target',
            password: opts.targetPassword,
            configConnection: config.target,
          })
        ).password;

        const source = createAdapter(config.source);
        const target = createAdapter(config.target);
        const registry = createDefaultRegistry();
        if (config.customStrategies) {
          const configDir = resolve(opts.config, '..');
          await loadCustomStrategies(config.customStrategies, registry, configDir);
        }

        try {
          await source.connect();
          await target.connect();

          const showProgress = opts.progress && !opts.json && process.stderr.isTTY;
          let progressBar: cliProgress.SingleBar | undefined;

          const onProgress = showProgress
            ? (info: ProgressInfo) => {
                if (!progressBar) {
                  progressBar = new cliProgress.SingleBar(
                    {
                      format:
                        '{bar} {percentage}% | {value}/{total} rows | {currentTable} | {tablesCompleted}/{tablesTotal} tables',
                      hideCursor: true,
                    },
                    cliProgress.Presets.shades_classic,
                  );
                  progressBar.start(info.totalRows || 1, 0, {
                    currentTable: info.currentTable,
                    tablesCompleted: 0,
                    tablesTotal: info.tablesTotal,
                  });
                }
                progressBar.update(Math.min(info.processedRows, info.totalRows || 1), {
                  currentTable: info.currentTable,
                  tablesCompleted: info.tablesCompleted,
                  tablesTotal: info.tablesTotal,
                });
              }
            : undefined;

          const startTime = Date.now();
          const result = await executeMask(source, target, config, registry, {
            syncSchema: opts.syncSchema,
            concurrency: opts.concurrency,
            fullRefresh: opts.fullRefresh,
            onProgress,
          });
          const durationMs = Date.now() - startTime;

          if (progressBar) {
            progressBar.stop();
          }

          logger.output(
            `Masked ${result.rowsProcessed} row(s) across ${result.tablesProcessed} table(s)`,
          );

          if (opts.auditLog) {
            const record = buildAuditRecord({
              config,
              result,
              durationMs,
              syncSchema: opts.syncSchema,
              concurrency: opts.concurrency,
            });
            await writeAuditLog(resolve(opts.auditLog), record);
          }
        } finally {
          await Promise.all([source.destroy(), target.destroy()]);
        }
      }
    },
  );

program
  .command('sync')
  .description('Sync and mask database using native dump → UPDATE mask → atomic swap')
  .option('-c, --config <file>', 'Config file path', 'shinobidb.yaml')
  .option('--source-password <password>', 'Source database password')
  .option('--target-password <password>', 'Target database password')
  .option('--dry-run', 'Dump, restore, and mask temp DB but skip swap (temp DB preserved)')
  .option('--keep-old', 'Keep old database after swap (for rollback)')
  .option('--keep-dump <path>', 'Save dump file to specified path')
  .option('--input-dump <path>', 'Restore from existing dump file (skip dump phase)')
  .option(
    '--concurrency <n>',
    'Number of tables to mask in parallel',
    (v: string) => parseInt(v, 10),
    1,
  )
  .option('--no-progress', 'Disable progress bar')
  .option('--audit-log <file>', 'Write audit log to file (JSON or CSV based on extension)')
  .option('--json', 'Output result as JSON')
  .action(
    async (opts: {
      config: string;
      sourcePassword?: string;
      targetPassword?: string;
      dryRun?: boolean;
      keepOld?: boolean;
      keepDump?: string;
      inputDump?: string;
      concurrency: number;
      progress: boolean;
      auditLog?: string;
      json?: boolean;
    }) => {
      const config = await loadConfig(resolve(opts.config));

      // Resolve passwords
      config.source.password = (
        await resolveConnection({
          role: 'source',
          password: opts.sourcePassword,
          configConnection: config.source,
        })
      ).password;

      config.target.password = (
        await resolveConnection({
          role: 'target',
          password: opts.targetPassword,
          configConnection: config.target,
        })
      ).password;

      const registry = createDefaultRegistry();
      if (config.customStrategies) {
        const configDir = resolve(opts.config, '..');
        await loadCustomStrategies(config.customStrategies, registry, configDir);
      }

      const showProgress = opts.progress && !opts.json && process.stderr.isTTY;
      let progressBar: cliProgress.SingleBar | undefined;

      const onProgress = showProgress
        ? (progress: SyncProgress) => {
            if (progress.phase === 'mask' && progress.totalRows != null) {
              if (!progressBar) {
                progressBar = new cliProgress.SingleBar(
                  {
                    format:
                      '{bar} {percentage}% | {value}/{total} rows | {currentTable} | {tablesCompleted}/{tablesTotal} tables',
                    hideCursor: true,
                  },
                  cliProgress.Presets.shades_classic,
                );
                progressBar.start(progress.totalRows || 1, 0, {
                  currentTable: progress.currentTable ?? '',
                  tablesCompleted: 0,
                  tablesTotal: progress.tablesTotal ?? 0,
                });
              }
              progressBar.update(Math.min(progress.processedRows ?? 0, progress.totalRows || 1), {
                currentTable: progress.currentTable ?? '',
                tablesCompleted: progress.tablesCompleted ?? 0,
                tablesTotal: progress.tablesTotal ?? 0,
              });
            } else if (!progressBar) {
              logger.info(`[${progress.phase}] ${progress.message}`);
            }
          }
        : undefined;

      const startTime = Date.now();
      const result = await executeSync(config, registry, {
        dryRun: opts.dryRun,
        keepOld: opts.keepOld,
        keepDump: opts.keepDump,
        inputDump: opts.inputDump,
        concurrency: opts.concurrency,
        onProgress,
      });
      const durationMs = Date.now() - startTime;

      if (progressBar) {
        progressBar.stop();
      }

      if (opts.json) {
        logger.output(JSON.stringify({ ...result, durationMs }, null, 2));
      } else {
        if (result.dryRun) {
          logger.output(
            `Dry run complete: ${result.rowsMasked} row(s) masked in ${result.tablesMasked} table(s)`,
          );
          logger.output(`Temp database preserved: ${result.tempDbName}`);
        } else {
          logger.output(
            `Sync complete: ${result.rowsMasked} row(s) masked in ${result.tablesMasked} table(s) (${(durationMs / 1000).toFixed(1)}s)`,
          );
        }
      }

      if (opts.auditLog) {
        const record = buildAuditRecord({
          config,
          result: {
            tablesProcessed: result.tablesMasked,
            rowsProcessed: result.rowsMasked,
            rowsWritten: result.rowsMasked,
            tableDetails: result.tableDetails.map((t) => ({
              schema: t.schema,
              table: t.table,
              rowsProcessed: t.rowsMasked,
              rowsWritten: t.rowsMasked,
              copyOnly: false,
              maskedColumns: t.maskedColumns,
            })),
          },
          durationMs,
          syncSchema: false,
          concurrency: opts.concurrency,
        });
        await writeAuditLog(resolve(opts.auditLog), record);
      }
    },
  );

function formatDriftOutput(result: DriftResult): void {
  logger.output('\nSchema Drift Report');
  logger.output('===================\n');

  const grouped: Record<string, DriftItem[]> = { critical: [], warning: [], info: [] };
  for (const item of result.items) {
    grouped[item.severity]!.push(item);
  }

  if (grouped.critical!.length > 0) {
    logger.output(`CRITICAL (${grouped.critical!.length})`);
    for (const item of grouped.critical!) {
      logger.output(
        `  ${item.schema}.${item.table}${item.column ? `.${item.column}` : ''} — ${item.message}`,
      );
      if (item.detection) {
        logger.output(`    Suggested strategy: ${item.detection.suggestedMaskingStrategy}`);
      }
    }
    logger.output('');
  }

  if (grouped.warning!.length > 0) {
    logger.output(`WARNING (${grouped.warning!.length})`);
    for (const item of grouped.warning!) {
      logger.output(
        `  ${item.schema}.${item.table}${item.column ? `.${item.column}` : ''} — ${item.message}`,
      );
      if (item.detection) {
        logger.output(`    Suggested strategy: ${item.detection.suggestedMaskingStrategy}`);
      }
    }
    logger.output('');
  }

  if (grouped.info!.length > 0) {
    logger.output(`INFO (${grouped.info!.length})`);
    for (const item of grouped.info!) {
      logger.output(
        `  ${item.schema}.${item.table}${item.column ? `.${item.column}` : ''} — ${item.message}`,
      );
    }
    logger.output('');
  }

  if (result.items.length === 0) {
    logger.success('No schema drift detected.');
  } else {
    logger.output(
      `Exit code: ${result.hasActionableDrift ? '1 (actionable drift detected)' : '0 (info only)'}`,
    );
  }
}

function formatDryRunOutput(result: DryRunResult): void {
  logger.output(
    `\nDry Run Preview — ${result.tables.length} table(s), ${result.totalRows} total row(s)\n`,
  );

  for (const table of result.tables) {
    if (table.copyOnly) {
      logger.output(`📋 ${table.schema}.${table.table} — copy only (${table.rowCount} row(s))`);
      continue;
    }

    logger.output(`🔒 ${table.schema}.${table.table} — ${table.rowCount} row(s)`);

    if (table.samples.length === 0) {
      logger.output('   (no rows to preview)\n');
      continue;
    }

    const columns = Object.keys(table.samples[0]!.before);

    for (let i = 0; i < table.samples.length; i++) {
      const sample = table.samples[i]!;
      logger.output(`   Row ${i + 1}:`);
      for (const col of columns) {
        const before = String(sample.before[col] ?? 'null');
        const after = String(sample.after[col] ?? 'null');
        if (before !== after) {
          logger.output(`     ${col}: ${before} → ${after}`);
        }
      }
    }
    logger.output('');
  }
}

program.parseAsync().catch((err: unknown) => {
  if (err instanceof DatabaseConnectionError) {
    logger.error(`Connection failed: ${err.message}`);
    logger.error('Hint: Check that the database is running and credentials are correct.');
  } else if (err instanceof ConfigFileError) {
    logger.error(`Config error: ${err.message}`);
    logger.error('Hint: Run "shinobidb config" to generate a valid config file.');
  } else if (err instanceof ConfigValidationError) {
    logger.error(`Invalid config: ${err.message}`);
    logger.error('Hint: Check the YAML structure matches the expected format.');
  } else if (err instanceof ShinobiError) {
    logger.error(`${err.code}: ${err.message}`);
  } else {
    logger.error(err instanceof Error ? err.message : String(err));
  }

  if (getLogLevel() === 'debug' && err instanceof Error && err.stack) {
    // Redact credentials from stack traces (URI passwords, connection string passwords)
    const sanitized = err.stack
      .replace(/:\/\/([^:]+):([^@]+)@/g, '://$1:[REDACTED]@')
      .replace(/password[=:]\s*\S+/gi, 'password=[REDACTED]');
    logger.debug(sanitized);
  }

  process.exitCode = 1;
});

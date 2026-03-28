#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Command } from 'commander';

import { generateConfig, configToYaml } from './core/config-generator.js';
import { loadConfig } from './core/config-loader.js';
import { executeMask } from './core/mask-executor.js';
import { scan } from './core/scanner.js';
import { createAdapter } from './db/factory.js';
import { createDefaultDetectors } from './detection/detector-factory.js';
import { createDefaultRegistry } from './masking/strategy-registry.js';
import {
  ShinobiError,
  DatabaseConnectionError,
  ConfigFileError,
  ConfigValidationError,
} from './shared/errors.js';
import { logger, setLogLevel, getLogLevel } from './shared/logger.js';

const program = new Command();

program
  .name('shinobidb')
  .description('Mask production database data for staging environments')
  .version('0.0.1')
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
  .requiredOption('--host <host>', 'Database host')
  .requiredOption('--port <port>', 'Database port', parseInt)
  .requiredOption('--user <user>', 'Database user')
  .requiredOption('--password <password>', 'Database password')
  .option('--type <type>', 'Database type', 'mysql')
  .option('--database <database>', 'Database name')
  .option('--schemas <schemas>', 'Comma-separated schema names')
  .option('--tables <tables>', 'Comma-separated table names')
  .option('--json', 'Output as JSON')
  .action(
    async (opts: {
      host: string;
      port: number;
      user: string;
      password: string;
      type: string;
      database?: string;
      schemas?: string;
      tables?: string;
      json?: boolean;
    }) => {
      const adapter = createAdapter({
        type: opts.type as 'mysql',
        host: opts.host,
        port: opts.port,
        user: opts.user,
        password: opts.password,
        database: opts.database,
      });

      try {
        await adapter.connect();

        const detectors = createDefaultDetectors();
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
      } finally {
        await adapter.destroy();
      }
    },
  );

program
  .command('config')
  .description('Generate masking config YAML from scan results')
  .requiredOption('--host <host>', 'Source database host')
  .requiredOption('--port <port>', 'Source database port', parseInt)
  .requiredOption('--user <user>', 'Source database user')
  .requiredOption('--password <password>', 'Source database password')
  .option('--type <type>', 'Database type', 'mysql')
  .option('--database <database>', 'Database name')
  .option('--schemas <schemas>', 'Comma-separated schema names')
  .option('--tables <tables>', 'Comma-separated table names')
  .option('--min-confidence <value>', 'Minimum confidence threshold', parseFloat)
  .option('-o, --output <file>', 'Output file path', 'shinobidb.yaml')
  .action(
    async (opts: {
      host: string;
      port: number;
      user: string;
      password: string;
      type: string;
      database?: string;
      schemas?: string;
      tables?: string;
      minConfidence?: number;
      output: string;
    }) => {
      const adapter = createAdapter({
        type: opts.type as 'mysql',
        host: opts.host,
        port: opts.port,
        user: opts.user,
        password: opts.password,
        database: opts.database,
      });

      try {
        await adapter.connect();

        const detectors = createDefaultDetectors();
        const scanResult = await scan(adapter, detectors, {
          schemas: opts.schemas?.split(','),
          tables: opts.tables?.split(','),
        });

        const config = generateConfig(scanResult, {
          source: {
            type: opts.type as 'mysql',
            host: opts.host,
            port: opts.port,
            user: opts.user,
            password: '<SOURCE_PASSWORD>',
            database: opts.database,
          },
          target: {
            type: opts.type as 'mysql',
            host: '<TARGET_HOST>',
            port: opts.port,
            user: '<TARGET_USER>',
            password: '<TARGET_PASSWORD>',
            database: opts.database,
          },
          minConfidence: opts.minConfidence,
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
  .command('mask')
  .description('Execute data masking based on config file')
  .option('-c, --config <file>', 'Config file path', 'shinobidb.yaml')
  .requiredOption('--source-password <password>', 'Source database password')
  .requiredOption('--target-password <password>', 'Target database password')
  .action(async (opts: { config: string; sourcePassword: string; targetPassword: string }) => {
    const config = await loadConfig(resolve(opts.config));

    config.source.password = opts.sourcePassword;
    config.target.password = opts.targetPassword;

    const source = createAdapter(config.source);
    const target = createAdapter(config.target);
    const registry = createDefaultRegistry();

    try {
      await source.connect();
      await target.connect();

      const result = await executeMask(source, target, config, registry);

      logger.output(
        `Masked ${result.rowsProcessed} row(s) across ${result.tablesProcessed} table(s)`,
      );
    } finally {
      await Promise.all([source.destroy(), target.destroy()]);
    }
  });

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
    logger.debug(err.stack);
  }

  process.exitCode = 1;
});

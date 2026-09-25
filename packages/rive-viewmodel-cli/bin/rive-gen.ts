#!/usr/bin/env node
/**
 * rive-gen CLI entry point.
 *
 * Usage:
 *   rive-gen --input path/to/file.riv [--output ./generated] [--name myFile]
 *            [--language dart|typescript] [--rive-import module]
 *            [--modern] [--interface] [--templates path/to/templates]
 */

import { Command } from 'commander';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { loadRiveWasm, loadRiveFile } from '../src/riveLoader.js';
import { buildIR } from '../src/irBuilder.js';
import {
  DEFAULT_RIVE_IMPORT,
  generate,
  Language,
  LANGUAGES,
} from '../src/generator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve the templates directory across every run context:
//   1. Bundled inside the published package (dist/bin -> <pkg>/templates/<language>).
//      `templates/` is copied from the repo's shared assets at build time.
//   2. Compiled from the repo (dist/bin -> repo-root/assets/templates/<language>).
//   3. Source via tsx (bin -> repo-root/assets/templates/<language>).
// The first candidate that exists on disk wins.
function defaultTemplatesDir(language: Language): string {
  const folder = LANGUAGES[language].templateFolder;
  const candidates = [
    path.resolve(__dirname, '../../templates', folder),
    path.resolve(__dirname, '../../../../assets/templates', folder),
    path.resolve(__dirname, '../../../assets/templates', folder),
  ];
  return candidates.find((dir) => fs.existsSync(dir)) ?? candidates[0];
}

function isLanguage(value: string): value is Language {
  return Object.hasOwn(LANGUAGES, value);
}

// Read the version from package.json so `--version` always matches the
// published package. npm always ships package.json at the tarball root, so:
//   1. Compiled/published (dist/bin -> <pkg>/package.json).
//   2. Source via tsx (bin -> <pkg>/package.json).
// The first candidate that exists on disk wins.
const PACKAGE_JSON_CANDIDATES = [
  path.resolve(__dirname, '../../package.json'),
  path.resolve(__dirname, '../package.json'),
];
const VERSION = (() => {
  for (const candidate of PACKAGE_JSON_CANDIDATES) {
    if (fs.existsSync(candidate)) {
      return JSON.parse(fs.readFileSync(candidate, 'utf-8')).version as string;
    }
  }
  return '0.0.0';
})();

const program = new Command();

program
  .name('rive-gen')
  .description('Generate ViewModel code from Rive (.riv) files')
  .version(VERSION)
  .requiredOption('-i, --input <file>', 'Path to the input .riv file')
  .option(
    '-o, --output <dir>',
    'Output directory (defaults to the same directory as the input file)',
  )
  .option(
    '-n, --name <name>',
    'Output file base name without extension (defaults to input file name)',
  )
  .option(
    '--language <language>',
    `Target language: ${Object.keys(LANGUAGES).join(' | ')}`,
    'dart',
  )
  .option(
    '--rive-import <module>',
    'TypeScript only: module exporting UntypedRiveViewModel and the binding params',
    DEFAULT_RIVE_IMPORT,
  )
  .option(
    '--modern',
    "Use modern Rive import 'package:rive/rive.dart' instead of rive_native",
    false,
  )
  .option('--interface', 'Implement the RiveViewModel interface', false)
  .option(
    '--templates <dir>',
    'Path to Mustache templates directory (default: the bundled templates of --language)',
  )
  .action(async (options) => {
    const inputPath = path.resolve(options.input as string);
    const language = options.language as string;

    if (!isLanguage(language)) {
      console.error(
        `Error: unsupported language '${language}' (expected ${Object.keys(LANGUAGES).join(' | ')})`,
      );
      process.exit(1);
    }

    if (!fs.existsSync(inputPath)) {
      console.error(`Error: input file not found: ${inputPath}`);
      process.exit(1);
    }

    if (!inputPath.endsWith('.riv')) {
      console.error('Error: input file must have a .riv extension');
      process.exit(1);
    }

    const inputFileName = path.basename(inputPath);
    const outputDir = options.output
      ? path.resolve(options.output as string)
      : path.dirname(inputPath);
    const outputBaseName =
      (options.name as string | undefined) ?? path.basename(inputPath, '.riv');
    const outputPath = path.join(
      outputDir,
      `${outputBaseName}${LANGUAGES[language].fileExtension}`,
    );

    const templatesDir = options.templates
      ? path.resolve(options.templates as string)
      : defaultTemplatesDir(language);
    const onWarning =
      language === 'typescript'
        ? (message: string) => console.warn(`Warning: ${message}`)
        : undefined;

    if (!fs.existsSync(templatesDir)) {
      console.error(
        `Error: templates directory not found: ${templatesDir}\n` +
          'Tip: run the CLI from the repo root, or pass --templates explicitly.',
      );
      process.exit(1);
    }

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    console.log(`Parsing: ${inputPath}`);

    // 1. Load the Rive WASM runtime
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let rive: any;
    try {
      process.stdout.write('Loading Rive WASM...');
      rive = await loadRiveWasm();
      process.stdout.write(' done\n');
    } catch (err) {
      process.stdout.write('\n');
      console.error('Failed to load Rive WASM:', (err as Error).message);
      process.exit(1);
    }

    // 2. Load the .riv file
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let riveFile: any;
    try {
      riveFile = await loadRiveFile(rive, inputPath);
    } catch (err) {
      console.error('Failed to load .riv file:', (err as Error).message);
      process.exit(1);
    }

    // 3. Build the intermediate representation
    let model;
    try {
      model = buildIR(riveFile, inputFileName, onWarning);
    } catch (err) {
      console.error('Failed to parse Rive file:', (err as Error).message);
      try { riveFile.unref?.(); } catch { /* ignore */ }
      process.exit(1);
    }

    console.log(
      `Found ${model.artboards.length} artboard(s), ` +
        `${model.viewModels.length} view model(s)`,
    );

    // 4. Generate code from Mustache templates
    let code: string;
    try {
      code = generate(model, templatesDir, {
        language,
        useInterface: options.interface as boolean,
        useModernRive: options.modern as boolean,
        riveImport: options.riveImport as string,
        onWarning,
      });
    } catch (err) {
      console.error('Failed to generate code:', (err as Error).message);
      try { riveFile.unref?.(); } catch { /* ignore */ }
      process.exit(1);
    }

    // 5. Write output
    fs.writeFileSync(outputPath, code, 'utf-8');
    console.log(`Generated: ${outputPath}`);

    // Best-effort cleanup — the WASM object may not support unref in all versions
    try { riveFile.unref?.(); } catch { /* ignore */ }
  });

program.parse();

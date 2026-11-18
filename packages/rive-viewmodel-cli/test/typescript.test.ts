import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generate } from '../src/generator.js';
import { buildIR } from '../src/irBuilder.js';
import { loadRiveFile, loadRiveWasm } from '../src/riveLoader.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');
const goldenDir = path.join(here, 'golden');
const templatesDir = path.resolve(here, '../../../assets/templates/typescript');
const fixtureNames = fs
  .readdirSync(fixturesDir)
  .filter((fileName) => fileName.endsWith('.riv'))
  .map((fileName) => path.basename(fileName, '.riv'));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let rive: any;

before(async () => {
  rive = await loadRiveWasm();
});

describe('typescript target', () => {
  for (const name of fixtureNames) {
    test(`matches the golden output of ${name}.riv`, async () => {
      const code = await generateTypeScript(name);
      const goldenPath = path.join(goldenDir, `${name}.ts`);

      if (process.env['UPDATE_GOLDEN']) {
        fs.writeFileSync(goldenPath, code);
      }

      assert.equal(code, fs.readFileSync(goldenPath, 'utf-8'));
    });
  }

  test('compiles the golden outputs with tsc --strict', () => {
    const tsc = path.resolve(here, '../node_modules/.bin/tsc');

    assert.doesNotThrow(() =>
      execFileSync(tsc, ['-p', path.join(here, 'tsconfig.golden.json')], {
        stdio: 'pipe',
      }),
    );
  });

  test('writes a property two levels below the root through the generated path', async () => {
    const riveFile = await loadRiveFile(
      rive,
      path.join(fixturesDir, 'data_bind_runtime_test.riv'),
    );
    const root = riveFile.viewModelByName('vm1').defaultInstance();
    const { createVm1ViewModel } = await import(
      pathToFileURL(path.join(goldenDir, 'data_bind_runtime_test.ts')).href
    );

    createVm1ViewModel(createUntypedRiveViewModel(root)).vm2.vm3.setInner(
      'from generated code',
    );

    assert.equal(
      root.viewModel('vm2').viewModel('vm3').string('inner').value,
      'from generated code',
    );
  });

  test('warns about unsupported list properties', async () => {
    const warnings: string[] = [];

    await generateTypeScript('global_view_models_test', (message) =>
      warnings.push(message),
    );

    assert.deepEqual(warnings, [
      'Skipped MainViewModel.listProperty: list properties are not supported',
    ]);
  });
});

async function generateTypeScript(
  name: string,
  onWarning: (message: string) => void = () => {},
): Promise<string> {
  const riveFile = await loadRiveFile(
    rive,
    path.join(fixturesDir, `${name}.riv`),
  );
  const model = buildIR(riveFile, `${name}.riv`, onWarning);
  return generate(model, templatesDir, { language: 'typescript', onWarning });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createUntypedRiveViewModel(root: any) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const at = (nestedViewModel?: string): any =>
    nestedViewModel ? root.viewModel(nestedViewModel) : root;
  return {
    setNumber: (name: string, value: number, nested?: string) =>
      (at(nested).number(name).value = value),
    setString: (name: string, value: string, nested?: string) =>
      (at(nested).string(name).value = value),
    setBoolean: (name: string, value: boolean, nested?: string) =>
      (at(nested).boolean(name).value = value),
    setEnum: (name: string, value: string, nested?: string) =>
      (at(nested).enum(name).value = value),
    setColor: (name: string, value: number, nested?: string) =>
      (at(nested).color(name).value = value),
    setImage: () => {
      throw new Error('not needed by this test');
    },
    fireTrigger: (name: string, nested?: string) =>
      at(nested).trigger(name).trigger(),
  };
}

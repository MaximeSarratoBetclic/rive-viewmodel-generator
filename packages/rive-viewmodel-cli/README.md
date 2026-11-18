# rive-gen CLI

[![npm version](https://img.shields.io/npm/v/@rive-viewmodel/cli?logo=npm&label=%40rive-viewmodel%2Fcli)](https://www.npmjs.com/package/@rive-viewmodel/cli)
[![node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![License: BSD-3-Clause](https://img.shields.io/badge/license-BSD--3--Clause-blue.svg)](../../LICENSE)

A Node.js CLI that generates Dart ViewModel wrapper code from Rive (`.riv`) files.

It uses `@rive-app/canvas-advanced` (the Rive JS/WASM runtime) to introspect `.riv` files and produces the same Dart output as the [web app](https://tguerin.github.io/rive-viewmodel-generator/).

> Part of the [rive-viewmodel-generator](../../README.md) monorepo.

## Prerequisites

- Node.js 18+
- npm 9+

## Install

### From npm (recommended)

```bash
npm install -g @rive-viewmodel/cli
```

Then use it from anywhere:

```bash
rive-gen --input path/to/MyAnimation.riv
```

Update to the latest published version:

```bash
npm install -g @rive-viewmodel/cli@latest
```

## Usage

### From the repo root (development)

Build the CLI first:

```bash
cd packages/rive-viewmodel-cli
npm install
npm run build
```

Then run it:

```bash
node packages/rive-viewmodel-cli/dist/bin/rive-gen.js --input path/to/file.riv
```

### Install globally via npm link

```bash
cd packages/rive-viewmodel-cli
npm install
npm run build
npm link
```

Then use it from anywhere:

```bash
rive-gen --input path/to/MyAnimation.riv
```

## Options

| Flag | Short | Description | Default |
|------|-------|-------------|---------|
| `--input <file>` | `-i` | Path to the `.riv` file | **required** |
| `--output <dir>` | `-o` | Output directory | Same as input file |
| `--name <name>` | `-n` | Output file base name (no extension) | Input file name |
| `--language <language>` | | Target language: `dart` or `typescript` | `dart` |
| `--rive-import <module>` | | TypeScript only: module that exports the session types | `@betclicgroup/common/cdk/assets/rive` |
| `--modern` | | Dart only: use `package:rive/rive.dart` import | `package:rive_native/rive_native.dart` |
| `--interface` | | Dart only: implement `RiveViewModel` interface | false |
| `--templates <dir>` | | Custom Mustache templates directory | `assets/templates/<language>/` |
| `--help` | `-h` | Display help | |
| `--version` | `-V` | Display version | |

## Examples

Generate with the legacy Rive import (default):

```bash
rive-gen -i assets/hero.riv -o lib/generated
```

Generate using the modern `package:rive` import:

```bash
rive-gen -i assets/hero.riv -o lib/generated --modern
```

Generate with the `RiveViewModel` interface implemented:

```bash
rive-gen -i assets/hero.riv -o lib/generated --modern --interface
```

Custom output file name:

```bash
rive-gen -i assets/hero_animation.riv -o lib/generated -n hero_view_model
```

## TypeScript target

`--language typescript` writes a `.ts` file that wraps an `UntypedRiveViewModel`
session with typed setters and triggers. It has no getters, streams or `dispose`:
it only emits what the session can do. The session types come from the
`--rive-import` module:

```ts
interface UntypedRiveViewModel {
  setNumber(name: string, value: number, nestedViewModel?: string): void;
  setString(name: string, value: string, nestedViewModel?: string): void;
  setBoolean(name: string, value: boolean, nestedViewModel?: string): void;
  setEnum(name: string, value: string, nestedViewModel?: string): void;
  setColor(name: string, value: number, nestedViewModel?: string): void;
  setImage(name: string, url: string, nestedViewModel?: string): Observable<void>;
  fireTrigger(name: string, nestedViewModel?: string): void;
}
```

The module must also export `RiveBindViewModelInstanceParams`,
`RiveNestedViewModelInstanceParams` and `RiveGlobalViewModelInstanceParams`.
The generated file has no runtime dependency other than `rxjs` and this module.

```bash
rive-gen -i assets/wheel.riv -o src/generated -n wheel-view-model --language typescript
```

### What the file contains

For a file with a `VmWheel` view model, a `VmSector` view model used in the
`instSector0`…`instSector11` slots, and a `ColorTheme` global view model:

- `WheelViewModelName`: the name of every top-level view model.
- `VmWheelInstance`, `VmSectorInstance`, …: the named instances of each view
  model, as an `as const` object and a union type of the same name.
- One union type per Rive enum, with the original values (no TypeScript `enum`).
- One interface and one factory per view model class, not per slot. Slots that
  share a class share its interface and its factory.
- One binding factory per top-level view model that is not global.

### Root and nested view models

`createVmWheelViewModel(viewModel, path?)` returns the typed wrapper. The root
call omits `path`. A nested slot is a getter that calls the factory of its
class with the full path from the root (`parent/child`), so every depth works
and a cycle cannot recurse forever:

```ts
const wheel = createVmWheelViewModel(session.viewModel);
wheel.setTxtTap('Tap to spin');
wheel.instSector3.setText('x2');
wheel.fireInWheel();
```

A global view model is not bound to an artboard. Its factory takes the session's
view model for that global:

```ts
const theme = createColorThemeViewModel(session.globalViewModel(WheelViewModelName.COLOR_THEME));
theme.setPrimaire(0xffe9312e);
```

### Binding

`createVmWheelBinding()` returns the `RiveBindViewModelInstanceParams` of the
root. It types the root instance, every nested slot whose class has named
instances, and every global view model that has named instances. Only the keys
you set produce an entry in `nestedInstances` or `globalInstances`:

```ts
public readonly riveBinding = createVmWheelBinding({
  instSector0: VmSectorInstance.SECTOR_0,
  colorTheme: ColorThemeInstance.INSTANCE,
});
```

A nested slot gets instance keys only when its shape matches a top-level view
model, so the instance names are known to exist.

### Known limits

- `@rive-app/canvas` up to 2.43.1 cannot resolve a view model path of more than
  two segments (`a/b/c`). The CLI warns for each such slot and emits no binding
  key for it. Its setters are still generated but have no effect at runtime.
- List, list index and artboard properties are not supported. The CLI warns and
  skips them.
- A view model with no supported property gets no interface and no factory. Its
  binding is still emitted.
- Every property of the `.riv` is generated, including the ones only the
  motion designer uses.

## Implementation notes

The WASM runtime is browser-first. For Node.js introspection (no rendering needed),
minimal DOM stubs (`document`, `navigator`, `window`) are installed before loading the
WASM. The Canvas/WebGL renderer is not used — only the `File` / `ViewModel` / `DataEnum`
APIs are called to read the `.riv` file structure.

## Shared templates

The Mustache templates in `assets/templates/dart/` are shared between this CLI and
the Flutter web app. The TypeScript templates in `assets/templates/typescript/`
are only used by this CLI. Pass `--templates` to use a custom template directory.

At build time (`npm run build`) these templates are copied into the package
(`templates/`, gitignored) so the published npm tarball is self-contained
and works when installed globally.

## Publishing (maintainers)

The package is published to npm under the public `@rive-viewmodel` scope.

```bash
cd packages/rive-viewmodel-cli
npm login                 # one-time, needs access to the @rive-viewmodel org
npm version patch         # or minor / major — bumps version + git tag
npm publish               # runs prepublishOnly (build) automatically
```

`prepublishOnly` rebuilds `dist/` and re-bundles `templates/` before every publish,
and `publishConfig.access = public` makes the scoped package public.

import {
  EnumModel,
  PropertyModel,
  PropertyType,
  RiveFileModel,
  ViewModelModel,
} from './models.js';
import { capitalize, toCamelCase, uncapitalize } from './stringUtils.js';

export interface TypeScriptContextOptions {
  riveImport: string;
  onWarning: (message: string) => void;
}

const MAX_LINE_LENGTH = 120;
const INDENT = '    ';
const MAX_RESOLVABLE_PATH_SEGMENTS = 2;

const VALUE_SETTERS: Partial<
  Record<PropertyType, { runtimeSetter: string; valueType: string }>
> = {
  [PropertyType.boolean]: { runtimeSetter: 'setBoolean', valueType: 'boolean' },
  [PropertyType.number]: { runtimeSetter: 'setNumber', valueType: 'number' },
  [PropertyType.integer]: { runtimeSetter: 'setNumber', valueType: 'number' },
  [PropertyType.string]: { runtimeSetter: 'setString', valueType: 'string' },
  [PropertyType.color]: { runtimeSetter: 'setColor', valueType: 'number' },
  [PropertyType.enumType]: { runtimeSetter: 'setEnum', valueType: 'string' },
};

interface MemberContext {
  isValue: boolean;
  isImage: boolean;
  isTrigger: boolean;
  isSlot: boolean;
  [field: string]: unknown;
}

interface ViewModelContext {
  interfaceName: string;
  factoryHead: string;
  members: MemberContext[];
}

interface BindingContext {
  hasSlots: boolean;
  hasGlobals: boolean;
  [field: string]: unknown;
}

interface NamingContext {
  classes: Map<string, ViewModelModel>;
  emptyClasses: Set<string>;
  enumNames: Set<string>;
  viewModelNameRefs: Map<string, string>;
}

export function buildTypeScriptContext(
  model: RiveFileModel,
  options: TypeScriptContextOptions,
): object {
  const classes = collectClasses(model.viewModels);
  const orderedClasses = orderClasses(model.viewModels, classes);
  const topLevelClasses = orderedClasses.filter(
    (vm) => vm.runtimeName !== undefined,
  );
  const viewModelNameConstant = `${model.fileNameBase}ViewModelName`;
  const viewModelNameKeys = uniqueConstantKeys(
    topLevelClasses.map((vm) => vm.runtimeName ?? vm.name),
  );
  const viewModelNameRefs = new Map(
    topLevelClasses.map((vm, i) => [
      vm.className,
      `${viewModelNameConstant}.${viewModelNameKeys[i]}`,
    ]),
  );
  const enums = buildEnums(collectEnums(model.viewModels));
  const emptyClasses = findEmptyClasses(classes);
  const naming: NamingContext = {
    classes,
    emptyClasses,
    enumNames: new Set(enums.map((e) => e.name)),
    viewModelNameRefs,
  };

  const viewModels = orderedClasses
    .filter((vm) => !emptyClasses.has(vm.className))
    .map((vm) => buildViewModel(vm, naming));
  const globals = topLevelClasses.filter(
    (vm) => vm.isGlobal && vm.instances.length > 0,
  );
  const bindings = topLevelClasses
    .filter((vm) => !vm.isGlobal)
    .map((vm) => buildBinding(vm, globals, naming, options.onWarning));

  return {
    fileName: model.fileName,
    hasViewModels: orderedClasses.length > 0,
    imports: buildImports(options.riveImport, viewModels, bindings),
    viewModelNameConstant,
    viewModelNames: topLevelClasses.map((vm, i) => ({
      key: viewModelNameKeys[i],
      value: quote(vm.runtimeName ?? vm.name),
    })),
    instances: topLevelClasses
      .filter((vm) => vm.instances.length > 0)
      .map(buildInstances),
    enums,
    viewModels,
    bindings,
  };
}

function collectClasses(
  viewModels: ViewModelModel[],
  classes: Map<string, ViewModelModel> = new Map(),
): Map<string, ViewModelModel> {
  for (const vm of viewModels) {
    if (!classes.has(vm.className)) classes.set(vm.className, vm);
    collectClasses(vm.nestedViewModels, classes);
  }
  return classes;
}

function orderClasses(
  topLevel: ViewModelModel[],
  classes: Map<string, ViewModelModel>,
): ViewModelModel[] {
  const referenced = new Set(
    [...classes.values()].flatMap((vm) =>
      slotsOf(vm).map((slot) => slot.metadata['returnType']),
    ),
  );
  const ordered: ViewModelModel[] = [];
  const visited = new Set<string>();
  const visit = (vm: ViewModelModel): void => {
    if (visited.has(vm.className)) return;
    visited.add(vm.className);
    ordered.push(vm);
    for (const slot of slotsOf(vm)) {
      const child = classes.get(slot.metadata['returnType']);
      if (child) visit(child);
    }
  };
  const artboardViewModels = topLevel.filter((vm) => !vm.isGlobal);
  [
    ...artboardViewModels.filter((vm) => !referenced.has(vm.className)),
    ...artboardViewModels,
    ...topLevel.filter((vm) => vm.isGlobal),
    ...classes.values(),
  ].forEach(visit);
  return ordered;
}

function slotsOf(vm: ViewModelModel): PropertyModel[] {
  return propertiesOf(vm).filter((p) => p.type === PropertyType.viewModel);
}

function propertiesOf(vm: ViewModelModel): PropertyModel[] {
  return [
    ...vm.properties,
    ...vm.listProperties.flatMap((listProperty) => listProperty.items),
  ];
}

function findEmptyClasses(classes: Map<string, ViewModelModel>): Set<string> {
  const emptyClasses = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const vm of classes.values()) {
      if (emptyClasses.has(vm.className)) continue;
      const hasMember = propertiesOf(vm).some((property) =>
        property.type === PropertyType.viewModel
          ? classes.has(property.metadata['returnType']) &&
            !emptyClasses.has(property.metadata['returnType'])
          : isSupportedMember(property.type),
      );
      if (!hasMember) {
        emptyClasses.add(vm.className);
        changed = true;
      }
    }
  }
  return emptyClasses;
}

function isSupportedMember(type: PropertyType): boolean {
  return (
    type === PropertyType.trigger ||
    type === PropertyType.image ||
    VALUE_SETTERS[type] !== undefined
  );
}

function uniqueConstantKeys(rawNames: string[]): string[] {
  const seen = new Set<string>();
  return rawNames.map((rawName) => {
    const base = toConstantKey(rawName);
    let key = base;
    for (let i = 2; seen.has(key); i++) key = `${base}_${i}`;
    seen.add(key);
    return key;
  });
}

function toConstantKey(rawName: string): string {
  const key = rawName
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  if (!key) return 'UNNAMED';
  return /^[0-9]/.test(key) ? `_${key}` : key;
}

function collectEnums(
  viewModels: ViewModelModel[],
  enums: EnumModel[] = [],
): EnumModel[] {
  for (const vm of viewModels) {
    enums.push(...vm.enums);
    collectEnums(vm.nestedViewModels, enums);
  }
  return enums;
}

function buildEnums(
  enums: EnumModel[],
): { name: string; declaration: string }[] {
  return enums.map((e) => {
    const values = e.values.map((v) => quote(v.value));
    const singleLine = `export type ${e.name} = ${values.join(' | ')};`;
    return {
      name: e.name,
      declaration:
        singleLine.length <= MAX_LINE_LENGTH
          ? singleLine
          : [
              `export type ${e.name} =`,
              ...values.map((value) => `${INDENT}| ${value}`),
            ].join('\n') + ';',
    };
  });
}

function buildInstances(vm: ViewModelModel): {
  name: string;
  values: { key: string; value: string }[];
} {
  const keys = uniqueConstantKeys(
    vm.instances.map((instance) => instance.value),
  );
  return {
    name: instanceTypeName(vm),
    values: vm.instances.map((instance, i) => ({
      key: keys[i],
      value: quote(instance.value),
    })),
  };
}

function buildViewModel(
  vm: ViewModelModel,
  naming: NamingContext,
): ViewModelContext {
  const interfaceName = vm.className;
  const factoryName = viewModelFactoryName(vm);
  return {
    interfaceName,
    factoryHead: functionHead(
      factoryName,
      ['viewModel: UntypedRiveViewModel', 'path?: string'],
      interfaceName,
    ),
    members: propertiesOf(vm)
      .map((property) => buildMember(property, naming))
      .filter((member): member is MemberContext => member !== null),
  };
}

function buildMember(
  property: PropertyModel,
  naming: NamingContext,
): MemberContext | null {
  const baseName = capitalize(
    toCamelCase(property.originalName) || property.name,
  );
  const riveName = quote(property.originalName);
  const flags = {
    isValue: false,
    isImage: false,
    isTrigger: false,
    isSlot: false,
  };

  if (property.type === PropertyType.viewModel) {
    const slotClass = naming.classes.get(property.metadata['returnType']);
    if (!slotClass || naming.emptyClasses.has(slotClass.className)) return null;
    return {
      ...flags,
      isSlot: true,
      name: property.name,
      slotInterfaceName: slotClass.className,
      slotFactoryName: viewModelFactoryName(slotClass),
      childPath: `path ? \`\${path}/${escapeTemplateLiteral(property.originalName)}\` : ${riveName}`,
    };
  }

  if (property.type === PropertyType.trigger) {
    const methodName = `fire${baseName}`;
    return {
      ...flags,
      isTrigger: true,
      methodName,
      implementation: arrowMember(
        methodName,
        '()',
        `viewModel.fireTrigger(${riveName}, path)`,
      ),
    };
  }

  if (property.type === PropertyType.image) {
    const methodName = `set${baseName}`;
    return {
      ...flags,
      isImage: true,
      methodName,
      implementation: arrowMember(
        methodName,
        'url',
        `viewModel.setImage(${riveName}, url, path)`,
      ),
    };
  }

  const setter = VALUE_SETTERS[property.type];
  if (!setter) return null;
  const enumType = property.metadata['enumType'];
  const methodName = `set${baseName}`;
  return {
    ...flags,
    isValue: true,
    methodName,
    valueType:
      property.type === PropertyType.enumType && naming.enumNames.has(enumType)
        ? enumType
        : setter.valueType,
    implementation: arrowMember(
      methodName,
      'value',
      `viewModel.${setter.runtimeSetter}(${riveName}, value, path)`,
    ),
  };
}

function buildBinding(
  root: ViewModelModel,
  globals: ViewModelModel[],
  naming: NamingContext,
  onWarning: (message: string) => void,
): BindingContext {
  const baseName = classBaseName(root);
  const bindingInterfaceName = `${baseName}Binding`;
  const hasInstance = root.instances.length > 0;
  const slots = collectBindingSlots(root, naming, onWarning);
  const globalFields = globals.map((global) => ({
    key: uncapitalize(classBaseName(global)),
    instanceTypeName: instanceTypeName(global),
    viewModelNameRef: naming.viewModelNameRefs.get(global.className),
  }));
  const hasFields = hasInstance || slots.length > 0 || globalFields.length > 0;
  const hasSlots = slots.length > 0;
  const hasGlobals = globalFields.length > 0;
  return {
    bindingInterfaceName,
    factoryHead: functionHead(
      `create${baseName}Binding`,
      hasFields ? [`binding: ${bindingInterfaceName} = {}`] : [],
      'RiveBindViewModelInstanceParams',
    ),
    viewModelNameRef: naming.viewModelNameRefs.get(root.className),
    instanceTypeName: instanceTypeName(root),
    hasFields,
    hasInstance,
    hasSlots,
    hasGlobals,
    hasSlotsAndGlobals: hasSlots && hasGlobals,
    hasCollections: hasSlots || hasGlobals,
    slots,
    globals: globalFields,
  };
}

function collectBindingSlots(
  vm: ViewModelModel,
  naming: NamingContext,
  onWarning: (message: string) => void,
  segments: string[] = [],
  keyParts: string[] = [],
  visiting: Set<string> = new Set([vm.className]),
): object[] {
  const result: object[] = [];
  for (const slot of slotsOf(vm)) {
    const slotClass = naming.classes.get(slot.metadata['returnType']);
    if (!slotClass || visiting.has(slotClass.className)) continue;
    const slotSegments = [...segments, slot.originalName];
    const slotKeyParts = [...keyParts, slot.name];
    if (slotSegments.length > MAX_RESOLVABLE_PATH_SEGMENTS) {
      onWarning(
        `Nested view model '${slotSegments.join('/')}' is ${slotSegments.length} levels deep: ` +
          '@rive-app/canvas <= 2.43.1 cannot resolve view model paths of more than ' +
          `${MAX_RESOLVABLE_PATH_SEGMENTS} segments, so its setters and instance binding have no effect`,
      );
      continue;
    }
    const viewModelNameRef = naming.viewModelNameRefs.get(slotClass.className);
    if (
      slot.metadata['matchesTopLevel'] === 'true' &&
      slotClass.instances.length > 0 &&
      viewModelNameRef
    ) {
      result.push({
        key: slotKeyParts[0] + slotKeyParts.slice(1).map(capitalize).join(''),
        propertyName: quote(slotSegments.join('/')),
        viewModelNameRef,
        instanceTypeName: instanceTypeName(slotClass),
      });
    }
    result.push(
      ...collectBindingSlots(
        slotClass,
        naming,
        onWarning,
        slotSegments,
        slotKeyParts,
        new Set([...visiting, slotClass.className]),
      ),
    );
  }
  return result;
}

function buildImports(
  riveImport: string,
  viewModels: ViewModelContext[],
  bindings: BindingContext[],
): { line: string }[] {
  const riveTypes = [
    ...(viewModels.length > 0 ? ['UntypedRiveViewModel'] : []),
    ...(bindings.length > 0 ? ['RiveBindViewModelInstanceParams'] : []),
    ...(bindings.some((b) => b.hasSlots)
      ? ['RiveNestedViewModelInstanceParams']
      : []),
    ...(bindings.some((b) => b.hasGlobals)
      ? ['RiveGlobalViewModelInstanceParams']
      : []),
  ].sort();
  const hasImages = viewModels.some((vm) =>
    vm.members.some((member) => member.isImage),
  );
  const imports: [string, string[]][] =
    riveTypes.length > 0 ? [[riveImport, riveTypes]] : [];
  if (hasImages) imports.push(['rxjs', ['Observable']]);
  return imports
    .sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map(([module, names]) => ({ line: importLine(module, names) }));
}

function importLine(module: string, names: string[]): string {
  const singleLine = `import { ${names.join(', ')} } from ${quote(module)};`;
  if (singleLine.length <= MAX_LINE_LENGTH) return singleLine;
  return [
    'import {',
    ...names.map((name) => `${INDENT}${name},`),
    `} from ${quote(module)};`,
  ].join('\n');
}

function functionHead(
  name: string,
  parameters: string[],
  returnType: string,
): string {
  const singleLine = `export function ${name}(${parameters.join(', ')}): ${returnType} {`;
  if (singleLine.length <= MAX_LINE_LENGTH) return singleLine;
  return [
    `export function ${name}(`,
    ...parameters.map((parameter) => `${INDENT}${parameter},`),
    `): ${returnType} {`,
  ].join('\n');
}

function arrowMember(name: string, parameter: string, body: string): string {
  const memberIndent = INDENT.repeat(2);
  const singleLine = `${memberIndent}${name}: ${parameter} => ${body},`;
  if (singleLine.length <= MAX_LINE_LENGTH) return singleLine;
  return `${memberIndent}${name}: ${parameter} =>\n${INDENT.repeat(3)}${body},`;
}

function viewModelFactoryName(vm: ViewModelModel): string {
  return `create${classBaseName(vm)}ViewModel`;
}

function instanceTypeName(vm: ViewModelModel): string {
  return `${classBaseName(vm)}Instance`;
}

function classBaseName(vm: ViewModelModel): string {
  return vm.className.endsWith('ViewModel')
    ? vm.className.slice(0, -'ViewModel'.length)
    : vm.className;
}

function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function escapeTemplateLiteral(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
}

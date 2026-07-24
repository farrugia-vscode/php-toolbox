import type { MethodCall, MethodDeclaration, ParamInfo } from '../php/members';
import type { TextEdit } from './editSet';

/** One parameter of the new signature, and where its value comes from. */
export interface ParamSpec {
  name: string;
  type: string | null;
  defaultText: string | null;
  /** Index of the parameter it replaces in the current signature, null when it is new. */
  originIndex: number | null;
  /** What callers have to pass for a new parameter. */
  argumentText: string | null;
}

/** Splits on commas that are not inside brackets, quotes or nested calls. */
export function splitTopLevel(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';

  for (const character of input) {
    if (quote) {
      quote = character === quote ? null : quote;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if ('([{'.includes(character)) {
      depth++;
    } else if (')]}'.includes(character)) {
      depth--;
    } else if (character === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }

    current += character;
  }

  if (current.trim() !== '') {
    parts.push(current.trim());
  }

  return parts;
}

/** The signature as an editable line, each parameter tagged with the slot it comes from. */
export function describeParams(method: MethodDeclaration): string {
  return method.params
    .map((param, index) => {
      const type = param.type ? `${param.type} ` : '';
      const value = param.defaultText ? ` = ${param.defaultText}` : '';

      return `#${index + 1} ${type}$${param.name}${value}`;
    })
    .join(', ');
}

const PARAM = /^(?:#(\d+)\s+)?(?:((?:\?|\\)?[\w\\|&]+)\s+)?\$(\w+)(?:\s*=\s*([\s\S]+))?$/;

/** Reads back the edited signature line, keeping track of which parameter was which. */
export function parseParams(input: string): ParamSpec[] | { error: string } {
  const specs: ParamSpec[] = [];

  for (const part of splitTopLevel(input)) {
    const match = PARAM.exec(part.trim());

    if (!match) {
      return { error: `${part} is not a valid parameter.` };
    }

    const [, origin, type, name, defaultText] = match;

    specs.push({
      name,
      type: type ?? null,
      defaultText: defaultText?.trim() ?? null,
      originIndex: origin ? Number(origin) - 1 : null,
      argumentText: null,
    });
  }

  return specs;
}

export function renderParams(specs: ParamSpec[]): string {
  return specs
    .map((spec) => {
      const type = spec.type ? `${spec.type} ` : '';
      const value = spec.defaultText ? ` = ${spec.defaultText}` : '';

      return `${type}$${spec.name}${value}`;
    })
    .join(', ');
}

export function declarationEdit(method: MethodDeclaration, specs: ParamSpec[]): TextEdit {
  return { start: method.paramsStart, end: method.paramsEnd, text: renderParams(specs) };
}

/** Promoted parameters declare properties: dropping one silently removes a property. */
export function promotedLoss(method: MethodDeclaration, specs: ParamSpec[]): ParamInfo[] {
  const kept = new Set(specs.map((spec) => spec.originIndex));

  return method.params.filter((param, index) => param.isPromoted && !kept.has(index));
}

/** The argument each new parameter gets at a call site, in the order of the new signature. */
function argumentsFor(text: string, call: MethodCall, method: MethodDeclaration, specs: ParamSpec[]): string[] | { error: string } {
  const positional = call.args.filter((argument) => argument.label === null);
  const named = new Map(call.args.filter((argument) => argument.label !== null).map((argument) => [argument.label!, argument]));
  const values: Array<{ text: string | null; isFallback: boolean }> = [];

  for (const spec of specs) {
    if (spec.originIndex === null) {
      values.push({ text: spec.argumentText ?? spec.defaultText, isFallback: spec.argumentText === null });
      continue;
    }

    const original = method.params[spec.originIndex];
    const argument = (original ? named.get(original.name) : undefined) ?? positional[spec.originIndex];

    values.push(
      argument
        ? { text: text.slice(argument.start, argument.end).trim(), isFallback: false }
        : { text: spec.defaultText ?? original?.defaultText ?? null, isFallback: true },
    );
  }

  // A value the caller never wrote belongs at the end or nowhere: PHP fills the tail in
  // from the defaults, but a hole in the middle has to be spelled out.
  while (values.length > 0 && values[values.length - 1].isFallback) {
    values.pop();
  }

  if (values.some((value) => value.text === null)) {
    return { error: 'a call would be left without a value for a parameter in the middle' };
  }

  return values.map((value) => value.text as string);
}

/** Rewrites one call to match the new signature. */
export function callEdit(
  text: string,
  call: MethodCall,
  method: MethodDeclaration,
  specs: ParamSpec[],
): TextEdit | { error: string } {
  if (call.hasSpread) {
    return { error: 'a call spreads its arguments' };
  }

  const values = argumentsFor(text, call, method, specs);

  if ('error' in values) {
    return values;
  }

  return { start: call.argsStart, end: call.argsEnd, text: values.join(', ') };
}

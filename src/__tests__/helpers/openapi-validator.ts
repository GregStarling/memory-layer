/**
 * Minimal zero-dependency OpenAPI contract validator for test use.
 *
 * Parses the subset of YAML that appears in `openapi.yaml` (indent-based
 * maps, scalars, inline arrays/objects) and exposes a `validate()` function
 * that checks an HTTP response body against the declared response schema
 * for a given `path` + `method` + `status` code.
 *
 * Scope is deliberately narrow: the goal is to catch contract drift where
 * HTTP responses stop matching the OpenAPI spec, not to be a general-purpose
 * JSON Schema validator. If a feature isn't needed by Phase 1-3 endpoint
 * responses, it's not supported here.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

type YamlValue =
  | string
  | number
  | boolean
  | null
  | YamlValue[]
  | { [key: string]: YamlValue };

/** Tokenize an indented YAML document into (indent, text) lines. */
function tokenizeLines(source: string): Array<{ indent: number; text: string }> {
  const lines: Array<{ indent: number; text: string }> = [];
  for (const raw of source.split('\n')) {
    // Strip trailing CR + comments (but keep # inside quoted strings — rare
    // in our openapi.yaml so we use a simple heuristic).
    let line = raw.replace(/\r$/, '');
    const hashIdx = line.indexOf('#');
    if (hashIdx >= 0) {
      // Don't strip inside a quoted value on the same line.
      const before = line.slice(0, hashIdx);
      if (!/["'][^"']*$/.test(before)) line = before;
    }
    if (line.trim() === '') continue;
    const match = line.match(/^(\s*)(.*)$/);
    if (!match) continue;
    lines.push({ indent: match[1].length, text: match[2] });
  }
  return lines;
}

/** Parse a scalar literal (number, bool, null, string). */
function parseScalar(raw: string): YamlValue {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  if (trimmed === 'null' || trimmed === '~') return null;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  if (/^-?\d+\.\d+$/.test(trimmed)) return Number(trimmed);
  // Strip quotes if present.
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Parse an inline flow value: `[a, b]`, `{a: 1}`, or a scalar. */
function parseFlowValue(raw: string): YamlValue {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner === '') return [];
    return splitFlowTopLevel(inner).map((part) => parseFlowValue(part));
  }
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner === '') return {};
    const obj: Record<string, YamlValue> = {};
    for (const part of splitFlowTopLevel(inner)) {
      const colon = part.indexOf(':');
      if (colon < 0) continue;
      const key = part.slice(0, colon).trim().replace(/^['"]|['"]$/g, '');
      obj[key] = parseFlowValue(part.slice(colon + 1));
    }
    return obj;
  }
  return parseScalar(trimmed);
}

/** Split comma-separated parts at the top bracket level. */
function splitFlowTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim() !== '') parts.push(current);
  return parts;
}

type Line = { indent: number; text: string };

function parseBlockScalar(
  lines: Line[],
  start: number,
  indent: number,
): { value: string; next: number } {
  const parts: string[] = [];
  let i = start;
  while (i < lines.length && lines[i].indent >= indent) {
    parts.push(lines[i].text.slice(indent));
    i += 1;
  }
  return { value: parts.join('\n'), next: i };
}

function parseBlock(lines: Line[], start: number, indent: number): { value: YamlValue; next: number } {
  // Detect list vs map by first non-trivial line at this indent.
  let i = start;
  while (i < lines.length && lines[i].indent < indent) i++;
  if (i >= lines.length) return { value: null, next: i };

  if (lines[i].text.startsWith('- ')) {
    // List
    const out: YamlValue[] = [];
    while (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith('- ')) {
      const itemText = lines[i].text.slice(2).trim();
      i++;
      if (itemText === '') {
        // Item is a nested map
        const { value, next } = parseBlock(lines, i, indent + 2);
        out.push(value);
        i = next;
      } else if (itemText.includes(':') && !itemText.trim().match(/^['"]/)) {
        // Inline map start: "- key: value" becomes a map entry for the list item
        const map: Record<string, YamlValue> = {};
        const colon = itemText.indexOf(':');
        const key = itemText.slice(0, colon).trim();
        const rest = itemText.slice(colon + 1).trim();
        if (rest === '') {
          const { value, next } = parseBlock(lines, i, indent + 2);
          map[key] = value;
          i = next;
        } else if (rest === '|' || rest === '>') {
          const { value, next } = parseBlockScalar(lines, i, indent + 4);
          map[key] = value;
          i = next;
        } else {
          map[key] = parseFlowValue(rest);
        }
        // Continue consuming additional keys in the same list-item (indent = indent + 2)
        while (i < lines.length && lines[i].indent === indent + 2 && !lines[i].text.startsWith('- ')) {
          const line = lines[i];
          const c = line.text.indexOf(':');
          if (c < 0) { i++; continue; }
          const k = line.text.slice(0, c).trim();
          const v = line.text.slice(c + 1).trim();
          i++;
          if (v === '') {
            const { value, next } = parseBlock(lines, i, indent + 4);
            map[k] = value;
            i = next;
          } else if (v === '|' || v === '>') {
            const { value, next } = parseBlockScalar(lines, i, indent + 4);
            map[k] = value;
            i = next;
          } else {
            map[k] = parseFlowValue(v);
          }
        }
        out.push(map);
      } else {
        out.push(parseFlowValue(itemText));
      }
    }
    return { value: out, next: i };
  }

  // Map
  const map: Record<string, YamlValue> = {};
  while (i < lines.length && lines[i].indent === indent && !lines[i].text.startsWith('- ')) {
    const line = lines[i];
    const colon = line.text.indexOf(':');
    if (colon < 0) { i++; continue; }
    const key = line.text.slice(0, colon).trim().replace(/^['"]|['"]$/g, '');
    const valueText = line.text.slice(colon + 1).trim();
    i++;
    if (valueText === '') {
      const { value, next } = parseBlock(lines, i, indent + 2);
      map[key] = value;
      i = next;
    } else if (valueText === '|' || valueText === '>') {
      const { value, next } = parseBlockScalar(lines, i, indent + 2);
      map[key] = value;
      i = next;
    } else {
      map[key] = parseFlowValue(valueText);
    }
  }
  return { value: map, next: i };
}

export function parseYaml(source: string): YamlValue {
  const lines = tokenizeLines(source);
  const { value } = parseBlock(lines, 0, 0);
  return value;
}

export type OpenApiDoc = Record<string, YamlValue>;

let cached: OpenApiDoc | null = null;

function findProjectRoot(): string {
  // This file lives at src/__tests__/helpers/openapi-validator.ts in source
  // and at dist/... when compiled. Walk up to find openapi.yaml.
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'openapi.yaml');
    try {
      readFileSync(candidate, 'utf8');
      return dir;
    } catch {
      dir = path.dirname(dir);
    }
  }
  throw new Error('openapi.yaml not found walking up from helper');
}

export function loadOpenApi(): OpenApiDoc {
  if (cached) return cached;
  const root = findProjectRoot();
  const text = readFileSync(path.join(root, 'openapi.yaml'), 'utf8');
  cached = parseYaml(text) as OpenApiDoc;
  return cached;
}

function isRecord(value: unknown): value is Record<string, YamlValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Resolve a $ref like '#/components/schemas/Playbook' against the doc root.
 * Returns null if the ref can't be followed.
 */
function resolveRef(doc: OpenApiDoc, ref: string): YamlValue | null {
  if (!ref.startsWith('#/')) return null;
  const parts = ref.slice(2).split('/');
  let node: YamlValue = doc;
  for (const part of parts) {
    if (!isRecord(node)) return null;
    node = node[part];
    if (node === undefined) return null;
  }
  return node;
}

/**
 * Validate a response body against a schema node. Returns an array of human
 * readable mismatches (empty means the response matches the spec).
 */
export function validateAgainstSchema(
  doc: OpenApiDoc,
  schema: YamlValue,
  value: unknown,
  pathLabel = '$',
): string[] {
  if (!schema) return [];
  if (isRecord(schema) && typeof schema.$ref === 'string') {
    const resolved = resolveRef(doc, schema.$ref);
    if (!resolved) return [`${pathLabel}: unresolvable $ref ${schema.$ref}`];
    return validateAgainstSchema(doc, resolved, value, pathLabel);
  }
  if (!isRecord(schema)) return [];
  const errors: string[] = [];
  const type = schema.type;
  const nullable = schema.nullable === true;

  if (value === null && nullable) {
    return errors;
  }

  if (type === 'object' || (isRecord(schema.properties) && type === undefined)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${pathLabel}: expected object, got ${describe(value)}`);
      return errors;
    }
    const record = value as Record<string, unknown>;
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    for (const key of required) {
      if (!(key in record)) {
        errors.push(`${pathLabel}.${key}: required field missing`);
      }
    }
    if (isRecord(schema.properties)) {
      for (const [key, childSchema] of Object.entries(schema.properties)) {
        if (key in record) {
          errors.push(
            ...validateAgainstSchema(doc, childSchema, record[key], `${pathLabel}.${key}`),
          );
        }
      }
    }
    return errors;
  }

  if (type === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`${pathLabel}: expected array, got ${describe(value)}`);
      return errors;
    }
    if (schema.items) {
      value.forEach((item, idx) => {
        errors.push(
          ...validateAgainstSchema(doc, schema.items as YamlValue, item, `${pathLabel}[${idx}]`),
        );
      });
    }
    return errors;
  }

  if (type === 'string') {
    if (value !== undefined && value !== null && typeof value !== 'string') {
      errors.push(`${pathLabel}: expected string, got ${describe(value)}`);
    } else if (
      typeof value === 'string' &&
      Array.isArray(schema.enum) &&
      !(schema.enum as unknown[]).includes(value)
    ) {
      errors.push(
        `${pathLabel}: value ${JSON.stringify(value)} not in enum [${(schema.enum as unknown[]).join(', ')}]`,
      );
    }
    return errors;
  }

  if (type === 'number' || type === 'integer') {
    if (value !== undefined && value !== null && typeof value !== 'number') {
      errors.push(`${pathLabel}: expected number, got ${describe(value)}`);
    }
    return errors;
  }

  if (type === 'boolean') {
    if (value !== undefined && value !== null && typeof value !== 'boolean') {
      errors.push(`${pathLabel}: expected boolean, got ${describe(value)}`);
    }
    return errors;
  }

  return errors;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Look up the response schema for a path + method + status code.
 * Returns null if the endpoint or status code isn't documented.
 */
export function getResponseSchema(
  doc: OpenApiDoc,
  apiPath: string,
  method: string,
  statusCode: string,
): YamlValue | null {
  const paths = doc.paths;
  if (!isRecord(paths)) return null;
  const pathItem = paths[apiPath];
  if (!isRecord(pathItem)) return null;
  const operation = pathItem[method.toLowerCase()];
  if (!isRecord(operation)) return null;
  const responses = operation.responses;
  if (!isRecord(responses)) return null;
  const response = responses[statusCode];
  if (!isRecord(response)) return null;
  const content = response.content;
  if (!isRecord(content)) return null;
  const json = content['application/json'];
  if (!isRecord(json)) return null;
  return json.schema ?? null;
}

/**
 * Convenience: validate a response body against the documented schema for
 * a path/method/status. Throws a descriptive error listing all mismatches.
 */
export function assertMatchesOpenApi(
  apiPath: string,
  method: string,
  statusCode: string,
  body: unknown,
): void {
  const doc = loadOpenApi();
  const schema = getResponseSchema(doc, apiPath, method, statusCode);
  if (!schema) {
    throw new Error(
      `OpenAPI contract check: no response schema found for ${method.toUpperCase()} ${apiPath} ${statusCode}`,
    );
  }
  const errors = validateAgainstSchema(doc, schema, body);
  if (errors.length > 0) {
    throw new Error(
      `OpenAPI contract drift for ${method.toUpperCase()} ${apiPath} ${statusCode}:\n  - ${errors.join('\n  - ')}`,
    );
  }
}

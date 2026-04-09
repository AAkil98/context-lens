/**
 * Lightweight JSON Schema validator — zero runtime dependencies.
 * Handles the subset of draft 2020-12 used by context-lens schemas.
 * @see cl-spec-011 §9.4
 */

export interface ValidationError {
  path: string;
  message: string;
  expected?: string;
  actual?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

type Schema = Record<string, unknown>;

// ── Core validator ───────────────────────────────────────────────

export function validateAgainstSchema(
  value: unknown,
  schema: Schema,
): ValidationResult {
  const errors: ValidationError[] = [];
  const defs = (schema['$defs'] as Record<string, Schema>) ?? {};
  walkSchema(value, schema, '', defs, errors);
  return { valid: errors.length === 0, errors };
}

function walkSchema(
  value: unknown,
  schema: Schema,
  path: string,
  defs: Record<string, Schema>,
  errors: ValidationError[],
): void {
  // Resolve $ref
  if ('$ref' in schema) {
    const ref = schema['$ref'] as string;
    const defName = ref.replace('#/$defs/', '');
    const resolved = defs[defName];
    if (resolved === undefined) {
      errors.push({ path, message: `Unresolved $ref: ${ref}` });
      return;
    }
    walkSchema(value, resolved, path, defs, errors);
    return;
  }

  // Handle oneOf (used for nullable types)
  if ('oneOf' in schema) {
    const oneOf = schema['oneOf'] as Schema[];
    const matched = oneOf.some(sub => {
      const subErrors: ValidationError[] = [];
      walkSchema(value, sub, path, defs, subErrors);
      return subErrors.length === 0;
    });
    if (!matched) {
      errors.push({
        path,
        message: `Value does not match any oneOf variant`,
        actual: typeOf(value),
      });
    }
    return;
  }

  // Type checking
  if ('type' in schema) {
    const schemaType = schema['type'] as string;

    if (value === null) {
      if (schemaType !== 'null') {
        errors.push({ path, message: `Expected ${schemaType}, got null`, expected: schemaType, actual: 'null' });
      }
      return;
    }

    if (value === undefined) {
      errors.push({ path, message: `Expected ${schemaType}, got undefined`, expected: schemaType, actual: 'undefined' });
      return;
    }

    switch (schemaType) {
      case 'string':
        if (typeof value !== 'string') {
          errors.push({ path, message: `Expected string`, expected: 'string', actual: typeOf(value) });
          return;
        }
        validateEnum(value, schema, path, errors);
        break;

      case 'number':
        if (typeof value !== 'number') {
          errors.push({ path, message: `Expected number`, expected: 'number', actual: typeOf(value) });
          return;
        }
        validateNumeric(value, schema, path, errors);
        break;

      case 'integer':
        if (typeof value !== 'number' || !Number.isInteger(value)) {
          errors.push({ path, message: `Expected integer`, expected: 'integer', actual: typeOf(value) });
          return;
        }
        validateNumeric(value, schema, path, errors);
        break;

      case 'boolean':
        if (typeof value !== 'boolean') {
          errors.push({ path, message: `Expected boolean`, expected: 'boolean', actual: typeOf(value) });
        }
        break;

      case 'array':
        if (!Array.isArray(value)) {
          errors.push({ path, message: `Expected array`, expected: 'array', actual: typeOf(value) });
          return;
        }
        validateArray(value, schema, path, defs, errors);
        break;

      case 'object':
        if (typeof value !== 'object' || Array.isArray(value)) {
          errors.push({ path, message: `Expected object`, expected: 'object', actual: typeOf(value) });
          return;
        }
        validateObject(value as Record<string, unknown>, schema, path, defs, errors);
        break;

      case 'null':
        if (value !== null) {
          errors.push({ path, message: `Expected null`, expected: 'null', actual: typeOf(value) });
        }
        break;
    }
  }

  // Handle enum without type
  if ('enum' in schema && !('type' in schema)) {
    validateEnum(value, schema, path, errors);
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function validateEnum(
  value: unknown,
  schema: Schema,
  path: string,
  errors: ValidationError[],
): void {
  if ('enum' in schema) {
    const allowed = schema['enum'] as unknown[];
    if (!allowed.includes(value)) {
      errors.push({
        path,
        message: `Value not in enum`,
        expected: allowed.join(', '),
        actual: String(value),
      });
    }
  }
}

function validateNumeric(
  value: number,
  schema: Schema,
  path: string,
  errors: ValidationError[],
): void {
  if ('minimum' in schema && value < (schema['minimum'] as number)) {
    errors.push({ path, message: `Value ${value} < minimum ${schema['minimum']}` });
  }
  if ('maximum' in schema && value > (schema['maximum'] as number)) {
    errors.push({ path, message: `Value ${value} > maximum ${schema['maximum']}` });
  }
  if ('exclusiveMinimum' in schema && value <= (schema['exclusiveMinimum'] as number)) {
    errors.push({ path, message: `Value ${value} <= exclusiveMinimum ${schema['exclusiveMinimum']}` });
  }
  if ('exclusiveMaximum' in schema && value >= (schema['exclusiveMaximum'] as number)) {
    errors.push({ path, message: `Value ${value} >= exclusiveMaximum ${schema['exclusiveMaximum']}` });
  }
}

function validateArray(
  value: unknown[],
  schema: Schema,
  path: string,
  defs: Record<string, Schema>,
  errors: ValidationError[],
): void {
  if ('minItems' in schema && value.length < (schema['minItems'] as number)) {
    errors.push({ path, message: `Array length ${value.length} < minItems ${schema['minItems']}` });
  }
  if ('maxItems' in schema && value.length > (schema['maxItems'] as number)) {
    errors.push({ path, message: `Array length ${value.length} > maxItems ${schema['maxItems']}` });
  }
  if ('items' in schema) {
    const itemSchema = schema['items'] as Schema;
    for (let i = 0; i < value.length; i++) {
      walkSchema(value[i], itemSchema, `${path}[${i}]`, defs, errors);
    }
  }
}

function validateObject(
  value: Record<string, unknown>,
  schema: Schema,
  path: string,
  defs: Record<string, Schema>,
  errors: ValidationError[],
): void {
  // Check required fields
  if ('required' in schema) {
    const required = schema['required'] as string[];
    for (const field of required) {
      if (!(field in value)) {
        errors.push({ path: joinPath(path, field), message: `Missing required field` });
      }
    }
  }

  // Validate known properties
  if ('properties' in schema) {
    const props = schema['properties'] as Record<string, Schema>;
    for (const [key, propSchema] of Object.entries(props)) {
      if (key in value) {
        walkSchema(value[key], propSchema, joinPath(path, key), defs, errors);
      }
    }
  }

  // additionalProperties with a schema (used for map-typed fields like perPattern, operationTimings)
  if ('additionalProperties' in schema && typeof schema['additionalProperties'] === 'object' && schema['additionalProperties'] !== null) {
    const addlSchema = schema['additionalProperties'] as Schema;
    const knownKeys = new Set(Object.keys((schema['properties'] as Record<string, unknown> | undefined) ?? {}));
    for (const [key, val] of Object.entries(value)) {
      if (!knownKeys.has(key)) {
        walkSchema(val, addlSchema, joinPath(path, key), defs, errors);
      }
    }
  }
}

function joinPath(base: string, field: string): string {
  return base ? `${base}.${field}` : field;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

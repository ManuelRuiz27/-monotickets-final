const INVALID = Symbol('zod_invalid');

export class ZodError extends Error {
  constructor(issues = []) {
    super('Validation error');
    this.name = 'ZodError';
    this.issues = issues;
  }
}

class BaseSchema {
  constructor() {
    this._optional = false;
    this._refinements = [];
  }

  optional() {
    const clone = this._clone();
    clone._optional = true;
    return clone;
  }

  refine(check, message = 'Invalid value') {
    const clone = this._clone();
    clone._refinements.push({ check, message });
    return clone;
  }

  safeParse(value, path = []) {
    if (value === undefined || value === null) {
      if (this._optional) {
        return { success: true, data: undefined };
      }
      const error = new ZodError([{ path, message: 'Required' }]);
      return { success: false, error };
    }

    const issues = [];
    const parsed = this._parse(value, path, issues);
    if (parsed === INVALID) {
      return { success: false, error: new ZodError(issues) };
    }

    for (const refinement of this._refinements) {
      let result = false;
      try {
        result = Boolean(refinement.check(parsed));
      } catch (error) {
        result = false;
      }
      if (!result) {
        issues.push({ path, message: refinement.message });
      }
    }

    if (issues.length > 0) {
      return { success: false, error: new ZodError(issues) };
    }

    return { success: true, data: parsed };
  }

  parse(value) {
    const result = this.safeParse(value);
    if (!result.success) {
      throw result.error;
    }
    return result.data;
  }

  _clone() {
    const copy = Object.create(this.constructor.prototype);
    Object.assign(copy, this);
    copy._refinements = Array.isArray(this._refinements) ? [...this._refinements] : [];
    return copy;
  }

  // eslint-disable-next-line class-methods-use-this
  _parse() {
    throw new Error('Not implemented');
  }
}

class ZodString extends BaseSchema {
  constructor() {
    super();
    this._checks = [];
    this._trim = false;
    this._toLowerCase = false;
  }

  min(length, message = `Must be at least ${length} characters`) {
    const clone = this._clone();
    clone._checks.push((value, path, issues) => {
      if (value.length < length) {
        issues.push({ path, message });
      }
    });
    return clone;
  }

  max(length, message = `Must be at most ${length} characters`) {
    const clone = this._clone();
    clone._checks.push((value, path, issues) => {
      if (value.length > length) {
        issues.push({ path, message });
      }
    });
    return clone;
  }

  regex(pattern, message = 'Invalid format') {
    const clone = this._clone();
    clone._checks.push((value, path, issues) => {
      if (!pattern.test(value)) {
        issues.push({ path, message });
      }
    });
    return clone;
  }

  trim() {
    const clone = this._clone();
    clone._trim = true;
    return clone;
  }

  toLowerCase() {
    const clone = this._clone();
    clone._toLowerCase = true;
    return clone;
  }

  _parse(value, path, issues) {
    if (typeof value !== 'string') {
      issues.push({ path, message: 'Expected string' });
      return INVALID;
    }

    let result = value;
    if (this._trim) {
      result = result.trim();
    }
    if (this._toLowerCase) {
      result = result.toLowerCase();
    }

    for (const check of this._checks) {
      check(result, path, issues);
      if (issues.length > 0) {
        return INVALID;
      }
    }

    return result;
  }
}

class ZodNumber extends BaseSchema {
  constructor() {
    super();
    this._coerce = false;
    this._checks = [];
  }

  coerce() {
    const clone = this._clone();
    clone._coerce = true;
    return clone;
  }

  min(value, message = `Must be greater than or equal to ${value}`) {
    const clone = this._clone();
    clone._checks.push((input, path, issues) => {
      if (input < value) {
        issues.push({ path, message });
      }
    });
    return clone;
  }

  max(value, message = `Must be less than or equal to ${value}`) {
    const clone = this._clone();
    clone._checks.push((input, path, issues) => {
      if (input > value) {
        issues.push({ path, message });
      }
    });
    return clone;
  }

  int(message = 'Expected integer') {
    const clone = this._clone();
    clone._checks.push((input, path, issues) => {
      if (!Number.isInteger(input)) {
        issues.push({ path, message });
      }
    });
    return clone;
  }

  positive(message = 'Must be greater than zero') {
    return this.min(0, message).refine((value) => value > 0, message);
  }

  _parse(value, path, issues) {
    let input = value;
    if (this._coerce && typeof input !== 'number') {
      const coerced = Number(input);
      if (!Number.isNaN(coerced)) {
        input = coerced;
      }
    }

    if (typeof input !== 'number' || Number.isNaN(input)) {
      issues.push({ path, message: 'Expected number' });
      return INVALID;
    }

    for (const check of this._checks) {
      check(input, path, issues);
      if (issues.length > 0) {
        return INVALID;
      }
    }

    return input;
  }
}

class ZodArray extends BaseSchema {
  constructor(elementSchema) {
    super();
    this.elementSchema = elementSchema;
    this._min = null;
  }

  min(length, message = `Expected at least ${length} items`) {
    const clone = this._clone();
    clone._min = { length, message };
    return clone;
  }

  _parse(value, path, issues) {
    if (!Array.isArray(value)) {
      issues.push({ path, message: 'Expected array' });
      return INVALID;
    }

    if (this._min && value.length < this._min.length) {
      issues.push({ path, message: this._min.message });
      return INVALID;
    }

    const result = [];
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];
      const parsed = this.elementSchema.safeParse(item, path.concat(index));
      if (!parsed.success) {
        issues.push(...parsed.error.issues);
        return INVALID;
      }
      result.push(parsed.data);
    }

    return result;
  }
}

class ZodUnion extends BaseSchema {
  constructor(options) {
    super();
    this.options = options;
  }

  _parse(value, path, issues) {
    for (const option of this.options) {
      const parsed = option.safeParse(value, path);
      if (parsed.success) {
        return parsed.data;
      }
    }
    issues.push({ path, message: 'No union variant matched' });
    return INVALID;
  }
}

class ZodEnum extends BaseSchema {
  constructor(values) {
    super();
    this.values = values;
  }

  _parse(value, path, issues) {
    if (typeof value !== 'string') {
      issues.push({ path, message: 'Expected string' });
      return INVALID;
    }
    if (!this.values.includes(value)) {
      issues.push({ path, message: 'Invalid enum value' });
      return INVALID;
    }
    return value;
  }
}

class ZodRecord extends BaseSchema {
  constructor(valueSchema) {
    super();
    this.valueSchema = valueSchema;
  }

  _parse(value, path, issues) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      issues.push({ path, message: 'Expected object' });
      return INVALID;
    }
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
      const parsed = this.valueSchema.safeParse(entry, path.concat(key));
      if (!parsed.success) {
        issues.push(...parsed.error.issues);
        return INVALID;
      }
      result[key] = parsed.data;
    }
    return result;
  }
}

class ZodAny extends BaseSchema {
  // eslint-disable-next-line class-methods-use-this
  _parse(value) {
    return value;
  }
}

class ZodObject extends BaseSchema {
  constructor(shape) {
    super();
    this.shape = shape;
    this._unknownBehavior = 'strip';
    this._catchall = null;
  }

  passthrough() {
    const clone = this._clone();
    clone._unknownBehavior = 'passthrough';
    return clone;
  }

  strip() {
    const clone = this._clone();
    clone._unknownBehavior = 'strip';
    return clone;
  }

  strict() {
    const clone = this._clone();
    clone._unknownBehavior = 'strict';
    return clone;
  }

  catchall(schema) {
    const clone = this._clone();
    clone._catchall = schema;
    clone._unknownBehavior = 'passthrough';
    return clone;
  }

  _parse(value, path, issues) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      issues.push({ path, message: 'Expected object' });
      return INVALID;
    }

    const result = {};
    for (const [key, schema] of Object.entries(this.shape)) {
      const parsed = schema.safeParse(value[key], path.concat(key));
      if (!parsed.success) {
        issues.push(...parsed.error.issues);
        return INVALID;
      }
      if (parsed.data !== undefined) {
        result[key] = parsed.data;
      }
    }

    for (const [key, entry] of Object.entries(value)) {
      if (key in this.shape) {
        continue;
      }
      if (this._unknownBehavior === 'passthrough') {
        if (this._catchall) {
          const parsed = this._catchall.safeParse(entry, path.concat(key));
          if (!parsed.success) {
            issues.push(...parsed.error.issues);
            return INVALID;
          }
          result[key] = parsed.data;
        } else {
          result[key] = entry;
        }
      } else if (this._unknownBehavior === 'strict') {
        issues.push({ path: path.concat(key), message: 'Unknown key' });
        return INVALID;
      }
    }

    return result;
  }
}

export const z = {
  string: () => new ZodString(),
  number: () => new ZodNumber(),
  array: (schema) => new ZodArray(schema),
  union: (schemas) => new ZodUnion(schemas),
  enum: (values) => new ZodEnum(values),
  record: (schema) => new ZodRecord(schema),
  object: (shape) => new ZodObject(shape),
  any: () => new ZodAny(),
};


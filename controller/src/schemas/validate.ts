// JSON Schema validation for every factory artifact, policy and config file.
// Schemas live in the repository's top-level schemas/ directory (JSON Schema 2020-12).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Module, { type AnySchemaObject } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

// ajv and ajv-formats are CommonJS; under NodeNext their default export is the module object.
const Ajv2020 = Ajv2020Module.default;
const addFormats = addFormatsModule.default;

export const SCHEMA_DIR = fileURLToPath(new URL("../../../schemas/", import.meta.url));

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface Validator {
  /** Schema file names, e.g. "spec.schema.json". */
  readonly schemas: readonly string[];
  validate(schema: string, data: unknown): ValidationResult;
}

export function createValidator(schemaDir: string = SCHEMA_DIR): Validator {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);

  const files = readdirSync(schemaDir).filter((f) => f.endsWith(".schema.json")).sort();
  const ids = new Map<string, string>();
  for (const file of files) {
    const schema = JSON.parse(readFileSync(join(schemaDir, file), "utf8")) as AnySchemaObject;
    if (typeof schema.$id !== "string") throw new Error(`${file}: missing $id`);
    ajv.addSchema(schema);
    ids.set(file, schema.$id);
  }

  return {
    schemas: files,
    validate(schema, data) {
      const id = ids.get(schema);
      if (id === undefined) throw new Error(`unknown schema: ${schema}`);
      const check = ajv.getSchema(id);
      if (check === undefined) throw new Error(`schema failed to compile: ${schema}`);
      // No schema is async, so a validation result is always a boolean.
      const valid = check(data) === true;
      const errors = (check.errors ?? []).map((e) => `${e.instancePath === "" ? "/" : e.instancePath} ${e.message ?? "is invalid"}`);
      return { valid, errors };
    },
  };
}

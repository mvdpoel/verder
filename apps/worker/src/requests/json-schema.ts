import { z } from "zod";

/**
 * The JSON Schema a tool advertises in `tools/list`, derived from the zod
 * schema that validates its arguments — so what the model is told and what is
 * enforced cannot drift. Covers exactly the shapes the tools use.
 */
export function jsonSchemaOf(t: z.ZodTypeAny): Record<string, unknown> {
  const desc = t.description ? { description: t.description } : {};
  if (t instanceof z.ZodOptional || t instanceof z.ZodNullable) return { ...jsonSchemaOf(t.unwrap()), ...desc };
  if (t instanceof z.ZodDefault) return { ...jsonSchemaOf(t._def.innerType), ...desc };
  if (t instanceof z.ZodEffects) return { ...jsonSchemaOf(t.innerType()), ...desc };
  if (t instanceof z.ZodString) {
    const out: Record<string, unknown> = { type: "string", ...desc };
    for (const c of t._def.checks) {
      if (c.kind === "max") out.maxLength = c.value;
      if (c.kind === "min") out.minLength = c.value;
    }
    return out;
  }
  if (t instanceof z.ZodNumber) {
    const out: Record<string, unknown> = { type: t._def.checks.some((c) => c.kind === "int") ? "integer" : "number", ...desc };
    for (const c of t._def.checks) {
      if (c.kind === "max") out.maximum = c.value;
      if (c.kind === "min") out.minimum = c.value;
    }
    return out;
  }
  if (t instanceof z.ZodEnum) return { type: "string", enum: [...t.options], ...desc };
  if (t instanceof z.ZodArray) {
    const out: Record<string, unknown> = { type: "array", items: jsonSchemaOf(t.element), ...desc };
    if (t._def.maxLength) out.maxItems = t._def.maxLength.value;
    return out;
  }
  if (t instanceof z.ZodObject) {
    const shape = t.shape as Record<string, z.ZodTypeAny>;
    const required = Object.entries(shape)
      .filter(([, v]) => !(v instanceof z.ZodOptional || v instanceof z.ZodDefault || v instanceof z.ZodNullable))
      .map(([k]) => k);
    return {
      type: "object", ...desc,
      properties: Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, jsonSchemaOf(v)])),
      ...(required.length ? { required } : {}),
      additionalProperties: false,
    };
  }
  throw new Error(`jsonSchemaOf: unsupported zod type ${t.constructor.name}`);
}

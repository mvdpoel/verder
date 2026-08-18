export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(v: unknown): string {
  if (v === null) return "null";
  const t = typeof v;
  if (t === "string") return JSON.stringify(v);
  if (t === "boolean") return v ? "true" : "false";
  if (t === "number") {
    if (!Number.isFinite(v as number)) throw new TypeError("Non-finite number in canonical JSON");
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(serialize).join(",")}]`;
  if (t === "object") {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, val]) => {
        if (val === undefined) throw new TypeError("undefined value in canonical JSON");
        return true;
      })
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${serialize(val)}`).join(",")}}`;
  }
  throw new TypeError(`Unsupported type in canonical JSON: ${t}`);
}

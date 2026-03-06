const expressionCache = new Map<string, (context: Record<string, unknown>) => unknown>();

export function evaluateExpression<T = unknown>(expression: string, context: Record<string, unknown>): T {
  const trimmed = expression.trim();
  if (!trimmed) {
    return undefined as T;
  }
  if (trimmed.startsWith("$")) {
    return resolvePointer(trimmed, context) as T;
  }
  let compiled = expressionCache.get(trimmed);
  if (!compiled) {
    compiled = new Function("context", `with (context) { return (${trimmed}); }`) as (
      ctx: Record<string, unknown>,
    ) => unknown;
    expressionCache.set(trimmed, compiled);
  }
  return compiled(context) as T;
}

export function resolvePointer(pointer: string, context: Record<string, unknown>): unknown {
  const path = pointer.replace(/^\$+/, "");
  if (!path) return context;
  const segments = path.split(".").filter(Boolean);
  let current: unknown = context;
  for (const segment of segments) {
    if (current && typeof current === "object" && segment in current) {
      current = (current as Record<string, unknown>)[segment];
      continue;
    }
    return undefined;
  }
  return current;
}

export function interpolateTemplate(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{\{(.*?)\}\}/g, (_match, expr) => {
    try {
      const value = evaluateExpression(expr, context);
      if (value === undefined || value === null) {
        return "";
      }
      if (typeof value === "object") {
        return JSON.stringify(value);
      }
      return String(value);
    } catch (err) {
      return `[[error:${(err as Error).message}]]`;
    }
  });
}

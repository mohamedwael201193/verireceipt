import { badRequest } from "./errors";

/** Read the raw query so duplicate and prototype keys cannot silently disappear. */
export function exactQuery(rawUrl: string, allowed: readonly string[]): Record<string, string> {
  const output: Record<string, string> = Object.create(null) as Record<string, string>;
  const params = new URLSearchParams(rawUrl.includes("?") ? rawUrl.slice(rawUrl.indexOf("?") + 1) : "");
  for (const [key, value] of params) {
    if (!allowed.includes(key)) throw badRequest("UNKNOWN_PARAM", `Unsupported query parameter: ${key}`);
    if (Object.hasOwn(output, key)) throw badRequest("DUPLICATE_PARAM", `Query parameter ${key} was given more than once`);
    output[key] = value;
  }
  return output;
}

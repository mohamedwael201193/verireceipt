// Bounded public-source reads. Callers choose fixed, reviewed upstream hosts.
// A timer races the entire body read, not only receipt of HTTP headers.
export class SourceReadError extends Error {
  constructor(public readonly code: string, public readonly httpStatus?: number) {
    super(code);
    this.name = "SourceReadError";
  }
}
let active = 0;
const MAX_ACTIVE_READS = 12;
export async function boundedSourceText(
  url: string,
  options: { timeoutMs: number; maxBytes: number; headers?: Record<string, string> },
): Promise<{ raw: string; fetchedAt: string }> {
  if (active >= MAX_ACTIVE_READS) throw new SourceReadError("SOURCE_BUSY");
  active++;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelRead: (() => void) | undefined;
  const run = async () => {
    const response = await fetch(url, { headers: options.headers, signal: controller.signal, redirect: "error" });
    if (!response.ok) {
      controller.abort();
      throw new SourceReadError("SOURCE_HTTP_ERROR", response.status);
    }
    const length = response.headers.get("content-length");
    if (length && /^\d+$/.test(length) && Number(length) > options.maxBytes) {
      controller.abort();
      throw new SourceReadError("SOURCE_TOO_LARGE");
    }
    if (!response.body) throw new SourceReadError("SOURCE_EMPTY_BODY");
    const reader = response.body.getReader();
    cancelRead = () => { void reader.cancel().catch(() => undefined); };
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > options.maxBytes) {
          controller.abort();
          void reader.cancel().catch(() => undefined);
          throw new SourceReadError("SOURCE_TOO_LARGE");
        }
        chunks.push(Buffer.from(part.value));
      }
    } finally {
      cancelRead = undefined;
      reader.releaseLock();
    }
    const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, size));
    return { raw, fetchedAt: new Date().toISOString() };
  };
  try {
    return await Promise.race([
      run().finally(() => { active--; }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new SourceReadError("SOURCE_TIMEOUT"));
          controller.abort();
          cancelRead?.();
        }, options.timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

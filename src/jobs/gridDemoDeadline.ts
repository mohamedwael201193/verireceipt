/** Caller deadline stays bounded even when the source joins a longer shared flight. */
export async function gridDemoDeadline<T>(work: Promise<T>, timeoutMs = 15_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('grid demo deadline exceeded')), timeoutMs);
      timer.unref();
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

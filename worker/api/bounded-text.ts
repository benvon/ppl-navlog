/** Read untrusted upstream bodies without buffering unbounded content first. */
export async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number.parseInt(response.headers.get("Content-Length") ?? "0", 10);
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("upstream body exceeds limit");
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) throw new Error("upstream body exceeds limit");
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

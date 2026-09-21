import { describe, expect, it } from "vitest";
import { readBoundedText } from "./bounded-text";

describe("bounded upstream text", () => {
  it("reads a body at the byte limit", async () => {
    expect(await readBoundedText(new Response("12345"), 5)).toBe("12345");
  });

  it("rejects a forged small content length before buffering a larger stream", async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("123456")); },
      cancel() { canceled = true; },
    });
    await expect(readBoundedText(new Response(body, { headers: { "Content-Length": "1" } }), 5)).rejects.toThrow("exceeds limit");
    expect(canceled).toBe(true);
  });

  it("rejects an oversized declared length without reading", async () => {
    await expect(readBoundedText(new Response("small", { headers: { "Content-Length": "100" } }), 5)).rejects.toThrow("exceeds limit");
  });
});

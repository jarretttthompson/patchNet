// Native CompressionStream / DecompressionStream wrapper.
// Supported: Chrome 80+, Firefox 113+, Safari 16.4+. Zero dependencies.
//
// Uses Response.body.pipeThrough() — the idiomatic approach that avoids the
// TransformStream backpressure deadlock that happens when you await writer.write()
// before starting to drain the readable side.

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function collectResponse(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

export async function compressPatch(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const compressed = await collectResponse(
    new Response(bytes).body!.pipeThrough(new CompressionStream("deflate-raw"))
  );
  return uint8ToBase64(compressed)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

export async function decompressPatch(encoded: string): Promise<string> {
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const decompressed = await collectResponse(
    new Response(bytes).body!.pipeThrough(new DecompressionStream("deflate-raw"))
  );
  return new TextDecoder().decode(decompressed);
}

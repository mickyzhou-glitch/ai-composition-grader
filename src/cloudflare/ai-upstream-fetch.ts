import { connect as workerConnect } from "cloudflare:sockets";

interface IpSocket {
  opened: Promise<unknown>;
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): Promise<void>;
}

type IpConnector = (
  address: { hostname: string; port: number },
  options: { allowHalfOpen: true },
) => IpSocket;

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const encoder = new TextEncoder();

function headerEnd(bytes: Uint8Array): number {
  for (let index = 0; index <= bytes.length - 4; index += 1) {
    if (bytes[index] === 13 && bytes[index + 1] === 10 && bytes[index + 2] === 13 && bytes[index + 3] === 10) return index;
  }
  throw new Error("AI upstream returned an invalid HTTP response");
}

function decodeChunked(bytes: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  let position = 0;
  let total = 0;
  while (position < bytes.length) {
    let lineEnd = position;
    while (lineEnd + 1 < bytes.length && !(bytes[lineEnd] === 13 && bytes[lineEnd + 1] === 10)) lineEnd += 1;
    if (lineEnd + 1 >= bytes.length) throw new Error("AI upstream returned an incomplete chunked response");
    const size = Number.parseInt(new TextDecoder().decode(bytes.subarray(position, lineEnd)).split(";", 1)[0], 16);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("AI upstream returned an invalid chunk size");
    position = lineEnd + 2;
    if (size === 0) break;
    if (position + size + 2 > bytes.length || bytes[position + size] !== 13 || bytes[position + size + 1] !== 10) {
      throw new Error("AI upstream returned an incomplete chunked response");
    }
    chunks.push(bytes.subarray(position, position + size));
    total += size;
    position += size + 2;
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

function parseHttpResponse(bytes: Uint8Array): Response {
  const end = headerEnd(bytes);
  const headerText = new TextDecoder("latin1").decode(bytes.subarray(0, end));
  const lines = headerText.split("\r\n");
  const match = /^HTTP\/1\.[01] (\d{3})(?: |$)/u.exec(lines.shift() ?? "");
  if (!match) throw new Error("AI upstream returned an invalid HTTP status");
  const headers = new Headers();
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon < 1) throw new Error("AI upstream returned an invalid HTTP header");
    headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
  }
  const encodedBody = bytes.subarray(end + 4);
  const body = headers.get("transfer-encoding")?.toLowerCase().includes("chunked")
    ? decodeChunked(encodedBody)
    : encodedBody;
  headers.delete("transfer-encoding");
  headers.delete("content-length");
  headers.delete("connection");
  return new Response(body.slice().buffer as ArrayBuffer, { status: Number(match[1]), headers });
}

function isIpv4(hostname: string): boolean {
  const octets = hostname.split(".");
  return octets.length === 4 && octets.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255);
}

export async function fetchAiUpstream(
  url: string,
  init: RequestInit,
  _connector?: IpConnector,
): Promise<Response> {
  const target = new URL(url);
  if (!isIpv4(target.hostname)) return fetch(url, init);
  if (target.protocol !== "http:") throw new Error("Direct IP AI connections currently require HTTP");
  if (typeof init.body !== "string" || init.method?.toUpperCase() !== "POST") throw new Error("Invalid direct IP AI request");

  const connector = _connector ?? workerConnect;
  const socket = connector({ hostname: target.hostname, port: Number(target.port || 80) }, { allowHalfOpen: true });
  const signal = init.signal ?? AbortSignal.timeout(30_000);
  const onAbort = () => { void socket.close().catch(() => undefined); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await socket.opened;
    if (signal.aborted) throw signal.reason;
    const body = encoder.encode(init.body);
    const headers = new Headers(init.headers);
    headers.set("Host", target.host);
    headers.set("Connection", "close");
    headers.set("Accept-Encoding", "identity");
    headers.set("Content-Length", String(body.length));
    const requestBytes = encoder.encode(
      `POST ${target.pathname}${target.search} HTTP/1.1\r\n${Array.from(headers, ([name, value]) => `${name}: ${value}\r\n`).join("")}\r\n`,
    );
    const writer = socket.writable.getWriter();
    const combined = new Uint8Array(requestBytes.length + body.length);
    combined.set(requestBytes);
    combined.set(body, requestBytes.length);
    await writer.write(combined);
    writer.releaseLock();

    const chunks: Uint8Array[] = [];
    const reader = socket.readable.getReader();
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_RESPONSE_BYTES) throw new Error("AI upstream response is too large");
      chunks.push(value);
    }
    const responseBytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { responseBytes.set(chunk, offset); offset += chunk.length; }
    return parseHttpResponse(responseBytes);
  } finally {
    signal.removeEventListener("abort", onAbort);
    await socket.close().catch(() => undefined);
  }
}

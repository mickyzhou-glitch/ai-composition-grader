export function connect(): never {
  throw new Error("Cloudflare sockets must be injected in unit tests");
}

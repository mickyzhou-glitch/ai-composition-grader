import { fromBase64Url, toBase64Url } from "../auth/password-proof";

export async function sealSetting(value: string, keyText: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", fromBase64Url(keyText), { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(value));
  return JSON.stringify({ iv: toBase64Url(iv), ciphertext: toBase64Url(new Uint8Array(data)) });
}

export async function openSetting(value: string, keyText: string): Promise<string> {
  const parsed = JSON.parse(value) as { iv: string; ciphertext: string };
  const key = await crypto.subtle.importKey("raw", fromBase64Url(keyText), { name: "AES-GCM" }, false, ["decrypt"]);
  const data = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(parsed.iv) }, key, fromBase64Url(parsed.ciphertext));
  return new TextDecoder().decode(data);
}

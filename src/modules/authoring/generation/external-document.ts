import { resolve4 } from "node:dns/promises";
import { request } from "node:https";

const MAX_DOCUMENT_BYTES = 512 * 1024;

export function trustedDocumentUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")
    || !/\./.test(url.hostname) || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname) || /^\[[^\]]+\]$/.test(url.hostname)) {
    throw new Error("扩展资料仅接受安全公网HTTPS正文页，不接受内网、登录凭证、裸IP或其他端口。");
  }
  url.hash = "";
  return url;
}

export function publicIpv4(address: string) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) return false;
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 192 && b === 0) || (a === 192 && b === 88 && c === 99) || (a === 192 && b === 0 && c === 2)
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
}

export function documentText(html: string) {
  return html.replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|nav|header|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, entity: string) => {
      const value = entity.startsWith("x") ? parseInt(entity.slice(1), 16) : Number(entity);
      return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : " ";
    })
    .replace(/&(nbsp|amp|quot|apos|lt|gt);/gi, (_, entity: string) =>
      ({ nbsp: " ", amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" })[entity.toLowerCase()] ?? " ")
    .replace(/\s+/g, " ").trim();
}

export async function fetchExternalDocument(value: string, signal: AbortSignal): Promise<{ url: string; text: string; retrievedAt: string }> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(20000)]);
  let url = trustedDocumentUrl(value);
  for (let redirect = 0; redirect <= 3; redirect++) {
    bounded.throwIfAborted();
    // Resolve and pin a public IPv4 address, so redirects and DNS rebinding
    // cannot turn a model-suggested URL into an internal network request.
    const addresses = await new Promise<string[]>((resolve, reject) => {
      const abort = () => reject(bounded.reason);
      bounded.addEventListener("abort", abort, { once: true });
      void resolve4(url.hostname).then(resolve, reject).finally(() => bounded.removeEventListener("abort", abort));
      if (bounded.aborted) abort();
    });
    bounded.throwIfAborted();
    if (!addresses.length || addresses.some((address) => !publicIpv4(address))) throw new Error("扩展资料域名未解析到安全公网地址。");
    const result = await new Promise<{ location?: string; body?: Buffer; contentType?: string }>((resolve, reject) => {
      const req = request(url, { signal: bounded, family: 4,
        lookup: (_host, _options, callback) => callback(null, addresses[0], 4),
        headers: { Accept: "text/html,text/plain", "User-Agent": "Itembank-Evidence/1.0" },
      }, (response) => {
        response.on("error", reject);
        if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
          response.resume();
          if (!response.headers.location) reject(new Error("扩展来源重定向没有目标地址。"));
          else resolve({ location: response.headers.location });
          return;
        }
        const contentType = response.headers["content-type"] ?? "";
        if (response.statusCode !== 200 || !/^text\/(html|plain)(?:;|$)/i.test(contentType)) {
          response.resume();
          reject(new Error(`扩展来源不支持或不可读取（HTTP ${response.statusCode}）；当前只支持HTML或纯文本正文。`));
          return;
        }
        let bytes = 0;
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_DOCUMENT_BYTES) req.destroy(new Error("扩展资料超过512KB读取上限。"));
          else chunks.push(chunk);
        });
        response.on("end", () => resolve({ body: Buffer.concat(chunks), contentType }));
      });
      req.on("error", reject);
      req.setTimeout(10000, () => req.destroy(new Error("扩展资料下载超时。")));
      req.end();
    });
    bounded.throwIfAborted();
    if (result.location) {
      url = trustedDocumentUrl(new URL(result.location, url).toString());
      continue;
    }
    const charset = /charset=["']?([\w-]+)/i.exec(result.contentType ?? "")?.[1] ?? "utf-8";
    const text = documentText(new TextDecoder(charset).decode(result.body));
    if (text.length < 80) throw new Error("扩展来源没有足够正文，标题或空页面不能作为具体答案依据。");
    return { url: url.toString(), text: text.slice(0, 50000), retrievedAt: new Date().toISOString() };
  }
  throw new Error("扩展资料重定向超过3次上限。");
}

/**
 * createSafeUrlDownload — replaces the same export from @copilotkit/runtime/v2.
 *
 * Returns a downloader function that:
 *   - Rejects links whose host is not in `allowedHosts`
 *   - Rejects private / loopback addresses
 *   - Enforces `maxBytes` and `timeoutMs` via AbortSignal
 *   - Honours `maxRedirects: 0` (no redirect following)
 */

/** Private IPv4 ranges: 10.x, 172.16-31.x, 192.168.x, 127.x, 169.254.x */
const PRIVATE_IPV4 = [
  /^10\.\d+\.\d+\.\d+$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
  /^192\.168\.\d+\.\d+$/,
  /^127\.\d+\.\d+\.\d+$/,
  /^169\.254\.\d+\.\d+$/,
];

/** IPv6 loopback / link-local / private patterns. */
const PRIVATE_IPV6 = [
  /^::1$/,
  /^fe80:/i,
  /^fc[0-9a-f]{2}:/i,
  /^fd[0-9a-f]{2}:/i,
];

function isPrivateAddress(hostname: string): boolean {
  if (hostname === "localhost") return true;
  for (const pattern of PRIVATE_IPV4) {
    if (pattern.test(hostname)) return true;
  }
  const bare = hostname.replace(/^\[|]$/g, "");
  for (const pattern of PRIVATE_IPV6) {
    if (pattern.test(bare)) return true;
  }
  return false;
}

export type SafeUrlDownloadOptions = {
  allowedHosts: string[];
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
};

export type DownloadLink = {
  url: URL;
  isUrlSupportedByModel: boolean;
};

export type DownloadResult = {
  data: Uint8Array;
};

/**
 * Returns a function that downloads a batch of URLs subject to the safety
 * constraints provided.  Each entry in the input array is downloaded
 * independently; a link that fails produces an error rather than silently
 * returning empty bytes, so callers can decide how to surface the failure.
 */
export function createSafeUrlDownload(
  options: SafeUrlDownloadOptions,
): (links: DownloadLink[]) => Promise<DownloadResult[]> {
  const { allowedHosts, maxBytes, timeoutMs, maxRedirects } = options;

  async function downloadOne(link: DownloadLink): Promise<DownloadResult> {
    const { url } = link;

    if (url.protocol !== "https:") {
      throw new Error(
        `createSafeUrlDownload: only https links are allowed (got ${url.protocol})`,
      );
    }

    const hostname = url.hostname.replace(/\.$/, "");

    if (!allowedHosts.includes(hostname)) {
      throw new Error(
        `createSafeUrlDownload: host "${hostname}" is not in the allowed hosts list`,
      );
    }

    if (isPrivateAddress(hostname)) {
      throw new Error(
        `createSafeUrlDownload: "${hostname}" is not a public address`,
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url.toString(), {
        signal: controller.signal,
        // Prevent the runtime from following redirects when maxRedirects is 0.
        redirect: maxRedirects === 0 ? "error" : "follow",
      });

      if (!response.ok) {
        const err = new Error(
          `createSafeUrlDownload: server responded ${response.status}`,
        ) as Error & { statusCode: number };
        err.statusCode = response.status;
        throw err;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("createSafeUrlDownload: response body is not readable");
      }

      const chunks: Uint8Array[] = [];
      let totalBytes = 0;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          totalBytes += value.byteLength;
          if (totalBytes > maxBytes) {
            reader.cancel();
            throw new Error(
              `createSafeUrlDownload: response is larger than ${maxBytes} bytes`,
            );
          }
          chunks.push(value);
        }
      }

      const data = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return { data };
    } finally {
      clearTimeout(timer);
    }
  }

  return (links) => Promise.all(links.map(downloadOne));
}

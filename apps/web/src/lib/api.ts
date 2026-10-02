export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: options.body instanceof FormData ? options.headers : {
      'Content-Type': 'application/json', ...options.headers
    }
  });
  const body = await response.json().catch(() => null) as { message?: string; error?: string } | null;
  if (!response.ok) throw new Error(body?.message || body?.error || `请求失败 (${response.status})`);
  return body as T;
}

export function explainError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// randomUUID requires HTTPS, while text chat can also be used over LAN HTTP.
export function createId(): string {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

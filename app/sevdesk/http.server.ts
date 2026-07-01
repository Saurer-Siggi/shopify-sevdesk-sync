const BASE_URL = "https://my.sevdesk.de/api/v1";

function authHeader(): string {
  const token = process.env.SEVDESK_API_TOKEN;
  if (!token) throw new Error("SEVDESK_API_TOKEN is not set");
  return token;
}

export class SevDeskApiError extends Error {
  constructor(
    public readonly path: string,
    public readonly status: number,
    body: string,
  ) {
    super(`SevDesk API ${path} -> ${status}: ${body.slice(0, 300)}`);
  }
}

export async function sevGet<T>(
  path: string,
  params: Record<string, string> = {},
): Promise<T[]> {
  const url = new URL(BASE_URL + path);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const res = await fetch(url, { headers: { Authorization: authHeader() } });
  if (!res.ok) {
    throw new SevDeskApiError(path, res.status, await res.text());
  }
  const json = (await res.json()) as { objects: T[] };
  return json.objects;
}

export async function sevPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(BASE_URL + path, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new SevDeskApiError(path, res.status, await res.text());
  }
  return (await res.json()) as T;
}

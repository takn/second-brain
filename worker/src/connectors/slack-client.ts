/**
 * Minimal Slack Web API client: cursor pagination and rate-limit retries,
 * nothing else. Injectable as a plain function so tests stub responses.
 */

export type SlackCall = (
  method: string,
  params: Record<string, string | number | boolean | undefined>,
) => Promise<Record<string, unknown>>;

export function createSlackClient(botToken: string, fetchImpl = fetch): SlackCall {
  return async function call(method, params) {
    for (let attempt = 0; ; attempt++) {
      const body = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) body.set(k, String(v));
      }
      const res = await fetchImpl(`https://slack.com/api/${method}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${botToken}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      });

      if (res.status === 429 && attempt < 5) {
        const retryAfter = Number(res.headers.get("retry-after") ?? "5");
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        continue;
      }
      if (!res.ok) throw new Error(`slack ${method}: HTTP ${res.status}`);

      const data = (await res.json()) as Record<string, unknown> & { ok: boolean; error?: string };
      if (!data.ok) throw new Error(`slack ${method}: ${data.error}`);
      return data;
    }
  };
}

/** Follow cursor pagination, collecting `field` across pages. */
export async function paginate<T>(
  call: SlackCall,
  method: string,
  params: Record<string, string | number | boolean | undefined>,
  field: string,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await call(method, { ...params, cursor, limit: params.limit ?? 200 });
    out.push(...((page[field] as T[] | undefined) ?? []));
    cursor = (page.response_metadata as { next_cursor?: string } | undefined)?.next_cursor;
    if (cursor === "") cursor = undefined;
  } while (cursor);
  return out;
}

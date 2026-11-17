/** Error returned by the API, with a message that is safe to show to the user. */
export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

/**
 * Single entry point for every call to the backend: JSON in/out, same-origin
 * cookies, and a thrown ApiError whenever the response is not 2xx.
 */
export async function api<T = unknown>(
  path: string,
  /** portfolioId: the portfolio a scoped route (assets, tabs, trades) acts on, sent as X-Portfolio-Id. */
  options: { method?: string; body?: unknown; portfolioId?: number } = {}
): Promise<T> {
  const hasBody = options.body !== undefined;

  let res: Response;
  try {
    res = await fetch(path, {
      method: options.method ?? "GET",
      credentials: "same-origin",
      headers: {
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
        ...(options.portfolioId !== undefined ? { "X-Portfolio-Id": String(options.portfolioId) } : {}),
      },
      body: hasBody ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new ApiError(0, "Sem conexão com o servidor. Tente novamente.");
  }

  const text = await res.text();
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    throw new ApiError(res.status, data?.error || `Erro ${res.status}`, typeof data?.code === "string" ? data.code : undefined);
  }
  return data as T;
}

export function errorMessage(error: unknown, fallback: string) {
  return error instanceof ApiError ? error.message : fallback;
}

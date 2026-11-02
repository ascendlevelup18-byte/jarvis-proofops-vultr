import { CaseSchema } from "./case-schema.ts";
import type { Case, CaseRequest } from "./case-types.ts";

export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export async function submitCase(request: CaseRequest): Promise<Case> {
  const res = await fetch("/cases", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ApiError("Invalid JSON response", res.status, null);
  }

  if (!res.ok) {
    throw new ApiError(
      typeof body === "object" && body && "error" in body ? String((body as { error: string }).error) : res.statusText,
      res.status,
      body,
    );
  }

  const parsed = CaseSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError("Response failed validation", res.status, parsed.error.flatten());
  }

  return parsed.data as Case;
}

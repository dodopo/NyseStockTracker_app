/**
 * Small HTTP helpers shared by the route modules: safe errors, body
 * validation with the shared zod schemas, async handlers and timestamps.
 */
import type express from "express";
import type { z } from "zod";
import { firstIssue } from "../shared/schemas";

/** Error whose message is safe to show to the user. */
export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

/** Validates a request body with a shared zod schema; 400 with the first issue otherwise. */
export function parseBody<S extends z.ZodType>(schema: S, body: unknown): z.output<S> {
  const result = schema.safeParse(body ?? {});
  if (!result.success) throw new HttpError(400, firstIssue(result.error));
  return result.data;
}

export function nowIso() {
  return new Date().toISOString();
}

type AsyncHandler = (req: express.Request, res: express.Response) => Promise<unknown> | unknown;

/** Express 4 does not catch rejected promises; this forwards them to the error handler. */
export const wrap =
  (handler: AsyncHandler): express.RequestHandler =>
  (req, res, next) => {
    Promise.resolve(handler(req, res)).catch(next);
  };

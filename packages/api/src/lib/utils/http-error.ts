import { HTTPException } from 'hono/http-exception';

export function badRequest(message: string): HTTPException {
  return new HTTPException(400, { message });
}

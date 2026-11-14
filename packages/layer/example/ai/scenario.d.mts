export const REPLY: string;
export function supportModels(deps: { Mock: new (options: any) => any; simulateReadableStream: (options: any) => any }): { chat: any; stream: any };
export function answerCustomer(options: {
  ai: any;
  models: { chat: any; stream: any };
  telemetry?: Record<string, unknown>;
  lookupOrder: (orderId: string) => Promise<unknown>;
}): Promise<{ answer: string; reply: string }>;

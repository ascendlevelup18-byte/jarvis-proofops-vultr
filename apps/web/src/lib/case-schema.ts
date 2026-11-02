import { z } from "zod";

const CaseRequestSchema = z.object({
  customerId: z.string(),
  orderId: z.string(),
  message: z.string(),
});

export const CaseSchema = z
  .object({
    id: z.string(),
    request: CaseRequestSchema,
    state: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    understanding: z.unknown().nullable(),
    evidence: z.unknown().nullable(),
    proposal: z.unknown().nullable(),
    authorization: z.unknown().nullable(),
    action: z.unknown().nullable(),
    verification: z.unknown().nullable(),
    reasons: z.array(z.object({ code: z.string(), detail: z.string() })),
    audit: z.array(
      z.object({
        seq: z.number(),
        caseId: z.string(),
        at: z.string(),
        type: z.string(),
        from: z.string().nullable(),
        to: z.string().nullable(),
        data: z.unknown(),
      }),
    ),
  })
  .passthrough();

export type ParsedCase = z.infer<typeof CaseSchema>;

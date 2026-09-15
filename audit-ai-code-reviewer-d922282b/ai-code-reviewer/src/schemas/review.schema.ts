import { z } from "zod";

export const findingCategorySchema = z.enum([
	"correctness",
	"security",
	"performance",
	"type-safety",
	"error-handling",
	"maintainability"
]);

export const findingConfidenceSchema = z.enum(["low", "medium", "high"]);

export const findingSchema = z.object({
	severity: z.enum(["high", "medium", "low"]),
	category: findingCategorySchema,
	confidence: findingConfidenceSchema,
	title: z.string(),
	explanation: z.string(),
	lineHint: z.string().nullable(),
	suggestion: z.string().nullable()
});

export const reviewResponseSchema = z.object({
	findings: z.array(findingSchema),
	summary: z.string()
});

export type ReviewResponse = z.infer<typeof reviewResponseSchema>;

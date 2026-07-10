import { z } from 'zod';
import type { OutlinePayload, HydratedStepPayload } from './types';

/**
 * Zod schemas mirroring the domain contracts in types.ts. Two jobs:
 *   1. Runtime validation of the model's structured output.
 *   2. Deriving the JSON Schema handed to the SDK's `outputFormat`.
 *
 * The parse functions are typed to return the hand-written interfaces from
 * types.ts, so any structural drift between schema and interface is a compile
 * error at the `return` statement — no separate drift guard needed.
 *
 * Cross-field rules (e.g. an 'edit' needs hunks) are enforced at runtime in the
 * parse functions rather than in the schema, so the JSON Schema handed to the
 * SDK stays purely structural.
 */

const changeKindSchema = z.enum(['edit', 'create', 'delete', 'rename']);

const relatedFileSchema = z.object({
  file: z.string(),
  relationship: z.string(),
});

const highlightRangeSchema = z.object({
  file: z.string(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  note: z.string(),
});

const stepNavigationSchema = z.object({
  file: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
});

export const OutlineStepSchema = z.object({
  stepNumber: z.number().int().positive(),
  title: z.string().min(1),
  targetFiles: z.array(z.string()).min(1),
  dependsOn: z.array(z.number().int().positive()).default([]),
  // Optional with a default: solve-mode fills it; explain-mode steps omit it.
  changeKind: changeKindSchema.default('edit'),
  genericExplanation: z.string().min(1),
  specificExplanation: z.string().min(1),
  prerequisites: z.array(z.string()).optional(),
  relatedFiles: z.array(relatedFileSchema).optional(),
  focus: stepNavigationSchema.optional(),
});

export const OutlinePayloadSchema = z.object({
  problemSummary: z.string().min(1),
  steps: z.array(OutlineStepSchema).min(1),
});

export const AnchoredHunkSchema = z.object({
  contextBefore: z.string(),
  oldText: z.string(),
  newText: z.string(),
  contextAfter: z.string(),
  advisoryStartLine: z.number().int().positive().optional(),
});

const stepVerificationSchema = z.object({
  command: z.string().optional(),
  expectedOutcome: z.string(),
  rollbackInstructions: z.string(),
});

export const HydratedStepPayloadSchema = z.object({
  stepNumber: z.number().int().positive(),
  primaryFile: z.string().min(1),
  changeKind: changeKindSchema,
  renameTo: z.string().optional(),
  hunks: z.array(AnchoredHunkSchema).optional(),
  fullFileContent: z.string().optional(),
  navigation: stepNavigationSchema,
  highlightRanges: z.array(highlightRangeSchema).optional(),
  verification: stepVerificationSchema.optional(),
});

export function parseOutlinePayload(data: unknown): OutlinePayload {
  return OutlinePayloadSchema.parse(data);
}

export function parseHydratedStep(data: unknown): HydratedStepPayload {
  const step = HydratedStepPayloadSchema.parse(data);
  assertChangeKindShape(step);
  return step;
}

function assertChangeKindShape(step: HydratedStepPayload): void {
  switch (step.changeKind) {
    case 'edit':
      if (!step.hunks || step.hunks.length === 0) {
        throw new Error(`Step ${step.stepNumber}: changeKind 'edit' requires at least one hunk.`);
      }
      break;
    case 'create':
      if (step.fullFileContent === undefined) {
        throw new Error(`Step ${step.stepNumber}: changeKind 'create' requires fullFileContent.`);
      }
      break;
    case 'rename':
      if (!step.renameTo) {
        throw new Error(`Step ${step.stepNumber}: changeKind 'rename' requires renameTo.`);
      }
      break;
    case 'delete':
      break;
  }
}

/**
 * Convert to a JSON Schema the Claude CLI accepts. zod 4 defaults to
 * draft-2020-12 and stamps a `$schema` meta URL the CLI's validator can't
 * resolve, so we target draft-7 and drop the `$schema` key.
 */
function toCliJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>;
  delete js.$schema;
  return js;
}

/** JSON Schema for the SDK's structured-output `outputFormat` (outline phase). */
export function outlineJsonSchema(): Record<string, unknown> {
  return toCliJsonSchema(OutlinePayloadSchema);
}

/** JSON Schema for the SDK's structured-output `outputFormat` (per-step hydration). */
export function hydratedStepJsonSchema(): Record<string, unknown> {
  return toCliJsonSchema(HydratedStepPayloadSchema);
}

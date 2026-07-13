import { describe, it, expect } from 'vitest';
import {
  parseOutlinePayload,
  parseHydratedStep,
  outlineJsonSchema,
  hydratedStepJsonSchema,
} from './schema';

const validOutline = {
  problemSummary: 'Fix the race condition in checkout.',
  steps: [
    {
      stepNumber: 1,
      title: 'Guard the shared cart mutation',
      targetFiles: ['src/checkout.ts'],
      dependsOn: [],
      changeKind: 'edit',
      genericExplanation: 'A mutex serializes access to shared mutable state.',
      specificExplanation: 'cart.total is written from two async handlers.',
    },
  ],
};

describe('parseOutlinePayload', () => {
  it('accepts a valid outline', () => {
    const out = parseOutlinePayload(validOutline);
    expect(out.steps).toHaveLength(1);
    expect(out.steps[0]!.changeKind).toBe('edit');
  });

  it('defaults dependsOn to [] when omitted', () => {
    const step = { ...validOutline.steps[0] } as Record<string, unknown>;
    delete step.dependsOn;
    const out = parseOutlinePayload({ ...validOutline, steps: [step] });
    expect(out.steps[0]!.dependsOn).toEqual([]);
  });

  it('rejects an empty steps array', () => {
    expect(() => parseOutlinePayload({ ...validOutline, steps: [] })).toThrow();
  });

  it('coerces an unknown changeKind to edit (lenient for weak models)', () => {
    const bad = { ...validOutline, steps: [{ ...validOutline.steps[0], changeKind: 'mutate' }] };
    expect(parseOutlinePayload(bad).steps[0]!.changeKind).toBe('edit');
  });

  it('rejects a non-positive stepNumber', () => {
    const bad = { ...validOutline, steps: [{ ...validOutline.steps[0], stepNumber: 0 }] };
    expect(() => parseOutlinePayload(bad)).toThrow();
  });

  it('defaults changeKind to edit when omitted (explain-mode steps)', () => {
    const step = { ...validOutline.steps[0] } as Record<string, unknown>;
    delete step.changeKind;
    const out = parseOutlinePayload({ ...validOutline, steps: [step] });
    expect(out.steps[0]!.changeKind).toBe('edit');
  });

  it('accepts an explain-mode step with a focus range', () => {
    const step = {
      ...validOutline.steps[0],
      focus: { file: 'src/checkout.ts', startLine: 10, endLine: 20 },
    };
    const out = parseOutlinePayload({ ...validOutline, steps: [step] });
    expect(out.steps[0]!.focus).toEqual({ file: 'src/checkout.ts', startLine: 10, endLine: 20 });
  });
});

const validEditStep = {
  stepNumber: 1,
  primaryFile: 'src/checkout.ts',
  changeKind: 'edit',
  hunks: [
    {
      contextBefore: 'function checkout() {',
      oldText: '  cart.total += item.price;',
      newText: '  await lock.run(() => { cart.total += item.price; });',
      contextAfter: '}',
    },
  ],
  navigation: { file: 'src/checkout.ts', startLine: 12, endLine: 14 },
};

describe('parseHydratedStep', () => {
  it('accepts a valid edit step', () => {
    const s = parseHydratedStep(validEditStep);
    expect(s.hunks).toHaveLength(1);
  });

  it("rejects an 'edit' step with no hunks", () => {
    expect(() => parseHydratedStep({ ...validEditStep, hunks: [] })).toThrow(/at least one hunk/);
  });

  it("rejects a 'create' step with no fullFileContent", () => {
    const bad = {
      stepNumber: 2,
      primaryFile: 'src/lock.ts',
      changeKind: 'create',
      navigation: { file: 'src/lock.ts', startLine: 1, endLine: 1 },
    };
    expect(() => parseHydratedStep(bad)).toThrow(/requires fullFileContent/);
  });

  it("accepts a 'create' step with fullFileContent", () => {
    const ok = {
      stepNumber: 2,
      primaryFile: 'src/lock.ts',
      changeKind: 'create',
      fullFileContent: 'export class Lock {}',
      navigation: { file: 'src/lock.ts', startLine: 1, endLine: 1 },
    };
    expect(parseHydratedStep(ok).changeKind).toBe('create');
  });

  it("rejects a 'rename' step with no renameTo", () => {
    const bad = {
      stepNumber: 3,
      primaryFile: 'src/a.ts',
      changeKind: 'rename',
      navigation: { file: 'src/a.ts', startLine: 1, endLine: 1 },
    };
    expect(() => parseHydratedStep(bad)).toThrow(/requires renameTo/);
  });
});

describe('json schema exports', () => {
  it('produce object schemas for the SDK outputFormat', () => {
    const o = outlineJsonSchema();
    expect(o).toHaveProperty('type', 'object');
    expect(o).toHaveProperty('properties');
    const h = hydratedStepJsonSchema();
    expect(h).toHaveProperty('type', 'object');
    expect(h).toHaveProperty('properties');
  });
});

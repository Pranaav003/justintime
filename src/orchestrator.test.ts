import { describe, it, expect } from 'vitest';
import { Orchestrator, type EditorPort, type PanelPort, type RollbackPort } from './orchestrator';
import type { PlanProvider, RepoContext, SessionCtx, FileState } from './plan-source';
import type { OutlineStep, WalkthroughOutline, HydratedStep, ApplyOutcome } from './types';
import type { StepView, WebviewToHost } from './webview/protocol';

function outlineStep(n: number, file: string): OutlineStep {
  return {
    stepNumber: n,
    title: `Step ${n}`,
    targetFiles: [file],
    dependsOn: [],
    changeKind: 'edit',
    genericExplanation: `generic ${n}`,
    specificExplanation: `specific ${n}`,
  };
}

/** Provider returning a fixed 2-step outline; hydrates each with a hunk matching the fake file. */
class FakeProvider implements PlanProvider {
  lastCtx?: RepoContext;
  async produceOutline(_problem: string, ctx: RepoContext): Promise<WalkthroughOutline> {
    this.lastCtx = ctx;
    const mode = ctx.mode ?? 'solve';
    return {
      sessionId: 'sess-x',
      problemSummary: 'summary',
      mode,
      steps: [outlineStep(1, 'a.ts'), outlineStep(2, 'b.ts')].map((s) => ({
        ...s,
        focus: { file: s.targetFiles[0]!, startLine: 2, endLine: 2 },
      })),
    };
  }
  async hydrateStep(step: OutlineStep, _current: FileState, _s: SessionCtx): Promise<HydratedStep> {
    const file = step.targetFiles[0]!;
    return {
      stepNumber: step.stepNumber,
      primaryFile: file,
      changeKind: 'edit',
      hunks: [{ contextBefore: 'top', oldText: 'TARGET', newText: 'FIXED', contextAfter: 'bottom' }],
      navigation: { file, startLine: 2, endLine: 2 },
      hazards: [],
    };
  }
  async answerQuestion(question: string, contextText: string): Promise<string> {
    return `answer to "${question}" (ctx: ${contextText.split('\n')[0]})`;
  }
}

class FakeEditor implements EditorPort {
  navigated: { file: string; startLine: number }[] = [];
  applied: HydratedStep[] = [];
  cleared = 0;
  constructor(public files: Record<string, string>) {}
  async listFiles(): Promise<string[]> {
    return Object.keys(this.files).sort();
  }
  async searchCode(): Promise<string> {
    return '';
  }
  async navigateTo(relPath: string, startLine: number): Promise<void> {
    this.navigated.push({ file: relPath, startLine });
  }
  async showDiff(): Promise<void> {}
  async applyStep(step: HydratedStep): Promise<ApplyOutcome> {
    this.applied.push(step);
    return { status: 'applied' };
  }
  async readFile(relPath: string): Promise<string | undefined> {
    return this.files[relPath];
  }
  clearHighlights(): void {
    this.cleared++;
  }
}

class FakePanel implements PanelPort {
  private handler?: (m: WebviewToHost) => void;
  busy: string[] = [];
  progress: string[] = [];
  idle: string[] = [];
  rendered: StepView[] = [];
  applied: number[] = [];
  conflicts: { n: number; reason: string }[] = [];
  errors: string[] = [];
  completed: { a: number; s: number; mode: string }[] = [];
  showBusy(m: string): void {
    this.busy.push(m);
  }
  showProgress(t: string): void {
    this.progress.push(t);
  }
  showIdle(m: string): void {
    this.idle.push(m);
  }
  paused = 0;
  showPaused(): void {
    this.paused++;
  }
  renderStep(v: StepView): void {
    this.rendered.push(v);
  }
  notifyApplied(n: number): void {
    this.applied.push(n);
  }
  notifyConflict(n: number, reason: string): void {
    this.conflicts.push({ n, reason });
  }
  notifyError(m: string): void {
    this.errors.push(m);
  }
  notifyCompleted(a: number, s: number, mode: string): void {
    this.completed.push({ a, s, mode });
  }
  answers: { id: number; answer: string }[] = [];
  answerErrors: { id: number; message: string }[] = [];
  postAnswer(id: number, answer: string): void {
    this.answers.push({ id, answer });
  }
  postAnswerError(id: number, message: string): void {
    this.answerErrors.push({ id, message });
  }
  onMessage(h: (m: WebviewToHost) => void): void {
    this.handler = h;
  }
  async emit(m: WebviewToHost): Promise<void> {
    await (this.handler as ((m: WebviewToHost) => unknown) | undefined)?.(m);
  }
}

class FakeRollback implements RollbackPort {
  snapshots: { step: number; path: string }[] = [];
  reverted = 0;
  async snapshotBeforeApply(step: number, absPath: string): Promise<void> {
    this.snapshots.push({ step, path: absPath });
  }
  async revertAll(): Promise<{ restored: number; deleted: number; errors: string[] }> {
    this.reverted++;
    return { restored: this.snapshots.length, deleted: 0, errors: [] };
  }
  hasSnapshots(): boolean {
    return this.snapshots.length > 0;
  }
}

const FILES = { 'a.ts': 'top\nTARGET\nbottom', 'b.ts': 'top\nTARGET\nbottom' };

function build(files = FILES) {
  const provider = new FakeProvider();
  const editor = new FakeEditor({ ...files });
  const panel = new FakePanel();
  const rollback = new FakeRollback();
  const orch = new Orchestrator(provider, editor, panel, rollback, { workspaceRoot: '/repo' });
  return { orch, editor, panel, rollback, provider };
}

describe('Orchestrator', () => {
  it('produces an outline and renders step 1 waiting for apply', async () => {
    const { orch, panel, editor } = build();
    await orch.start('fix it');
    expect(panel.busy[0]).toMatch(/Analyzing/);
    expect(panel.rendered).toHaveLength(1);
    expect(panel.rendered[0]!.stepNumber).toBe(1);
    expect(panel.rendered[0]!.totalSteps).toBe(2);
    expect(orch.getState().phase).toBe('waiting_for_apply');
    expect(editor.navigated.some((n) => n.file === 'a.ts')).toBe(true);
  });

  it('applies the current step, snapshots first, then advances', async () => {
    const { orch, panel, editor, rollback } = build();
    await orch.start('fix it');
    await panel.emit({ type: 'apply' });

    expect(rollback.snapshots[0]).toEqual({ step: 1, path: '/repo/a.ts' });
    expect(editor.applied[0]!.stepNumber).toBe(1);
    expect(panel.applied).toContain(1);
    // advanced to step 2
    expect(panel.rendered.at(-1)!.stepNumber).toBe(2);
    expect(orch.getState().currentStep).toBe(2);
  });

  it('completes the walkthrough after the last step', async () => {
    const { orch, panel } = build();
    await orch.start('fix it');
    await panel.emit({ type: 'apply' });
    await panel.emit({ type: 'apply' });
    expect(panel.completed).toEqual([{ a: 2, s: 0, mode: 'solve' }]);
    expect(orch.getState().status).toBe('completed');
  });

  it('skips a step without applying and advances', async () => {
    const { orch, panel, editor } = build();
    await orch.start('fix it');
    await panel.emit({ type: 'skip' });
    expect(editor.applied).toHaveLength(0);
    expect(panel.rendered.at(-1)!.stepNumber).toBe(2);
  });

  it('flags a conflict when the hydrated hunk cannot anchor to current content', async () => {
    const { orch, panel } = build({ 'a.ts': 'no marker here', 'b.ts': 'top\nTARGET\nbottom' });
    await orch.start('fix it');
    expect(panel.conflicts).toHaveLength(1);
    expect(panel.conflicts[0]!.n).toBe(1);
    expect(orch.getState().phase).toBe('conflict');
  });

  it('explain mode: navigates to focus, advances on Next without applying anything', async () => {
    const { orch, panel, editor } = build();
    await orch.start('how does it work', 'explain');
    expect(panel.rendered).toHaveLength(1);
    expect(panel.rendered[0]!.mode).toBe('explain');
    expect(orch.getState().phase).toBe('waiting_for_apply');
    // navigated to the step's focus range (line 2), not just the file top
    expect(editor.navigated.some((n) => n.file === 'a.ts' && n.startLine === 2)).toBe(true);

    await panel.emit({ type: 'apply' }); // "Next"
    expect(editor.applied).toHaveLength(0); // explain mode never applies
    expect(panel.rendered.at(-1)!.stepNumber).toBe(2);

    await panel.emit({ type: 'apply' });
    expect(orch.getState().status).toBe('completed');
    expect(panel.completed[0]).toEqual({ a: 2, s: 0, mode: 'explain' });
  });

  it('cancel aborts an in-flight analysis and reports Cancelled', async () => {
    const hangingProvider: PlanProvider = {
      async produceOutline(_p: string, ctx: RepoContext): Promise<WalkthroughOutline> {
        return new Promise((_resolve, reject) => {
          ctx.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      },
      async hydrateStep(): Promise<HydratedStep> {
        throw new Error('not reached');
      },
    };
    const panel = new FakePanel();
    const orch = new Orchestrator(hangingProvider, new FakeEditor({ ...FILES }), panel, new FakeRollback(), {
      workspaceRoot: '/repo',
    });
    const startP = orch.start('x', 'solve');
    await Promise.resolve(); // let start() register the handler + kick off produceOutline
    await panel.emit({ type: 'cancel' });
    await startP;
    // cancel() resets the panel to a clean idle state (not a banner over the spinner)
    expect(panel.idle.some((m) => /cancel/i.test(m))).toBe(true);
    expect(panel.rendered).toHaveLength(0);
  });

  it('routes a chat question to the provider and posts the answer', async () => {
    const { orch, panel } = build();
    await orch.start('fix it');
    await panel.emit({ type: 'ask', id: 1, question: 'why this change?' });
    expect(panel.answers).toHaveLength(1);
    expect(panel.answers[0]!.id).toBe(1);
    expect(panel.answers[0]!.answer).toContain('why this change?');
  });

  it('preserves per-step chat history across re-renders', async () => {
    const { orch, panel } = build();
    await orch.start('fix it');
    await panel.emit({ type: 'ask', id: 1, question: 'why step one?' });
    // Re-render step 1 (review toggle) — its chat history must come back.
    await panel.emit({ type: 'reviewStep', stepNumber: 1 });
    const last = panel.rendered.at(-1)!;
    expect(last.chat).toHaveLength(1);
    expect(last.chat[0]!.question).toBe('why step one?');
    expect(last.chat[0]!.answer).toContain('why step one?');
  });

  it('pause shows the paused state and resume re-renders the step', async () => {
    const { orch, panel } = build();
    await orch.start('fix it');
    const rendersBefore = panel.rendered.length;
    await panel.emit({ type: 'pause' });
    expect(panel.paused).toBe(1);
    expect(orch.getState().phase).toBe('paused');
    await panel.emit({ type: 'resume' });
    expect(orch.getState().phase).toBe('waiting_for_apply');
    expect(panel.rendered.length).toBeGreaterThan(rendersBefore); // step re-rendered on resume
  });

  it('passes a repo map (file list) to the provider before analysis', async () => {
    const { orch, provider } = build();
    await orch.start('fix it');
    expect(provider.lastCtx?.repoMap).toEqual(['a.ts', 'b.ts']);
  });

  it('reverts all via the rollback store', async () => {
    const { orch, panel, rollback } = build();
    await orch.start('fix it');
    await panel.emit({ type: 'apply' });
    const result = await orch.revertAll();
    expect(rollback.reverted).toBe(1);
    expect(result.restored).toBeGreaterThan(0);
  });

  it('apply(): applyStep conflict outcome notifies conflict', async () => {
    const { orch, editor, panel } = build();
    editor.applyStep = async (): Promise<ApplyOutcome> => ({ status: 'conflict', reason: 'merge conflict' });
    await orch.start('fix it');
    await panel.emit({ type: 'apply' });
    expect(panel.conflicts.some((c) => c.reason === 'merge conflict')).toBe(true);
  });

  it('apply(): applyStep error outcome notifies error', async () => {
    const { orch, editor, panel } = build();
    editor.applyStep = async (): Promise<ApplyOutcome> => ({ status: 'error', message: 'permission denied' });
    await orch.start('fix it');
    await panel.emit({ type: 'apply' });
    expect(panel.errors.some((e) => e.includes('permission denied'))).toBe(true);
    expect(editor.applied).toHaveLength(0);
  });

  it('apply(): a snapshot failure surfaces as an error instead of deadlocking (regression)', async () => {
    const { orch, editor, panel, rollback } = build();
    rollback.snapshotBeforeApply = async () => {
      throw new Error('disk full');
    };
    await orch.start('fix it');
    await panel.emit({ type: 'apply' });
    expect(panel.errors.some((e) => /disk full/i.test(e))).toBe(true);
    expect(editor.applied).toHaveLength(0); // never reached applyStep
  });

  it('handleMessage never leaks an unhandled rejection (regression)', async () => {
    const { orch, editor, panel } = build();
    await orch.start('fix it');
    editor.navigateTo = async () => {
      throw new Error('navigate boom');
    };
    await panel.emit({ type: 'openLocation', file: 'a.ts', line: 1 });
    expect(panel.errors.some((e) => /went wrong/i.test(e))).toBe(true);
  });

  it('activateCurrentStep: a hydrate failure surfaces notifyError', async () => {
    const { orch, provider, panel } = build();
    provider.hydrateStep = async () => {
      throw new Error('hydrate boom');
    };
    await orch.start('fix it');
    expect(panel.errors.some((e) => /hydrate boom/i.test(e))).toBe(true);
  });

  it('openLocation with an empty file does not navigate', async () => {
    const { orch, editor, panel } = build();
    await orch.start('fix it');
    const before = editor.navigated.length;
    await panel.emit({ type: 'openLocation', file: '', line: 0 });
    expect(editor.navigated.length).toBe(before);
  });

  it('apply() is a no-op when not waiting_for_apply (e.g. paused)', async () => {
    const { orch, editor, panel } = build();
    await orch.start('fix it');
    await panel.emit({ type: 'pause' });
    const applied = editor.applied.length;
    await panel.emit({ type: 'apply' });
    expect(editor.applied.length).toBe(applied);
  });

  it('review(): switching to a different reviewed step re-renders it', async () => {
    const { orch, panel } = build();
    await orch.start('fix it');
    await panel.emit({ type: 'apply' }); // advance to step 2 (both hydrated)
    await panel.emit({ type: 'reviewStep', stepNumber: 1 });
    expect(orch.getState().review?.viewing).toBe(1);
    await panel.emit({ type: 'reviewStep', stepNumber: 2 });
    expect(orch.getState().review?.viewing).toBe(2);
    expect(panel.rendered.at(-1)!.reviewMode).toBe(true);
  });

  it('resume() from the explaining phase fires SHOW_READY', async () => {
    const { orch, editor } = build();
    editor.showDiff = async () => {
      orch.pause(); // pause while phase === 'explaining' (between HYDRATE_DONE and SHOW_READY)
    };
    await orch.start('fix it');
    expect(orch.getState().phase).toBe('paused');
    await orch.resume();
    expect(orch.getState().phase).toBe('waiting_for_apply');
  });

  it('ask(): posts an error when the provider has no answerQuestion', async () => {
    const noChat: PlanProvider = {
      async produceOutline(_p: string, ctx: RepoContext): Promise<WalkthroughOutline> {
        return { sessionId: 's', problemSummary: 'x', mode: ctx.mode ?? 'solve', steps: [outlineStep(1, 'a.ts')] };
      },
      async hydrateStep(step: OutlineStep): Promise<HydratedStep> {
        return {
          stepNumber: step.stepNumber,
          primaryFile: 'a.ts',
          changeKind: 'edit',
          hunks: [{ contextBefore: 'top', oldText: 'TARGET', newText: 'F', contextAfter: 'bottom' }],
          navigation: { file: 'a.ts', startLine: 2, endLine: 2 },
          hazards: [],
        };
      },
    };
    const panel = new FakePanel();
    const orch = new Orchestrator(noChat, new FakeEditor({ ...FILES }), panel, new FakeRollback(), { workspaceRoot: '/repo' });
    await orch.start('x');
    await panel.emit({ type: 'ask', id: 9, question: 'q' });
    expect(panel.answerErrors.some((e) => e.id === 9)).toBe(true);
  });
});

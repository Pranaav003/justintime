import { initialState, transition, type SessionState, type WalkthroughEvent } from './state-machine';
import { applyHunks } from './anchor';
import type { OutlineStep, WalkthroughOutline, HydratedStep, ApplyOutcome } from './types';
import type { PlanProvider, FileState } from './plan-source';
import type { StepView, StepDotStatus, WebviewToHost, DiffHunkView } from './webview/protocol';
import type { RevertResult } from './rollback-store';

/**
 * The conductor (design Section 3 & 9). Owns the SessionState, drives the state
 * machine, and coordinates provider -> editor -> rollback -> panel through the
 * outline + lazy-hydration loop. Depends only on narrow ports (structurally
 * satisfied by the real EditorBridge / ExplanationPanel / RollbackStore), so it
 * stays VS Code-free and unit-testable with fakes.
 */

export interface EditorPort {
  navigateTo(relPath: string, startLine: number, endLine: number): Promise<void>;
  showDiff(title: string, relPath: string, before: string, after: string): Promise<void>;
  applyStep(step: HydratedStep): Promise<ApplyOutcome>;
  readFile(relPath: string): Promise<string | undefined>;
  clearHighlights(): void;
}

export interface PanelPort {
  showBusy(message: string): void;
  renderStep(view: StepView): void;
  notifyApplied(stepNumber: number): void;
  notifyConflict(stepNumber: number, reason: string): void;
  notifyError(message: string): void;
  notifyCompleted(applied: number, skipped: number): void;
  onMessage(handler: (msg: WebviewToHost) => void): void;
}

export interface RollbackPort {
  snapshotBeforeApply(step: number, absPath: string): Promise<void>;
  revertAll(): Promise<RevertResult>;
  hasSnapshots(): boolean;
}

export interface OrchestratorOptions {
  workspaceRoot: string;
  maxSteps?: number;
  showPrerequisites?: boolean;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function join(...parts: string[]): string {
  return parts.join('/').replace(/\/{2,}/g, '/');
}

export class Orchestrator {
  private state: SessionState = initialState();
  private outline?: WalkthroughOutline;
  private readonly hydratedByStep = new Map<number, HydratedStep>();
  private readonly beforeTextByStep = new Map<number, string>();
  private readonly stepStatus = new Map<number, 'done' | 'skipped'>();
  private appliedCount = 0;
  private skippedCount = 0;
  private registered = false;

  constructor(
    private readonly provider: PlanProvider,
    private readonly editor: EditorPort,
    private readonly panel: PanelPort,
    private readonly rollback: RollbackPort,
    private readonly opts: OrchestratorOptions,
  ) {}

  getState(): SessionState {
    return this.state;
  }

  async start(problem: string): Promise<void> {
    if (!this.registered) {
      // Return the promise so hosts/tests that care can await it; the real
      // webview host ignores the return value.
      this.panel.onMessage((m) => this.handleMessage(m));
      this.registered = true;
    }
    this.panel.showBusy('Analyzing your codebase…');
    let outline: WalkthroughOutline;
    try {
      outline = await this.provider.produceOutline(problem, { workspaceRoot: this.opts.workspaceRoot });
    } catch (e) {
      this.panel.notifyError(`Analysis failed: ${errMsg(e)}`);
      return;
    }
    this.outline = outline;
    if (!this.dispatch({ type: 'START', totalSteps: outline.steps.length })) {
      this.panel.notifyError('Could not start walkthrough (no steps).');
      return;
    }
    await this.activateCurrentStep();
  }

  async revertAll(): Promise<RevertResult> {
    return this.rollback.revertAll();
  }

  pause(): void {
    this.dispatch({ type: 'PAUSE' });
  }

  async resume(): Promise<void> {
    if (this.dispatch({ type: 'RESUME' })) {
      // Re-render the current step if we have it hydrated.
      const step = this.currentOutlineStep();
      const hydrated = step && this.hydratedByStep.get(step.stepNumber);
      if (step && hydrated) {
        this.panel.renderStep(this.buildView(step, hydrated, false));
      }
    }
  }

  private dispatch(ev: WalkthroughEvent): boolean {
    const r = transition(this.state, ev);
    if (r.ok) {
      this.state = r.state;
      return true;
    }
    return false; // illegal transitions are ignored (state machine is authoritative)
  }

  private currentOutlineStep(): OutlineStep | undefined {
    return this.outline?.steps[this.state.currentStep - 1];
  }

  private async activateCurrentStep(): Promise<void> {
    const step = this.currentOutlineStep();
    if (!step) {
      return;
    }
    // Coarse navigation to the target file while we hydrate.
    await this.editor.navigateTo(step.targetFiles[0] ?? '', 1, 1);
    if (!this.dispatch({ type: 'NAV_DONE' })) {
      return;
    }

    this.panel.showBusy(`Preparing step ${step.stepNumber} of ${this.outline!.steps.length}…`);

    const current: FileState = {};
    for (const f of step.targetFiles) {
      const content = await this.editor.readFile(f);
      if (content !== undefined) {
        current[f] = content;
      }
    }

    let hydrated: HydratedStep;
    try {
      hydrated = await this.provider.hydrateStep(step, current, { sessionId: this.outline!.sessionId });
    } catch (e) {
      this.dispatch({ type: 'HYDRATE_FAILED', message: errMsg(e) });
      this.panel.notifyError(`Could not prepare step ${step.stepNumber}: ${errMsg(e)}`);
      return;
    }

    const before = current[hydrated.primaryFile] ?? '';
    let afterText: string;
    if (hydrated.changeKind === 'edit') {
      const res = applyHunks(before, hydrated.hunks ?? []);
      if (res.status === 'error') {
        // Anchors don't match current content -> conflict before we ever apply.
        this.dispatch({ type: 'CONFLICT' });
        this.panel.notifyConflict(step.stepNumber, `could not locate the change (${res.reason})`);
        return;
      }
      afterText = res.text;
    } else if (hydrated.changeKind === 'create') {
      afterText = hydrated.fullFileContent ?? '';
    } else if (hydrated.changeKind === 'delete') {
      afterText = '';
    } else {
      afterText = before; // rename: content unchanged
    }

    this.hydratedByStep.set(step.stepNumber, hydrated);
    this.beforeTextByStep.set(step.stepNumber, before);

    if (!this.dispatch({ type: 'HYDRATE_DONE' })) {
      return;
    }

    await this.editor.navigateTo(hydrated.navigation.file, hydrated.navigation.startLine, hydrated.navigation.endLine);
    try {
      await this.editor.showDiff(
        `JustInTime — Step ${step.stepNumber}: ${step.title}`,
        hydrated.primaryFile,
        before,
        afterText,
      );
    } catch {
      // Diff view is best-effort; don't break the walkthrough if it fails.
    }

    this.panel.renderStep(this.buildView(step, hydrated, false));
    this.dispatch({ type: 'SHOW_READY' });
  }

  private buildView(step: OutlineStep, hydrated: HydratedStep, reviewMode: boolean): StepView {
    const total = this.outline!.steps.length;
    const dots: StepDotStatus[] = Array.from({ length: total }, (_unused, i): StepDotStatus => {
      const n = i + 1;
      const st = this.stepStatus.get(n);
      if (st === 'done') {
        return 'done';
      }
      if (st === 'skipped') {
        return 'skipped';
      }
      return n === this.state.currentStep ? 'current' : 'upcoming';
    });

    const nav = hydrated.navigation;
    let diffHunks: DiffHunkView[];
    if (hydrated.changeKind === 'edit') {
      diffHunks = (hydrated.hunks ?? []).map((h) => ({ oldText: h.oldText, newText: h.newText }));
    } else if (hydrated.changeKind === 'create') {
      diffHunks = [{ oldText: '', newText: hydrated.fullFileContent ?? '' }];
    } else if (hydrated.changeKind === 'delete') {
      diffHunks = [{ oldText: this.beforeTextByStep.get(step.stepNumber) ?? '', newText: '' }];
    } else {
      diffHunks = [];
    }

    return {
      stepNumber: step.stepNumber,
      totalSteps: total,
      title: step.title,
      locationLabel: `${nav.file}:${nav.startLine}-${nav.endLine}`,
      locationFile: nav.file,
      locationLine: nav.startLine,
      genericMarkdown: step.genericExplanation,
      specificMarkdown: step.specificExplanation,
      prerequisites: step.prerequisites ?? [],
      relatedFiles: step.relatedFiles ?? [],
      changeKind: hydrated.changeKind,
      diffHunks,
      reviewMode,
      showPrerequisites: this.opts.showPrerequisites ?? true,
      dots,
    };
  }

  private async handleMessage(msg: WebviewToHost): Promise<void> {
    switch (msg.type) {
      case 'ready':
        break;
      case 'apply':
        await this.apply();
        break;
      case 'skip':
        await this.skip();
        break;
      case 'pause':
        this.pause();
        break;
      case 'reviewStep':
        await this.review(msg.stepNumber);
        break;
      case 'openLocation':
        await this.openLocation(msg.file, msg.line);
        break;
    }
  }

  private absPath(rel: string): string {
    return join(this.opts.workspaceRoot, rel);
  }

  async apply(): Promise<void> {
    if (this.state.phase !== 'waiting_for_apply') {
      return;
    }
    const step = this.currentOutlineStep();
    const hydrated = step && this.hydratedByStep.get(step.stepNumber);
    if (!step || !hydrated) {
      return;
    }
    if (!this.dispatch({ type: 'APPLY' })) {
      return;
    }
    await this.rollback.snapshotBeforeApply(step.stepNumber, this.absPath(hydrated.primaryFile));
    if (hydrated.changeKind === 'rename' && hydrated.renameTo) {
      await this.rollback.snapshotBeforeApply(step.stepNumber, this.absPath(hydrated.renameTo));
    }

    const outcome = await this.editor.applyStep(hydrated);
    if (outcome.status === 'applied') {
      this.dispatch({ type: 'APPLY_DONE' });
      this.stepStatus.set(step.stepNumber, 'done');
      this.appliedCount++;
      this.panel.notifyApplied(step.stepNumber);
      await this.advance();
    } else if (outcome.status === 'conflict') {
      this.dispatch({ type: 'APPLY_FAILED', message: outcome.reason });
      this.panel.notifyConflict(step.stepNumber, outcome.reason);
    } else {
      this.dispatch({ type: 'APPLY_FAILED', message: outcome.message });
      this.panel.notifyError(`Failed to apply step ${step.stepNumber}: ${outcome.message}`);
    }
  }

  async skip(): Promise<void> {
    const step = this.currentOutlineStep();
    if (!step || !this.dispatch({ type: 'SKIP' })) {
      return;
    }
    this.stepStatus.set(step.stepNumber, 'skipped');
    this.skippedCount++;
    await this.advance();
  }

  private async advance(): Promise<void> {
    this.editor.clearHighlights();
    if (!this.dispatch({ type: 'ADVANCE' })) {
      return;
    }
    if (this.state.status === 'completed') {
      this.panel.notifyCompleted(this.appliedCount, this.skippedCount);
      return;
    }
    await this.activateCurrentStep();
  }

  private async review(n: number): Promise<void> {
    if (this.state.phase === 'reviewing' && this.state.review?.viewing === n) {
      if (this.dispatch({ type: 'EXIT_REVIEW' })) {
        const step = this.currentOutlineStep();
        const hydrated = step && this.hydratedByStep.get(step.stepNumber);
        if (step && hydrated) {
          this.panel.renderStep(this.buildView(step, hydrated, false));
        }
      }
      return;
    }
    if (!this.dispatch({ type: 'REVIEW', step: n })) {
      return;
    }
    const step = this.outline?.steps[n - 1];
    const hydrated = this.hydratedByStep.get(n);
    if (step && hydrated) {
      this.panel.renderStep(this.buildView(step, hydrated, true));
    }
  }

  private async openLocation(file: string, line: number): Promise<void> {
    if (!file) {
      return; // e.g. the completion-screen revert placeholder
    }
    await this.editor.navigateTo(file, line || 1, line || 1);
  }
}

import { initialState, transition, type SessionState, type WalkthroughEvent } from './state-machine';
import { applyHunks, locateSnippet } from './anchor';
import type { OutlineStep, WalkthroughOutline, HydratedStep, ApplyOutcome, WalkthroughMode } from './types';
import type { PlanProvider, FileState } from './plan-source';
import type { StepView, StepDotStatus, WebviewToHost, DiffHunkView, ChatEntry } from './webview/protocol';
import type { RevertResult } from './rollback-store';

/**
 * The conductor (design Section 3 & 9). Owns the SessionState, drives the state
 * machine, and coordinates provider -> editor -> rollback -> panel through the
 * outline + lazy-hydration loop. Depends only on narrow ports (structurally
 * satisfied by the real EditorBridge / ExplanationPanel / RollbackStore), so it
 * stays VS Code-free and unit-testable with fakes.
 */

export interface EditorPort {
  listFiles(): Promise<string[]>;
  navigateTo(relPath: string, startLine: number, endLine: number): Promise<void>;
  showDiff(title: string, relPath: string, before: string, after: string): Promise<void>;
  applyStep(step: HydratedStep): Promise<ApplyOutcome>;
  readFile(relPath: string): Promise<string | undefined>;
  clearHighlights(): void;
}

export interface PanelPort {
  showBusy(message: string): void;
  showProgress(text: string): void;
  showIdle(message: string): void;
  showPaused(): void;
  renderStep(view: StepView): void;
  notifyApplied(stepNumber: number): void;
  notifyConflict(stepNumber: number, reason: string): void;
  notifyError(message: string): void;
  notifyCompleted(applied: number, skipped: number, mode: WalkthroughMode): void;
  postAnswer(id: number, answer: string): void;
  postAnswerError(id: number, message: string): void;
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
  /** Hard-abort analysis/hydration after this many seconds. 0 = never (Cancel only). */
  analysisTimeoutSeconds?: number;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Show the "still working" nudge after this long (progress streams before then). */
const SOFT_TIMEOUT_MS = 45_000;
/** Default hard-abort ceiling; overridable via options (0 = never, rely on Cancel). */
const DEFAULT_ANALYSIS_TIMEOUT_SEC = 600;

function join(...parts: string[]): string {
  return parts.join('/').replace(/\/{2,}/g, '/');
}

export class Orchestrator {
  private state: SessionState = initialState();
  private outline?: WalkthroughOutline;
  private mode: WalkthroughMode = 'solve';
  private readonly hydratedByStep = new Map<number, HydratedStep>();
  private readonly beforeTextByStep = new Map<number, string>();
  private readonly stepStatus = new Map<number, 'done' | 'skipped'>();
  private readonly chatByStep = new Map<number, ChatEntry[]>();
  private appliedCount = 0;
  private skippedCount = 0;
  private registered = false;
  private inflight?: AbortController;
  private cancelled = false;
  private timedOut = false;

  /** Run a provider call with a soft "still working" nudge and a hard abort timeout. */
  private async withTimeout<T>(op: (signal: AbortSignal) => Promise<T>, onSoft: () => void): Promise<T> {
    this.cancelled = false;
    this.timedOut = false;
    this.inflight = new AbortController();
    const hardMs = (this.opts.analysisTimeoutSeconds ?? DEFAULT_ANALYSIS_TIMEOUT_SEC) * 1000;
    const soft = setTimeout(onSoft, SOFT_TIMEOUT_MS);
    const hard =
      hardMs > 0
        ? setTimeout(() => {
            this.timedOut = true;
            this.inflight?.abort();
          }, hardMs)
        : undefined;
    try {
      return await op(this.inflight.signal);
    } finally {
      clearTimeout(soft);
      if (hard) {
        clearTimeout(hard);
      }
    }
  }

  /** Abort the in-flight analysis/hydration (from the panel Cancel button). */
  cancel(): void {
    this.cancelled = true;
    this.inflight?.abort();
    // Reset immediately so the panel doesn't sit on a spinner while the
    // subprocess winds down.
    this.panel.showIdle('Cancelled. Run “JustInTime: Start Walkthrough” to begin again.');
  }

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

  async start(problem: string, mode: WalkthroughMode = 'solve'): Promise<void> {
    if (!this.registered) {
      // Return the promise so hosts/tests that care can await it; the real
      // webview host ignores the return value.
      this.panel.onMessage((m) => this.handleMessage(m));
      this.registered = true;
    }
    this.mode = mode;
    this.panel.showBusy(mode === 'explain' ? 'Reading your codebase…' : 'Analyzing your codebase…');

    // Repo-map pre-pass: hand the model the file tree so it skips discovery turns.
    this.panel.showProgress('Mapping the workspace…');
    let repoMap: string[] = [];
    try {
      repoMap = await this.editor.listFiles();
    } catch {
      // Best-effort; fall back to the model globbing on its own.
    }

    let outline: WalkthroughOutline;
    try {
      outline = await this.withTimeout(
        (signal) =>
          this.provider.produceOutline(problem, {
            workspaceRoot: this.opts.workspaceRoot,
            mode,
            signal,
            onProgress: (t) => this.panel.showProgress(t),
            repoMap,
            readFile: (p) => this.editor.readFile(p),
          }),
        () => this.panel.showProgress('Still working on a large codebase… you can Cancel, or start again with a narrower question.'),
      );
    } catch (e) {
      if (this.cancelled) {
        return; // cancel() already reset the panel
      }
      this.panel.showIdle(
        this.timedOut
          ? 'Analysis timed out. Try a narrower question or open a smaller folder, then start again.'
          : `Analysis failed: ${errMsg(e)}`,
      );
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
    if (this.dispatch({ type: 'PAUSE' })) {
      this.panel.showPaused();
    }
  }

  async resume(): Promise<void> {
    if (this.dispatch({ type: 'RESUME' })) {
      this.renderCurrentAfterInterrupt();
    }
  }

  /**
   * Re-render the current step after a pause/review interrupt. If we resumed
   * back into 'explaining', SHOW_READY was never fired (the interrupt landed
   * between HYDRATE_DONE and SHOW_READY), so drive it now.
   */
  private renderCurrentAfterInterrupt(): void {
    const step = this.currentOutlineStep();
    if (!step) {
      return;
    }
    const hydrated = this.hydratedByStep.get(step.stepNumber);
    if (this.mode === 'solve' && !hydrated) {
      return; // solve mode needs a hydrated diff to render
    }
    if (this.state.phase === 'explaining' && !this.dispatch({ type: 'SHOW_READY' })) {
      return;
    }
    this.panel.renderStep(this.buildView(step, hydrated, false));
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
    if (this.mode === 'explain') {
      await this.activateExplainStep(step);
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
      hydrated = await this.withTimeout(
        (signal) =>
          this.provider.hydrateStep(step, current, {
            sessionId: this.outline!.sessionId,
            workspaceRoot: this.opts.workspaceRoot,
            signal,
            onProgress: (t) => this.panel.showProgress(t),
          }),
        () => this.panel.showProgress(`Still preparing step ${step.stepNumber}… you can Cancel.`),
      );
    } catch (e) {
      if (this.cancelled) {
        return; // cancel() already reset the panel
      }
      if (this.timedOut) {
        this.panel.showIdle(`Step ${step.stepNumber} timed out. Start again with a narrower scope.`);
        return;
      }
      this.dispatch({ type: 'HYDRATE_FAILED', message: errMsg(e) });
      this.panel.notifyError(`Could not prepare step ${step.stepNumber}: ${errMsg(e)}`);
      return;
    }

    // The hydrated primaryFile may differ from the outline's targetFiles (two
    // separate model calls); read it now so we don't false-conflict on ''.
    if (current[hydrated.primaryFile] === undefined) {
      const content = await this.editor.readFile(hydrated.primaryFile);
      if (content !== undefined) {
        current[hydrated.primaryFile] = content;
      }
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

    // Anchor the highlight to where the first hunk actually is, rather than the
    // model's advisory navigation line numbers.
    if (hydrated.changeKind === 'edit' && hydrated.hunks && hydrated.hunks.length > 0) {
      const loc = locateSnippet(before, hydrated.hunks[0]!.oldText);
      if (loc) {
        hydrated.navigation = { file: hydrated.primaryFile, startLine: loc.startLine, endLine: loc.endLine };
      }
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

    if (!this.dispatch({ type: 'SHOW_READY' })) {
      // Interrupted (pause/review) during navigate/showDiff — don't paint the
      // interactive Apply UI; the interrupt handler will re-render.
      return;
    }
    this.panel.renderStep(this.buildView(step, hydrated, false));
  }

  private buildView(step: OutlineStep, hydrated: HydratedStep | undefined, reviewMode: boolean): StepView {
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

    const nav = hydrated?.navigation ??
      step.focus ?? { file: step.targetFiles[0] ?? '', startLine: 1, endLine: 1 };

    let diffHunks: DiffHunkView[];
    if (!hydrated) {
      diffHunks = []; // explain mode: no diff
    } else if (hydrated.changeKind === 'edit') {
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
      changeKind: hydrated?.changeKind ?? 'explain',
      diffHunks,
      reviewMode,
      showPrerequisites: this.opts.showPrerequisites ?? true,
      dots,
      mode: this.mode,
      chat: this.chatByStep.get(step.stepNumber) ?? [],
    };
  }

  /** The step currently shown to the user (the reviewed step, or the active one). */
  private displayedStepNumber(): number {
    return this.state.phase === 'reviewing' && this.state.review ? this.state.review.viewing : this.state.currentStep;
  }

  /** Explain mode: navigate to the step's focus and render explanation-only (no diff). */
  private async activateExplainStep(step: OutlineStep): Promise<void> {
    const focus = step.focus ?? { file: step.targetFiles[0] ?? '', startLine: 1, endLine: 1 };
    // Prefer the content-anchored location over the model's advisory line numbers.
    if (focus.anchor) {
      const content = await this.editor.readFile(focus.file);
      const loc = content ? locateSnippet(content, focus.anchor) : undefined;
      if (loc) {
        step.focus = { ...focus, startLine: loc.startLine, endLine: loc.endLine };
      }
    }
    const nav = step.focus ?? focus;
    await this.editor.navigateTo(nav.file, nav.startLine, nav.endLine);
    if (!this.dispatch({ type: 'NAV_DONE' })) {
      return;
    }
    // No diff to hydrate — go straight through to the interactive state.
    if (!this.dispatch({ type: 'HYDRATE_DONE' })) {
      return;
    }
    if (!this.dispatch({ type: 'SHOW_READY' })) {
      return;
    }
    this.panel.renderStep(this.buildView(step, undefined, false));
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
      case 'resume':
        await this.resume();
        break;
      case 'cancel':
        this.cancel();
        break;
      case 'ask':
        await this.ask(msg.id, msg.question);
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
    if (!step) {
      return;
    }
    if (this.mode === 'explain') {
      // "Next" in explain mode: nothing to apply — just advance through the flow.
      if (!this.dispatch({ type: 'APPLY' }) || !this.dispatch({ type: 'APPLY_DONE' })) {
        return;
      }
      this.stepStatus.set(step.stepNumber, 'done');
      this.appliedCount++;
      await this.advance();
      return;
    }
    const hydrated = this.hydratedByStep.get(step.stepNumber);
    if (!hydrated) {
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
      if (!this.dispatch({ type: 'APPLY_DONE' })) {
        // Interrupted while applyStep was awaiting; the change is on disk but
        // the machine moved on. Don't fire advance/accounting on a rejected
        // transition — leave it for manual retry/revert.
        return;
      }
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
    if (!this.dispatch({ type: 'ADVANCE' })) {
      return;
    }
    this.editor.clearHighlights();
    if (this.state.status === 'completed') {
      this.panel.notifyCompleted(this.appliedCount, this.skippedCount, this.mode);
      return;
    }
    await this.activateCurrentStep();
  }

  private async review(n: number): Promise<void> {
    if (this.state.phase === 'reviewing') {
      if (this.state.review?.viewing === n) {
        // Toggle off: user clicked the step they're already reviewing.
        if (this.dispatch({ type: 'EXIT_REVIEW' })) {
          this.renderCurrentAfterInterrupt();
        }
        return;
      }
      // Switching to a different step: exit the current review first so the
      // next REVIEW is a legal transition (no nested review).
      this.dispatch({ type: 'EXIT_REVIEW' });
    }
    if (!this.dispatch({ type: 'REVIEW', step: n })) {
      return;
    }
    const step = this.outline?.steps[n - 1];
    if (!step) {
      return;
    }
    const hydrated = this.hydratedByStep.get(n);
    if (this.mode === 'solve' && !hydrated) {
      return;
    }
    this.panel.renderStep(this.buildView(step, hydrated, true));
  }

  /** Mid-step chat: answer a follow-up question about the displayed step (read-only). */
  private async ask(id: number, question: string): Promise<void> {
    // Record the turn in the displayed step's history so it survives re-renders.
    const stepNumber = this.displayedStepNumber();
    const history = this.chatByStep.get(stepNumber) ?? [];
    const entry: ChatEntry = { id, question };
    history.push(entry);
    this.chatByStep.set(stepNumber, history);

    if (!this.provider.answerQuestion) {
      entry.error = 'Chat is not available for this provider.';
      this.panel.postAnswerError(id, entry.error);
      return;
    }
    const step = this.outline?.steps[stepNumber - 1];
    const contextText = step
      ? `Walkthrough step ${step.stepNumber}: ${step.title}\n` +
        `What it does: ${step.genericExplanation}\n` +
        `Why here: ${step.specificExplanation}\n` +
        `Relevant file(s): ${step.targetFiles.join(', ')}`
      : 'No active step.';
    const ac = new AbortController(); // independent of the walkthrough's inflight controller
    try {
      const answer = await this.provider.answerQuestion(question, contextText, {
        workspaceRoot: this.opts.workspaceRoot,
        signal: ac.signal,
        readFile: (p) => this.editor.readFile(p),
      });
      entry.answer = answer;
      this.panel.postAnswer(id, answer);
    } catch (e) {
      entry.error = errMsg(e);
      this.panel.postAnswerError(id, entry.error);
    }
  }

  private async openLocation(file: string, line: number): Promise<void> {
    if (!file) {
      return; // e.g. the completion-screen revert placeholder
    }
    await this.editor.navigateTo(file, line || 1, line || 1);
  }
}

import type { StepState } from './types';

/**
 * Pure walkthrough state machine (design Section 9). No VS Code, no I/O.
 *
 * Models one walkthrough session: the active step's phase plus the cross-cutting
 * paused / reviewing / conflict / error states. `transition` returns a
 * discriminated result so the orchestrator can handle illegal transitions as
 * data rather than exceptions.
 */

export type SessionStatus = 'idle' | 'active' | 'completed';

export interface SessionState {
  status: SessionStatus;
  /** The active step's phase; meaningful when status === 'active'. */
  phase: StepState;
  /** 1-based index of the active step; 0 before START. */
  currentStep: number;
  totalSteps: number;
  /** Present only while phase === 'reviewing'. */
  review?: { viewing: number; return: { currentStep: number; phase: StepState } };
  /** Present only while phase === 'paused'; the phase to restore on RESUME. */
  pausedFrom?: StepState;
  /** Present only while phase === 'error'. */
  errorMessage?: string;
}

export type WalkthroughEvent =
  | { type: 'START'; totalSteps: number }
  | { type: 'NAV_DONE' }
  | { type: 'HYDRATE_DONE' }
  | { type: 'HYDRATE_FAILED'; message: string }
  | { type: 'SHOW_READY' }
  | { type: 'APPLY' }
  | { type: 'APPLY_DONE' }
  | { type: 'APPLY_FAILED'; message: string }
  | { type: 'CONFLICT' }
  | { type: 'REHYDRATE' }
  | { type: 'FORCE_APPLY' }
  | { type: 'SKIP' }
  | { type: 'ADVANCE' }
  | { type: 'PAUSE' }
  | { type: 'RESUME' }
  | { type: 'REVIEW'; step: number }
  | { type: 'EXIT_REVIEW' }
  | { type: 'ERROR'; message: string }
  | { type: 'RETRY' };

export type TransitionResult =
  | { ok: true; state: SessionState }
  | { ok: false; error: string };

export function initialState(): SessionState {
  return { status: 'idle', phase: 'pending', currentStep: 0, totalSteps: 0 };
}

function ok(state: SessionState): TransitionResult {
  return { ok: true, state };
}

function illegal(event: WalkthroughEvent, phase: StepState): TransitionResult {
  return { ok: false, error: `illegal transition: ${event.type} not allowed from phase '${phase}'` };
}

/** Phases from which the walkthrough may be paused, reviewed, or errored out. */
const ACTIVE_INTERRUPTIBLE: ReadonlySet<StepState> = new Set<StepState>([
  'navigating',
  'hydrating',
  'explaining',
  'waiting_for_apply',
  'applying',
  'confirmed',
  'skipped',
  'conflict',
]);

export function transition(state: SessionState, event: WalkthroughEvent): TransitionResult {
  // START is the only event valid from idle.
  if (event.type === 'START') {
    if (state.status !== 'idle') {
      return { ok: false, error: 'START is only valid from the idle state' };
    }
    if (event.totalSteps < 1) {
      return { ok: false, error: 'totalSteps must be at least 1' };
    }
    return ok({ status: 'active', phase: 'navigating', currentStep: 1, totalSteps: event.totalSteps });
  }

  if (state.status !== 'active') {
    return { ok: false, error: `event ${event.type} requires an active session (status is '${state.status}')` };
  }

  const { phase } = state;

  switch (event.type) {
    case 'NAV_DONE':
      return phase === 'navigating' ? ok({ ...state, phase: 'hydrating' }) : illegal(event, phase);

    case 'HYDRATE_DONE':
      return phase === 'hydrating' ? ok({ ...state, phase: 'explaining' }) : illegal(event, phase);

    case 'HYDRATE_FAILED':
      return phase === 'hydrating'
        ? ok({ ...state, phase: 'error', errorMessage: event.message })
        : illegal(event, phase);

    case 'SHOW_READY':
      return phase === 'explaining' ? ok({ ...state, phase: 'waiting_for_apply' }) : illegal(event, phase);

    case 'APPLY':
      return phase === 'waiting_for_apply' ? ok({ ...state, phase: 'applying' }) : illegal(event, phase);

    case 'APPLY_DONE':
      return phase === 'applying' ? ok({ ...state, phase: 'confirmed' }) : illegal(event, phase);

    case 'APPLY_FAILED':
      return phase === 'applying'
        ? ok({ ...state, phase: 'error', errorMessage: event.message })
        : illegal(event, phase);

    case 'CONFLICT':
      return phase === 'navigating' || phase === 'hydrating' || phase === 'waiting_for_apply'
        ? ok({ ...state, phase: 'conflict' })
        : illegal(event, phase);

    case 'REHYDRATE':
      return phase === 'conflict' ? ok({ ...state, phase: 'hydrating' }) : illegal(event, phase);

    case 'FORCE_APPLY':
      return phase === 'conflict' ? ok({ ...state, phase: 'applying' }) : illegal(event, phase);

    case 'SKIP':
      return phase === 'explaining' || phase === 'waiting_for_apply' || phase === 'conflict'
        ? ok({ ...state, phase: 'skipped' })
        : illegal(event, phase);

    case 'ADVANCE': {
      if (phase !== 'confirmed' && phase !== 'skipped') {
        return illegal(event, phase);
      }
      if (state.currentStep >= state.totalSteps) {
        return ok({ ...state, status: 'completed' });
      }
      return ok({ ...state, currentStep: state.currentStep + 1, phase: 'navigating' });
    }

    case 'PAUSE':
      if (phase === 'paused' || phase === 'reviewing') {
        return illegal(event, phase);
      }
      return ACTIVE_INTERRUPTIBLE.has(phase)
        ? ok({ ...state, phase: 'paused', pausedFrom: phase })
        : illegal(event, phase);

    case 'RESUME':
      if (phase !== 'paused' || state.pausedFrom === undefined) {
        return illegal(event, phase);
      }
      return ok({ status: 'active', phase: state.pausedFrom, currentStep: state.currentStep, totalSteps: state.totalSteps });

    case 'REVIEW':
      if (phase === 'reviewing' || phase === 'paused') {
        return illegal(event, phase);
      }
      if (event.step < 1 || event.step > state.totalSteps) {
        return { ok: false, error: `cannot review step ${event.step}: out of range` };
      }
      return ok({
        ...state,
        phase: 'reviewing',
        review: { viewing: event.step, return: { currentStep: state.currentStep, phase } },
      });

    case 'EXIT_REVIEW': {
      if (phase !== 'reviewing' || state.review === undefined) {
        return illegal(event, phase);
      }
      const { return: r } = state.review;
      return ok({ status: 'active', phase: r.phase, currentStep: r.currentStep, totalSteps: state.totalSteps });
    }

    case 'ERROR':
      return ok({ ...state, phase: 'error', errorMessage: event.message });

    case 'RETRY':
      return phase === 'error'
        ? ok({ status: 'active', phase: 'navigating', currentStep: state.currentStep, totalSteps: state.totalSteps })
        : illegal(event, phase);

    default: {
      const _exhaustive: never = event;
      return { ok: false, error: `unknown event ${JSON.stringify(_exhaustive)}` };
    }
  }
}

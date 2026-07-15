import { describe, it, expect } from 'vitest';
import { initialState, transition, type SessionState, type WalkthroughEvent } from './state-machine';

/** Apply a sequence of events, asserting each succeeds; return the final state. */
function run(events: WalkthroughEvent[], from: SessionState = initialState()): SessionState {
  let state = from;
  for (const ev of events) {
    const r = transition(state, ev);
    if (!r.ok) {
      throw new Error(`unexpected illegal transition on ${ev.type}: ${r.error}`);
    }
    state = r.state;
  }
  return state;
}

describe('initial + START', () => {
  it('starts idle', () => {
    const s = initialState();
    expect(s.status).toBe('idle');
    expect(s.currentStep).toBe(0);
  });

  it('START activates step 1 in navigating', () => {
    const s = run([{ type: 'START', totalSteps: 3 }]);
    expect(s.status).toBe('active');
    expect(s.currentStep).toBe(1);
    expect(s.phase).toBe('navigating');
    expect(s.totalSteps).toBe(3);
  });

  it('rejects START when not idle', () => {
    const s = run([{ type: 'START', totalSteps: 3 }]);
    const r = transition(s, { type: 'START', totalSteps: 2 });
    expect(r.ok).toBe(false);
  });
});

describe('happy path', () => {
  it('navigates → hydrates → explains → waits → applies → confirms → advances', () => {
    const s = run([
      { type: 'START', totalSteps: 2 },
      { type: 'NAV_DONE' },
      { type: 'HYDRATE_DONE' },
      { type: 'SHOW_READY' },
      { type: 'APPLY' },
      { type: 'APPLY_DONE' },
    ]);
    expect(s.phase).toBe('confirmed');
    expect(s.currentStep).toBe(1);

    const s2 = run([{ type: 'ADVANCE' }], s);
    expect(s2.phase).toBe('navigating');
    expect(s2.currentStep).toBe(2);
  });

  it('ADVANCE past the last step completes the session', () => {
    const s = run([
      { type: 'START', totalSteps: 1 },
      { type: 'NAV_DONE' },
      { type: 'HYDRATE_DONE' },
      { type: 'SHOW_READY' },
      { type: 'APPLY' },
      { type: 'APPLY_DONE' },
      { type: 'ADVANCE' },
    ]);
    expect(s.status).toBe('completed');
  });
});

describe('illegal transitions', () => {
  it('rejects APPLY while explaining (must SHOW_READY first)', () => {
    const s = run([{ type: 'START', totalSteps: 1 }, { type: 'NAV_DONE' }, { type: 'HYDRATE_DONE' }]);
    expect(s.phase).toBe('explaining');
    const r = transition(s, { type: 'APPLY' });
    expect(r.ok).toBe(false);
  });

  it('rejects NAV_DONE from waiting_for_apply', () => {
    const s = run([
      { type: 'START', totalSteps: 1 },
      { type: 'NAV_DONE' },
      { type: 'HYDRATE_DONE' },
      { type: 'SHOW_READY' },
    ]);
    expect(transition(s, { type: 'NAV_DONE' }).ok).toBe(false);
  });
});

describe('errors', () => {
  it('HYDRATE_FAILED → error, RETRY → navigating (same step)', () => {
    const s = run([{ type: 'START', totalSteps: 2 }, { type: 'NAV_DONE' }, { type: 'HYDRATE_FAILED', message: 'boom' }]);
    expect(s.phase).toBe('error');
    expect(s.errorMessage).toBe('boom');
    const s2 = run([{ type: 'RETRY' }], s);
    expect(s2.phase).toBe('navigating');
    expect(s2.currentStep).toBe(1);
  });

  it('APPLY_FAILED → error', () => {
    const s = run([
      { type: 'START', totalSteps: 1 },
      { type: 'NAV_DONE' },
      { type: 'HYDRATE_DONE' },
      { type: 'SHOW_READY' },
      { type: 'APPLY' },
      { type: 'APPLY_FAILED', message: 'write denied' },
    ]);
    expect(s.phase).toBe('error');
  });
});

describe('conflict', () => {
  it('CONFLICT from waiting_for_apply, then REHYDRATE → hydrating', () => {
    const base = run([
      { type: 'START', totalSteps: 1 },
      { type: 'NAV_DONE' },
      { type: 'HYDRATE_DONE' },
      { type: 'SHOW_READY' },
      { type: 'CONFLICT' },
    ]);
    expect(base.phase).toBe('conflict');
    expect(run([{ type: 'REHYDRATE' }], base).phase).toBe('hydrating');
    expect(run([{ type: 'FORCE_APPLY' }], base).phase).toBe('applying');
    expect(run([{ type: 'SKIP' }], base).phase).toBe('skipped');
  });
});

describe('skip', () => {
  it('SKIP from waiting_for_apply → skipped, then ADVANCE', () => {
    const s = run([
      { type: 'START', totalSteps: 2 },
      { type: 'NAV_DONE' },
      { type: 'HYDRATE_DONE' },
      { type: 'SHOW_READY' },
      { type: 'SKIP' },
    ]);
    expect(s.phase).toBe('skipped');
    expect(run([{ type: 'ADVANCE' }], s).currentStep).toBe(2);
  });
});

describe('pause / resume', () => {
  it('PAUSE from waiting_for_apply then RESUME restores waiting_for_apply', () => {
    const s = run([
      { type: 'START', totalSteps: 1 },
      { type: 'NAV_DONE' },
      { type: 'HYDRATE_DONE' },
      { type: 'SHOW_READY' },
      { type: 'PAUSE' },
    ]);
    expect(s.phase).toBe('paused');
    expect(run([{ type: 'RESUME' }], s).phase).toBe('waiting_for_apply');
  });

  it('rejects PAUSE during in-flight async phases (hydrating/applying)', () => {
    const hydrating = run([{ type: 'START', totalSteps: 1 }, { type: 'NAV_DONE' }]);
    expect(hydrating.phase).toBe('hydrating');
    expect(transition(hydrating, { type: 'PAUSE' }).ok).toBe(false);

    const applying = run([
      { type: 'START', totalSteps: 1 },
      { type: 'NAV_DONE' },
      { type: 'HYDRATE_DONE' },
      { type: 'SHOW_READY' },
      { type: 'APPLY' },
    ]);
    expect(applying.phase).toBe('applying');
    expect(transition(applying, { type: 'PAUSE' }).ok).toBe(false);
  });

  it('rejects PAUSE when already paused', () => {
    const s = run([
      { type: 'START', totalSteps: 1 },
      { type: 'NAV_DONE' },
      { type: 'HYDRATE_DONE' },
      { type: 'SHOW_READY' },
      { type: 'PAUSE' },
    ]);
    expect(transition(s, { type: 'PAUSE' }).ok).toBe(false);
  });

  it('rejects REVIEW during in-flight async phases', () => {
    const applying = run([
      { type: 'START', totalSteps: 2 },
      { type: 'NAV_DONE' },
      { type: 'HYDRATE_DONE' },
      { type: 'SHOW_READY' },
      { type: 'APPLY' },
    ]);
    expect(transition(applying, { type: 'REVIEW', step: 1 }).ok).toBe(false);
  });
});

describe('illegal & edge transitions', () => {
  it('START with totalSteps < 1 is rejected', () => {
    expect(transition(initialState(), { type: 'START', totalSteps: 0 }).ok).toBe(false);
  });

  it('ERROR from an active phase sets error phase + message', () => {
    const s = run([{ type: 'START', totalSteps: 1 }, { type: 'NAV_DONE' }]);
    const r = transition(s, { type: 'ERROR', message: 'boom' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.state.phase).toBe('error');
      expect(r.state.errorMessage).toBe('boom');
    }
  });

  it('RETRY from a non-error phase is illegal', () => {
    const s = run([{ type: 'START', totalSteps: 1 }, { type: 'NAV_DONE' }, { type: 'HYDRATE_DONE' }]);
    expect(transition(s, { type: 'RETRY' }).ok).toBe(false);
  });

  it('EXIT_REVIEW when not reviewing is illegal', () => {
    const s = run([{ type: 'START', totalSteps: 1 }]);
    expect(transition(s, { type: 'EXIT_REVIEW' }).ok).toBe(false);
  });

  it('REVIEW with an out-of-range step is rejected', () => {
    const s = run([{ type: 'START', totalSteps: 2 }, { type: 'NAV_DONE' }, { type: 'HYDRATE_DONE' }, { type: 'SHOW_READY' }]);
    expect(transition(s, { type: 'REVIEW', step: 9 }).ok).toBe(false);
    expect(transition(s, { type: 'REVIEW', step: 0 }).ok).toBe(false);
  });

  it('ADVANCE from a non-confirmed/skipped phase is illegal', () => {
    const s = run([{ type: 'START', totalSteps: 1 }, { type: 'NAV_DONE' }, { type: 'HYDRATE_DONE' }]);
    expect(transition(s, { type: 'ADVANCE' }).ok).toBe(false);
  });

  it('FORCE_APPLY / REHYDRATE from a non-conflict phase are illegal', () => {
    const s = run([{ type: 'START', totalSteps: 1 }, { type: 'NAV_DONE' }, { type: 'HYDRATE_DONE' }, { type: 'SHOW_READY' }]);
    expect(transition(s, { type: 'FORCE_APPLY' }).ok).toBe(false);
    expect(transition(s, { type: 'REHYDRATE' }).ok).toBe(false);
  });

  it('PAUSE from reviewing is illegal; REVIEW from paused is illegal', () => {
    const reviewing = run([
      { type: 'START', totalSteps: 2 },
      { type: 'NAV_DONE' },
      { type: 'HYDRATE_DONE' },
      { type: 'SHOW_READY' },
      { type: 'REVIEW', step: 1 },
    ]);
    expect(transition(reviewing, { type: 'PAUSE' }).ok).toBe(false);
    const paused = run([
      { type: 'START', totalSteps: 1 },
      { type: 'NAV_DONE' },
      { type: 'HYDRATE_DONE' },
      { type: 'SHOW_READY' },
      { type: 'PAUSE' },
    ]);
    expect(transition(paused, { type: 'REVIEW', step: 1 }).ok).toBe(false);
  });

  it('CONFLICT from a phase that cannot conflict (confirmed) is illegal', () => {
    const s = run([
      { type: 'START', totalSteps: 1 },
      { type: 'NAV_DONE' },
      { type: 'HYDRATE_DONE' },
      { type: 'SHOW_READY' },
      { type: 'APPLY' },
      { type: 'APPLY_DONE' },
    ]);
    expect(s.phase).toBe('confirmed');
    expect(transition(s, { type: 'CONFLICT' }).ok).toBe(false);
  });
});

describe('review', () => {
  it('REVIEW a completed step then EXIT_REVIEW restores prior phase + currentStep', () => {
    const s = run([
      { type: 'START', totalSteps: 3 },
      { type: 'NAV_DONE' },
      { type: 'HYDRATE_DONE' },
      { type: 'SHOW_READY' },
    ]);
    const reviewing = run([{ type: 'REVIEW', step: 1 }], s);
    expect(reviewing.phase).toBe('reviewing');
    expect(reviewing.review?.viewing).toBe(1);
    const back = run([{ type: 'EXIT_REVIEW' }], reviewing);
    expect(back.phase).toBe('waiting_for_apply');
    expect(back.currentStep).toBe(1);
    expect(back.review).toBeUndefined();
  });
});

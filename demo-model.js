export const initialState = (mode = 'solve') => ({ mode, step: 0, decisions: [] });

export function transition(state, action) {
  if (action.type === 'mode') {
    return initialState(action.mode === 'explain' ? 'explain' : 'solve');
  }
  if (action.type === 'reset') return initialState(state.mode);
  if (action.type === 'back') {
    const step = Math.max(0, state.step - 1);
    return { ...state, step, decisions: state.decisions.slice(0, step) };
  }
  if (!['apply', 'skip', 'next'].includes(action.type) || state.step >= 3) return state;
  return {
    ...state,
    step: state.step + 1,
    decisions: [...state.decisions, state.mode === 'solve' && action.type === 'apply']
  };
}

export function files(state) {
  const [guard, helper, regression] = state.mode === 'solve' ? state.decisions : [];
  // Independent fragments preserve every earlier apply/skip decision.
  const helperCode = helper
    ? 'function sum(values) {\n  return values.reduce((a, b) => a + b, 0);\n}\n\n'
    : '';
  const guardCode = guard ? '  if (values.length === 0) return 0;\n' : '';
  const sumExpression = helper ? 'sum(values)' : 'values.reduce((a, b) => a + b, 0)';
  const code = `${helperCode}export function average(values) {\n${guardCode}  return ${sumExpression}\n    / values.length;\n}`;
  const testCode = "import assert from 'node:assert/strict';\nimport { average } from './average.js';\n\n// Illustrative regression case\nassert.equal(average([]), 0);";
  return {
    'average.js': code,
    ...(regression ? { 'average.test.js': testCode } : {})
  };
}

export function createPlayback({
  getState,
  dispatch,
  eligible,
  schedule = setTimeout,
  cancel = clearTimeout,
  onChange = () => {}
}) {
  let generation = 0;
  let timer = null;
  let playing = false;

  const stop = () => {
    generation++;
    if (timer !== null) cancel(timer);
    timer = null;
    playing = false;
    onChange(false);
  };

  const queue = () => {
    const own = generation;
    const mode = getState().mode;
    timer = schedule(() => {
      if (own !== generation || !playing || mode !== getState().mode) return;
      timer = null;
      if (!eligible()) {
        stop();
        return;
      }
      dispatch({ type: mode === 'solve' ? 'apply' : 'next' });
      if (getState().step >= 3) stop();
      else queue();
    }, 2400);
  };

  return {
    stop,
    isPlaying: () => playing,
    play() {
      if (playing || !eligible() || getState().step >= 3) return;
      generation++;
      playing = true;
      onChange(true);
      queue();
    }
  };
}

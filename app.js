import { initialState, transition, files, createPlayback } from './demo-model.js';

const $ = id => document.getElementById(id);
const steps = [
 { title: 'Start with the edge case.', description: 'What happens when there’s nothing to average? Dividing by an empty array’s length returns NaN. Let’s make that behavior intentional.', context: 'Return 0 when the input array is empty.', explain: 'An empty array has length 0. The original function computes 0 / 0, which produces NaN.' },
 { title: 'Give the calculation a name.', description: 'The reducer adds every value together. Extracting a small helper separates the summation from the average, so the intent is easier to read.', context: 'Extract sum(values). This change is independent of the guard.', explain: 'reduce starts at 0 and accumulates each value. Dividing that total by the number of values gives the arithmetic mean.' },
 { title: 'Capture the expectation.', description: 'A focused regression case documents the empty-input behavior. This illustrative test is shown in a separate file; it is not executed here.', context: 'Add an empty-input regression case. It needs the guard to pass.', explain: 'A test for an empty array would document the intended result. The original implementation returns NaN, so expecting 0 would fail.' }
];
let state = initialState();
let selectedFile = 'average.js';
let userPaused = false;
let inView = true;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const motionEligible = () => !document.hidden && !reducedMotion.matches && !userPaused;
const playback = createPlayback({
 getState: () => state,
 eligible: () => motionEligible() && inView,
 dispatch: action => { state = transition(state, action); render(); },
 onChange: playing => { $('demo-play').textContent = playing ? 'Ⅱ Pause guided demo' : '▷ Play guided demo'; }
});

// Every sample line is a text node: fixture strings are never parsed as HTML.
export function renderCode(target, code, original = '') {
 const originalLines = new Set(original.split('\n'));
 const fragment = document.createDocumentFragment();
 code.split('\n').forEach((text, index) => {
  const line = document.createElement('span');
  line.className = `code-line${original && !originalLines.has(text) ? ' added' : ''}`;
  const number = document.createElement('span');
  number.className = 'line-number';
  number.setAttribute('aria-hidden', 'true');
  number.textContent = String(index + 1).padStart(2, '0');
  const source = document.createElement('span');
  source.textContent = text || ' ';
  line.append(number, source);
  fragment.append(line);
 });
 target.replaceChildren(fragment);
}

function render(announcement) {
 const complete = state.step === steps.length;
 const explain = state.mode === 'explain';
 const step = steps[Math.min(state.step, 2)];
 const currentFiles = files(state);
 if (!currentFiles[selectedFile]) selectedFile = 'average.js';
 const applied = state.decisions.filter(Boolean).length;
 renderCode($('demo-code'), currentFiles[selectedFile], selectedFile === 'average.js' ? files(initialState())['average.js'] : '// illustrative test');
 $('file-label').textContent = selectedFile;
 $('file-switch').hidden = !currentFiles['average.test.js'];
 $('file-switch').textContent = selectedFile === 'average.js' ? 'View test file' : 'View function';
 $('step-label').textContent = complete ? 'WALKTHROUGH COMPLETE' : `STEP 0${state.step + 1} OF 03`;
 $('step-title').textContent = complete ? (explain ? 'A little clearer now.' : 'Small steps. Clear decisions.') : step.title;
 $('step-description').textContent = complete ? (explain ? 'You explored the original function without changing a line. Switch to Solve to try the proposed edits, or replay this explanation.' : `${applied} sample ${applied === 1 ? 'change' : 'changes'} applied. ${3 - applied} skipped. These decisions only changed the browser fixture; no code or tests were executed.`) : step.description;
 $('context-label').textContent = explain ? 'READ-ONLY EXPLANATION' : complete ? 'YOUR CALL, AT EVERY STEP' : 'PROPOSED CHANGE';
 $('step-context').textContent = complete ? (explain ? 'The original code is unchanged.' : 'Back rewinds your last decision. Replay starts with the original code.') : explain ? step.explain : step.context;
 $('workspace-label').textContent = explain ? 'Read-only sample' : 'Local sample';
 $('change-count').textContent = `${applied} ${applied === 1 ? 'change' : 'changes'} applied`;
 $('demo-apply').textContent = complete ? 'Replay walkthrough ↻' : explain ? 'Next explanation →' : 'Apply change →';
 $('demo-skip').hidden = explain || complete;
 $('demo-back').disabled = state.step === 0;
 const disablePlay = complete || !motionEligible();
 // Only move focus owned by the control that is about to become unavailable.
 if (disablePlay && document.activeElement === $('demo-play')) {
  $('demo-apply').focus({ preventScroll: true });
 }
 $('demo-play').disabled = disablePlay;
 document.querySelectorAll('.step-track li').forEach((item, index) => {
  item.classList.toggle('current', index === state.step);
  item.classList.toggle('done', index < state.step);
  if (index === state.step) item.setAttribute('aria-current', 'step');
  else item.removeAttribute('aria-current');
 });
 document.querySelectorAll('input[name="mode"]').forEach(input => input.checked = input.value === state.mode);
 $('demo-status').textContent = announcement || (complete ? `${explain ? 'Explanation' : 'Walkthrough'} complete.` : `${explain ? 'Explain' : 'Solve'} · Step ${state.step + 1} of 3`);
 const codeSide = document.querySelector('.code-side');
 codeSide.classList.remove('changed');
 requestAnimationFrame(() => codeSide.classList.add('changed'));
}

function act(action, announcement) {
 playback.stop();
 state = transition(state, action);
 render(announcement);
}
$('demo-apply').addEventListener('click', () => act({ type: state.step === 3 ? 'reset' : state.mode === 'explain' ? 'next' : 'apply' }));
$('demo-skip').addEventListener('click', () => {
 // Keep keyboard focus meaningful when the final skip control disappears.
 if (state.step === 2) $('demo-apply').focus({ preventScroll: true });
 act({ type: 'skip' });
});
$('demo-back').addEventListener('click', () => act({ type: 'back' }));
$('demo-reset').addEventListener('click', () => act({ type: 'reset' }, 'Restarted with the original code.'));
document.querySelectorAll('input[name="mode"]').forEach(input => input.addEventListener('change', () => act({ type: 'mode', mode: input.value }, `${input.value === 'solve' ? 'Solve' : 'Explain'} mode. Fresh walkthrough; original code restored.`)));
$('file-switch').addEventListener('click', () => {
 playback.stop();
 selectedFile = selectedFile === 'average.js' ? 'average.test.js' : 'average.js';
 render(`Viewing ${selectedFile}.`);
});
$('demo-play').addEventListener('click', () => {
 if (playback.isPlaying()) { playback.stop(); $('demo-status').textContent = 'Guided demo paused.'; }
 else { playback.play(); $('demo-status').textContent = state.mode === 'explain' ? 'Playing read-only explanations.' : 'Playing: sample changes apply every few seconds.'; }
});
function updateMotion() {
 playback.stop();
 document.documentElement.classList.toggle('motion-paused', !motionEligible());
 $('motion-toggle').setAttribute('aria-pressed', String(userPaused));
 $('motion-toggle').textContent = userPaused ? 'Enable motion' : 'Pause motion';
 render(reducedMotion.matches ? 'Reduced motion is on. Use the manual steps.' : 'Motion updated. Guided demo stays paused.');
}
$('motion-toggle').addEventListener('click', () => { userPaused = !userPaused; updateMotion(); });
reducedMotion.addEventListener('change', updateMotion);
document.addEventListener('visibilitychange', updateMotion);
if ('IntersectionObserver' in window) {
 const demoObserver = new IntersectionObserver(entries => {
  inView = entries[0].isIntersecting;
  if (!inView) {
   const wasPlaying = playback.isPlaying();
   playback.stop();
   if (wasPlaying) $('demo-status').textContent = 'Paused while the demo is offscreen.';
  }
  $('demo').classList.toggle('motion-paused', !inView);
 }, { threshold: 0 });
 demoObserver.observe($('demo'));
 const revealObserver = new IntersectionObserver(entries => entries.forEach(entry => {
  entry.target.classList.toggle('motion-paused', !entry.isIntersecting);
  if (entry.isIntersecting && motionEligible()) entry.target.classList.add('is-visible');
 }), { threshold: .12 });
 document.querySelectorAll('.reveal, .hero-visual, .hero-copy').forEach(el => revealObserver.observe(el));
}
render();
document.documentElement.classList.toggle('motion-paused', !motionEligible());
document.documentElement.classList.add('motion-ready');
// Only expose controls after all required bindings and the initial render succeeded.
document.querySelectorAll('.interactive').forEach(el => { if (el.id !== 'file-switch') el.hidden = false; });
$('file-switch').hidden = true;
$('demo-play').disabled = !motionEligible();

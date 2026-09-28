import '@fontsource/orbitron/700.css';
import '@fontsource/orbitron/900.css';
import '@fontsource/chakra-petch/400.css';
import '@fontsource/chakra-petch/600.css';
import '@fontsource/chakra-petch/700.css';
import './ui/styles.css';
import { Game } from './game/Game';

// Collect errors for automated checks (window.__errors).
const errs: string[] = [];
(window as unknown as { __errors: string[] }).__errors = errs;
window.addEventListener('error', (e) => errs.push('ERR: ' + e.message));
window.addEventListener('unhandledrejection', (e) => errs.push('REJ: ' + String(e.reason)));

async function boot() {
  // Make sure the display font is ready before canvas letter textures are drawn.
  try {
    await Promise.all([document.fonts.load('900 64px Orbitron'), document.fonts.load('600 16px "Chakra Petch"')]);
  } catch {
    // Fonts are cosmetic; continue without them.
  }
  const game = new Game();
  await game.init();
}

boot().catch((err) => {
  console.error(err);
  const t = document.getElementById('loadtext');
  if (t) t.textContent = 'FAILED TO START: ' + String(err?.message ?? err);
});

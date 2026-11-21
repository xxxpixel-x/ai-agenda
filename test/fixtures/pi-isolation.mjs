import assert from 'node:assert/strict';
import path from 'node:path';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { runTurn } from '../../src/engines/pi.mjs';

const [cwd, agentDir] = process.argv.slice(2);
const faux = fauxProvider();
faux.setResponses([(ctx) => {
  const system = JSON.stringify(ctx.messages.filter((m) => m.role === 'system'));
  assert.match(system, /agenda-system-marker/);
  assert.doesNotMatch(system, /poison/);
  assert.ok(ctx.messages.findLast((m) => m.role === 'user').content.some((b) => b.type === 'image'));
  return fauxAssistantMessage('isolated');
}]);
const result = await runTurn({ cwd, agentDir, provider: faux.provider, system: 'agenda-system-marker', prompt: 'hello',
  images: [{ path: path.join(cwd, 'pixel.png'), type: 'image/png' }] });
assert.equal(result.text, 'isolated');

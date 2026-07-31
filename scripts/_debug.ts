import { generateMap } from '../src/sim/mapgen';
try {
  const plan = generateMap(1, 320, 240, 'bourg');
  if (!plan) { console.log('NULL'); process.exit(1); }
  console.log('OK —', plan.fp.buildings.length, 'buildings');
} catch (e: any) {
  console.error('THREW:', e.message);
  process.exit(1);
}
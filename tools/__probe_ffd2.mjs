import { readFileSync } from 'node:fs';
import * as DB from 'pixi-dragonbones-runtime';
const ske = JSON.parse(readFileSync('public/blip/blip_ske.json','utf8'));
const parser = new DB.ObjectDataParser();
const data = parser.parseDragonBonesData(ske, 1.0);
const armData = data.getArmature('blip');
for (const an of ['idle','wave','blink']) {
  const a = armData.animations[an];
  // AnimationData stores per-bone/slot timelines maps. Inspect keys.
  const slotKeys = a.slotTimelines ? Object.keys(a.slotTimelines) : null;
  const boneKeys = a.boneTimelines ? Object.keys(a.boneTimelines) : null;
  // FFD deform timelines are usually stored under a deform/slot timeline map.
  const props = Object.keys(a).filter(k=>k.toLowerCase().includes('timeline')||k.toLowerCase().includes('deform')||k.toLowerCase().includes('ffd'));
  console.log(an, 'timeline-like props:', props.join(','));
  if (a.boneTimelines) console.log('  bone:', Object.keys(a.boneTimelines).join(','));
  if (a.slotTimelines) console.log('  slot:', Object.keys(a.slotTimelines).join(','));
}
// dump one anim object shallow
const idle = armData.animations['idle'];
console.log('idle own keys:', Object.keys(idle).join(','));

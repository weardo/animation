import { readFileSync } from 'node:fs';
import * as DB from 'pixi-dragonbones-runtime';
const ske = JSON.parse(readFileSync('public/blip/blip_ske.json','utf8'));
const parser = new DB.ObjectDataParser();
const data = parser.parseDragonBonesData(ske, 1.0);
const armData = data.getArmature('blip');
const idle = armData.animations['idle'];
const bodyTL = idle.slotTimelines['body'];
console.log('idle body slot timelines count:', bodyTL.length);
for (const tl of bodyTL) {
  console.log('  timeline type:', tl.type, 'frameCount-ish');
}
// TimelineType constant for slot deform
console.log('TimelineType.SlotDeform =', DB.TimelineType ? DB.TimelineType.SlotDeform : 'n/a');
// Check float frame array has nonzero deltas stored
console.log('frameFloatArray length:', data.frameFloatArray.length, 'sample nonzero count:', data.frameFloatArray.filter(v=>v!==0).length);

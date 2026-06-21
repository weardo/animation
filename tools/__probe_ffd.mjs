// Throwaway probe: parse blip skeleton via the runtime parser and drive the FFD timeline headless,
// reading slot._displayFrame.deformVertices to confirm authored FFD moves verts. No GL needed for
// the armature math (only the Pixi *display* needs WebGL); we use the base factory + WorldClock-free
// advanceTime, exactly the path RigLayer uses (currentTime setter + advanceTime(0)).
import { readFileSync } from 'node:fs';
import { BaseObject, WorldClock } from 'pixi-dragonbones-runtime';
import * as DB from 'pixi-dragonbones-runtime';

const ske = JSON.parse(readFileSync('public/blip/blip_ske.json','utf8'));

// Use the raw ObjectDataParser + BaseFactory-free path: build a DragonBonesData, then an Armature.
const parser = new DB.ObjectDataParser();
const data = parser.parseDragonBonesData(ske, 1.0);
console.log('armatures:', data.armatureNames);
const armData = data.getArmature('blip');
console.log('bones:', armData.sortedBones.map(b=>b.name).join(','));
console.log('anims:', Object.keys(armData.animations).join(','));
const idle = armData.animations['idle'];
console.log('idle frames duration:', idle.frameCount ?? idle.duration);

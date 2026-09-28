// Shark test: builds the procedural reef shark over a plain ground plane (no terrain: it cruises
// at its home) and renders it from a few angles mid tail-beat.
//   node test/world-shark.mjs [outPrefix]     -> <outPrefix>-{side,top,front}.png
import './headless.mjs';
import { worldHarness, done } from './world-harness.mjs';
import { Material } from '../src/engine/render/Material.js';
import { Shark } from '../src/world/Shark.js';

const out = process.argv[ 2 ] || '/tmp/claude-shark';
const H = await worldHarness( { width: 1600, height: 900 } );
const { E, scene } = H;

const ground = new E.Mesh( new E.PlaneGeometry( 60, 60 ).rotateX( - Math.PI / 2 ), new Material( { name: 'ground', color: 0x8f8a78, roughness: 0.95 } ) );
ground.position.y = - 1.2;
ground.receiveShadow = true;
scene.add( ground );

const shark = new Shark( { scene, terrain: null, homePos: new E.Vector3( 0, 0, 0 ) } );
shark.heading.set( 0, 0, - 1 );
shark.update( 0.4, { playerPos: new E.Vector3( 0, 0, 50 ), playerInWater: false, spearedFish: false } );
const p = shark.position;
const at = ( x, y, z ) => [ p.x + x, p.y + y, p.z + z ];

await H.shot( `${ out }-side.png`, { pos: at( - 4.2, 0.6, 0 ), target: at( 0, 0.05, 0 ), fov: 40 } );
await H.shot( `${ out }-top.png`, { pos: at( 0.01, 4.5, 0.01 ), target: at( 0, 0, 0 ), fov: 40 } );
await H.shot( `${ out }-front.png`, { pos: at( 2.2, 0.9, - 3.0 ), target: at( 0, 0, 0 ), fov: 40 } );
await done();

// Ray test: builds a short-tail stingray and an eagle ray over a plain ground plane (no terrain) and
// renders them from a few angles mid-wave.
//   node test/world-stingray.mjs [outPrefix]     -> <outPrefix>-{side,top,front,eagle-side,eagle-top,eagle-front,belly,pair}.png
import './headless.mjs';
import { worldHarness, done } from './world-harness.mjs';
import { Material } from '../src/engine/render/Material.js';
import { Rays } from '../src/world/marine/Rays.js';

const out = process.argv[ 2 ] || '/tmp/claude-stingray';
const H = await worldHarness( { width: 1600, height: 900 } );
const { E, scene } = H;

const ground = new E.Mesh( new E.PlaneGeometry( 80, 80 ).rotateX( - Math.PI / 2 ), new Material( { name: 'ground', color: 0xb8ae92, roughness: 0.95 } ) );
ground.position.y = - 6;
ground.receiveShadow = true;
scene.add( ground );

// flat seabed at -6 m for the brains
const terrain = { heightAt: () => - 6, normalAt: ( x, z, o ) => o.set( 0, 1, 0 ) };
const rays = new Rays( { scene, terrain, spawns: [
	{ species: 'stingray', x: 0, z: 0, scale: 1, roam: 20 },
	{ species: 'eagle', x: 6, z: 0, scale: 1, roam: 20 },
] } );

// hold them still (pose only), mid-wave
const [ sting, eagle ] = rays.rays.map( ( r ) => r.brain );
const pose = ( b, x, y, phase ) => {

	b.update = () => {};
	b.position.set( x, y, 0 );
	b.yaw = 0; b.pitch = 0; b.roll = 0; b.settled = 0;
	b.phase = phase; b.tailPhase = phase * 0.7;

};

pose( sting, 0, - 5.4, 1.2 );
pose( eagle, 6, - 4.8, 1.0 );
sting.amp = 0.055;
eagle.amp = 0.2;
rays.update( 0, null, null );
rays.update( 1 / 60, null, null );

const at = ( b, x, y, z ) => [ b.position.x + x, b.position.y + y, b.position.z + z ];
await H.shot( `${ out }-side.png`, { pos: at( sting, - 3.0, 0.5, 0.3 ), target: at( sting, 0, 0, 0.3 ), fov: 40 } );
await H.shot( `${ out }-top.png`, { pos: at( sting, 0.01, 3.4, 0.4 ), target: at( sting, 0, 0, 0.4 ), fov: 40 } );
await H.shot( `${ out }-front.png`, { pos: at( sting, 1.6, 0.9, - 2.2 ), target: at( sting, 0, 0, 0.1 ), fov: 40 } );
await H.shot( `${ out }-eagle-side.png`, { pos: at( eagle, - 2.4, 0.5, 0.3 ), target: at( eagle, 0, 0, 0.3 ), fov: 40 } );
await H.shot( `${ out }-eagle-top.png`, { pos: at( eagle, 0.01, 3.0, 0.4 ), target: at( eagle, 0, 0, 0.4 ), fov: 40 } );
await H.shot( `${ out }-eagle-front.png`, { pos: at( eagle, 1.2, 0.7, - 2.0 ), target: at( eagle, 0, 0, 0.1 ), fov: 40 } );
// the pale belly: rolled over to face the sun
sting.roll = Math.PI;
rays.update( 1 / 60, null, null );
await H.shot( `${ out }-belly.png`, { pos: at( sting, 0.01, 3.4, 0.4 ), target: at( sting, 0, 0, 0.4 ), fov: 40 } );
sting.roll = 0;
// wing beat at the top of the stroke
eagle.phase = 2.6;
rays.update( 1 / 60, null, null );
await H.shot( `${ out }-pair.png`, { pos: [ 3, - 2.5, 5.5 ], target: [ 3, - 5.2, 0 ], fov: 50 } );
await done();

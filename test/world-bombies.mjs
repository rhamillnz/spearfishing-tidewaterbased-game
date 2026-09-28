// Bombies test: checks that no pinnacle (rock or kelp) breaks the sea surface on the real terrain,
// then renders one pinnacle standing on a flat 12 m seabed.
//   node test/world-bombies.mjs [outPrefix]     -> <outPrefix>-{side,close}.png
import './headless.mjs';
import { worldHarness, done } from './world-harness.mjs';
import { Material } from '../src/engine/render/Material.js';
import { TerrainData } from '../src/world/TerrainData.js';
import { Bombies, BOMBIE_LOCATIONS } from '../src/world/Bombies.js';

const out = process.argv[ 2 ] || '/tmp/claude-bombies';

// the whole reef on the real terrain, off-screen: nothing above y = -0.5
{

	const real = new Bombies( { scene: { add() {} }, terrain: new TerrainData() } );
	const g = real.mesh.geometry;
	g.computeBoundingBox();
	console.log( 'bombies: triangles', g.index.count / 3, 'highest point', g.boundingBox.max.y.toFixed( 2 ) );
	if ( g.boundingBox.max.y > - 0.5 ) throw new Error( 'a bombie breaks the surface' );

}

const H = await worldHarness( { width: 1600, height: 900 } );
const { E, scene } = H;

const SEABED = - 12;
const ground = new E.Mesh( new E.PlaneGeometry( 120, 120 ).rotateX( - Math.PI / 2 ), new Material( { name: 'ground', color: 0x8f8a78, roughness: 0.95 } ) );
ground.position.y = SEABED;
ground.receiveShadow = true;
scene.add( ground );

// one pinnacle (the Cathedral Haystack) moved to the origin
const b = BOMBIE_LOCATIONS[ 5 ];
BOMBIE_LOCATIONS.length = 0;
BOMBIE_LOCATIONS.push( { ...b, x: 0, z: 0 } );
new Bombies( { scene, terrain: { heightAt: () => SEABED } } );

await H.shot( `${ out }-side.png`, { pos: [ - 22, - 5, 6 ], target: [ 0, - 7, 0 ], fov: 50 } );
await H.shot( `${ out }-close.png`, { pos: [ - 8, - 3.5, 5 ], target: [ 0, - 4.5, 0 ], fov: 55 } );
await done();

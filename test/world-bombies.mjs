// Bombies test: checks on the real terrain that no pinnacle (rock or kelp) comes within 0.8 m of
// the sea surface, that every foot is sunk into the seabed and the boulders are half buried, and
// that the triangle budget holds; then renders one pinnacle standing on a flat 12 m seabed and one
// shallow reef on a 3 m seabed.
//   node test/world-bombies.mjs [outPrefix]     -> <outPrefix>-{side,close,base,reef}.png
import './headless.mjs';
import { worldHarness, done } from './world-harness.mjs';
import { Material } from '../src/engine/render/Material.js';
import { TerrainData } from '../src/world/TerrainData.js';
import { Bombies, BOMBIE_LOCATIONS } from '../src/world/Bombies.js';

const out = process.argv[ 2 ] || '/tmp/claude-bombies';

// the whole reef on the real terrain, off-screen
{

	const terrain = new TerrainData();
	const real = new Bombies( { scene: { add() {} }, terrain } );
	let tris = 0, top = - Infinity;
	for ( const m of [ real.mesh, real.kelpMesh ] ) {

		const g = m.geometry;
		g.computeBoundingBox();
		tris += g.index.count / 3;
		top = Math.max( top, g.boundingBox.max.y );
		console.log( `${ m.name }: triangles ${ g.index.count / 3 }, highest point ${ g.boundingBox.max.y.toFixed( 2 ) }` );

	}

	console.log( 'bombies: triangles', tris, 'highest point', top.toFixed( 2 ) );
	if ( top > - 0.8 ) throw new Error( 'a bombie comes within 0.8 m of the surface' );
	if ( tris > 130000 ) throw new Error( 'bombies over the triangle budget' );
	for ( const b of real.locations ) {

		console.log( `  ${ b.name.padEnd( 24 ) } seabed ${ b.baseDepth.toFixed( 1 ) }  top ${ b.topDepth.toFixed( 1 ) }  radius ${ b.radius.toFixed( 1 ) } (foot ${ b.footRadius.toFixed( 1 ) })  foot sunk ${ b.baseSunk.toFixed( 2 ) } m  boulders buried ${ ( b.boulderBuried * 100 ).toFixed( 0 ) }%` );
		if ( b.baseSunk < 0.8 ) throw new Error( `${ b.name }: foot not sunk 0.8 m into the seabed` );
		if ( b.boulderBuried < 0.35 ) throw new Error( `${ b.name }: a boulder is less than 35% buried` );

	}

	// no two pinnacles overlap
	const L = real.locations;
	for ( let i = 0; i < L.length; i ++ ) {

		for ( let j = i + 1; j < L.length; j ++ ) {

			if ( Math.hypot( L[ i ].x - L[ j ].x, L[ i ].z - L[ j ].z ) < L[ i ].footRadius + L[ j ].footRadius + 2 ) throw new Error( `${ L[ i ].name } overlaps ${ L[ j ].name }` );

		}

	}

}

const H = await worldHarness( { width: 1600, height: 900 } );
const { E, scene } = H;

const ground = new E.Mesh( new E.PlaneGeometry( 200, 200 ).rotateX( - Math.PI / 2 ), new Material( { name: 'ground', color: 0x8f8a78, roughness: 0.95 } ) );
ground.receiveShadow = true;
scene.add( ground );

// one pinnacle (the Cathedral Haystack) moved to the origin on a 12 m seabed, and a shallow
// reef (the Kelp Forest Bombie) 60 m off on a 3 m seabed (terraced ground: a flat mesh cannot
// be at both depths, so the reef shot sees the reef's own floor)
const SEABED = - 12, REEF_BED = - 3;
const cath = BOMBIE_LOCATIONS[ 5 ], reef = BOMBIE_LOCATIONS[ 7 ];
BOMBIE_LOCATIONS.length = 0;
BOMBIE_LOCATIONS.push( { ...cath, x: 0, z: 0 } );
ground.position.y = SEABED;
const one = new Bombies( { scene, terrain: { heightAt: () => SEABED } } );

await H.shot( `${ out }-side.png`, { pos: [ - 24, - 5, 8 ], target: [ 0, - 7, 0 ], fov: 50 } );
await H.shot( `${ out }-close.png`, { pos: [ - 7, - 2.6, 5 ], target: [ 0, - 3.8, 0 ], fov: 55 } );
await H.shot( `${ out }-base.png`, { pos: [ - 13, - 11.2, 6 ], target: [ 0, - 10.5, 0 ], fov: 60 } );

scene.remove( one.mesh ); scene.remove( one.kelpMesh );
BOMBIE_LOCATIONS.length = 0;
BOMBIE_LOCATIONS.push( { ...reef, x: 0, z: 0 } );
ground.position.y = REEF_BED;
new Bombies( { scene, terrain: { heightAt: () => REEF_BED } } );
await H.shot( `${ out }-reef.png`, { pos: [ - 11, - 0.9, 7 ], target: [ 0, - 2.6, 0 ], fov: 55 } );
await done();

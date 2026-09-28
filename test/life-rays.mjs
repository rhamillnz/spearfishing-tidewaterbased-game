// Ray behaviour on the CPU (node, no GPU): runs every ray of the game's RAY_SPAWNS (src/world/marine/
// Rays.js) over the production terrain for several simulated minutes and asserts they
//   - stay under water (never break the surface) and above the seabed
//   - never go over water shallower than MIN_WATER, into the bombies or out of the play area
//   - actually move (cruise around, not stuck), stingrays hug the bottom and rest on the sand now and
//     then, eagle rays cruise higher
//   - glide away from a swimming diver who comes close (and ignore one on the boat / beach)
//   node test/life-rays.mjs
import { Vector3 } from '../src/engine/index.js';
import { TerrainData } from '../src/world/TerrainData.js';
import { RayBrain, RAY_SPECIES, MIN_WATER, SHY_DIST, AREA, bombieFootprints } from '../src/world/marine/RayBrain.js';
import { RAY_SPAWNS } from '../src/world/marine/Rays.js';

let fails = 0;
const check = ( ok, msg ) => {

	console.log( ( ok ? 'ok   ' : 'FAIL ' ) + msg );
	if ( ! ok ) fails ++;

};

const terrain = new TerrainData();
const bombies = bombieFootprints( terrain );
const dt = 1 / 30;
const MINUTES = 12;
const mk = ( s, i ) => new RayBrain( { terrain, species: s.species, home: new Vector3( s.x, 0, s.z ), roam: s.roam, scale: s.scale, seed: i * 7 + 3 } );
const rays = RAY_SPAWNS.map( mk );
check( rays.length >= 4 && rays.length <= 8, `${ rays.length } rays (${ rays.filter( ( r ) => r.species === 'stingray' ).length } stingrays, ${ rays.filter( ( r ) => r.species === 'eagle' ).length } eagle rays)` );

const stats = rays.map( ( r ) => ( {
	start: r.position.clone(), last: r.position.clone(), path: 0, maxTop: - Infinity, minBelly: Infinity, minWater: Infinity,
	minBombie: Infinity, outside: 0, bad: 0, rests: 0, altSum: 0, n: 0, wasRest: false, maxFromHome: 0,
} ) );

const steps = Math.round( MINUTES * 60 / dt );
for ( let k = 0; k < steps; k ++ ) {

	for ( let i = 0; i < rays.length; i ++ ) {

		const r = rays[ i ], s = stats[ i ], p = r.position;
		r.update( dt, null );
		if ( ! Number.isFinite( p.x + p.y + p.z + r.yaw + r.phase + r.amp ) ) s.bad ++;
		const g = terrain.heightAt( p.x, p.z );
		const sp = RAY_SPECIES[ r.species ];
		s.maxTop = Math.max( s.maxTop, p.y + sp.halfThick * r.scale );
		s.minBelly = Math.min( s.minBelly, p.y - g );
		s.minWater = Math.min( s.minWater, - g );
		for ( const b of bombies ) s.minBombie = Math.min( s.minBombie, Math.hypot( p.x - b.x, p.z - b.z ) - b.radius );
		if ( p.x < AREA.xMin || p.x > AREA.xMax || p.z < AREA.zMin || p.z > AREA.zMax ) s.outside ++;
		s.path += p.distanceTo( s.last );
		s.last.copy( p );
		s.altSum += p.y - g;
		s.n ++;
		const resting = r.state === 'rest';
		if ( resting && ! s.wasRest ) s.rests ++;
		s.wasRest = resting;
		s.maxFromHome = Math.max( s.maxFromHome, Math.hypot( p.x - r.home.x, p.z - r.home.z ) );

	}

}

for ( let i = 0; i < rays.length; i ++ ) {

	const r = rays[ i ], s = stats[ i ];
	const name = `${ r.species } #${ i }`;
	console.log( `  ${ name }: path ${ s.path.toFixed( 0 ) } m, net ${ s.start.distanceTo( r.position ).toFixed( 1 ) } m, mean altitude ${ ( s.altSum / s.n ).toFixed( 2 ) } m, top ${ s.maxTop.toFixed( 2 ) }, min belly ${ s.minBelly.toFixed( 3 ) }, min water ${ s.minWater.toFixed( 2 ) } m, bombie clearance ${ s.minBombie.toFixed( 1 ) } m, rests ${ s.rests }, max from home ${ s.maxFromHome.toFixed( 0 ) } m` );
	check( s.bad === 0, `${ name }: finite state` );
	check( s.maxTop < - 0.5, `${ name }: stays under water (top ${ s.maxTop.toFixed( 2 ) } m)` );
	check( s.minBelly > 0, `${ name }: stays above the seabed` );
	check( s.minWater >= MIN_WATER, `${ name }: never over water shallower than ${ MIN_WATER } m (${ s.minWater.toFixed( 2 ) })` );
	check( s.minBombie > 2.0, `${ name }: keeps clear of the bombies (${ s.minBombie.toFixed( 1 ) } m)` );
	check( s.outside === 0, `${ name }: stays in the play area` );
	check( s.path > 120, `${ name }: moves (${ s.path.toFixed( 0 ) } m in ${ MINUTES } min)` );
	check( s.maxFromHome > 8 && s.maxFromHome < 120, `${ name }: roams around its patch (max ${ s.maxFromHome.toFixed( 0 ) } m from home)` );
	if ( r.species === 'stingray' ) {

		check( s.altSum / s.n < 1.2, `${ name }: hugs the bottom` );
		check( s.rests >= 1, `${ name }: rests on the sand now and then (${ s.rests })` );

	} else check( s.altSum / s.n > 1.0, `${ name }: cruises higher` );

}

// ---- shy: a swimming diver right next to each ray; it should put SHY_DIST between them within a few s
{

	const out = [];
	for ( let i = 0; i < rays.length; i ++ ) {

		const r = rays[ i ];
		const diverPos = r.position.clone().add( new Vector3( 1.5, 0.3, 0 ) );
		const diver = { position: diverPos, swimming: true };
		let fled = false, t = 0;
		for ( ; t < 8; t += dt ) {

			r.update( dt, diver );
			if ( r.position.distanceTo( diverPos ) > SHY_DIST + 0.5 ) {

				fled = true;
				break;

			}

		}

		out.push( t );
		check( fled, `${ r.species } #${ i }: glides away from a close diver (${ fled ? t.toFixed( 1 ) + ' s' : 'no' })` );

	}

	// a resting stingray lifts off when approached
	const r = mk( RAY_SPAWNS.find( ( s ) => s.species === 'stingray' ), 99 );
	for ( let k = 0; k < 20 * 60 / dt && r.state !== 'rest'; k ++ ) r.update( dt, null );
	check( r.state === 'rest', 'a stingray settles to rest' );
	const diverPos = r.position.clone().add( new Vector3( 0, 1, 2.5 ) );
	r.update( dt, { position: diverPos, swimming: true } );
	check( r.state === 'flee', 'a resting stingray bolts when the diver swims up' );

	// a diver out of the water (boat / beach) is ignored
	const r2 = mk( RAY_SPAWNS[ 0 ], 5 );
	r2.update( dt, { position: r2.position.clone().add( new Vector3( 1, 0, 0 ) ), swimming: false } );
	check( r2.state !== 'flee', 'ignores a diver who is not swimming' );

}

console.log( fails ? `${ fails } FAILED` : 'all ray checks passed' );
process.exit( fails ? 1 : 0 );

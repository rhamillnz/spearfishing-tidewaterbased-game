// Bombies collision + circling test (node, no GPU): checks that the swimming player cannot pass
// through a bombie's rock and slides smoothly around it (Colliders' stacked cylinders, built by
// Bombies.js from the same profile bombieRadiusAt() reads), and that the reef's fish (Fish.js)
// never end up inside a bombie's profile - including their spawn positions - while the ones
// attracted to a bombie actually circle it (a ring outside the rock, real angular motion) rather
// than clustering at its centre. See life-fish.mjs / life-player.mjs for the same no-GPU approach,
// and world-bombies.mjs for the geometry's own checks (foot sunk, boulders buried, ...).
//   node test/life-bombie-collide.mjs
import { TerrainData } from '../src/world/TerrainData.js';
import { WORLD } from '../src/world/WorldLayout.js';
import { FishSchools } from '../src/world/Fish.js';
import { Bombies, BOMBIE_LOCATIONS, bombieRadiusAt } from '../src/world/Bombies.js';
import { Colliders } from '../src/world/Colliders.js';

let fails = 0;
const check = ( ok, msg ) => {

	console.log( ( ok ? 'ok   ' : 'FAIL ' ) + msg );
	if ( ! ok ) fails ++;

};

const terrain = new TerrainData();

// ------------------------------------------------------------------ player / boat collision

const colliders = new Colliders();
const bombies = new Bombies( { scene: { add() {} }, terrain, colliders } );
check( colliders.cylinders.length >= BOMBIE_LOCATIONS.length * 3, `bombies: ${ colliders.cylinders.length } collider cylinders for ${ BOMBIE_LOCATIONS.length } pinnacles` );

// walk a capsule straight at each bombie's axis at a few heights through its column: it must never
// cross the axis (the cylinders stop it well outside), and it must never take an unreasonably big
// single-frame step (a smooth push-out, not a teleport)
{

	let worstGap = Infinity, maxStep = 0;
	for ( const b of bombies.locations ) {

		for ( const frac of [ 0.1, 0.4, 0.7 ] ) {

			const y = b.baseDepth + ( b.topDepth - b.baseDepth ) * frac;
			const pos = { x: b.x - b.footRadius - 15, y, z: b.z };
			for ( let i = 0; i < 800; i ++ ) {

				const before = pos.x;
				pos.x += 0.05;
				colliders.resolveCapsule( pos, 0.3, 1.0, 0 );
				maxStep = Math.max( maxStep, Math.abs( pos.x - before ) );

			}

			const dist = Math.hypot( pos.x - b.x, pos.z - b.z );
			const rock = bombieRadiusAt( b, y );
			worstGap = Math.min( worstGap, dist - rock );

		}

	}

	check( worstGap > 0, `player: never inside a bombie's rock walking straight at the axis (closest gap ${ worstGap.toFixed( 2 ) } m outside the surface)` );
	check( maxStep < 0.5, `player: no single-frame teleport while colliding (largest step ${ maxStep.toFixed( 3 ) } m for a 0.05 m/frame walk)` );

}

// approach off-axis and keep walking straight through: the capsule should slide around the rock and
// come out the far side well clear of it, not get stuck against it
{

	const b = bombies.locations[ 0 ];
	const pos = { x: b.x - b.footRadius - 20, y: b.baseDepth + ( b.topDepth - b.baseDepth ) * 0.4, z: b.z + b.footRadius * 0.5 };
	let stuck = 0;
	for ( let i = 0; i < 1600; i ++ ) {

		const before = pos.x;
		colliders.resolveCapsule( pos, 0.3, 1.0, 0 );
		pos.x += 0.05;
		if ( Math.abs( pos.x - before - 0.05 ) > 0.001 ) stuck ++; // the collider fought the forward step

	}

	const endsClear = pos.x > b.x + b.footRadius + 15;
	check( endsClear, `player: slides past an off-axis bombie and keeps going (ended ${ ( pos.x - b.x ).toFixed( 1 ) } m past the centre)` );
	check( stuck < 1600, `player: forward progress isn't fully blocked while sliding (${ stuck }/1600 steps deflected)` );

}

// ------------------------------------------------------------------ fish: never inside, and circle

const rc = WORLD.reef.center;
const fish = new FishSchools( { parent: { add() {} }, terrain, center: rc.clone(), radius: WORLD.reef.radius + 10 } );

function insidePenetration( x, y, z ) {

	let worst = 0;
	for ( const b of bombies.locations ) {

		if ( y < b.baseDepth - 0.05 || y > b.topDepth + 0.05 ) continue;
		const d = Math.hypot( x - b.x, z - b.z );
		worst = Math.max( worst, bombieRadiusAt( b, y ) - d );

	}

	return worst; // > 0: inside by that many metres

}

function maxPenetrationOverAllFish() {

	let worst = 0;
	for ( let i = 0; i < fish.n; i ++ ) worst = Math.max( worst, insidePenetration( fish.pos[ i * 3 ], fish.pos[ i * 3 + 1 ], fish.pos[ i * 3 + 2 ] ) );
	return worst;

}

// before setBombies(): FishSchools laid its groups out with only the raw BOMBIE_LOCATIONS entries
// (no terrain-fitted geometry yet), so some spawns can land inside where the real rock turns out to
// be. setBombies() must fix that immediately (the game never renders a frame in between).
const beforeCount = ( () => {

	let n = 0;
	for ( let i = 0; i < fish.n; i ++ ) if ( insidePenetration( fish.pos[ i * 3 ], fish.pos[ i * 3 + 1 ], fish.pos[ i * 3 + 2 ] ) > 0 ) n ++;
	return n;

} )();
fish.setBombies( bombies );
check( maxPenetrationOverAllFish() === 0, `fish: spawn positions are clear of every bombie right after setBombies() (${ beforeCount } needed correcting)` );

// simulate several minutes with every group active (no player -> nothing culled by distance) and
// track: (a) no fish ever ends up inside a bombie, (b) fish attracted to one spend most of their
// time in a ring just outside its surface, (c) they actually go round it (angular motion), not just
// mill in place
const bombieGroups = fish.groups.filter( ( g ) => g.zone.bombieIndex != null );
check( bombieGroups.length > 0, `fish: ${ bombieGroups.length } schools are attracted to the bombies` );

const trackers = bombieGroups.map( ( g ) => ( { g, loc: bombies.locations[ g.zone.bombieIndex ], angle: null, total: 0 } ) );
const ringSamples = [];
let worstPenetration = 0;

const dt = 1 / 20, minutes = 4, steps = Math.round( minutes * 60 / dt );
for ( let s = 0; s < steps; s ++ ) {

	fish.update( dt, null );
	worstPenetration = Math.max( worstPenetration, maxPenetrationOverAllFish() );

	if ( s % 40 === 0 ) { // every 2 s: each group's centre angle around its own bombie, unwrapped

		for ( const tr of trackers ) {

			const ang = Math.atan2( tr.g.center.z - tr.loc.z, tr.g.center.x - tr.loc.x );
			if ( tr.angle !== null ) {

				let d = ang - tr.angle;
				while ( d > Math.PI ) d -= 2 * Math.PI;
				while ( d < - Math.PI ) d += 2 * Math.PI;
				tr.total += d;

			}

			tr.angle = ang;

		}

	}

	if ( s % 100 === 0 && s * dt > 60 ) { // every 5 s after a minute's warm-up: every fish's ring distance

		for ( const g of bombieGroups ) {

			const loc = bombies.locations[ g.zone.bombieIndex ];
			for ( let k = 0; k < g.count; k ++ ) {

				const i = g.offset + k, x = fish.pos[ i * 3 ], y = fish.pos[ i * 3 + 1 ], z = fish.pos[ i * 3 + 2 ];
				ringSamples.push( Math.hypot( x - loc.x, z - loc.z ) - bombieRadiusAt( loc, y ) );

			}

		}

	}

}

console.log( `simulated ${ minutes } min at ${ 1 / dt } Hz, ${ fish.n } fish, ${ bombieGroups.length } bombie schools, ${ ringSamples.length } ring samples` );
check( worstPenetration <= 0, `fish: never end up inside a bombie's profile over ${ minutes } simulated minutes (worst penetration ${ worstPenetration.toFixed( 3 ) } m)` );

const inBand = ringSamples.filter( ( r ) => r >= 0.5 && r <= 4 ).length / ringSamples.length;
check( inBand > 0.5, `fish: spend most of their time 0.5 - 4 m outside a bombie's surface (${ ( inBand * 100 ).toFixed( 0 ) }% of samples)` );

const minSwing = Math.min( ...trackers.map( ( tr ) => Math.abs( tr.total ) ) );
const avgSwing = trackers.reduce( ( a, tr ) => a + Math.abs( tr.total ), 0 ) / trackers.length;
check( minSwing > 0.5, `fish: every bombie school shows real angular motion round its rock (least active: ${ minSwing.toFixed( 2 ) } rad over ${ minutes } min, average ${ avgSwing.toFixed( 2 ) } rad)` );

console.log( fails ? `${ fails } FAILED` : 'all passed' );
process.exit( fails ? 1 : 0 );

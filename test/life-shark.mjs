// Shark encounter AI on the CPU (node, no GPU): drives sharks through the full encounter state
// machine (see src/world/Shark.js) against a fake diver + dive float, replicating the small amount
// of orchestration Game.js does around it (gate on landed fish, only one shark engages at a time,
// theft / snatch resolution). Asserts the behaviour the design calls for:
//   - no engagement until the diver has landed a batch of fish, and only one shark at a time
//   - it circles the float (or the diver, with no float) before doing anything else
//   - it can steal at most one fish from the float, and only while the diver is far from it
//   - it makes a few bluff charges that reach in close, nose-first, before peeling away
//   - poking it ends the encounter immediately (fast flee); not poking lets it snatch a held fish
//   - it never swims over ground shallower than the seabed limit
//   node test/life-shark.mjs
import { Vector3 } from '../src/engine/index.js';
import { TerrainData } from '../src/world/TerrainData.js';
import { Shark } from '../src/world/Shark.js';

let fails = 0;
const check = ( ok, msg ) => {

	console.log( ( ok ? 'ok   ' : 'FAIL ' ) + msg );
	if ( ! ok ) fails ++;

};

const scene = { add() {} };
const dt = 1 / 30;
const MIN_SEABED_HARD = - 2.0; // Shark's MIN_SEABED ( -2.5 ) + the 0.5 m revert margin it enforces

// Orchestration glue mirroring the shark section of Game.js's update loop, driving `sharks` against
// a fake `world` = { player: { position, inWater }, float: { active, position, stashedFish },
// speargunLandings, heldSpearFish, groundedEver, minChargeDist, chargeHeadOnOk, thefts, toasts }
function step( sharks, world ) {

	let anyEngaged = sharks.some( ( s ) => s.engaged );
	const sharksHungry = world.player.inWater && world.speargunLandings >= 4;

	for ( const shark of sharks ) {

		const wasEngaged = shark.engaged;
		shark.update( dt, {
			playerPos: world.player.position,
			playerInWater: world.player.inWater,
			allowEngage: sharksHungry && ! anyEngaged,
			floatActive: world.float.active,
			floatPos: world.float.position,
		} );

		if ( wasEngaged && ! shark.engaged ) world.speargunLandings = 0;

		const h = world.terrain.heightAt( shark.position.x, shark.position.z );
		if ( h > MIN_SEABED_HARD + 1e-6 ) world.groundedEver = true;

		if ( ! shark.engaged ) continue;
		anyEngaged = true;

		if ( shark.wantsToSteal && world.float.stashedFish.length ) {

			world.float.stashedFish.shift();
			shark.markStolen();
			world.thefts ++;
			world.toasts.push( 'theft' );

		}

		if ( shark.state === 'charge' ) {

			const d = shark.position.distanceTo( world.player.position );
			world.minChargeDist = Math.min( world.minChargeDist, d );
			if ( d < 3 ) {

				const toPlayer = world.player.position.clone().sub( shark.position ).normalize();
				if ( shark.heading.dot( toPlayer ) > 0.5 ) world.chargeHeadOnOk = true;

			}
			world.toasts.push( 'poke hint' );

		}

		if ( shark.state === 'snatch' ) {

			const hasFish = !! world.heldSpearFish;
			if ( hasFish && shark.position.distanceTo( world.player.position ) < 2.4 ) {

				world.heldSpearFish = null;
				world.snatched = true;
				shark.snatch();

			} else if ( ! hasFish ) {

				shark.disengage();

			}

		}

	}

}

const run = ( sharks, world, seconds ) => {

	for ( let t = 0; t < seconds; t += dt ) step( sharks, world );

};

// ---- find a real, deep patch of the production terrain (as life-player.mjs does for its swim test)
const terrain = new TerrainData();
let sx = 20, sz = 80;
while ( terrain.heightAt( sx, sz ) > - 10 && sz < 400 ) sz += 5;
check( terrain.heightAt( sx, sz ) < - 8, `found deep water at (${ sx }, ${ sz }): ${ terrain.heightAt( sx, sz ).toFixed( 1 ) } m` );

const mkWorld = ( overrides = {} ) => ( {
	terrain,
	player: { position: new Vector3( sx, - 3, sz ), inWater: true },
	float: { active: true, position: new Vector3( sx - 2, - 0.2, sz - 2 ), stashedFish: [
		{ species: 'yellowtail', kg: 3.1 }, { species: 'grunt', kg: 0.8 },
	] },
	speargunLandings: 0,
	heldSpearFish: null,
	snatched: false,
	groundedEver: false,
	minChargeDist: Infinity,
	chargeHeadOnOk: false,
	thefts: 0,
	toasts: [],
	...overrides,
} );

const mkSharks = () => [
	new Shark( { scene, terrain, index: 0, homePos: new Vector3( sx + 25, - 8, sz + 10 ) } ),
	new Shark( { scene, terrain, index: 1, homePos: new Vector3( sx - 60, - 10, sz + 60 ) } ),
];

// ---- 1. No engagement before 4 landed fish, even with a shark well within range
{

	const sharks = mkSharks();
	const world = mkWorld();
	run( sharks, world, 45 );
	check( sharks.every( ( s ) => s.state === 'cruise' && ! s.engaged ), 'gate: sharks stay in cruise with 0 landed fish' );

}

// ---- 2-4. Hungry: single-shark exclusivity, circling the float, theft only while the diver is far,
//           bluff charges pressing in close head-on
let poked;
{

	const sharks = mkSharks();
	const world = mkWorld( { speargunLandings: 4 } );

	// drive to engagement
	let engagedAt = null;
	for ( let t = 0; t < 30 && ! engagedAt; t += dt ) {

		step( sharks, world );
		if ( sharks.some( ( s ) => s.engaged ) ) engagedAt = t;
		check( sharks.filter( ( s ) => s.engaged ).length <= 1, 'exclusivity: never more than one shark engaged' );

	}
	check( engagedAt !== null, `engage: a shark started an encounter (at t=${ engagedAt?.toFixed( 1 ) }s)` );
	const shark = sharks.find( ( s ) => s.engaged );
	check( !! shark, 'engage: exactly one shark is engaged' );

	// it approaches then circles the float before anything else
	let sawCircle = false, badPreCharge = false;
	for ( let t = 0; t < 30 && ! sawCircle; t += dt ) {

		step( sharks, world );
		if ( shark.state !== 'approach' && shark.state !== 'circleFloat' ) badPreCharge = true;
		if ( shark.state === 'circleFloat' ) sawCircle = true;

	}
	check( ! badPreCharge, 'pre-charge: shark only approaches/circles before its first charge' );
	check( sawCircle, 'circle: shark reaches the circleFloat state' );
	const rNear = shark.position.distanceTo( world.float.position );
	check( rNear > 6 && rNear < 16, `circle: orbits the float at a plausible radius (${ rNear.toFixed( 1 ) } m)` );

	// diver stays close to the float: no theft even though fish are available
	run( sharks, world, 10 );
	check( world.thefts === 0, 'theft: none while the diver is near the float' );
	check( world.float.stashedFish.length === 2, 'theft: float still has both fish while the diver is near' );

	// diver drifts far from the float: a theft should occur, and only once
	world.player.position.set( sx + 40, - 3, sz + 40 );
	run( sharks, world, 12 );
	check( world.thefts === 1, `theft: exactly one fish stolen once the diver drifted away (thefts=${ world.thefts })` );
	check( world.float.stashedFish.length === 1, 'theft: float lost exactly one fish' );
	check( shark.stolenFish === true, 'theft: shark marks itself as having stolen already' );

	// keep the diver far away a little longer: still no second theft (well under CIRCLE_TIME_MIN, so
	// the encounter is guaranteed still to be circling, not off chasing the far-away diver already)
	run( sharks, world, 5 );
	check( world.thefts === 1, 'theft: still only one theft after more circling time' );

	// bring the diver back in for the charges
	world.player.position.set( sx, - 3, sz );
	world.heldSpearFish = { species: 'yellowtail', kg: 3.4, name: 'Yellowtail Kingfish' };

	// run through the rest of the circling (duration is randomised 30-60s) and the charge / peel cycles
	let sawCharge = false, sawPeel = false;
	for ( let t = 0; t < 80 && shark.state !== 'snatch' && shark.engaged; t += dt ) {

		step( sharks, world );
		if ( shark.state === 'charge' ) sawCharge = true;
		if ( shark.state === 'peel' ) sawPeel = true;

	}
	check( sawCharge, 'charge: shark enters the charge state' );
	check( sawPeel, 'charge: shark peels away between charges' );
	check( world.minChargeDist < 3, `charge: closes to inside poke range (min dist ${ world.minChargeDist.toFixed( 2 ) } m)` );
	check( world.chargeHeadOnOk, 'charge: approaches nose-first (heading points at the diver when close)' );
	check( shark.chargesDone >= 2 && shark.chargesDone <= 3, `charge: made 2-3 bluff charges (did ${ shark.chargesDone })` );

	poked = shark;

}

// ---- 5a. A poke mid-encounter ends it immediately (fast flee) and re-arms the 4-fish gate
{

	poked.poke();
	check( poked.state === 'flee', 'poke: shark flees immediately when poked' );
	const world = mkWorld( { speargunLandings: 4 } ); // landings only reset by the step() loop below
	world.speargunLandings = 4;
	const sharks = [ poked ];
	run( sharks, world, 13 ); // outlasts the poke flee timer
	check( poked.state === 'cruise' && ! poked.engaged, 'poke: shark returns to harmless cruising after fleeing' );

}

// ---- 5b. Never poked, and the diver still has a fish in hand: the shark snatches it, then leaves
{

	const sharks = mkSharks();
	const world = mkWorld( { speargunLandings: 4, heldSpearFish: { species: 'grunt', kg: 0.9, name: 'Blue Cod' } } );

	let shark = null;
	for ( let t = 0; t < 120 && ! world.snatched; t += dt ) {

		step( sharks, world );
		if ( ! shark ) shark = sharks.find( ( s ) => s.engaged );

	}
	check( world.snatched, 'snatch: the diver loses the held fish after the charges, unpoked' );
	check( world.heldSpearFish === null, 'snatch: held fish cleared' );
	check( shark && shark.state === 'flee', 'snatch: the shark flees immediately after snatching' );

	run( sharks, world, 12 );
	check( shark.state === 'cruise' && ! shark.engaged, 'snatch: shark settles back to cruising after fleeing' );
	check( world.speargunLandings === 0, 'gate: landings reset once the encounter concluded' );

}

// ---- terrain: no float deployed circles the diver instead, at the 12-15 m radius
{

	const sharks = mkSharks();
	const world = mkWorld( { speargunLandings: 4 } );
	world.float.active = false;

	let sawCircle = false;
	for ( let t = 0; t < 30 && ! sawCircle; t += dt ) {

		step( sharks, world );
		if ( sharks.some( ( s ) => s.state === 'circleFloat' ) ) sawCircle = true;

	}
	check( sawCircle, 'no float: shark still circles (the diver) with no float deployed' );
	const shark = sharks.find( ( s ) => s.engaged );
	run( sharks, world, 6 );
	const r = shark.position.distanceTo( world.player.position );
	check( r > 8 && r < 18, `no float: orbits the diver at a plausible radius (${ r.toFixed( 1 ) } m)` );
	check( world.thefts === 0, 'no float: no theft is possible without a float' );

}

// ---- terrain: a synthetic shelf forces the avoidance code to actually redirect the shark mid-circle
{

	// a simple beach ramp: shallow (even dry) near x=0, sloping down to deep water as x grows
	const ramp = {
		heightAt( x ) { return Math.max( - 40, - 0.18 * x ); },
		normalAt( x, z, out ) {

			const e = 0.5;
			const hx = this.heightAt( x + e, z ) - this.heightAt( x - e, z );
			const hz = this.heightAt( x, z + e ) - this.heightAt( x, z - e );
			out.set( - hx, 2 * e, - hz ).normalize();
			return out;

		},
	};

	const world = mkWorld( { speargunLandings: 4 } );
	world.terrain = ramp;
	// the diver sits close to the shelf: a chunk of the shark's circling radius would otherwise cross it
	world.player.position.set( 20, - 3, 0 );
	world.float.position.set( 20, - 0.2, 0 );

	const sharks = [ new Shark( { scene, terrain: ramp, index: 0, homePos: new Vector3( 55, - 10, 0 ) } ) ];
	run( sharks, world, 90 );
	check( ! world.groundedEver, `terrain: never swims over ground shallower than the seabed limit (${ MIN_SEABED_HARD } m)` );

}

console.log( fails ? `${ fails } FAILED` : 'all passed' );
process.exit( fails ? 1 : 0 );

import { Mesh, Vector3, Quaternion, MathUtils, Matrix4, Euler, BufferGeometry, Float32BufferAttribute, Color } from '../engine/index.js';
import { prepare, mergePrepared, sphere, roundedBox, loft, paintVertices, mat4 } from './boat/GeoKit.js';
import { createPropMaterial, PAT } from '../game/GameMaterials.js';

// Procedural Bronze Whaler / Reef Shark:
// - Cruises far out in deep reef water and drop-offs, minding its own business
// - Once the diver has proven a competent spearo (landed a few fish), one shark at a time will
//   come in and run an ENCOUNTER: circle the dive float (or the diver, if no float is out) for a
//   while, maybe steal an unattended fish, then make a few bluff charges at the diver to get their
//   attention. If it's never poked off, it snatches the diver's held fish and leaves; a poke at any
//   point sends it fleeing immediately. Either way it's then satisfied and stays away until the
//   diver lands another batch of fish.
// - Can be poked on the snout with the spear tip to fend off and repel!
//
// The body is three meshes (head + trunk, mid body, tail) hinged at PIVOTS so the tail can sweep
// from side to side. Model space: snout toward -Z (the three.js forward), back toward +Y.

const _v = new Vector3();
const _n = new Vector3();
const _m = new Matrix4();
const _mSeg = new Matrix4();
const _mHinge = new Matrix4();
const _one = new Vector3( 1, 1, 1 );
const _euler = new Euler();
const _up = new Vector3( 0, 1, 0 );

const MIN_SEABED = - 2.5; // sharks keep to water with the seabed deeper than this (m)
const PIVOTS = [ 0.02, 0.6 ]; // z of the mid-body and tail hinges

// ---- Encounter tuning (see Game.js for the "one shark at a time / every 4 landed fish" gating)
const CRUISE_SPEED = 1.8;
const ENGAGE_RADIUS = 40;          // (m) a hungry cruising shark within this range of the target may start an encounter
const APPROACH_SPEED = 3.2;
const CIRCLE_RADIUS_FLOAT = 11;    // circling radius around the dive float
const CIRCLE_RADIUS_PLAYER = 13.5; // circling radius around the diver when there's no float out (12-15m)
const CIRCLE_SPEED = 2.6;
const CIRCLE_TIME_MIN = 30, CIRCLE_TIME_MAX = 60; // seconds spent circling before the charges begin
const THEFT_MIN_PLAYER_DIST = 15;  // the diver must be at least this far from the float for a theft
const THEFT_DELAY = 6;             // seconds of eligible circling before a theft is attempted
const CHARGE_SPEED = 6.5;
const CHARGE_MIN_RANGE = 1.8, CHARGE_MAX_RANGE = 2.5; // how close a bluff charge presses in (inside poke range)
const CHARGES_MIN = 2, CHARGES_MAX = 3;
const PEEL_SPEED = 4.5;
const PEEL_TIME = 1.7;
const SNATCH_APPROACH_SPEED = 3.2;
const SNATCH_TIMEOUT = 6; // give up waiting on a snatch resolution after this long (diver got away)
const POKE_FLEE_SPEED = 6.5, POKE_FLEE_TIME = 12.0;
const SNATCH_FLEE_SPEED = 7.0, SNATCH_FLEE_TIME = 10.0;

export class Shark {

	constructor( { scene, terrain, index = 0, homePos = new Vector3( 20, - 8, 110 ) } ) {

		this.scene = scene;
		this.terrain = terrain;
		this.index = index;

		this.home = homePos.clone();
		this.position = homePos.clone();
		this.velocity = new Vector3( 1, 0, 0 );
		this.heading = new Vector3( 1, 0, 0 );
		this.quaternion = new Quaternion();

		// 'cruise' (default, far off, harmless) -> 'approach' -> 'circleFloat' -> 'charge' <-> 'peel'
		// (repeats for a few charges) -> 'snatch' (waiting on Game.js to resolve) -> 'flee' -> 'cruise'.
		// A poke() forces 'flee' from any state.
		this.state = 'cruise';
		this.engaged = false; // true for the whole encounter (approach..flee); Game.js only lets one shark engage at a time
		this.speed = CRUISE_SPEED;
		this.timer = 0;
		this.encounterTimer = 0;
		this.tailPhase = Math.random() * Math.PI * 2;
		this.fleeTimer = 0;
		this.circleAngle = Math.random() * Math.PI * 2;

		// encounter bookkeeping
		this.stolenFish = false;   // theft already used this encounter (at most one per encounter)
		this.wantsToSteal = false; // Game.js reads this each frame and, if it acts on it, calls markStolen()
		this._stealClock = THEFT_DELAY;
		this.chargesTotal = 0;
		this.chargesDone = 0;
		this.chargeRange = CHARGE_MIN_RANGE;
		this.peelDir = new Vector3( 1, 0, 0 );
		this._snatchClock = 0;

		// 3D Mesh: [ head + trunk, mid body, tail ]
		this.material = createPropMaterial( `shark_${index}` );
		this.segments = buildSharkGeometry().map( ( geo, s ) => {

			const mesh = new Mesh( geo, this.material );
			mesh.name = `Shark_${index}_${s}`;
			mesh.frustumCulled = false;
			mesh.castShadow = false;
			mesh.matrixAutoUpdate = false;
			scene.add( mesh );
			return mesh;

		} );
		this.mesh = this.segments[ 0 ];

	}

	poke() {

		// Repel shark when poked with spear tip! Ends the encounter immediately, whatever it was doing.
		this.state = 'flee';
		this.fleeTimer = POKE_FLEE_TIME;
		this.speed = POKE_FLEE_SPEED;
		return true;

	}

	snatch() {

		// Snatch fish from diver and flee (Game.js calls this once it has actually removed the fish)
		this.state = 'flee';
		this.fleeTimer = SNATCH_FLEE_TIME;
		this.speed = SNATCH_FLEE_SPEED;
		return true;

	}

	// Game.js calls this once it has actually removed a fish from the float in response to wantsToSteal
	markStolen() {

		this.stolenFish = true;
		this.wantsToSteal = false;
		this._stealClock = THEFT_DELAY;

	}

	// Encounter over with nothing resolved (diver got out of the water, etc): back to harmless cruising.
	disengage() {

		this.state = 'cruise';
		this.engaged = false;
		this.speed = CRUISE_SPEED;

	}

	_beginEncounter() {

		this.state = 'approach';
		this.engaged = true;
		this.stolenFish = false;
		this.wantsToSteal = false;
		this._stealClock = THEFT_DELAY;
		this.chargesTotal = 0;
		this.chargesDone = 0;
		this._snatchClock = 0;

	}

	update( dt, { playerPos, playerInWater, allowEngage = false, floatActive = false, floatPos = null } ) {

		this.timer += dt;
		this.tailPhase += dt * ( 1.2 + this.speed * 1.1 );

		const pPos = playerPos;
		const distToPlayer = this.position.distanceTo( pPos );
		const target = ( floatActive && floatPos ) ? floatPos : pPos;

		// The diver left the water mid-encounter: let the shark lose interest gracefully.
		if ( this.engaged && this.state !== 'flee' && ! playerInWater ) this.disengage();

		// ---- AI Behavior State Machine
		if ( this.state === 'flee' ) {

			this.fleeTimer -= dt;
			// Swim directly away from player
			_v.copy( this.position ).sub( pPos ).normalize();
			_v.y = Math.min( - 0.2, _v.y ); // dive deeper when fleeing
			this.heading.lerp( _v, 1 - Math.exp( - dt * 3 ) ).normalize();

			if ( this.fleeTimer <= 0 ) {

				this.state = 'cruise';
				this.engaged = false;
				this.speed = CRUISE_SPEED;

			}

		} else if ( this.state === 'approach' ) {

			this.speed = APPROACH_SPEED;
			const circleR = floatActive ? CIRCLE_RADIUS_FLOAT : CIRCLE_RADIUS_PLAYER;
			if ( this.position.distanceTo( target ) <= circleR + 1 ) {

				this.state = 'circleFloat';
				// start the circle from wherever the shark already is (not a random point on the ring):
				// a random pick could sit diametrically opposite and send it cutting straight past the target
				this.circleAngle = Math.atan2( this.position.z - target.z, this.position.x - target.x );
				this.encounterTimer = MathUtils.lerp( CIRCLE_TIME_MIN, CIRCLE_TIME_MAX, Math.random() );

			} else {

				_v.copy( target ).sub( this.position ).normalize();
				this.heading.lerp( _v, 1 - Math.exp( - dt * 2 ) ).normalize();

			}

		} else if ( this.state === 'circleFloat' ) {

			this.speed = CIRCLE_SPEED;
			this.encounterTimer -= dt;

			this.circleAngle += dt * 0.5;
			const r = floatActive ? CIRCLE_RADIUS_FLOAT : CIRCLE_RADIUS_PLAYER;
			const tx = target.x + Math.cos( this.circleAngle ) * r;
			const tz = target.z + Math.sin( this.circleAngle ) * r;
			const ty = Math.max( - 18, Math.min( - 1.2, target.y - 1.5 ) );
			_v.set( tx, ty, tz ).sub( this.position ).normalize();
			this.heading.lerp( _v, 1 - Math.exp( - dt * 2.5 ) ).normalize();

			// While circling the float, if the diver has drifted well away, it's an opening for a theft
			const eligible = floatActive && ! this.stolenFish && pPos.distanceTo( floatPos ) > THEFT_MIN_PLAYER_DIST;
			if ( eligible ) {

				this._stealClock -= dt;
				if ( this._stealClock <= 0 ) this.wantsToSteal = true;

			} else {

				this._stealClock = THEFT_DELAY;
				this.wantsToSteal = false;

			}

			if ( this.encounterTimer <= 0 ) {

				this.state = 'charge';
				this.chargesTotal = CHARGES_MIN + Math.floor( Math.random() * ( CHARGES_MAX - CHARGES_MIN + 1 ) );
				this.chargesDone = 0;
				this.chargeRange = MathUtils.lerp( CHARGE_MIN_RANGE, CHARGE_MAX_RANGE, Math.random() );

			}

		} else if ( this.state === 'charge' ) {

			this.speed = CHARGE_SPEED;
			_v.copy( pPos ).sub( this.position ).normalize();
			this.heading.lerp( _v, 1 - Math.exp( - dt * 6 ) ).normalize();

			if ( distToPlayer <= this.chargeRange ) {

				this.chargesDone ++;
				this.state = 'peel';
				this.encounterTimer = PEEL_TIME;

				// peel off to one side and loop back around
				_v.copy( this.position ).sub( pPos );
				_v.y = 0;
				if ( _v.lengthSq() < 1e-6 ) _v.set( 1, 0, 0 );
				_v.normalize().applyAxisAngle( _up, ( Math.random() < 0.5 ? 1 : - 1 ) * Math.PI * 0.35 );
				this.peelDir.copy( _v );

			}

		} else if ( this.state === 'peel' ) {

			this.speed = PEEL_SPEED;
			this.encounterTimer -= dt;
			this.heading.lerp( this.peelDir, 1 - Math.exp( - dt * 4 ) ).normalize();

			if ( this.encounterTimer <= 0 ) {

				if ( this.chargesDone < this.chargesTotal ) {

					this.state = 'charge';
					this.chargeRange = MathUtils.lerp( CHARGE_MIN_RANGE, CHARGE_MAX_RANGE, Math.random() );

				} else {

					this.state = 'snatch';
					this._snatchClock = 0;

				}

			}

		} else if ( this.state === 'snatch' ) {

			// Charges are done: close in and hold near the diver while Game.js decides whether there's
			// a held fish to actually snatch (it calls snatch() to resolve, or disengage() if not).
			this.speed = SNATCH_APPROACH_SPEED;
			_v.copy( pPos ).sub( this.position ).normalize();
			this.heading.lerp( _v, 1 - Math.exp( - dt * 3 ) ).normalize();

			this._snatchClock += dt;
			if ( this._snatchClock > SNATCH_TIMEOUT ) this.disengage();

		} else {

			// Peaceful cruising in deep reef/bay, far from any encounter
			this.state = 'cruise';
			this.speed = CRUISE_SPEED;

			// Patrol around home territory in wide lazy loop
			const dHome = this.position.distanceTo( this.home );
			if ( dHome > 28 ) {

				_v.copy( this.home ).sub( this.position ).normalize();
				this.heading.lerp( _v, 1 - Math.exp( - dt * 1.5 ) ).normalize();

			} else {

				// Gentle meandering
				const wander = Math.sin( this.timer * 0.4 + this.index * 2 ) * 0.015;
				this.heading.applyAxisAngle( _up, wander ).normalize();

			}

			// A hungry, unengaged shark close enough to the target may start an encounter
			if ( allowEngage && this.position.distanceTo( target ) < ENGAGE_RADIUS ) this._beginEncounter();

		}

		// ---- Stay in the water: look ahead and turn downhill (toward deeper water) before the shallows
		const terrain = this.terrain;
		if ( terrain ) {

			const look = 2 + this.speed;
			const ax = this.position.x + this.heading.x * look, az = this.position.z + this.heading.z * look;
			const shoal = terrain.heightAt( ax, az ) - MIN_SEABED; // > 0: the water ahead is too shallow
			if ( shoal > - 1 ) {

				terrain.normalAt( ax, az, _n );
				_v.set( _n.x, 0, _n.z );
				if ( _v.lengthSq() < 1e-6 ) _v.copy( this.home ).sub( this.position ).setY( 0 );
				_v.normalize();
				const k = MathUtils.clamp( shoal + 1, 0, 1 );
				this.heading.lerp( _v, 1 - Math.exp( - dt * ( 2 + 6 * k ) ) ).normalize();

			}

		}

		// Advance position (never onto the shallows / land)
		const px = this.position.x, pz = this.position.z;
		this.position.addScaledVector( this.heading, this.speed * dt );
		if ( terrain && terrain.heightAt( this.position.x, this.position.z ) > MIN_SEABED + 0.5 ) {

			this.position.x = px;
			this.position.z = pz;

		}

		// Keep shark below surface and above seabed
		const groundY = terrain ? terrain.heightAt( this.position.x, this.position.z ) : - 25;
		const maxDepthY = - 0.8; // stay under surface
		const minDepthY = Math.min( groundY + 1.2, maxDepthY );
		this.position.y = MathUtils.clamp( this.position.y, minDepthY, maxDepthY );

		// ---- Orient mesh
		const yaw = Math.atan2( - this.heading.x, - this.heading.z );
		const pitch = Math.asin( MathUtils.clamp( this.heading.y, - 0.6, 0.6 ) );
		// Swimming stroke: the head counter-swings slightly, the travelling wave grows toward the tail
		const beat = 0.1 + 0.02 * this.speed;
		const wHead = - Math.sin( this.tailPhase ) * beat * 0.25;
		const wMid = Math.sin( this.tailPhase - 0.6 ) * beat;
		const wTail = Math.sin( this.tailPhase - 1.5 ) * beat * 1.8;

		this.quaternion.setFromEuler( _euler.set( pitch, yaw + wHead, 0, 'YXZ' ) );
		_m.compose( this.position, this.quaternion, _one );
		setMatrix( this.segments[ 0 ], _m );

		// mid body hinged at PIVOTS[ 0 ], tail hinged at PIVOTS[ 1 ] on the mid body
		_mSeg.copy( _m ).multiply( hinge( PIVOTS[ 0 ], wMid ) );
		setMatrix( this.segments[ 1 ], _mSeg );
		_mSeg.multiply( hinge( PIVOTS[ 1 ], wTail - wMid ) );
		setMatrix( this.segments[ 2 ], _mSeg );

	}

}

function setMatrix( mesh, m ) {

	mesh.matrix.copy( m );
	mesh.matrixWorldNeedsUpdate = true;
	mesh.visible = true;

}

// rotation about the vertical axis through (0, 0, z)
function hinge( z, angle ) {

	const c = Math.cos( angle ), s = Math.sin( angle );
	// T(z) * Ry(angle) * T(-z)
	return _mHinge.set(
		c, 0, s, - s * z,
		0, 1, 0, 0,
		- s, 0, c, z - c * z,
		0, 0, 0, 1
	);

}

// ------------------------------------------------------------------ Shark 3D Geometry

// Body stations (2.4 m bronze whaler): z, half width, half height, centre y. Snout at -Z.
const BODY = [
	[ - 1.22, 0.004, 0.004, - 0.03 ],
	[ - 1.17, 0.06, 0.045, - 0.025 ],
	[ - 1.06, 0.13, 0.095, - 0.02 ],
	[ - 0.86, 0.21, 0.165, - 0.005 ],
	[ - 0.6, 0.27, 0.235, 0.01 ],
	[ - 0.3, 0.3, 0.28, 0.02 ],
	[ 0.0, 0.28, 0.27, 0.02 ],
	[ 0.3, 0.21, 0.215, 0.02 ],
	[ 0.6, 0.125, 0.14, 0.025 ],
	[ 0.85, 0.065, 0.085, 0.03 ],
	[ 1.0, 0.05, 0.068, 0.035 ],
	[ 1.1, 0.03, 0.05, 0.045 ],
	[ 1.16, 0.004, 0.006, 0.05 ],
];

// Catmull-Rom interpolation of the station table at z -> [ halfWidth, halfHeight, centreY ]
function bodyAt( z ) {

	const n = BODY.length;
	let i = 0;
	while ( i < n - 2 && z > BODY[ i + 1 ][ 0 ] ) i ++;
	const t = MathUtils.clamp( ( z - BODY[ i ][ 0 ] ) / ( BODY[ i + 1 ][ 0 ] - BODY[ i ][ 0 ] ), 0, 1 );
	const p0 = BODY[ Math.max( 0, i - 1 ) ], p1 = BODY[ i ], p2 = BODY[ i + 1 ], p3 = BODY[ Math.min( n - 1, i + 2 ) ];
	const out = [];
	for ( let k = 1; k < 4; k ++ ) {

		const a = p0[ k ], b = p1[ k ], c = p2[ k ], d = p3[ k ];
		out.push( Math.max( 0.003, 0.5 * ( 2 * b + ( c - a ) * t + ( 2 * a - 5 * b + 4 * c - d ) * t * t + ( 3 * b - a - 3 * c + d ) * t * t * t ) ) );

	}

	out[ 2 ] = MathUtils.lerp( p1[ 3 ], p2[ 3 ], t );
	return out;

}

const DORSAL = 0x55574d; // bronze-grey back
const FLANK = 0x7a7c72;
const BELLY = 0xdfe2df;
const FIN_DARK = 0x3f423c;

// Countershading: bronze-grey back fading through the flank to a white belly
function skin( v ) {

	const [ , h, yc ] = bodyAt( v.z );
	const t = ( v.y - yc ) / h;
	const c = new Color( BELLY ).lerp( new Color( FLANK ), MathUtils.smoothstep( t, - 0.55, - 0.2 ) );
	return c.lerp( new Color( DORSAL ), MathUtils.smoothstep( t, - 0.25, 0.35 ) );

}

// Lofted body section between z0 and z1. `tuck` shrinks the first ring so a rear segment's
// overlap hides inside the segment in front when the hinge bends.
function bodySection( z0, z1, rings, tuck = false ) {

	const SEGS = 18;
	const profiles = [];
	for ( let i = 0; i <= rings; i ++ ) {

		const z = z0 + ( z1 - z0 ) * i / rings;
		const [ w, h, yc ] = bodyAt( z );
		const s = tuck && i === 0 ? 0.985 : 1;
		const ring = [];
		for ( let j = 0; j < SEGS; j ++ ) {

			const a = j / SEGS * Math.PI * 2;
			const sy = Math.sin( a );
			// flatter belly, slightly peaked back
			const y = sy < 0 ? sy * 0.82 : sy * ( 1 + 0.06 * sy * sy * sy * sy );
			ring.push( new Vector3( Math.cos( a ) * w * s, yc + y * h * s, z ) );

		}

		profiles.push( ring );

	}

	const g = loft( profiles, { closed: true } );
	return prepare( paintVertices( g, skin ), { rough: 0.42, metal: 0.02, pattern: PAT.plain } );

}

// Thin fin: a lens-shaped planform, `thick` at `centre` and zero at the rim. `outline` and
// `centre` are [ u, v ] points; place( u, v, w ) maps planform coords and thickness offset
// w to model space.
function fin( outline, centre, thick, place, color = FIN_DARK ) {

	const n = outline.length;
	const rim = outline.map( ( [ u, v ] ) => place( u, v, 0 ) );
	const top = place( centre[ 0 ], centre[ 1 ], thick * 0.5 );
	const bot = place( centre[ 0 ], centre[ 1 ], - thick * 0.5 );

	// wind the +w face so its normal points along +w
	const e1 = rim[ 0 ].clone().sub( top ), e2 = rim[ 1 ].clone().sub( top );
	const flip = e1.cross( e2 ).dot( top.clone().sub( bot ) ) < 0;

	const pos = [];
	for ( let i = 0; i < n; i ++ ) {

		let a = rim[ i ], b = rim[ ( i + 1 ) % n ];
		if ( flip ) [ a, b ] = [ b, a ];
		pos.push( top.x, top.y, top.z, a.x, a.y, a.z, b.x, b.y, b.z );
		pos.push( bot.x, bot.y, bot.z, b.x, b.y, b.z, a.x, a.y, a.z );

	}

	const g = new BufferGeometry();
	g.setAttribute( 'position', new Float32BufferAttribute( pos, 3 ) );
	g.computeVertexNormals();
	return prepare( g, { color, rough: 0.45, metal: 0.02, pattern: PAT.plain } );

}

// planform in the body's vertical mid plane: u along z, v up
const vertical = ( y0 ) => ( u, v, w ) => new Vector3( w, y0 + v, u );

// paired side fin: u along z, v out along the span (drooping by `droop`), mirrored by `side`
const lateral = ( x0, y0, droop, side ) => ( u, v, w ) => new Vector3(
	side * ( x0 + v * Math.cos( droop ) + w * Math.sin( droop ) ),
	y0 - v * Math.sin( droop ) + w * Math.cos( droop ),
	u
);

// Returns [ head + trunk, mid body, tail ] geometries (see PIVOTS).
function buildSharkGeometry() {

	const [ p0, p1 ] = PIVOTS;

	// ---- head + trunk
	const front = [ bodySection( - 1.22, p0 + 0.04, 30 ) ];

	// tall first dorsal, swept back with a concave trailing edge
	front.push( fin(
		[ [ - 0.4, - 0.04 ], [ - 0.24, 0.15 ], [ - 0.1, 0.3 ], [ 0.0, 0.39 ], [ 0.03, 0.39 ], [ 0.0, 0.26 ], [ 0.02, 0.12 ], [ 0.08, - 0.04 ] ],
		[ - 0.12, 0.08 ], 0.05, vertical( 0.27 ) ) );

	// long sickle pectorals
	for ( const side of [ - 1, 1 ] ) {

		front.push( fin(
			[ [ - 0.5, 0 ], [ - 0.36, 0.2 ], [ - 0.19, 0.36 ], [ - 0.07, 0.45 ], [ - 0.03, 0.45 ], [ - 0.07, 0.33 ], [ - 0.16, 0.15 ], [ - 0.25, 0 ] ],
			[ - 0.3, 0.1 ], 0.045, lateral( 0.2, - 0.12, 0.55, side ) ) );

		// eyes
		const [ ew ] = bodyAt( - 0.92 );
		front.push( prepare( sphere( 0.022, 8, 6 ), { color: 0x0b0c0c, rough: 0.08, metal: 0.3, matrix: mat4( side * ( ew * 0.93 ), 0.03, - 0.92 ) } ) );

		// five gill slits
		for ( let k = 0; k < 5; k ++ ) {

			const z = - 0.68 + k * 0.045;
			const [ w ] = bodyAt( z );
			front.push( prepare( roundedBox( 0.01, 0.15 - k * 0.008, 0.008, 0.003, 1 ), {
				color: 0x2a2c28, rough: 0.6, metal: 0,
				matrix: mat4( side * ( w - 0.012 ), - 0.02, z, 0, 0, side * 0.18 ),
			} ) );

		}

	}

	// mouth: a dark crescent under the snout
	front.push( prepare( roundedBox( 0.16, 0.012, 0.03, 0.005, 1 ), { color: 0x2b2020, rough: 0.6, matrix: mat4( 0, - 0.105, - 0.9, - 0.2, 0, 0 ) } ) );

	// ---- mid body: pelvic fins, second dorsal, anal fin
	const mid = [ bodySection( p0 - 0.04, p1 + 0.04, 16, true ) ];
	for ( const side of [ - 1, 1 ] ) {

		mid.push( fin( [ [ 0.2, 0 ], [ 0.33, 0.13 ], [ 0.38, 0.14 ], [ 0.36, 0 ] ], [ 0.31, 0.04 ], 0.025, lateral( 0.08, - 0.15, 0.7, side ) ) );

	}

	mid.push( fin( [ [ 0.4, - 0.02 ], [ 0.49, 0.1 ], [ 0.52, 0.1 ], [ 0.52, 0.03 ], [ 0.56, - 0.02 ] ], [ 0.48, 0.02 ], 0.02, vertical( 0.17 ) ) );
	mid.push( fin( [ [ 0.44, 0.02 ], [ 0.52, - 0.09 ], [ 0.55, - 0.09 ], [ 0.55, - 0.02 ], [ 0.58, 0.02 ] ], [ 0.51, - 0.02 ], 0.02, vertical( - 0.09 ) ) );

	// ---- tail: peduncle and the forked, heterocercal caudal fin (long upper lobe)
	const tail = [ bodySection( p1 - 0.04, 1.16, 14, true ) ];
	tail.push( fin(
		[ [ 0.86, 0.02 ], [ 0.95, 0.14 ], [ 1.08, 0.34 ], [ 1.22, 0.5 ], [ 1.26, 0.5 ], [ 1.2, 0.34 ], [ 1.12, 0.14 ], [ 1.1, 0.05 ],
			[ 1.14, - 0.1 ], [ 1.19, - 0.24 ], [ 1.16, - 0.26 ], [ 1.06, - 0.16 ], [ 0.94, - 0.05 ], [ 0.86, - 0.02 ] ],
		[ 1.0, 0.03 ], 0.04, vertical( 0.04 ) ) );

	return [ front, mid, tail ].map( ( parts ) => mergePrepared( parts ) );

}

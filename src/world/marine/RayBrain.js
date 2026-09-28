import { Vector3, MathUtils } from '../../engine/index.js';
import { BOMBIE_LOCATIONS } from '../Bombies.js';
import { WORLD } from '../WorldLayout.js';

// Behaviour of one ray (see Rays.js): ambient wildlife, slow cruising over the seabed.
//   stingray: hugs the bottom (0.3 - 1 m above it), every so often glides to a stop and rests on the
//             sand for a while, then lifts off and moves on
//   eagle ray: cruises higher with a slow flapping 'flight', gliding now and then
// Both wander gently around a home patch, follow the seabed, turn away from the shallows (never over
// water shallower than MIN_WATER), from the bombies (BOMBIE_CLEAR beyond their rock) and the pier,
// stay inside the play area, never break the surface, and glide off when the swimming diver comes
// within SHY_DIST. Per-frame work is O(1) per ray (a few terrain lookups; the obstacle probe runs at
// a few Hz).

export const MIN_WATER = 1.2;      // (m) hard limit: never over water shallower than this
export const SOFT_WATER = 1.8;     // steer away from water shallower than this
export const BOMBIE_CLEAR = 3.0;   // (m) keep this far clear of a bombie's rock (steering margin)
export const BOMBIE_HARD = 2.2;    // hard limit
export const SHY_DIST = 4.0;       // glide away from the diver within this range
export const AREA = { xMin: - 130, xMax: 150, zMin: - 15, zMax: 190 };
const PIER = { xMin: WORLD.pier.x - WORLD.pier.headWidth / 2 - 2, xMax: WORLD.pier.x + WORLD.pier.headWidth / 2 + 2, zMax: WORLD.pier.zEnd + WORLD.pier.headDepth / 2 + 2, narrow: WORLD.pier.width / 2 + 2 };
const SURFACE_CLEAR = 0.6;         // (m) the top of the animal stays at least this far below sea level

export const RAY_SPECIES = {
	stingray: {
		cruise: 0.5, flee: 1.6, turn: 0.45, alt: [ 0.3, 1.0 ], halfSpan: 0.7, belly: 0.05, halfThick: 0.09, rests: true, softWater: SOFT_WATER,
		wave: { cruise: [ 3.2, 0.055 ], flee: [ 6.5, 0.085 ], rest: [ 0.9, 0.01 ] }, // [ rad/s, amplitude ]
	},
	eagle: {
		cruise: 0.8, flee: 2.0, turn: 0.5, alt: [ 1.0, 2.8 ], halfSpan: 0.5, belly: 0.04, halfThick: 0.07, rests: false, softWater: 3.0,
		wave: { cruise: [ 1.7, 0.2 ], flee: [ 3.6, 0.27 ], rest: [ 0.8, 0.025 ] },
	},
};

// the bombies' rock footprint: Bombies.js widens the low ones on shallow sites (this mirrors that)
export function bombieFootprints( terrain ) {

	return BOMBIE_LOCATIONS.map( ( b ) => {

		const seabed = terrain ? terrain.heightAt( b.x, b.z ) : - 12;
		const top = Math.min( - 1.8, seabed + b.height );
		let height = top - seabed;
		if ( height < 1.0 ) height = Math.max( 0.3, Math.min( 1.0, - 1.0 - seabed ) );
		const flat = Math.max( 0, Math.min( 1, ( 5 - height ) / 4 ) );
		return { x: b.x, z: b.z, radius: b.radius * ( 1 + 0.5 * flat ) };

	} );

}

const _v = new Vector3();

// small deterministic PRNG so every ray's wander is its own
function rng( seed ) {

	let a = ( seed * 2654435761 ) >>> 0;
	return () => {

		a = ( a + 0x6D2B79F5 ) >>> 0;
		let t = a;
		t = Math.imul( t ^ ( t >>> 15 ), t | 1 );
		t ^= t + Math.imul( t ^ ( t >>> 7 ), t | 61 );
		return ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296;

	};

}

export class RayBrain {

	// home: Vector3 (y ignored), roam: wander radius (m), scale: size multiplier on the reference model
	constructor( { terrain, species = 'stingray', home, roam = 30, scale = 1, seed = 1, obstacles = null } ) {

		this.terrain = terrain;
		this.species = species;
		this.sp = RAY_SPECIES[ species ];
		this.home = home.clone();
		this.roam = roam;
		this.scale = scale;
		this.random = rng( seed );
		this.obstacles = obstacles || bombieFootprints( terrain );

		this.position = new Vector3();
		this.yaw = this.random() * Math.PI * 2; // heading: forward = ( -sin yaw, 0, -cos yaw ) (snout at -Z)
		this.pitch = 0;
		this.roll = 0;
		this.yawRate = 0;
		this.vy = 0;
		this.speed = this.sp.cruise;
		this.state = 'cruise'; // 'cruise' | 'settle' | 'rest' | 'flee' | 'glide' (eagle)
		this.timer = 0;
		this.stateTime = 10 + this.random() * 30;
		this.wanderYaw = this.yaw;
		this.wanderT = 0;
		this.altitude = MathUtils.lerp( this.sp.alt[ 0 ], this.sp.alt[ 1 ], this.random() );
		this.probeT = 0;
		this.steerYaw = this.yaw;
		this.seabed = 0;
		this.groundNormal = new Vector3( 0, 1, 0 );
		this.settled = 0; // 0 swimming .. 1 lying on the sand (the body lines up with the seabed)

		// wave state for the shader
		this.phase = this.random() * Math.PI * 2;
		this.tailPhase = this.random() * Math.PI * 2;
		this.amp = this.sp.wave.cruise[ 1 ];

		this._place();

	}

	// start somewhere clear near home, at cruising height
	_place() {

		const h = this.home;
		let x = h.x, z = h.z;
		for ( let k = 0; k < 200 && ! this.clearAt( x, z, true ); k ++ ) {

			const a = this.random() * Math.PI * 2, r = 2 + k * 0.5;
			x = h.x + Math.cos( a ) * r;
			z = h.z + Math.sin( a ) * r;

		}

		const g = this.terrain ? this.terrain.heightAt( x, z ) : - 6;
		this.seabed = g;
		this.position.set( x, this._clampY( g + this.altitude * this.scale, g ), z );

	}

	// Is ( x, z ) open water for this ray? soft: the steering margins, else the hard limits.
	clearAt( x, z, soft ) {

		if ( x < AREA.xMin || x > AREA.xMax || z < AREA.zMin || z > AREA.zMax ) return false;
		const minWater = soft ? this.sp.softWater : MIN_WATER;
		if ( this.terrain && this.terrain.heightAt( x, z ) > - minWater ) return false;
		const clear = ( soft ? BOMBIE_CLEAR : BOMBIE_HARD ) + this.sp.halfSpan * this.scale;
		for ( const b of this.obstacles ) {

			const dx = x - b.x, dz = z - b.z, r = b.radius + clear;
			if ( dx * dx + dz * dz < r * r ) return false;

		}

		// the pier: its piles and the T-shaped head
		if ( soft && z < PIER.zMax && x > PIER.xMin && x < PIER.xMax ) {

			if ( z > WORLD.pier.zEnd - WORLD.pier.headDepth / 2 - 2 || Math.abs( x - WORLD.pier.x ) < PIER.narrow ) return false;

		}

		return true;

	}

	_clampY( y, ground ) {

		const top = - SURFACE_CLEAR - this.sp.halfThick * this.scale - ( this.species === 'eagle' ? 0.25 * this.scale : 0.05 * this.scale );
		const bottom = ground + this.sp.belly * this.scale;
		return Math.max( bottom, Math.min( top, y ) );

	}

	forward( out ) {

		return out.set( - Math.sin( this.yaw ), 0, - Math.cos( this.yaw ) );

	}

	// the heading ( yaw ) clear of obstacles nearest to `want`, probing ahead
	_steer( want ) {

		const look = 3 + 3 * this.scale + this.speed * 2;
		const p = this.position;
		const offs = [ 0, 0.3, - 0.3, 0.6, - 0.6, 0.95, - 0.95, 1.35, - 1.35, 1.8, - 1.8, 2.4, - 2.4, Math.PI ];
		// try the side we are already turning toward first
		const sgn = MathUtils.euclideanModulo( want - this.yaw + Math.PI, Math.PI * 2 ) - Math.PI < 0 ? - 1 : 1;
		for ( const o of offs ) {

			const y = want + o * sgn;
			const fx = - Math.sin( y ), fz = - Math.cos( y );
			if ( this.clearAt( p.x + fx * look * 0.5, p.z + fz * look * 0.5, true ) && this.clearAt( p.x + fx * look, p.z + fz * look, true ) ) return y;

		}

		// boxed in: head for home
		return Math.atan2( - ( this.home.x - p.x ), - ( this.home.z - p.z ) );

	}

	// diver: { position, swimming } or null
	update( dt, diver = null ) {

		if ( dt <= 0 ) return;
		const sp = this.sp, p = this.position, R = this.random;
		this.timer += dt;
		this.stateTime -= dt;

		// ---- the diver: glide away when a swimmer comes close
		let threat = null;
		if ( diver && diver.swimming && diver.position.distanceTo( p ) < SHY_DIST + this.scale * 0.5 ) threat = diver.position;
		if ( threat ) {

			if ( this.state !== 'flee' ) this.probeT = 0;
			this.state = 'flee';
			this.stateTime = 3 + R() * 3;
			this.wanderYaw = Math.atan2( - ( p.x - threat.x ), - ( p.z - threat.z ) ); // straight away

		}

		// ---- state
		let targetSpeed = sp.cruise, wave = sp.wave.cruise;
		const home = this.home;
		if ( this.state === 'flee' ) {

			targetSpeed = sp.flee;
			wave = sp.wave.flee;
			if ( this.stateTime <= 0 ) this._cruise();

		} else if ( this.state === 'settle' ) {

			// glide to a stop onto the sand
			targetSpeed = 0;
			wave = sp.wave.rest;
			if ( this.speed < 0.03 && p.y - this.seabed < this.sp.belly * this.scale + 0.03 ) {

				this.state = 'rest';
				this.stateTime = 15 + R() * 35;

			} else if ( this.stateTime <= 0 ) this._cruise();

		} else if ( this.state === 'rest' ) {

			targetSpeed = 0;
			wave = sp.wave.rest;
			if ( this.stateTime <= 0 ) this._cruise();

		} else if ( this.state === 'glide' ) {

			// eagle ray: wings held out, coasting
			targetSpeed = sp.cruise * 0.7;
			wave = sp.wave.rest;
			if ( this.stateTime <= 0 ) this._cruise();

		} else {

			if ( this.stateTime <= 0 ) {

				if ( sp.rests ) {

					// only settle on gently sloping sand in open water
					const flat = ! this.terrain || this.terrain.normalAt( p.x, p.z, _v ).y > 0.95;
					if ( flat ) {

						this.state = 'settle';
						this.stateTime = 30;

					} else this.stateTime = 5;

				} else {

					this.state = 'glide';
					this.stateTime = 3 + R() * 5;

				}

			}

			// wander: pick a new direction now and then, pulled back toward home when far out
			this.wanderT -= dt;
			if ( this.wanderT <= 0 ) {

				this.wanderT = 6 + R() * 10;
				this.wanderYaw = this.yaw + ( R() - 0.5 ) * 2.2;
				this.altitude = MathUtils.lerp( sp.alt[ 0 ], sp.alt[ 1 ], R() );
				const dx = home.x - p.x, dz = home.z - p.z;
				const d = Math.hypot( dx, dz );
				if ( d > this.roam ) {

					const toHome = Math.atan2( - dx, - dz );
					const k = Math.min( 1, ( d - this.roam ) / this.roam + 0.5 );
					this.wanderYaw += angleDiff( toHome, this.wanderYaw ) * k;

				}

			}

		}

		// ---- steering (probe at a few Hz; turning is rate limited)
		const moving = this.state !== 'rest';
		this.probeT -= dt;
		if ( this.probeT <= 0 && moving ) {

			this.probeT = 0.3;
			this.steerYaw = this._steer( this.wanderYaw );

		}

		const turn = sp.turn * ( this.state === 'flee' ? 2.2 : 1 );
		const want = MathUtils.clamp( angleDiff( this.steerYaw, this.yaw ) * 1.2, - turn, turn );
		this.yawRate += ( ( moving ? want : 0 ) - this.yawRate ) * ( 1 - Math.exp( - dt * 2 ) );
		this.yaw += this.yawRate * dt;

		// ---- speed (glides to a stop, bursts off)
		const acc = targetSpeed > this.speed ? ( this.state === 'flee' ? 1.5 : 0.4 ) : 0.25;
		this.speed += MathUtils.clamp( targetSpeed - this.speed, - acc * dt, acc * dt );

		// ---- advance (never into the shallows / bombies / out of the area)
		const px = p.x, pz = p.z;
		this.forward( _v );
		p.x += _v.x * this.speed * dt;
		p.z += _v.z * this.speed * dt;
		if ( ! this.clearAt( p.x, p.z, false ) ) {

			p.x = px;
			p.z = pz;
			this.speed *= 0.5;
			this.probeT = 0;

		}

		// ---- height: follow the seabed (looking a little ahead so rising ground is met early)
		const terrain = this.terrain;
		const ground = terrain ? terrain.heightAt( p.x, p.z ) : - 6;
		const aheadG = terrain ? terrain.heightAt( p.x + _v.x * 2, p.z + _v.z * 2 ) : ground;
		this.seabed = ground;
		const lying = this.state === 'settle' || this.state === 'rest';
		const alt = lying ? this.sp.belly * this.scale : this.altitude * this.scale + ( this.state === 'flee' ? 0.3 : 0 );
		const targetY = this._clampY( Math.max( ground, aheadG ) + alt, ground );
		const vyMax = lying ? 0.12 : 0.35;
		const vyWant = MathUtils.clamp( ( targetY - p.y ) * 0.8, - vyMax, vyMax );
		this.vy += ( vyWant - this.vy ) * ( 1 - Math.exp( - dt * 2 ) );
		p.y = this._clampY( p.y + this.vy * dt, ground );

		// ---- attitude: pitch with the climb, bank into turns, lie flush with the sand when resting
		this.settled += ( ( lying && p.y - ground < this.sp.belly * this.scale + 0.1 ? 1 : 0 ) - this.settled ) * ( 1 - Math.exp( - dt * 1.5 ) );
		if ( terrain ) terrain.normalAt( p.x, p.z, this.groundNormal );
		const climb = Math.atan2( this.vy, Math.max( 0.3, this.speed ) );
		this.pitch = climb * 0.8 * ( 1 - this.settled );
		this.roll = MathUtils.clamp( - this.yawRate * ( this.species === 'eagle' ? 0.9 : 0.5 ), - 0.4, 0.4 ) * ( 1 - this.settled );

		// ---- the wave
		const [ w, a ] = wave;
		const speedK = this.state === 'glide' ? 1 : 0.6 + 0.4 * Math.min( 1.5, this.speed / sp.cruise );
		this.phase += dt * w * speedK;
		this.tailPhase += dt * ( 0.8 + this.speed * 1.2 );
		this.amp += ( a - this.amp ) * ( 1 - Math.exp( - dt * 1.2 ) );

	}

	_cruise() {

		this.state = 'cruise';
		this.stateTime = 25 + this.random() * 45;
		this.wanderT = 0;

	}

}

function angleDiff( a, b ) {

	return MathUtils.euclideanModulo( a - b + Math.PI, Math.PI * 2 ) - Math.PI;

}


import { Mesh, BufferGeometry, Float32BufferAttribute, Matrix4, Quaternion, Vector3, MathUtils } from '../engine/index.js';
import { prepare, mergePrepared, cylinder, torus, sphere, rod, mat4, roundedBox } from '../world/boat/GeoKit.js';
import { createPropMaterial, createLineMaterial, PAT } from './GameMaterials.js';

// The Speargun viewmodel and projectile system:
// - Held in first-person with smooth ADS (aim down sights) on RMB
// - Left-click fires a high-velocity stainless steel spear shaft with underwater drag
// - Monofilament shooting line connects the speargun muzzle to the rear of the spear
// - Spear sticks into terrain/rocks on impact or reaches max line range (4.8m)
// - Right-click (tap while loaded): quick spear jab / poke (used for fending off sharks)
// - Right-click / R (when spear is out): retrieves spear and begins reloading
//
// States: 'idle' -> ( fire ) 'spearOut' (flying / stuck) -> ( fish hit ) 'fighting' (a CatchMinigame
// fight, same tension-band mechanic as the fishing rod) -> ( caught ) 'held' (the fish stays impaled,
// loaded at the muzzle, until stashed) -> ( stash ) 'reloading' -> 'idle'. 'retrieving' reels an empty
// or lost spear back in (a miss, an escaped fish, or a stone shot's clean, fightless retrieve).

export const SPEAR_L = 1.15; // 1.15m shaft
export const GUN_L = 0.92;   // 92cm teak wood barrel
export const MAX_LINE = 4.8; // 4.8m shooting line length
const LINE_SEGS = 32;

// First-person viewmodel positions (in camera space)
const POSES = {
	idle: { elev: 0.08, side: 0.12, hand: [ 0.16, - 0.15, - 0.38 ] },
	aim: { elev: 0.01, side: 0.0, hand: [ 0.0, - 0.075, - 0.32 ] },     // Center aligned with crosshair
	poke: { elev: 0.02, side: 0.03, hand: [ 0.06, - 0.11, - 0.65 ] },   // Sudden forward jab
	recoil: { elev: 0.18, side: 0.08, hand: [ 0.14, - 0.11, - 0.31 ] }, // Kick back on fire
	reload: { elev: 0.28, side: 0.22, hand: [ 0.18, - 0.22, - 0.35 ] }, // Tilted up while cocking bands
};

const _v = new Vector3();
const _v2 = new Vector3();
const _h = new Vector3();
const _x = new Vector3();
const _y = new Vector3();
const _z = new Vector3();
const _up = new Vector3( 0, 1, 0 );
const _m = new Matrix4();
const _q = new Quaternion();
const _fwd = new Vector3();

export class Speargun {

	constructor( { scene, camera, query, terrain, audio = null } ) {

		this.scene = scene;
		this.camera = camera;
		this.query = query;
		this.terrain = terrain;
		this.audio = audio;

		this.equipped = false;
		this.state = 'idle'; // 'idle', 'aim', 'firing', 'spearOut', 'retrieving', 'reloading', 'poke'
		this.t = 0;
		this.pokeT = 0;
		this.reloadProgress = 1.0;
		this.loaded = true;
		this.aiming = false;

		this.maxRange = MAX_LINE;
		this.muzzleVel = 27.0;
		this.spearedFish = null;
		this.onFishHit = null;
		this.onFishLanded = null;
		this.onPokeShark = null;

		// Spear projectile in world space
		this.spearPos = new Vector3();
		this.spearVel = new Vector3();
		this.spearQuat = new Quaternion();
		this.stuckInTerrain = false;

		// While fighting: the speared fish's tether target (wanders about at the fight's distance)
		this.fishPos = new Vector3();
		this._wander = 0;

		// Speargun muzzle point in world space
		this.muzzlePos = new Vector3();

		// Smooth camera-space pose
		this.pose = {
			elev: POSES.idle.elev,
			side: POSES.idle.side,
			hand: new Vector3( ...POSES.idle.hand ),
		};

		// 3D Meshes
		this.gunMat = createPropMaterial( 'speargun' );
		this.gunMesh = new Mesh( buildSpeargunGeometry(), this.gunMat );
		this.gunMesh.name = 'Speargun';
		this.gunMesh.frustumCulled = false;
		this.gunMesh.castShadow = false;
		this.gunMesh.matrixAutoUpdate = false;
		this.gunMesh.visible = false;

		this.spearMat = createPropMaterial( 'spearShaft' );
		this.spearMesh = new Mesh( buildSpearGeometry(), this.spearMat );
		this.spearMesh.name = 'SpearShaft';
		this.spearMesh.frustumCulled = false;
		this.spearMesh.castShadow = false;
		this.spearMesh.visible = false;

		this.lineMat = createLineMaterial( LINE_SEGS );
		this.lineMesh = new Mesh( buildLineGeometry( LINE_SEGS ), this.lineMat );
		this.lineMesh.name = 'SpearLine';
		this.lineMesh.frustumCulled = false;
		this.lineMesh.castShadow = false;
		this.lineMesh.visible = false;

		scene.add( this.gunMesh, this.spearMesh, this.lineMesh );

	}

	setGear( { rangeM, spearVel } ) {

		if ( rangeM ) this.maxRange = rangeM;
		if ( spearVel ) this.muzzleVel = spearVel;

	}

	equip( on ) {

		this.equipped = on;
		// a fish held on the spear stays put (loaded, at the muzzle) whether or not the gun is drawn
		if ( on ) {

			if ( this.state !== 'held' ) this.state = this.loaded ? 'idle' : 'reloading';
			this.t = 0;
			if ( this.audio && this.audio.rodReady ) this.audio.rodReady();

		} else if ( this.state !== 'held' ) {

			this.state = 'stowed';
			this.gunMesh.visible = false;
			this.spearMesh.visible = false;
			this.lineMesh.visible = false;

		}

	}

	fire() {

		if ( ! this.equipped || ! this.loaded || this.state === 'reloading' || this.state === 'spearOut'
			|| this.state === 'fighting' || this.state === 'held' ) {

			return false;

		}

		// Fire spear along camera aim vector
		const cam = this.camera;
		cam.getWorldDirection( _fwd ).normalize();

		// Start spear at speargun muzzle
		this.spearPos.copy( this.muzzlePos );
		// Velocity scaled by speargun gear
		this.spearVel.copy( _fwd ).multiplyScalar( this.muzzleVel || 27.0 );
		this.spearQuat.setFromUnitVectors( new Vector3( 0, 1, 0 ), _fwd );

		this.loaded = false;
		this.stuckInTerrain = false;
		this.spearedFish = null;
		this.state = 'spearOut';
		this.t = 0;

		// Sound effect
		if ( this.audio && this.audio.whoosh ) this.audio.whoosh( 0.9 );

		return true;

	}

	poke( sharks = [], fishSchools = null ) {

		if ( ! this.equipped || this.state === 'reloading' || this.state === 'spearOut' ) return false;
		if ( this.state === 'poke' ) return false;

		// a fish held or fighting on the spear keeps its pose: only the shark-repelling jab still fires
		const carrying = this.state === 'held' || this.state === 'fighting';
		if ( ! carrying ) {

			this.state = 'poke';
			this.pokeT = 0;

		}
		if ( this.audio && this.audio.whoosh ) this.audio.whoosh( 0.35 );

		const cam = this.camera;
		cam.getWorldDirection( _fwd ).normalize();

		// 1. Check if poking a shark to repel it!
		for ( const shark of sharks ) {

			const dShark = shark.position.distanceTo( cam.position );
			if ( dShark < 3.2 ) {

				_v.copy( shark.position ).sub( cam.position ).normalize();
				if ( _fwd.dot( _v ) > 0.4 ) {

					shark.poke();
					if ( this.onPokeShark ) this.onPokeShark( shark );

				}

			}

		}

		// 2. Close-up spear poke on fish
		if ( fishSchools && ! this.spearedFish ) {

			const pokeTip = _v.copy( this.muzzlePos ).addScaledVector( _fwd, 1.4 );
			const hit = fishSchools.checkSpearHit( pokeTip, this.muzzlePos, 0.38 );
			if ( hit ) {

				this.spearedFish = hit;
				fishSchools.impaleFish( hit );
				this.spearPos.copy( pokeTip );
				this.loaded = false;
				if ( this.onFishHit ) this.onFishHit( hit );

			}

		}

		return true;

	}

	// a fish is on: same tension-band fight as the fishing rod (see CatchMinigame / Game.updateFight)
	startFight() {

		this.state = 'fighting';
		this.fishPos.copy( this.spearPos );
		this._wander = 0;
		this.t = 0;

	}

	// the fight is won: the fish stays impaled, loaded at the muzzle, until it's stashed
	hold() {

		this.state = 'held';
		this.t = 0;

	}

	retrieve() {

		if ( this.state === 'reloading' || this.state === 'stowed' || this.state === 'held' ) return;
		this.state = 'retrieving';
		this.stuckInTerrain = false;
		if ( this.audio && this.audio.lineOut ) this.audio.lineOut( 0.4 );

	}

	reload() {

		this.state = 'reloading';
		this.reloadProgress = 0;
		this.t = 0;

	}

	update( dt, { visible, aiming = false, fishSchools = null, fight = null } ) {

		// a fish loaded on the spear stays visible and tracked at the muzzle even once the gun is
		// stowed (weapon switched away, or the diver's boarded / climbed out somewhere the speargun
		// can't be drawn): it isn't lost from view until it's actually stashed.
		if ( this.state === 'held' ) visible = true;

		if ( ! this.equipped && this.state !== 'held' ) {

			this.gunMesh.visible = false;
			this.spearMesh.visible = false;
			this.lineMesh.visible = false;
			return;

		}

		this.t += dt;
		this.aiming = aiming && this.loaded && this.state !== 'poke';
		const cam = this.camera;

		// ---- Pose interpolation
		let targetPose = POSES.idle;
		if ( this.state === 'poke' ) {

			targetPose = POSES.poke;
			this.pokeT += dt;
			if ( this.pokeT > 0.28 ) {

				this.state = this.loaded ? 'idle' : 'spearOut';

			}

		} else if ( this.aiming ) {

			targetPose = POSES.aim;

		} else if ( this.state === 'reloading' ) {

			targetPose = POSES.reload;
			this.reloadProgress += dt / 1.1; // 1.1s reload time
			if ( this.reloadProgress >= 1.0 ) {

				this.loaded = true;
				this.state = 'idle';
				if ( this.audio && this.audio.bail ) this.audio.bail( true );

			}

		} else if ( this.state === 'spearOut' && this.t < 0.12 ) {

			targetPose = POSES.recoil;

		}

		const speed = this.state === 'poke' ? 24 : this.aiming ? 14 : 9;
		const k = 1 - Math.exp( - speed * dt );
		const p = this.pose;
		p.elev += ( targetPose.elev - p.elev ) * k;
		p.side += ( targetPose.side - p.side ) * k;
		p.hand.x += ( targetPose.hand[ 0 ] - p.hand.x ) * k;
		p.hand.y += ( targetPose.hand[ 1 ] - p.hand.y ) * k;
		p.hand.z += ( targetPose.hand[ 2 ] - p.hand.z ) * k;

		// Subtle natural breathing sway when not strictly aiming
		if ( ! this.aiming ) {

			p.elev += Math.sin( this.t * 1.5 ) * 0.003;
			p.side += Math.sin( this.t * 1.1 + 0.8 ) * 0.003;

		}

		// Fighting: the gun kicks and sways with the fish on the end of the shooting line, the same
		// way the rod dips and sways with the fight (see FishingRod.update)
		if ( this.state === 'fighting' && fight ) {

			p.elev += - 0.1 * fight.surge + 0.04 * Math.sin( this.t * 2.3 );
			p.side += 0.05 * Math.sin( this.t * 1.1 + fight.surge * 2 );

		}

		// Calculate Speargun viewmodel matrix in camera space
		_y.set( 0, 0, - 1 ).applyAxisAngle( _x.set( 1, 0, 0 ), p.elev ).applyAxisAngle( _up, p.side ).normalize();
		_z.set( 0, 1, 0 ).addScaledVector( _y, - _y.y ).normalize();
		_x.crossVectors( _y, _z ).normalize();

		_m.makeBasis( _x, _y, _z ).setPosition( p.hand );
		cam.updateMatrixWorld();
		this.gunMesh.matrix.multiplyMatrices( cam.matrixWorld, _m );
		this.gunMesh.matrixWorldNeedsUpdate = true;
		this.gunMesh.visible = visible;

		// Compute world position of speargun muzzle (tip of the barrel)
		this.muzzlePos.set( 0, GUN_L * 0.75, 0.04 ).applyMatrix4( this.gunMesh.matrix );

		// ---- Spear Ballistics & Simulation
		if ( this.state === 'spearOut' ) {

			if ( ! this.stuckInTerrain ) {

				// Underwater physics: rapid drag slows projectile, slight gravity drop
				const distFromMuzzle = this.spearPos.distanceTo( this.muzzlePos );

				if ( distFromMuzzle >= ( this.maxRange || MAX_LINE ) ) {

					// Reached maximum shooting line range! Line goes taut
					this.spearVel.set( 0, 0, 0 );

				} else {

					const prevPos = _v2.copy( this.spearPos );
					this.spearPos.addScaledVector( this.spearVel, dt );
					// Water drag
					this.spearVel.multiplyScalar( Math.exp( - dt * 3.4 ) );
					// Subtle underwater drop
					this.spearVel.y -= 2.8 * dt;

					// Orient spear along velocity direction while moving
					if ( this.spearVel.lengthSq() > 0.5 ) {

						_v.copy( this.spearVel ).normalize();
						this.spearQuat.setFromUnitVectors( new Vector3( 0, 1, 0 ), _v );

					}

					// Check fish collision!
					if ( ! this.spearedFish && fishSchools ) {

						const hit = fishSchools.checkSpearHit( this.spearPos, prevPos, 0.4 );
						if ( hit ) {

							this.spearedFish = hit;
							this.spearVel.set( 0, 0, 0 );
							fishSchools.impaleFish( hit );
							if ( this.onFishHit ) this.onFishHit( hit );

						}

					}

				}

				// Check terrain / seabed collision
				const groundY = this.terrain ? this.terrain.heightAt( this.spearPos.x, this.spearPos.z ) : - 999;
				if ( this.spearPos.y <= groundY + 0.05 ) {

					this.spearPos.y = groundY + 0.05;
					this.spearVel.set( 0, 0, 0 );
					this.stuckInTerrain = true;

				}

			}

			if ( this.spearedFish && fishSchools ) {

				fishSchools.updateImpaledFish( this.spearPos, dt );

			}

			// Position spear mesh in world space
			this.spearMesh.position.copy( this.spearPos );
			this.spearMesh.quaternion.copy( this.spearQuat );
			this.spearMesh.visible = visible;

		} else if ( this.state === 'retrieving' ) {

			// Reel spear back to muzzle
			_v.copy( this.muzzlePos ).sub( this.spearPos );
			const dist = _v.length();
			const step = Math.min( dist, 5.5 * dt );

			if ( dist > 1e-3 ) {

				this.spearPos.addScaledVector( _v.normalize(), step );
				this.spearQuat.setFromUnitVectors( new Vector3( 0, 1, 0 ), _v );

			}

			if ( this.spearedFish && fishSchools ) {

				fishSchools.updateImpaledFish( this.spearPos, dt );

			}

			if ( dist < 0.45 ) {

				// Spear returned to hands!
				if ( this.spearedFish ) {

					const landed = this.spearedFish;
					this.spearedFish = null;
					if ( fishSchools ) fishSchools.releaseImpaledFish();
					if ( this.onFishLanded ) this.onFishLanded( landed );

				}
				this.reload();

			}

			this.spearMesh.position.copy( this.spearPos );
			this.spearMesh.quaternion.copy( this.spearQuat );
			this.spearMesh.visible = visible;

		} else if ( this.state === 'fighting' && fight ) {

			// The fish fights at the end of the shooting line: it surges and thrashes at the fight's
			// distance from the muzzle (a tug-of-war on the tether, not a literal swimming distance -
			// same tension-band CatchMinigame that drives the rod, so it fights just as hard)
			this._wander += dt * ( 0.6 + fight.surge * 2.2 );
			_v.copy( this.fishPos ).sub( this.muzzlePos );
			const d0 = _v.length() || 1;
			_v.multiplyScalar( 1 / d0 );
			const sideways = _h.set( - _v.z, 0, _v.x ).multiplyScalar( Math.sin( this._wander ) * 0.3 * dt * ( 1 + fight.surge ) );
			const dist = Math.min( this.maxRange || MAX_LINE, Math.max( 0.3, fight.distance ) );
			this.fishPos.set( this.muzzlePos.x + _v.x * dist, this.muzzlePos.y + _v.y * dist, this.muzzlePos.z + _v.z * dist ).add( sideways );
			this.spearPos.lerp( this.fishPos, 1 - Math.exp( - dt * 9 ) );

			if ( this.spearPos.distanceToSquared( this.muzzlePos ) > 1e-5 ) {

				_v.copy( this.spearPos ).sub( this.muzzlePos ).normalize();
				this.spearQuat.setFromUnitVectors( new Vector3( 0, 1, 0 ), _v );

			}

			if ( fishSchools ) fishSchools.updateImpaledFish( this.spearPos, dt );

			this.spearMesh.position.copy( this.spearPos );
			this.spearMesh.quaternion.copy( this.spearQuat );
			this.spearMesh.visible = visible;

		} else if ( this.state === 'held' ) {

			// Landed: the fish stays impaled just forward of the muzzle, in line with the barrel (the
			// same basis as the loaded/idle pose below, just further out so the catch clears the gun)
			this.spearMesh.matrix.copy( this.gunMesh.matrix );
			_m.makeTranslation( 0, GUN_L * 0.75 + 0.5, 0.04 );
			this.spearMesh.matrix.multiply( _m );
			this.spearMesh.matrixWorldNeedsUpdate = true;
			this.spearPos.setFromMatrixPosition( this.spearMesh.matrix );
			this.spearMesh.quaternion.setFromRotationMatrix( this.spearMesh.matrix );

			if ( fishSchools ) fishSchools.updateImpaledFish( this.spearPos, dt );

			this.spearMesh.position.copy( this.spearPos );
			this.spearMesh.visible = visible;

		} else {

			// Loaded: Spear sits neatly in the speargun track
			this.spearMesh.matrix.copy( this.gunMesh.matrix );
			// Offset along gun track
			_m.makeTranslation( 0, 0.12, 0.022 );
			this.spearMesh.matrix.multiply( _m );
			this.spearMesh.matrixWorldNeedsUpdate = true;
			this.spearMesh.position.setFromMatrixPosition( this.spearMesh.matrix );
			this.spearMesh.quaternion.setFromRotationMatrix( this.spearMesh.matrix );
			this.spearMesh.visible = visible && this.loaded;

		}

		// ---- Shooting Line
		const lineActive = ( this.state === 'spearOut' || this.state === 'retrieving' || this.state === 'fighting' );
		if ( lineActive && visible ) {

			const spearTail = _v2.copy( this.spearPos );
			const lm = this.lineMat.uniforms;
			lm.lineA.value.copy( this.muzzlePos );
			lm.lineB.value.copy( spearTail );

			// Quadratic Bezier sag
			const dist = this.muzzlePos.distanceTo( spearTail );
			const sag = Math.min( 0.35, dist * 0.06 );
			lm.lineCtl.value.copy( this.muzzlePos ).lerp( spearTail, 0.5 );
			lm.lineCtl.value.y -= sag;
			lm.lineShow.value = 1.0;
			this.lineMesh.visible = true;

		} else {

			this.lineMesh.visible = false;

		}

	}

}

// ------------------------------------------------------------------ Speargun Geometry

function buildSpeargunGeometry() {

	const parts = [];
	const M = ( x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx ) => mat4( x, y, z, rx, ry, rz, sx, sy, sz );
	const add = ( g, o ) => parts.push( prepare( g, o ) );

	// Speargun Materials
	const TEAK = { color: 0x6e3b20, rough: 0.38, metal: 0.05, pattern: PAT.wood };
	const CARBON = { color: 0x1b1d20, rough: 0.32, metal: 0.15, pattern: PAT.carbon };
	const STAINLESS = { color: 0xcfd3d6, rough: 0.15, metal: 0.95, pattern: PAT.machined };
	const GUNMETAL = { color: 0x33363a, rough: 0.28, metal: 0.85, pattern: PAT.machined };
	const RUBBER = { color: 0x181818, rough: 0.85, metal: 0.0, pattern: PAT.rubber };
	const AMBER = { color: 0xa85c24, rough: 0.65, metal: 0.0, pattern: PAT.rubber };

	// 1. Main Stock / Barrel (Teak laminated stock)
	const barrelL = GUN_L;
	add( roundedBox( 0.038, barrelL, 0.046, 0.007, 2 ), { ...TEAK, matrix: M( 0, barrelL * 0.5 - 0.2, 0 ) } );

	// 2. Spear track insert along top of barrel
	add( roundedBox( 0.012, barrelL - 0.06, 0.006, 0.002, 1 ), { ...GUNMETAL, matrix: M( 0, barrelL * 0.5 - 0.2, 0.022 ) } );

	// 3. Ergonomic Pistol Grip
	// Handle angled down-back at -22 deg (rx = -0.38)
	add( roundedBox( 0.028, 0.125, 0.045, 0.008, 2 ), { ...RUBBER, matrix: M( 0, - 0.16, - 0.045, - 0.38, 0, 0 ) } );
	// Handle base flare
	add( roundedBox( 0.034, 0.016, 0.055, 0.004, 1 ), { ...RUBBER, matrix: M( 0, - 0.21, - 0.068, - 0.38, 0, 0 ) } );

	// 4. Trigger & Trigger Guard
	// Trigger guard
	add( torus( 0.024, 0.0028, 6, 16, Math.PI ), { ...GUNMETAL, matrix: M( 0, - 0.11, - 0.015, Math.PI / 2, 0, 0 ) } );
	// Stainless trigger
	add( roundedBox( 0.004, 0.022, 0.008, 0.001, 1 ), { ...STAINLESS, matrix: M( 0, - 0.11, - 0.012, 0.25, 0, 0 ) } );

	// 5. Rear Loading Butt Pad (chest-loading cushion)
	add( roundedBox( 0.048, 0.035, 0.062, 0.008, 2 ), { ...RUBBER, matrix: M( 0, - 0.21, 0 ) } );

	// 6. Open Muzzle (Front of barrel)
	const muzzleY = barrelL - 0.2;
	add( roundedBox( 0.042, 0.065, 0.048, 0.006, 2 ), { ...GUNMETAL, matrix: M( 0, muzzleY + 0.025, 0 ) } );
	// Stainless line guide loop
	add( torus( 0.006, 0.0012, 5, 14 ), { ...STAINLESS, matrix: M( 0.018, muzzleY + 0.04, 0.012, 0, Math.PI / 2, 0 ) } );

	// 7. Circular Power Bands (Dual 16mm bands stretched back)
	// Left band
	add( cylinder( 0.0075, 0.0075, 0.38, 8 ), { ...AMBER, matrix: M( - 0.016, muzzleY - 0.16, 0.032, 0.04, 0, 0.05 ) } );
	// Right band
	add( cylinder( 0.0075, 0.0075, 0.38, 8 ), { ...AMBER, matrix: M( 0.016, muzzleY - 0.16, 0.032, 0.04, 0, - 0.05 ) } );
	// Dyneema Wishbone loop across bands
	add( cylinder( 0.0015, 0.0015, 0.034, 6 ), { ...STAINLESS, matrix: M( 0, muzzleY - 0.35, 0.034, 0, 0, Math.PI / 2 ) } );

	return mergePrepared( parts );

}

// ------------------------------------------------------------------ Spear Harpoon Geometry

function buildSpearGeometry() {

	const parts = [];
	const M = ( x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx ) => mat4( x, y, z, rx, ry, rz, sx, sy, sz );
	const add = ( g, o ) => parts.push( prepare( g, o ) );

	const SHAFT = { color: 0xdde2e6, rough: 0.12, metal: 0.98, pattern: PAT.machined };
	const TIP = { color: 0xedf0f2, rough: 0.08, metal: 1.0, pattern: PAT.machined };
	const FLOPPER = { color: 0xc2c6c9, rough: 0.22, metal: 0.95, pattern: PAT.machined };

	const len = SPEAR_L;

	// 1. Long 7mm Spring Stainless Steel Shaft
	add( cylinder( 0.0035, 0.0035, len - 0.05, 10 ), { ...SHAFT, matrix: M( 0, len * 0.5 - 0.025, 0 ) } );

	// 2. Conical Penetrating Point (Tri-cut pencil point)
	add( cylinder( 0.0002, 0.0035, 0.045, 10 ), { ...TIP, matrix: M( 0, len - 0.022, 0 ) } );

	// 3. Articulated Flopper (Barb that locks fish onto spear)
	add( roundedBox( 0.0016, 0.065, 0.007, 0.0008, 1 ), { ...FLOPPER, matrix: M( 0, len - 0.085, 0.005, 0.08, 0, 0 ) } );
	// Flopper retaining pin
	add( cylinder( 0.001, 0.001, 0.009, 6 ), { ...SHAFT, matrix: M( 0, len - 0.055, 0, 0, 0, Math.PI / 2 ) } );

	// 4. Rear Notches / Shark-Fin Tabs for band wishbones
	add( roundedBox( 0.002, 0.012, 0.006, 0.0005, 1 ), { ...SHAFT, matrix: M( 0, 0.18, 0.005 ) } );
	add( roundedBox( 0.002, 0.012, 0.006, 0.0005, 1 ), { ...SHAFT, matrix: M( 0, 0.28, 0.005 ) } );

	// 5. Rear Line Hole
	add( torus( 0.0032, 0.0008, 5, 12 ), { ...SHAFT, matrix: M( 0, 0.015, 0, 0, Math.PI / 2, 0 ) } );

	return mergePrepared( parts );

}

// ------------------------------------------------------------------ Line Geometry Helper

function buildLineGeometry( n ) {

	const pos = new Float32Array( ( n + 1 ) * 2 * 3 );
	const line = new Float32Array( ( n + 1 ) * 2 * 2 );
	const idx = [];

	for ( let i = 0; i <= n; i ++ ) {

		for ( let s = 0; s < 2; s ++ ) {

			const j = i * 2 + s;
			line[ j * 2 ] = i / n;
			line[ j * 2 + 1 ] = s ? 1 : - 1;

		}

		if ( i < n ) {

			const a = i * 2;
			idx.push( a, a + 1, a + 2, a + 1, a + 3, a + 2 );

		}

	}

	const g = new BufferGeometry();
	g.setAttribute( 'position', new Float32BufferAttribute( pos, 3 ) );
	g.setAttribute( 'aLine', new Float32BufferAttribute( line, 2 ) );
	g.setIndex( idx );
	return g;

}

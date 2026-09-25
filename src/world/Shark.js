import { Mesh, Vector3, Quaternion, MathUtils, Matrix4, Euler } from '../engine/index.js';
import { prepare, mergePrepared, cylinder, lathe, roundedBox, mat4 } from './boat/GeoKit.js';
import { createPropMaterial, PAT } from '../game/GameMaterials.js';

// Procedural Bronze Whaler / Reef Shark:
// - Cruising in deep reef water and drop-offs
// - Attracted by speared fish (blood / distress vibrations)
// - Circles the diver to snatch un-stashed fish
// - Can be poked on the snout with the spear tip to fend off and repel!

const _v = new Vector3();
const _fwd = new Vector3();
const _m = new Matrix4();
const _q = new Quaternion();

export class Shark {

	constructor( { scene, terrain, index = 0, homePos = new Vector3( 45, - 6, - 80 ) } ) {

		this.scene = scene;
		this.terrain = terrain;
		this.index = index;

		this.home = homePos.clone();
		this.position = homePos.clone();
		this.velocity = new Vector3( 1, 0, 0 );
		this.heading = new Vector3( 1, 0, 0 );
		this.quaternion = new Quaternion();

		this.state = 'cruise'; // 'cruise', 'stalk', 'lunge', 'flee'
		this.speed = 2.2;
		this.timer = 0;
		this.tailPhase = Math.random() * Math.PI * 2;
		this.fleeTimer = 0;
		this.circleAngle = Math.random() * Math.PI * 2;

		// 3D Mesh
		this.material = createPropMaterial( `shark_${index}` );
		this.mesh = new Mesh( buildSharkGeometry(), this.material );
		this.mesh.name = `Shark_${index}`;
		this.mesh.frustumCulled = false;
		this.mesh.castShadow = false;
		this.mesh.matrixAutoUpdate = false;

		scene.add( this.mesh );

	}

	poke() {

		// Repel shark when poked with spear tip!
		this.state = 'flee';
		this.fleeTimer = 12.0; // Flees for 12 seconds
		this.speed = 6.5;      // Bursts away
		return true;

	}

	snatch() {

		// Snatch fish from diver and flee
		this.state = 'flee';
		this.fleeTimer = 10.0;
		this.speed = 7.0;
		return true;

	}

	update( dt, { playerPos, playerInWater, spearedFish } ) {

		this.timer += dt;
		this.tailPhase += dt * ( this.speed * 2.2 );

		const pPos = playerPos;
		const distToPlayer = this.position.distanceTo( pPos );

		// ---- AI Behavior State Machine
		if ( this.state === 'flee' ) {

			this.fleeTimer -= dt;
			// Swim directly away from player
			_v.copy( this.position ).sub( pPos ).normalize();
			_v.y = Math.min( - 0.2, _v.y ); // dive deeper when fleeing
			this.heading.lerp( _v, 1 - Math.exp( - dt * 3 ) ).normalize();

			if ( this.fleeTimer <= 0 ) {

				this.state = 'cruise';
				this.speed = 2.2;

			}

		} else if ( spearedFish && playerInWater && distToPlayer < 45 ) {

			// Blood in the water! Shark is attracted and approaches diver
			this.state = 'stalk';
			this.speed = 3.4;

			if ( distToPlayer > 5.5 ) {

				// Move toward player
				_v.copy( pPos ).sub( this.position ).normalize();
				this.heading.lerp( _v, 1 - Math.exp( - dt * 2.5 ) ).normalize();

			} else {

				// Circle tightly around the player (radius 4-5m) looking for an opening
				this.circleAngle += dt * 0.9;
				const targetX = pPos.x + Math.cos( this.circleAngle ) * 4.5;
				const targetZ = pPos.z + Math.sin( this.circleAngle ) * 4.5;
				const targetY = Math.max( - 18, Math.min( - 1.5, pPos.y - 0.8 ) );

				_v.set( targetX, targetY, targetZ ).sub( this.position ).normalize();
				this.heading.lerp( _v, 1 - Math.exp( - dt * 4 ) ).normalize();

			}

		} else {

			// Peaceful cruising in deep reef/bay
			this.state = 'cruise';
			this.speed = 1.8;

			// Patrol around home territory in wide lazy loop
			const dHome = this.position.distanceTo( this.home );
			if ( dHome > 28 ) {

				_v.copy( this.home ).sub( this.position ).normalize();
				this.heading.lerp( _v, 1 - Math.exp( - dt * 1.5 ) ).normalize();

			} else {

				// Gentle meandering
				const wander = Math.sin( this.timer * 0.4 + this.index * 2 ) * 0.015;
				this.heading.applyAxisAngle( new Vector3( 0, 1, 0 ), wander ).normalize();

			}

		}

		// Keep shark below surface and above seabed
		const groundY = this.terrain ? this.terrain.heightAt( this.position.x, this.position.z ) : - 25;
		const minDepthY = groundY + 1.2;
		const maxDepthY = - 0.8; // stay under surface

		// Advance position
		this.position.addScaledVector( this.heading, this.speed * dt );
		this.position.y = MathUtils.clamp( this.position.y, minDepthY, maxDepthY );

		// ---- Orient mesh
		// Heading yaw & pitch
		const yaw = Math.atan2( - this.heading.x, - this.heading.z );
		const pitch = Math.asin( MathUtils.clamp( this.heading.y, - 0.6, 0.6 ) );
		// Tail swimming sway bank
		const tailWag = Math.sin( this.tailPhase ) * 0.08;

		this.quaternion.setFromEuler( new Euler( pitch, yaw, tailWag, 'YXZ' ) );

		// Update 3D transformation matrix
		_m.compose( this.position, this.quaternion, new Vector3( 1, 1, 1 ) );
		this.mesh.matrix.copy( _m );
		this.mesh.matrixWorldNeedsUpdate = true;
		this.mesh.visible = true;

	}

}

// ------------------------------------------------------------------ Shark 3D Geometry

function buildSharkGeometry() {

	const parts = [];
	const M = ( x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx ) => mat4( x, y, z, rx, ry, rz, sx, sy, sz );
	const add = ( g, o ) => parts.push( prepare( g, o ) );

	// Shark Skin: Slate-gray upper counter-shaded to light belly
	const DORSAL_GRAY = { color: 0x3d444b, rough: 0.35, metal: 0.05, pattern: PAT.plain };
	const BELLY_WHITE = { color: 0xe0e6eb, rough: 0.38, metal: 0.02, pattern: PAT.plain };
	const FIN_DARK = { color: 0x272c30, rough: 0.35, metal: 0.05, pattern: PAT.plain };

	// 1. Main Fusiform Body (2.4m reef shark)
	// Torso profile via lathe
	const bodyProfile = [
		[ 0.0, - 1.25 ],       // tail tip
		[ 0.05, - 1.15 ],
		[ 0.08, - 0.95 ],      // caudal peduncle
		[ 0.16, - 0.6 ],
		[ 0.28, - 0.15 ],      // mid body
		[ 0.32, 0.3 ],         // thickest girth
		[ 0.29, 0.7 ],         // behind head
		[ 0.22, 1.05 ],        // head
		[ 0.08, 1.35 ],        // snout
		[ 0.0, 1.42 ],         // tip of snout
	];
	// +Y along length (so snout is +Y, tail is -Y)
	add( lathe( bodyProfile, 18 ), { ...DORSAL_GRAY, matrix: M( 0, 0, 0, Math.PI / 2, 0, 0 ) } );

	// 2. White Counter-shaded Underbelly
	add( cylinder( 0.21, 0.24, 0.95, 12 ), { ...BELLY_WHITE, matrix: M( 0, - 0.08, 0.25, Math.PI / 2, 0, 0 ) } );

	// 3. Iconic Tall Dorsal Fin
	// Triangular swept fin on top of back
	add( roundedBox( 0.024, 0.42, 0.28, 0.005, 1 ), { ...FIN_DARK, matrix: M( 0, 0.32, 0.15, - 0.42, 0, 0 ) } );

	// 4. Swept Pectoral Fins (Left & Right)
	// Left pectoral fin
	add( roundedBox( 0.48, 0.022, 0.22, 0.004, 1 ), { ...FIN_DARK, matrix: M( - 0.38, - 0.12, 0.45, - 0.22, 0.35, - 0.35 ) } );
	// Right pectoral fin
	add( roundedBox( 0.48, 0.022, 0.22, 0.004, 1 ), { ...FIN_DARK, matrix: M( 0.38, - 0.12, 0.45, - 0.22, - 0.35, 0.35 ) } );

	// 5. Heterocercal Shark Tail (Caudal Fin)
	// Upper lobe (long swept blade)
	add( roundedBox( 0.02, 0.48, 0.18, 0.004, 1 ), { ...FIN_DARK, matrix: M( 0, 0.22, - 1.38, - 0.65, 0, 0 ) } );
	// Lower lobe (shorter blade)
	add( roundedBox( 0.018, 0.26, 0.14, 0.004, 1 ), { ...FIN_DARK, matrix: M( 0, - 0.12, - 1.34, 0.62, 0, 0 ) } );

	// 6. Secondary Dorsal Fin & Pelvic Fins
	add( roundedBox( 0.015, 0.12, 0.11, 0.003, 1 ), { ...FIN_DARK, matrix: M( 0, 0.12, - 0.75, - 0.5, 0, 0 ) } );
	add( roundedBox( 0.015, 0.11, 0.09, 0.003, 1 ), { ...FIN_DARK, matrix: M( 0, - 0.11, - 0.78, 0.5, 0, 0 ) } );

	// 7. Dark Eyes & Gill Slits
	add( cylinder( 0.018, 0.018, 0.008, 8 ), { color: 0x111111, rough: 0.1, metal: 0.8, matrix: M( - 0.16, 0.05, 1.05, 0, 0, Math.PI / 2 ) } );
	add( cylinder( 0.018, 0.018, 0.008, 8 ), { color: 0x111111, rough: 0.1, metal: 0.8, matrix: M( 0.16, 0.05, 1.05, 0, 0, Math.PI / 2 ) } );

	return mergePrepared( parts );

}

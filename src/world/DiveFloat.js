import { Mesh, Vector3, Quaternion, Matrix4, MathUtils, Euler, BufferGeometry, Float32BufferAttribute } from '../engine/index.js';
import { prepare, mergePrepared, cylinder, lathe, roundedBox, torus, mat4 } from './boat/GeoKit.js';
import { createPropMaterial, createLineMaterial, PAT } from '../game/GameMaterials.js';

// The Spearfisher's Surface Float ("Floating Locker"):
// - High-vis orange torpedo float with a dive flag towed on the water surface
// - Provides a safe locker to stash speared fish away from sharks
// - Trails behind the diver smoothly via a 15m high-vis floatline

const _v = new Vector3();
const _m = new Matrix4();

export class DiveFloat {

	constructor( { scene, query } ) {

		this.scene = scene;
		this.query = query;

		this.position = new Vector3( 0, 0, 0 );
		this.quaternion = new Quaternion();
		this.waterY = 0;
		this.active = false;
		this.stashedFish = [];
		this.maxKg = 15.0; // 15kg portable dive float locker capacity

		// 3D Torpedo Float Mesh
		this.material = createPropMaterial( 'diveFloat' );
		this.mesh = new Mesh( buildFloatGeometry(), this.material );
		this.mesh.name = 'DiveFloat';
		this.mesh.frustumCulled = false;
		this.mesh.castShadow = false;
		this.mesh.matrixAutoUpdate = false;
		this.mesh.visible = false;

		// Floatline tether
		this.lineMat = createLineMaterial( 24 );
		this.lineMesh = new Mesh( this.lineMat.createGeometry ? this.lineMat.createGeometry( 24 ) : buildFloatLineGeo( 24 ), this.lineMat );
		this.lineMesh.name = 'FloatLine';
		this.lineMesh.frustumCulled = false;
		this.lineMesh.castShadow = false;
		this.lineMesh.visible = false;

		scene.add( this.mesh, this.lineMesh );

	}

	get totalKg() {

		let sum = 0;
		for ( const f of this.stashedFish ) sum += f.kg;
		return sum;

	}

	fits( kg ) {

		return ( this.totalKg + kg ) <= this.maxKg + 0.05;

	}

	deploy( playerPos ) {

		this.active = true;
		this.position.set( playerPos.x - 3, 0, playerPos.z - 3 );
		this.mesh.visible = true;
		this.lineMesh.visible = true;

	}

	stow() {

		this.active = false;
		this.mesh.visible = false;
		this.lineMesh.visible = false;

	}

	stash( fish ) {

		this.stashedFish.push( fish );
		return this.stashedFish.length;

	}

	empty() {

		return this.stashedFish.splice( 0 );

	}

	update( dt, playerPos, playerInWater, waterHeight = 0 ) {

		if ( ! playerInWater ) {

			this.stow();
			return;

		}

		if ( ! this.active ) {

			this.deploy( playerPos );

		}

		// Water surface height at float position
		this.waterY = Number.isFinite( waterHeight ) ? waterHeight : 0;
		const targetY = this.waterY + 0.16 + Math.sin( Date.now() * 0.0025 ) * 0.05;

		// The float follows the diver on the surface with smooth drag tether
		_v.copy( this.position ).sub( playerPos );
		_v.y = 0; // horizontal distance only
		const hDist = _v.length();
		const atSurface = ( playerPos.y >= - 0.6 );
		const maxTether = atSurface ? 3.5 : 7.5; // Stays right next to diver at surface

		if ( hDist > maxTether ) {

			// Drag float along surface behind player
			_v.normalize();
			this.position.x = playerPos.x + _v.x * maxTether;
			this.position.z = playerPos.z + _v.z * maxTether;

		}

		this.position.y += ( targetY - this.position.y ) * ( 1 - Math.exp( - dt * 6 ) );

		// Orient float along tow direction with gentle wave roll
		const towAngle = Math.atan2( playerPos.x - this.position.x, playerPos.z - this.position.z );
		const waveRoll = Math.sin( Date.now() * 0.003 ) * 0.08;
		const wavePitch = Math.cos( Date.now() * 0.0025 ) * 0.06;

		this.quaternion.setFromEuler( new Euler( wavePitch, towAngle, waveRoll, 'YXZ' ) );

		// Update 3D matrix
		this.mesh.position.copy( this.position );
		this.mesh.quaternion.copy( this.quaternion );
		_m.compose( this.position, this.quaternion, new Vector3( 1, 1, 1 ) );
		this.mesh.matrix.copy( _m );
		this.mesh.matrixWorldNeedsUpdate = true;
		this.mesh.visible = true;

		// Update floatline between diver and float
		const lm = this.lineMat.uniforms;
		lm.lineA.value.copy( playerPos );
		lm.lineB.value.copy( this.position );
		// High-vis yellow/orange line sagging into water
		lm.lineCtl.value.copy( playerPos ).lerp( this.position, 0.5 );
		lm.lineCtl.value.y = Math.min( playerPos.y, this.position.y ) - 0.4;
		lm.lineShow.value = 1.0;
		this.lineMesh.visible = true;

	}

}

// ------------------------------------------------------------------ Dive Float 3D Geometry

function buildFloatGeometry() {

	const parts = [];
	const M = ( x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx ) => mat4( x, y, z, rx, ry, rz, sx, sy, sz );
	const add = ( g, o ) => parts.push( prepare( g, o ) );

	const HI_VIS_ORANGE = { color: 0xff4500, rough: 0.32, metal: 0.02, pattern: PAT.plain };
	const FLAG_RED = { color: 0xdc143c, rough: 0.4, metal: 0.0, pattern: PAT.cloth };
	const FLAG_WHITE = { color: 0xffffff, rough: 0.3, metal: 0.05, pattern: PAT.plain };
	const MESH_BAG = { color: 0x141a14, rough: 0.85, metal: 0.0, pattern: PAT.braid };
	const STAINLESS = { color: 0xcfd3d6, rough: 0.15, metal: 0.95, pattern: PAT.machined };

	// 1. Torpedo Float Body (1.3m long, 0.24m radius high-vis buoyant hull)
	const hullProfile = [
		[ 0.0, - 0.65 ],
		[ 0.12, - 0.58 ],
		[ 0.20, - 0.35 ],
		[ 0.24, 0.0 ],
		[ 0.20, 0.35 ],
		[ 0.12, 0.58 ],
		[ 0.0, 0.65 ],
	];
	add( lathe( hullProfile, 16 ), { ...HI_VIS_ORANGE, matrix: M( 0, 0, 0, Math.PI / 2, 0, 0 ) } );

	// 2. High-vis reflective safety bands
	add( cylinder( 0.21, 0.21, 0.08, 16 ), { ...FLAG_WHITE, matrix: M( 0, 0, 0.28, Math.PI / 2, 0, 0 ) } );
	add( cylinder( 0.21, 0.21, 0.08, 16 ), { ...FLAG_WHITE, matrix: M( 0, 0, - 0.28, Math.PI / 2, 0, 0 ) } );

	// 3. High-vis keel / grab handles on underside
	add( roundedBox( 0.05, 0.11, 0.75, 0.015, 1 ), { color: 0x111111, rough: 0.8, metal: 0.0, matrix: M( 0, - 0.18, 0 ) } );

	// 4. Tall Dive Flag Mast (0.85m tall)
	add( cylinder( 0.008, 0.008, 0.85, 8 ), { ...STAINLESS, matrix: M( 0, 0.45, - 0.2 ) } );

	// 5. Alpha / Diver-Down Flag (Red with white diagonal stripe, 0.45m x 0.32m)
	add( roundedBox( 0.005, 0.32, 0.45, 0.003, 1 ), { ...FLAG_RED, matrix: M( 0, 0.70, - 0.2 ) } );
	// White diagonal stripe
	add( roundedBox( 0.008, 0.33, 0.11, 0.003, 1 ), { ...FLAG_WHITE, matrix: M( 0, 0.70, - 0.2, 0, 0, 0.65 ) } );

	// 6. Mesh Catch Bag underneath (Floating Locker)
	add( roundedBox( 0.32, 0.36, 0.65, 0.04, 1 ), { ...MESH_BAG, matrix: M( 0, - 0.38, 0 ) } );

	// 7. Stainless Tow D-ring on nose
	add( torus( 0.03, 0.005, 6, 16 ), { ...STAINLESS, matrix: M( 0, 0, 0.68, Math.PI / 2, 0, 0 ) } );

	return mergePrepared( parts );

}

function buildFloatLineGeo( n ) {

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

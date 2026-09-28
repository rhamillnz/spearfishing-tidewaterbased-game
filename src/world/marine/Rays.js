import { Group, Mesh, Vector3, Quaternion, Matrix4, Euler } from '../../engine/index.js';
import { RayBrain } from './RayBrain.js';
import { RAY_KIND, MAX_RAYS, buildRayGeometry, createRayMaterial, newWaveArray } from './RayModel.js';

// Rays: ambient wildlife cruising over the sand flats and around the reefs and pier, like the whale
// (not spearable, not catchable, harmless: nothing else in the game knows about them).
//   short-tail stingray (Bathytoshia brevicaudata): big dark disc, hugs the bottom, rests on the sand
//   eagle ray (Myliobatis tenuicaudatus): pointed wings, cruises higher with a slow flapping flight
// Procedural models and the wing wave: RayModel.js (one material, the wave in the vertex shader).
// Behaviour: RayBrain.js. Two levels of detail per animal and distance culling (murk underwater,
// depth from above), as the whale does. Per frame: O(n) brains + one matrix and one vec4 each.

// species, home patch (x, z), size
export const RAY_SPAWNS = [
	{ species: 'stingray', x: 2, z: 26, scale: 1.0, roam: 26 },    // sand flats off the beach
	{ species: 'stingray', x: 76, z: 48, scale: 1.25, roam: 24 },  // out from the pier head
	{ species: 'stingray', x: - 40, z: 58, scale: 0.85, roam: 26 }, // the edge of the reef
	{ species: 'stingray', x: 18, z: 108, scale: 1.35, roam: 30 }, // deep sand
	{ species: 'eagle', x: - 8, z: 80, scale: 1.1, roam: 36 },
	{ species: 'eagle', x: 84, z: 98, scale: 1.25, roam: 32 },
];

const LOD_DIST = 22; // m: lod0 -> lod1
const UNDER_VIS = 70; // m: lost in the blue beyond this when the camera is under water
const ABOVE_VIS = 45; // m: from the air, seen only near by (and not at all when deep)
const MAX_DIST = 160;

const _q = new Quaternion();
const _q2 = new Quaternion();
const _m = new Matrix4();
const _s = new Vector3();
const _e = new Euler();
const _up = new Vector3( 0, 1, 0 );
const _diver = { position: new Vector3(), swimming: false };

export class Rays {

	constructor( { scene, terrain, spawns = RAY_SPAWNS } ) {

		this.scene = scene;
		this.terrain = terrain;
		this.group = new Group();
		this.group.name = 'Rays';
		this.waves = newWaveArray();
		this.material = createRayMaterial( this.waves );
		this.rays = spawns.slice( 0, MAX_RAYS ).map( ( s, i ) => {

			const kind = s.species === 'eagle' ? RAY_KIND.eagle : RAY_KIND.stingray;
			const brain = new RayBrain( { terrain, species: s.species, home: new Vector3( s.x, 0, s.z ), roam: s.roam, scale: s.scale, seed: i * 7 + 3 } );
			const meshes = [ 0, 1 ].map( ( lod ) => {

				const mesh = new Mesh( buildRayGeometry( kind, lod, i ), this.material );
				mesh.name = `Ray_${ s.species }_${ i }_lod${ lod }`;
				mesh.matrixAutoUpdate = false;
				mesh.castShadow = true;
				mesh.receiveShadow = true;
				mesh.visible = false;
				this.group.add( mesh );
				return mesh;

			} );
			return { brain, kind, slot: i, meshes, lod: 0, quaternion: new Quaternion() };

		} );
		scene.add( this.group );
		this.update( 0, null, null );

	}

	// player: the Player (position, mode) or null (free camera: nobody in the water to shy away from)
	// Once the real bombies exist (Game builds them after the app's wildlife), steer around their
	// actual rock: each pinnacle's widest profile radius replaces the estimated footprint.
	setBombies( bombies ) {

		const obstacles = bombies.locations.map( ( b ) => ( {
			x: b.x, z: b.z,
			radius: b.profile ? Math.max( ...b.profile.map( ( p ) => p.r ) ) : b.radius,
		} ) );
		for ( const r of this.rays ) r.brain.obstacles = obstacles;

	}

	update( dt, camera, player = null ) {

		let diver = null;
		if ( player ) {

			_diver.position.copy( player.position );
			_diver.swimming = player.mode === 'swim';
			diver = _diver;

		}

		const W = this.waves;
		const camUnder = camera ? camera.position.y < 0 : true;
		for ( const r of this.rays ) {

			const b = r.brain;
			b.update( dt, diver );

			// wave state: last frame -> the upper half, this frame's
			W[ MAX_RAYS + r.slot ].copy( W[ r.slot ] );
			W[ r.slot ].set( b.phase, b.amp, r.kind, b.tailPhase );
			if ( dt === 0 ) W[ MAX_RAYS + r.slot ].copy( W[ r.slot ] );

			// pose: yaw, climb and bank; lying on the sand it lines up with the seabed
			_q.setFromEuler( _e.set( b.pitch, b.yaw, b.roll, 'YXZ' ) );
			if ( b.settled > 0.01 ) {

				_q2.setFromUnitVectors( _up, b.groundNormal ).multiply( _q );
				_q.slerp( _q2, b.settled );

			}

			r.quaternion.copy( _q );
			_m.compose( b.position, _q, _s.setScalar( b.scale ) );

			// level of detail and culling
			let lod = r.lod, visible = true;
			if ( camera ) {

				const d = camera.position.distanceTo( b.position );
				if ( lod === 0 && d > LOD_DIST * 1.1 ) lod = 1;
				else if ( lod === 1 && d < LOD_DIST * 0.9 ) lod = 0;
				if ( d > MAX_DIST ) visible = false;
				if ( camUnder && d > UNDER_VIS ) visible = false;
				if ( ! camUnder && ( d > ABOVE_VIS || ( b.position.y < - 6 && d > 20 ) ) ) visible = false;

			}

			r.lod = lod;
			for ( let i = 0; i < 2; i ++ ) {

				const mesh = r.meshes[ i ];
				mesh.visible = visible && i === lod;
				mesh.matrix.copy( _m );
				mesh.matrixWorldNeedsUpdate = true;

			}

		}

	}

}

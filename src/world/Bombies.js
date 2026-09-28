import { Mesh, Vector3, Matrix4, Color } from '../engine/index.js';
import { prepare, mergePrepared, box, cylinder, mat4, paintVertices } from './boat/GeoKit.js';
import { createPropMaterial, PAT } from '../game/GameMaterials.js';
import { buildRockGeometry, ROCK_STYLES } from './terrain/RockGeometry.js';
import { mulberry32 } from '../util/Noise.js';

// Underwater "Bombies" & Haystack Pinnacles (Iconic Kiwi Reef Formations):
// - Massive craggy rock towers and haystack hills rising from the seabed up near the surface
// - Covered with dense kelp beds and seaweed (Ecklonia radiata)
// - Prime habitat for iconic NZ fish: Snapper, Tarakihi, Trevally, Kingfish, Blue Cod, Butterfish
// - Provide essential cover for spearfishers to stalk and sneak up on skittish trophy fish

export const BOMBIE_LOCATIONS = [
	// 1. East Pier Head / Mooring Pinnacle (action right as you dive off boat/pier!):
	{ name: 'Pier East Haystack', x: 74, z: 46, radius: 4.8, height: 8.5 },
	// 2. Central Bay Pinnacle (right in front of pier head):
	{ name: 'Bay Centre Pinnacle', x: 38, z: 52, radius: 5.2, height: 9.0 },
	// 3. West Shallows Bombie (between pier and outer reef):
	{ name: 'West Shallows Bombie', x: - 12, z: 38, radius: 4.6, height: 7.5 },
	// 4. North Bay Haystack (near the beach wading breakers):
	{ name: 'Beach Kelp Haystack', x: 18, z: 15, radius: 4.0, height: 6.0 },
	// 5. Eastern Channel Pinnacle:
	{ name: 'East Channel Pinnacle', x: 96, z: 66, radius: 5.8, height: 10.5 },
	// 6. South Bay Cathedral Haystack:
	{ name: 'Cathedral Haystack', x: 32, z: 92, radius: 6.2, height: 12.0 },
	// 7. Reef Outer Horn Pinnacle:
	{ name: 'Reef Horn Pinnacle', x: - 54, z: 72, radius: 6.0, height: 11.5 },
	// 8. Western Kelp Forest Pinnacle:
	{ name: 'Kelp Forest Bombie', x: - 92, z: 46, radius: 5.2, height: 10.0 },
	// 9. Kingfish Ridge Pinnacle (Outer high-current pinnacle):
	{ name: 'Kingfish Ridge Pinnacle', x: 68, z: 122, radius: 6.8, height: 14.0 },
	// 10. Deep Drop-off Pinnacle:
	{ name: 'Outer Drop-off Haystack', x: - 16, z: 136, radius: 7.2, height: 15.5 },
	// 11. Southwest Haystack:
	{ name: 'Southwest Pinnacle', x: - 66, z: 126, radius: 6.5, height: 14.5 },
	// 12. Far South Oceanic Pinnacle (Deep blue pelagic territory):
	{ name: 'Oceanic Haystack', x: 26, z: 168, radius: 7.8, height: 17.5 },
];

export class Bombies {

	constructor( { scene, terrain } ) {

		this.scene = scene;
		this.terrain = terrain;

		// Calculate exact seabed attachment and crown heights from actual terrain
		this.locations = BOMBIE_LOCATIONS.map( ( b ) => {

			const seabed = terrain ? terrain.heightAt( b.x, b.z ) : - 12.0;
			const targetTop = Math.min( - 1.8, seabed + b.height );
			// never taller than the water is deep: a bombie in 3 m of water is a low reef, not a spire
			const actualHeight = Math.max( 1.2, targetTop - seabed );
			return {
				...b,
				baseDepth: seabed,
				topDepth: targetTop,
				height: actualHeight,
			};

		} );

		// 3D Material: Weathered underwater reef limestone and granite
		this.material = createPropMaterial( 'bombieRock' );
		this.mesh = new Mesh( buildBombiesGeometry( this.locations ), this.material );
		this.mesh.name = 'Bombies';
		this.mesh.frustumCulled = false;
		this.mesh.castShadow = true;

		scene.add( this.mesh );

	}

	// Returns bombie info if player is within cover range (< 3.8m from rock surface)
	checkCover( playerPos ) {

		for ( const b of this.locations ) {

			// Horizontal distance to pinnacle center
			const dx = playerPos.x - b.x;
			const dz = playerPos.z - b.z;
			const hDist = Math.hypot( dx, dz );

			// Check if within pinnacle depth range
			const inDepthBand = playerPos.y <= b.topDepth + 1.8 && playerPos.y >= b.baseDepth - 1.0;

			// Within 3.5m of the rock perimeter
			if ( inDepthBand && hDist <= ( b.radius + 3.5 ) ) {

				return {
					name: b.name,
					distance: Math.max( 0, hDist - b.radius ),
					bombie: b,
				};

			}

		}

		return null;

	}

}

// ------------------------------------------------------------------ Bombies 3D Geometry

function buildBombiesGeometry( locations ) {

	const parts = [];
	const M = ( x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx ) => mat4( x, y, z, rx, ry, rz, sx, sy, sz );
	const add = ( g, o ) => parts.push( prepare( g, o ) );

	const ROCK_DARK = 0x2e353b;
	const ROCK_CRUST = 0x4a4f4c;
	const ROCK_ENCRUST = 0x4a4a3a;
	const ROCK_CORALLINE = 0x5e4848;
	const KELP_FOREST = { color: 0x223616, rough: 0.65, metal: 0.0, pattern: PAT.cloth };
	const KELP_GOLD = { color: 0x3d4e1b, rough: 0.60, metal: 0.0, pattern: PAT.braid };
	const SEAWEED_BROWN = { color: 0x352b18, rough: 0.75, metal: 0.0, pattern: PAT.plain };

	const paintRock = ( geo, baseColor ) => {
		const ao = geo.attributes.ao.array;
		paintVertices( geo, ( v, i ) => {
			const col = new Color( baseColor );
			col.multiplyScalar( ao[ i ] );
			const yNorm = ( v.y + 0.8 ) / 1.6;
			col.multiplyScalar( 0.6 + 0.4 * Math.max( 0, Math.min( 1, yNorm ) ) );
			return col;
		} );
	};

	for ( let bi = 0; bi < locations.length; bi ++ ) {

		const b = locations[ bi ];
		const x = b.x, z = b.z, h = b.height, r = b.radius;
		const baseY = b.baseDepth;
		const rng = mulberry32( bi + 1 );

		const rockColor = ( tint ) => {
			const t = rng();
			if ( tint && t < 0.1 ) return ROCK_ENCRUST;
			if ( tint && t < 0.18 ) return ROCK_CORALLINE;
			const c = new Color( ROCK_DARK );
			c.lerp( new Color( ROCK_CRUST ), rng() );
			return c;
		};

		const addRock = ( style, sx, sy, sz, px, py, pz, ry, tiltRx, tiltRz, subdiv = 2, tint = true ) => {
			const seed = Math.floor( rng() * 2147483647 );
			const geo = buildRockGeometry( style, seed, subdiv );
			// shallow reefs: squash any rock whose crown would come within 0.8 m of the surface
			const crown = 1.06 * ROCK_STYLES[ style ].scale[ 1 ];
			py = Math.min( py, - 0.8 - 0.15 * crown );
			if ( py + sy * crown > - 0.8 ) sy = ( - 0.8 - py ) / crown;
			paintRock( geo, rockColor( tint ) );
			add( geo, { color: 0xffffff, rough: 0.92, metal: 0.03, pattern: PAT.plain, matrix: M( px, py, pz, tiltRx, ry, tiltRz, sx, sy, sz ) } );
		};

		// 1. Stacked core: 3-5 spire/block rocks, tapering upward
		const nCore = 3 + Math.floor( rng() * 3 );
		for ( let i = 0; i < nCore; i ++ ) {

			const t = nCore > 1 ? i / ( nCore - 1 ) : 0.5;
			const style = rng() < 0.6 ? 3 : 1;
			const sy = h / ( nCore * 1.2 );
			const s = r * ( 1.0 - t * 0.45 );
			// rock half height ~ 0.85 x style scale: the bottom rock is centred on the seabed, the
			// top one's crown lands on topY (never breaking the surface)
			const top = sy * ( style === 3 ? 1.45 : 0.9 ) * 0.85;
			const yPos = baseY + ( h - top ) * t;
			const ry = rng() * Math.PI * 2;
			const tilt = ( rng() - 0.5 ) * 0.3;
			const jx = ( rng() - 0.5 ) * 0.4 * r;
			const jz = ( rng() - 0.5 ) * 0.4 * r;
			addRock( style, s, sy, s, x + jx, yPos, z + jz, ry, tilt, tilt * 0.7, 3, i > 0 ); // fine mesh; plain dark base rock

		}

		// 2. Base skirt: 6-9 boulders/blocks scattered around the base
		const nSkirt = 6 + Math.floor( rng() * 4 );
		for ( let i = 0; i < nSkirt; i ++ ) {

			const angle = ( i / nSkirt ) * Math.PI * 2 + ( rng() - 0.5 ) * 0.5;
			const dist = r * ( 0.8 + rng() * 0.5 );
			const style = Math.floor( rng() * 3 );
			const size = r * ( 0.3 + rng() * 0.3 );
			const yPos = baseY - size * 0.2;
			const ry = rng() * Math.PI * 2;
			const tilt = ( rng() - 0.5 ) * 0.25;
			addRock( style, size, size * 0.65, size, x + Math.cos( angle ) * dist, yPos, z + Math.sin( angle ) * dist, ry, tilt, 0, 2, false ); // big skirt boulders stay plain dark rock

		}

		// 3. Shoulder rocks: 3-6 small rocks wedged on the mid slopes
		const nSh = 3 + Math.floor( rng() * 4 );
		for ( let i = 0; i < nSh; i ++ ) {

			const angle = rng() * Math.PI * 2;
			const t = 0.35 + rng() * 0.35;
			// on the tapering core surface, sunk a little into it
			const dist = 0.85 * r * ( 1 - 0.45 * t ) * ( 0.75 + rng() * 0.2 );
			const style = Math.floor( rng() * 2 );
			const size = r * ( 0.15 + rng() * 0.15 );
			const yPos = baseY + h * t;
			addRock( style, size, size * 0.8, size, x + Math.cos( angle ) * dist, yPos, z + Math.sin( angle ) * dist, rng() * Math.PI * 2, 0, 0 );

		}

		// 4. Kelp stipes with thin blades (replacing old rounded-box fronds)
		for ( let k = 0; k < 14; k ++ ) {

			const kAngle = ( k / 14 ) * Math.PI * 2 + ( rng() - 0.5 ) * 0.4;
			const tk = 0.5 + rng() * 0.4;
			// just inside the tapering core's surface so the holdfast is anchored on rock
			const kDist = 0.85 * r * ( 1 - 0.45 * tk ) * ( 0.45 + rng() * 0.3 );
			const kx = x + Math.cos( kAngle ) * kDist;
			const kz = z + Math.sin( kAngle ) * kDist;
			const ky = baseY + h * tk;
			const kelpMat = ( k % 2 === 0 ) ? KELP_FOREST : ( k % 3 === 0 ) ? KELP_GOLD : SEAWEED_BROWN;

			// Stipe: slender cylinder tapering upward, with its fronds staying under the surface
			const stipeH = Math.min( 1.2 + rng() * 1.2, - 1.9 - ky );
			if ( stipeH < 0.4 ) continue;
			const stipeRt = 0.04 + rng() * 0.03;
			const stipeRb = stipeRt * ( 1.3 + rng() * 0.4 );
			add( cylinder( stipeRt, stipeRb, stipeH, 6 ), {
				...kelpMat,
				matrix: M( kx, ky + stipeH * 0.5, kz, ( rng() - 0.5 ) * 0.1, kAngle, ( rng() - 0.5 ) * 0.1 ),
			} );

			// Blades: 4-6 thin fronds fanned around the stipe top
			const nBlades = 4 + Math.floor( rng() * 3 );
			for ( let b = 0; b < nBlades; b ++ ) {

				const bAngle = ( b / nBlades ) * Math.PI * 2 + ( rng() - 0.5 ) * 0.3;
				const tilt = 0.4 + rng() * 0.5;
				const bladeH = 0.9 + rng() * 0.5;
				// blade grows from the stipe top: tilt it out (X), then fan it round the stipe (Y)
				add( box( 0.18, bladeH, 0.02 ).translate( 0, bladeH * 0.5, 0 ), {
					...kelpMat,
					matrix: mat4( kx, ky + stipeH, kz, tilt, bAngle, 0, 1, 1, 1, 'YXZ' ),
				} );

			}

		}

	}

	return mergePrepared( parts );

}

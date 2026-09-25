import { Mesh, Vector3, Matrix4 } from '../engine/index.js';
import { prepare, mergePrepared, roundedBox, cylinder, lathe, mat4 } from './boat/GeoKit.js';
import { createPropMaterial, PAT } from '../game/GameMaterials.js';

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
			const actualHeight = Math.max( 4.5, targetTop - seabed );
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

	const ROCK_DARK = { color: 0x2e353b, rough: 0.92, metal: 0.04, pattern: PAT.plain };
	const ROCK_CRUST = { color: 0x424a4f, rough: 0.88, metal: 0.02, pattern: PAT.plain };
	const KELP_FOREST = { color: 0x223616, rough: 0.65, metal: 0.0, pattern: PAT.cloth };
	const KELP_GOLD = { color: 0x3d4e1b, rough: 0.60, metal: 0.0, pattern: PAT.braid };
	const SEAWEED_BROWN = { color: 0x352b18, rough: 0.75, metal: 0.0, pattern: PAT.plain };

	for ( const b of locations ) {

		const x = b.x, z = b.z, h = b.height, r = b.radius;
		const midY = b.baseDepth + h * 0.5;
		const topY = b.baseDepth + h;

		// 1. Main Craggy Haystack Spire (Steep conical mound)
		add( cylinder( r * 0.55, r * 1.35, h, 14 ), { ...ROCK_DARK, matrix: M( x, midY, z ) } );

		// 2. Surrounding craggy shoulder boulders and buttress crevices
		for ( let angle = 0; angle < Math.PI * 2; angle += 0.9 ) {

			const dist = r * ( 0.65 + Math.sin( angle * 2 ) * 0.2 );
			const bx = x + Math.cos( angle ) * dist;
			const bz = z + Math.sin( angle ) * dist;
			const by = b.baseDepth + h * ( 0.25 + Math.cos( angle * 3 ) * 0.2 );
			const br = r * ( 0.38 + Math.cos( angle * 2 ) * 0.12 );
			add( roundedBox( br * 1.9, br * 2.5, br * 1.9, br * 0.35, 1 ), { ...ROCK_CRUST, matrix: M( bx, by, bz, angle * 0.4, angle, 0.2 ) } );

		}

		// 3. Haystack Pinnacle Crown (Natural domed reef top)
		add( roundedBox( r * 1.25, 1.4, r * 1.25, 0.4, 1 ), { ...ROCK_CRUST, matrix: M( x, topY - 0.7, z ) } );

		// 4. Dense Kelp & Seaweed (Ecklonia radiata) draped across rock crevices and crowns
		for ( let k = 0; k < 14; k ++ ) {

			const kAngle = ( k / 14 ) * Math.PI * 2 + Math.sin( k ) * 0.3;
			const kDist = r * ( 0.45 + ( k % 3 ) * 0.2 );
			const kx = x + Math.cos( kAngle ) * kDist;
			const kz = z + Math.sin( kAngle ) * kDist;
			// Kelp clinging from mid-height up to the crown
			const ky = b.baseDepth + h * ( 0.4 + ( k % 4 ) * 0.16 );
			const kelpMat = ( k % 2 === 0 ) ? KELP_FOREST : ( k % 3 === 0 ) ? KELP_GOLD : SEAWEED_BROWN;

			// Swaying kelp frond blade clusters
			add( roundedBox( 1.1 + ( k % 3 ) * 0.4, 2.2 + ( k % 4 ) * 0.6, 0.35, 0.15, 1 ), {
				...kelpMat,
				matrix: M( kx, ky, kz, 0.25 * Math.sin( k ), kAngle + 0.4, 0.3 * Math.cos( k ) ),
			} );

			// Kelp stipes / stems anchored in rock cracks
			add( cylinder( 0.08, 0.14, 2.4, 6 ), {
				...SEAWEED_BROWN,
				matrix: M( kx, ky - 0.9, kz, 0.15, kAngle, 0.1 ),
			} );

		}

		// Extra thick kelp canopy right across the crown of the haystack
		for ( let c = 0; c < 6; c ++ ) {

			const cAngle = ( c / 6 ) * Math.PI * 2;
			const cx = x + Math.cos( cAngle ) * ( r * 0.35 );
			const cz = z + Math.sin( cAngle ) * ( r * 0.35 );
			add( roundedBox( 1.8, 1.2, 1.8, 0.3, 1 ), {
				...KELP_FOREST,
				matrix: M( cx, topY - 0.3, cz, 0.1, cAngle, 0.15 ),
			} );

		}

	}

	return mergePrepared( parts );

}

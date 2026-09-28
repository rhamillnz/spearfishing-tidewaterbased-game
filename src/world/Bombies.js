import { Mesh, Vector3, Color, BufferGeometry, Float32BufferAttribute } from '../engine/index.js';
import { prepare, mergePrepared, paintVertices, mat4, linearColor } from './boat/GeoKit.js';
import { createPropMaterial, PAT } from '../game/GameMaterials.js';
import { buildRockGeometry, noise3, fbm3 } from './terrain/RockGeometry.js';
import { mulberry32 } from '../util/Noise.js';

// Underwater "Bombies" & Haystack Pinnacles (Iconic Kiwi Reef Formations):
// - Massive craggy rock towers and haystack hills rising from the seabed up near the surface
// - Covered with kelp (Ecklonia radiata) on their crowns and ledges, pink coralline paint and
//   sponges on the walls
// - Prime habitat for iconic NZ fish: Snapper, Tarakihi, Trevally, Kingfish, Blue Cod, Butterfish
// - Provide essential cover for spearfishers to stalk and sneak up on skittish trophy fish
//
// Each pinnacle is ONE closed rock mass: a surface of revolution around a vertical axis (a
// haystack / beehive profile flaring out at the foot, or a broad low dome on the shallow sites)
// cut by near-vertical fracture planes that change a little from one bedding layer to the next
// (stacked jointed blocks with ledges between them), grooved by vertical crevices and roughened
// by noise. The lower half never overhangs, and the foot follows the seabed and continues
// 1 m into it, so nothing can pass under the rock. A few talus boulders lie half buried around
// the foot. Kelp grows in clumps from the upward facing rock (a separate, double-sided mesh that
// sways with the surge).

export const BOMBIE_LOCATIONS = [
	// 1. Pier East Haystack (a short swim out from the mooring, in 7-8 m of water):
	{ name: 'Pier East Haystack', x: 60, z: 84, radius: 4.8, height: 8.5 },
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

const ROCK_CEILING = - 1.0; // no rock above this (m, sea level 0)
const KELP_CEILING = - 0.95; // nor kelp
const SINK = 1.0; // the foot continues this far into the seabed

// rock surface detail in the shader: grain and pits (the geometry carries the facets and crevices)
const ROCK_SURFACE = /* wgsl */`
	{
		let q = in.P;
		let big = perlin3( q * 0.8 ) * 0.5 + perlin3( q * 1.9 + 3.7 ) * 0.3;
		let fine = perlin3( q * 5.3 + 1.3 ) * 0.2 + abs( perlin3( q * 11.0 ) ) * 0.1;
		s.albedo = s.albedo * ( 1.0 + big * 0.28 + fine * 0.35 );
		s.roughness = 0.9;
		s.normal = gpBump( in.P, s.normal, big * 0.05 + fine * 0.012 );
	}
`;

// kelp: thin tissue lets the light through; aux.w = how freely the part sways (0 at the holdfast)
const KELP_VERTEX = /* wgsl */`
	{
		let w = v.aux.w;
		let ph = dot( v.position.xz, vec2f( 0.61, 0.43 ) ) + v.position.y * 0.35;
		let t1 = frame.time; let t0 = frame.time - frame.dt;
		let s1 = vec3f( sin( t1 * 0.8 + ph ), sin( t1 * 1.3 + ph * 2.1 ) * 0.25, sin( t1 * 0.57 + ph * 1.7 + 1.3 ) * 0.7 );
		let s0 = vec3f( sin( t0 * 0.8 + ph ), sin( t0 * 1.3 + ph * 2.1 ) * 0.25, sin( t0 * 0.57 + ph * 1.7 + 1.3 ) * 0.7 );
		v.worldOffset = s1 * w * 0.16;
		v.prevWorldOffset = s0 * w * 0.16;
	}
`;
const KELP_SURFACE = /* wgsl */`
	s.translucency = s.albedo * 0.35;
`;

export class Bombies {

	constructor( { scene, terrain } ) {

		this.scene = scene;
		this.terrain = terrain;
		const heightAt = terrain ? ( x, z ) => terrain.heightAt( x, z ) : () => - 12.0;

		// seabed attachment and crown heights from the actual terrain
		this.locations = BOMBIE_LOCATIONS.map( ( b ) => {

			const seabed = heightAt( b.x, b.z );
			const top = Math.min( - 1.8, seabed + b.height );
			let height = top - seabed;
			// shallow water: a low reef (0.3 - 1 m of rock), never within 1 m of the surface
			if ( height < 1.0 ) height = Math.max( 0.3, Math.min( 1.0, ROCK_CEILING - seabed ) );
			// the lower, the broader
			const flat = Math.max( 0, Math.min( 1, ( 5 - height ) / 4 ) );
			return {
				...b,
				radius: b.radius * ( 1 + 0.5 * flat ),
				baseDepth: seabed,
				topDepth: seabed + height,
				height,
			};

		} );

		const { rock, kelp } = buildBombiesGeometry( this.locations, heightAt );

		// weathered reef rock, encrusted, pink coralline paint, sponges
		this.material = createPropMaterial( 'bombieRock', { surface: ROCK_SURFACE } );
		this.mesh = new Mesh( rock, this.material );
		this.mesh.name = 'Bombies';
		this.mesh.frustumCulled = false;
		this.mesh.castShadow = true;
		this.mesh.receiveShadow = true;
		scene.add( this.mesh );

		// Ecklonia kelp: thin fronds, both faces, swaying
		this.kelpMaterial = createPropMaterial( 'bombieKelp', { vertex: KELP_VERTEX, surface: KELP_SURFACE } );
		this.kelpMaterial.side = 'double';
		this.kelpMesh = new Mesh( kelp, this.kelpMaterial );
		this.kelpMesh.name = 'BombieKelp';
		this.kelpMesh.frustumCulled = false;
		this.kelpMesh.castShadow = true;
		this.kelpMesh.receiveShadow = true;
		scene.add( this.kelpMesh );

	}

	// Returns bombie info if player is within cover range (< 3.5 m from the rock)
	checkCover( playerPos ) {

		for ( const b of this.locations ) {

			// Horizontal distance to pinnacle center
			const dx = playerPos.x - b.x;
			const dz = playerPos.z - b.z;
			const hDist = Math.hypot( dx, dz );

			// Check if within pinnacle depth range
			const inDepthBand = playerPos.y <= b.topDepth + 1.8 && playerPos.y >= b.baseDepth - 1.0;

			// Within 3.5 m of the rock: the flared foot reaches footRadius, the walls about radius
			const reach = b.footRadius ? b.radius + ( b.footRadius - b.radius ) * Math.max( 0, Math.min( 1, 1 - ( playerPos.y - b.baseDepth ) / 3 ) ) : b.radius;
			if ( inDepthBand && hDist <= ( reach + 3.5 ) ) {

				return {
					name: b.name,
					distance: Math.max( 0, hDist - reach ),
					bombie: b,
				};

			}

		}

		return null;

	}

}

// ------------------------------------------------------------------ Bombies 3D Geometry

const smoothstep = ( a, b, x ) => {

	const t = Math.max( 0, Math.min( 1, ( x - a ) / ( b - a ) ) );
	return t * t * ( 3 - 2 * t );

};

const lerp = ( a, b, t ) => a + ( b - a ) * t;

// rock colours (sRGB)
const C = {
	grey: new Color( 0x827d72 ),
	brown: new Color( 0x6b6152 ),
	dark: new Color( 0x3a3833 ),
	turf: new Color( 0x55552f ), // short algal turf on the tops
	silt: new Color( 0x857a64 ), // sediment settled on flat ledges
	coralline: new Color( 0x9c7479 ), // encrusting coralline algae (pink paint)
	sponge: new Color( 0xb86a2c ),
	spongeY: new Color( 0xb09a3a ),
};

// Colour of the rock at world position p with normal n, cavity ao (0..1, 1 = open) and height
// above the seabed; seed varies the patches per pinnacle.
function rockColor( p, n, ao, above, seed ) {

	const c = new Color();
	c.copy( C.grey ).lerp( C.brown, 0.5 + 0.5 * fbm3( p.x * 0.12, p.y * 0.2, p.z * 0.12, 3, seed ) );
	// streaky bedding tones
	c.lerp( C.dark, 0.25 * Math.max( 0, noise3( p.x * 0.05, p.y * 1.1, p.z * 0.05, seed + 1 ) ) );
	const up = n.y;
	// coralline paint on the walls and ledges below the canopy
	const cor = smoothstep( 0.15, 0.35, fbm3( p.x * 0.35, p.y * 0.35, p.z * 0.35, 3, seed + 2 ) ) * smoothstep( - 0.3, 0.2, up );
	c.lerp( C.coralline, cor * 0.45 );
	// turf and silt on the flats
	c.lerp( C.turf, smoothstep( 0.55, 0.85, up ) * 0.55 );
	c.lerp( C.silt, smoothstep( 0.8, 0.97, up ) * smoothstep( 0.1, 0.45, fbm3( p.x * 0.6, 0, p.z * 0.6, 2, seed + 3 ) ) * 0.6 );
	// sponges: small bright patches on the walls
	const sp = noise3( p.x * 1.4, p.y * 1.4, p.z * 1.4, seed + 4 );
	if ( sp > 0.6 && up < 0.5 ) c.lerp( sp > 0.66 ? C.sponge : C.spongeY, smoothstep( 0.6, 0.68, sp ) * 0.7 );
	// occlusion: cavities, overhangs and the seabed
	let occ = ao;
	occ *= lerp( 0.62, 1, smoothstep( - 0.6, 0.1, up ) );
	occ *= lerp( 0.55, 1, smoothstep( 0, 1.8, above ) );
	return c.multiplyScalar( occ );

}

function buildBombiesGeometry( locations, heightAt ) {

	const rockParts = [];
	const kelp = new KelpBuilder();
	for ( let bi = 0; bi < locations.length; bi ++ ) {

		const site = locations[ bi ];
		const rng = mulberry32( bi * 7919 + 1 );
		const seed = 1000 + bi * 131;
		const core = buildCore( site, rng, seed, heightAt );
		rockParts.push( prepare( core.geo, { rough: 0.92, metal: 0.02, pattern: PAT.plain } ) );
		addBoulders( site, core, rng, seed, heightAt, rockParts );
		addKelp( site, core, rng, heightAt, kelp );

	}

	return { rock: mergePrepared( rockParts ), kelp: kelp.build() };

}

// ---- the pinnacle core: one closed, displaced surface of revolution
function buildCore( site, rng, seed, heightAt ) {

	const H = site.height, r = site.radius;
	const x0 = site.x, z0 = site.z, y0 = site.baseDepth;

	// profile: radius( t ) / r for t = 0 (foot) .. 1 (crown); tall sites get a haystack /
	// beehive, low ones a broad flat-topped dome
	const tall = Math.max( 0, Math.min( 1, ( H / r - 0.3 ) / 1.4 ) );
	const pExp = lerp( 3.4, 1.7, tall ) * ( 0.9 + 0.2 * rng() );
	const qExp = lerp( 2.4, 1.3, tall );
	const flare = 0.22 + 0.16 * rng();
	const prof = ( t ) => Math.pow( Math.max( 0, 1 - Math.pow( Math.min( 1, t ), pExp ) ), 1 / qExp ) + flare * Math.pow( 1 - Math.min( 1, t ), 5 );
	site.footRadius = r * ( 1 + flare );

	// rings evenly spaced along the profile curve (tall walls and flat tops both get detail)
	const N = 400, arc = [ 0 ];
	for ( let k = 1; k <= N; k ++ ) arc.push( arc[ k - 1 ] + Math.hypot( ( prof( k / N ) - prof( ( k - 1 ) / N ) ) * r, H / N ) );
	const L = arc[ N ];
	const NC = Math.round( Math.max( 44, Math.min( 60, 2 * Math.PI * r * ( 1 + flare ) / 0.6 ) ) );
	const NR = Math.round( Math.max( 12, Math.min( 44, L / 0.45 ) ) );
	const ringT = [];
	for ( let i = 0, k = 0; i < NR; i ++ ) {

		// the last ring stops short of the axis: the apex vertex closes the top
		const s = L * i / NR * 0.985;
		while ( k < N - 1 && arc[ k + 1 ] < s ) k ++;
		ringT.push( ( k + ( s - arc[ k ] ) / ( arc[ k + 1 ] - arc[ k ] ) ) / N );

	}

	// bedding layers ~1.5 m thick: the walls step in at each ledge, and each layer's blocks are
	// cut by its own variant of the pinnacle's fracture planes
	const nLayers = H > 2.5 ? Math.max( 2, Math.round( H / 1.5 ) ) : 1;
	// uneven layer thickness: boundaries jittered along t
	const bounds = [ 0 ];
	for ( let l = 1; l < nLayers; l ++ ) bounds.push( ( l + ( rng() - 0.5 ) * 0.5 ) / nLayers );
	bounds.push( 1 );
	const nPlanes = 9 + Math.floor( rng() * 6 );
	const basePlanes = [];
	for ( let k = 0; k < nPlanes; k ++ ) basePlanes.push( { a: ( k + rng() * 0.8 ) / nPlanes * Math.PI * 2, d: 0.74 + rng() * 0.18, tilt: ( rng() - 0.5 ) * 0.4 } );
	const layers = [];
	for ( let l = 0; l <= nLayers; l ++ ) layers.push( basePlanes.map( ( p ) => ( { a: p.a + ( rng() - 0.5 ) * 0.6, d: p.d + ( rng() - 0.5 ) * 0.12, tilt: p.tilt + ( rng() - 0.5 ) * 0.3 } ) ) );
	const facet = ( planes, th, t ) => {

		let rp = 1.6;
		for ( const p of planes ) {

			const c = Math.cos( th - p.a );
			if ( c > 0.05 ) rp = Math.min( rp, ( p.d + p.tilt * ( t - 0.5 ) ) / c );

		}

		// smooth min with the circle (weathered edges)
		const k = 0.04;
		const h = Math.max( k - Math.abs( 1 - rp ), 0 ) / k;
		return Math.min( 1, rp ) - h * h * k * 0.25;

	};

	// vertical crevices (some run the full height, some only part of it)
	const cracks = [];
	const nCracks = 5 + Math.floor( rng() * 5 );
	for ( let k = 0; k < nCracks; k ++ ) {

		const t0 = rng() < 0.5 ? - 0.1 : rng() * 0.5;
		cracks.push( { a: rng() * Math.PI * 2, ph: rng() * 6, t0, t1: t0 + 0.35 + rng() * 0.7, w: 0.18 + rng() * 0.2, depth: Math.min( 0.9, 0.16 * r ) * ( 0.5 + rng() * 0.5 ) } );

	}

	// the crown and flat tops are cut by gently tilted fracture planes into facets
	const topPlanes = [];
	const Hs = Math.min( H, 3 ) + 0.5;
	for ( let k = 0; k < 6 + Math.floor( rng() * 4 ); k ++ ) {

		const a = rng() * Math.PI * 2;
		topPlanes.push( { cx: Math.cos( a ), cz: Math.sin( a ), s: 0.12 + rng() * 0.35, o: ( 0.02 + rng() * 0.15 ) * Hs } );

	}

	const nv = NR * NC + NC + 1; // profile rings, the buried skirt ring, the apex
	const pos = new Float32Array( nv * 3 );
	const rest = [];
	const P = new Vector3();
	const idxOf = ( i, j ) => ( i + 1 ) * NC + j; // i = -1: skirt ring
	for ( let i = 0; i < NR; i ++ ) {

		const t = ringT[ i ];
		const dt = 1 / N;
		// profile normal (outward, up)
		const dR = ( prof( t + dt ) - prof( Math.max( 0, t - dt ) ) ) * r;
		const dY = ( t + dt - Math.max( 0, t - dt ) ) * H;
		const nl = Math.hypot( dR, dY );
		const nR = dY / nl, nY = - dR / nl;
		for ( let j = 0; j < NC; j ++ ) {

			const th = ( j / NC ) * Math.PI * 2;
			const cx = Math.cos( th ), cz = Math.sin( th );
			// layer blend: near-vertical walls within a layer, stepping in at the ledge on top of it;
			// the bedding dips a little around the pinnacle and the ledges come and go
			const tb = t + 0.1 / nLayers * noise3( cx * 1.1, cz * 1.1, seed * 0.01, seed );
			let li = 0;
			while ( li < nLayers - 1 && tb > bounds[ li + 1 ] ) li ++;
			const f = ( tb - bounds[ li ] ) / ( bounds[ li + 1 ] - bounds[ li ] );
			const step = nLayers > 1 ? smoothstep( 0.8, 1.0, f ) : 0;
			const wall = li < nLayers - 1 ? 0.75 * smoothstep( - 0.65, - 0.05, noise3( cx * 1.4, cz * 1.4, li * 2.7, seed + 5 ) ) : 0;
			const tEff = lerp( t, lerp( bounds[ li ], bounds[ li + 1 ], step ), wall );
			let R = r * prof( tEff ) * lerp( facet( layers[ li ], th, t ), facet( layers[ li + 1 ], th, t ), step );
			for ( const c of cracks ) {

				let da = Math.abs( th - c.a - 0.25 * Math.sin( t * 4 + c.ph ) ) % ( Math.PI * 2 );
				if ( da > Math.PI ) da = Math.PI * 2 - da;
				const across = da * R / c.w;
				if ( across < 3 ) R -= c.depth * Math.exp( - across * across ) * smoothstep( c.t0, c.t0 + 0.08, t ) * ( 1 - smoothstep( c.t1 - 0.08, c.t1, t ) );

			}

			R = Math.max( R, 0.05 * r );
			// lumps, then sharp-edged noise ridges, along the profile normal
			const lx = cx * R, lz = cz * R;
			let ly = t * H;
			const up = smoothstep( 0.3, 0.75, nY );
			if ( up > 0 ) {

				let yc = ly;
				for ( const q of topPlanes ) yc = Math.min( yc, H - q.o - q.s * ( lx * q.cx + lz * q.cz ) );
				ly = lerp( ly, Math.max( yc, ly - 0.3 * Hs ), up );

			}

			let disp = fbm3( lx * 0.25 + seed, ly * 0.25, lz * 0.25, 3, seed ) * Math.min( 0.35, 0.04 * r );
			disp += fbm3( lx * 1.1, ly * 1.1, lz * 1.1 + seed, 3, seed + 9 ) * 0.1;
			disp -= Math.abs( noise3( lx * 0.6, ly * 0.45 + seed, lz * 0.6, seed + 3 ) ) * 0.4;
			rest.push( { R: R + disp * nR, y: ly + disp * nY, th } );

		}

	}

	// the lower half never overhangs: going up a column, the radius never grows
	for ( let i = 1; i < NR && ringT[ i ] < 0.55; i ++ ) {

		for ( let j = 0; j < NC; j ++ ) rest[ i * NC + j ].R = Math.min( rest[ i * NC + j ].R, rest[ ( i - 1 ) * NC + j ].R );

	}

	// to world space; the foot follows the seabed down a slope (uphill it is simply buried)
	const crown = Math.min( ROCK_CEILING, y0 + H + 0.25 );
	let sunk = Infinity;
	for ( let i = 0; i < NR; i ++ ) {

		const t = ringT[ i ];
		for ( let j = 0; j < NC; j ++ ) {

			const v = rest[ i * NC + j ];
			const x = x0 + Math.cos( v.th ) * v.R, z = z0 + Math.sin( v.th ) * v.R;
			const g = heightAt( x, z );
			let y = y0 + v.y + Math.min( 0, g - y0 ) * ( 1 - smoothstep( 0, 0.3, t ) );
			if ( i === 0 ) y = Math.min( y, g ) - 0.15;
			y = Math.min( y, crown );
			const k = idxOf( i, j );
			pos[ k * 3 ] = x; pos[ k * 3 + 1 ] = y; pos[ k * 3 + 2 ] = z;
			if ( i === 0 ) {

				// skirt: straight down into the seabed
				const s = idxOf( - 1, j );
				pos[ s * 3 ] = x; pos[ s * 3 + 1 ] = Math.min( g - SINK, y - 0.6 ); pos[ s * 3 + 2 ] = z;
				sunk = Math.min( sunk, g - pos[ s * 3 + 1 ] );

			}

		}

	}

	site.baseSunk = sunk;
	const apex = nv - 1;
	P.set( 0, 0, 0 );
	for ( let j = 0; j < NC; j ++ ) P.add( new Vector3( pos[ idxOf( NR - 1, j ) * 3 ], pos[ idxOf( NR - 1, j ) * 3 + 1 ], pos[ idxOf( NR - 1, j ) * 3 + 2 ] ) );
	P.divideScalar( NC );
	pos[ apex * 3 ] = P.x; pos[ apex * 3 + 1 ] = Math.min( crown, P.y + 0.15 ); pos[ apex * 3 + 2 ] = P.z;

	// triangles: rows -1 .. NR-1 around, then the apex fan (outward winding: j runs anticlockwise
	// seen from below, so a, next ring, next column)
	const idx = [];
	for ( let i = - 1; i < NR - 1; i ++ ) {

		for ( let j = 0; j < NC; j ++ ) {

			const j1 = ( j + 1 ) % NC;
			const a = idxOf( i, j ), b = idxOf( i + 1, j ), c = idxOf( i + 1, j1 ), d = idxOf( i, j1 );
			idx.push( a, b, d, b, c, d );

		}

	}

	for ( let j = 0; j < NC; j ++ ) idx.push( idxOf( NR - 1, j ), apex, idxOf( NR - 1, ( j + 1 ) % NC ) );

	const geo = new BufferGeometry();
	geo.setAttribute( 'position', new Float32BufferAttribute( pos, 3 ) );
	geo.setIndex( idx );
	geo.computeVertexNormals();
	// outward check on the widest ring (winding depends on the handedness of th)
	const nrm = geo.attributes.normal;
	const k0 = idxOf( 0, 0 );
	if ( nrm.getX( k0 ) * ( pos[ k0 * 3 ] - x0 ) + nrm.getZ( k0 ) * ( pos[ k0 * 3 + 2 ] - z0 ) < 0 ) {

		for ( let f = 0; f < idx.length; f += 3 ) {

			const tmp = idx[ f + 1 ]; idx[ f + 1 ] = idx[ f + 2 ]; idx[ f + 2 ] = tmp;

		}

		geo.setIndex( idx );
		geo.computeVertexNormals();

	}

	// cavity occlusion: vertices sunk below their grid neighbours (along the normal) are darker
	const ao = new Float32Array( nv ).fill( 1 );
	const at = ( k ) => P.set( pos[ k * 3 ], pos[ k * 3 + 1 ], pos[ k * 3 + 2 ] );
	const avg = new Vector3(), n = new Vector3();
	for ( let i = 0; i < NR; i ++ ) {

		for ( let j = 0; j < NC; j ++ ) {

			const k = idxOf( i, j );
			avg.set( 0, 0, 0 );
			avg.add( at( idxOf( Math.max( - 1, i - 1 ), j ) ) );
			avg.add( at( i + 1 < NR ? idxOf( i + 1, j ) : apex ) );
			avg.add( at( idxOf( i, ( j + 1 ) % NC ) ) );
			avg.add( at( idxOf( i, ( j + NC - 1 ) % NC ) ) );
			avg.multiplyScalar( 0.25 ).sub( at( k ) );
			n.fromBufferAttribute( nrm, k );
			ao[ k ] = Math.max( 0.35, Math.min( 1, 1 - avg.dot( n ) * 3.5 ) );

		}

	}

	const nn = new Vector3();
	paintVertices( geo, ( p, k ) => {

		nn.fromBufferAttribute( nrm, k );
		return rockColor( p, nn, ao[ k ], p.y - heightAt( p.x, p.z ), seed );

	} );

	return { geo, NR, NC, ringT, idxOf, pos, nrm };

}

// ---- talus: boulders fallen from the walls, leaning on the foot and at least 40% buried in the
// seabed; outcrops: blocks weathering out of the crown and ledges, half sunk into the core
function addBoulders( site, core, rng, seed, heightAt, parts ) {

	const nrmV = new Vector3();
	let minBuried = 1;
	const place = ( s, x, z, base, k ) => {

		// base( geo bounds ) -> { y, buried }: the boulder's offset and the fraction below its bed
		const geo = buildRockGeometry( rng() < 0.6 ? 0 : 1, Math.floor( rng() * 2147483647 ), 2 );
		geo.applyMatrix4( mat4( 0, 0, 0, ( rng() - 0.5 ) * 0.4, rng() * Math.PI * 2, ( rng() - 0.5 ) * 0.4, s, s * ( 0.6 + rng() * 0.25 ), s * ( 0.8 + rng() * 0.3 ) ) );
		geo.computeBoundingBox();
		const bb = geo.boundingBox;
		const { y, buried } = base( bb );
		if ( y + bb.max.y > ROCK_CEILING ) return;
		minBuried = Math.min( minBuried, buried );
		geo.translate( x, y, z );
		geo.computeVertexNormals();
		const ao = geo.attributes.ao.array;
		const nrm = geo.attributes.normal;
		paintVertices( geo, ( p, i ) => rockColor( p, nrmV.fromBufferAttribute( nrm, i ), ao[ i ], p.y - heightAt( p.x, p.z ), seed + k ) );
		parts.push( prepare( geo, { rough: 0.92, metal: 0.02, pattern: PAT.plain } ) );

	};

	const nTalus = site.height > 2.5 ? 3 + Math.floor( rng() * 3 ) : 2;
	for ( let k = 0; k < nTalus; k ++ ) {

		// against the foot: out from a contact ring vertex
		const c = core.idxOf( 0, Math.floor( rng() * core.NC ) );
		const fx = core.pos[ c * 3 ] - site.x, fz = core.pos[ c * 3 + 2 ] - site.z;
		const s = Math.min( 1.8, 0.3 + site.height * 0.35, site.radius * ( 0.12 + rng() * 0.12 ) );
		const out = 0.9 + rng() * 0.2 + s * 0.3 / Math.hypot( fx, fz );
		const x = site.x + fx * out, z = site.z + fz * out;
		place( s, x, z, ( bb ) => {

			// lowest seabed under the boulder's footprint
			const h = bb.max.y - bb.min.y;
			const rr = Math.max( bb.max.x - bb.min.x, bb.max.z - bb.min.z ) * 0.5;
			let g = heightAt( x, z );
			for ( let a = 0; a < 6; a ++ ) g = Math.min( g, heightAt( x + Math.cos( a ) * rr, z + Math.sin( a ) * rr ) );
			const y = Math.min( g - 0.42 * h - bb.min.y, ROCK_CEILING - bb.max.y );
			return { y, buried: ( g - ( y + bb.min.y ) ) / h };

		}, k );

	}

	// outcrops on the flatter upward faces of the core
	const nOut = 2 + Math.floor( rng() * 3 );
	for ( let k = 0, tries = 0; k < nOut && tries < 60; tries ++ ) {

		const i = 1 + Math.floor( rng() * ( core.NR - 1 ) );
		const v = core.idxOf( i, Math.floor( rng() * core.NC ) );
		if ( core.nrm.getY( v ) < 0.8 ) continue;
		const x = core.pos[ v * 3 ], vy = core.pos[ v * 3 + 1 ], z = core.pos[ v * 3 + 2 ];
		if ( vy < heightAt( x, z ) + 0.3 ) continue;
		const s = Math.min( 1.1, 0.25 + site.height * 0.1, site.radius * 0.12 ) * ( 0.6 + rng() * 0.5 );
		place( s, x, z, ( bb ) => {

			const h = bb.max.y - bb.min.y;
			return { y: vy - 0.5 * h - bb.min.y, buried: 0.5 };

		}, 10 + k );
		k ++;

	}

	site.boulderBuried = minBuried;

}

// ---- Ecklonia radiata: clumps on the upward facing rock, thickest on the shallow crowns
function addKelp( site, core, rng, heightAt, kelp ) {

	// candidates: grid vertices of the core facing up, clear of the seabed and the surface;
	// fewer plants in deep water, and on a tall pinnacle mostly on the crown and upper ledges
	const cand = [];
	const p = new Vector3(), n = new Vector3();
	const low = site.height < 2.5;
	for ( let i = 1; i < core.NR; i ++ ) {

		for ( let j = 0; j < core.NC; j ++ ) {

			const k = core.idxOf( i, j );
			p.set( core.pos[ k * 3 ], core.pos[ k * 3 + 1 ], core.pos[ k * 3 + 2 ] );
			n.fromBufferAttribute( core.nrm, k );
			if ( n.y < 0.35 || p.y > KELP_CEILING - 0.45 ) continue;
			if ( p.y < heightAt( p.x, p.z ) + 0.2 ) continue; // buried
			const w = n.y * ( 1 - 0.85 * smoothstep( 5, 14, - p.y ) ) * ( low ? 1 : lerp( 0.2, 1, smoothstep( 0.3, 0.75, core.ringT[ i ] ) ) );
			cand.push( { p: p.clone(), n: n.clone(), w } );

		}

	}

	if ( cand.length === 0 ) return;
	// the current leans the fronds one way at each site
	const cur = rng() * Math.PI * 2;
	const nClumps = Math.min( 26, 6 + Math.round( ( low ? 1.8 : 1.0 ) * site.radius + site.height * 0.6 ) );
	const centres = [];
	for ( let tries = 0; tries < 400 && centres.length < nClumps; tries ++ ) {

		const c = cand[ Math.floor( rng() * cand.length ) ];
		if ( rng() < c.w && centres.every( ( o ) => o.p.distanceTo( c.p ) > 1.3 ) ) centres.push( c );

	}

	const jit = new Vector3();
	for ( const c of centres ) {

		const near = cand.filter( ( o ) => o.p.distanceTo( c.p ) < 1.1 );
		const nPlants = Math.round( ( 3 + rng() * 6 ) * Math.max( 0.4, c.w ) );
		for ( let k = 0; k < nPlants; k ++ ) {

			const a = k === 0 ? c : near[ Math.floor( rng() * near.length ) ];
			// a little jitter across the facet, the holdfast pressed into the rock
			jit.set( rng() - 0.5, 0, rng() - 0.5 ).multiplyScalar( 0.35 );
			jit.addScaledVector( a.n, - jit.dot( a.n ) );
			const anchor = a.p.clone().add( jit ).addScaledVector( a.n, - 0.06 );
			kelp.plant( anchor, a.n, cur + ( rng() - 0.5 ) * 0.9, rng );

		}

	}

}

// Kelp meshes: stipe tubes and ribbon laminae written straight into flat arrays (hundreds of
// small parts; the layout matches prepare(): position, normal, uv, color, aux)
const KELP_STIPE = 0x3a2e16;
const KELP_FROND = 0x574216;
const KELP_BLADE = 0x503c14;
const KELP_TIP = 0x6e5626;

class KelpBuilder {

	constructor() {

		this.pos = []; this.nor = []; this.col = []; this.aux = []; this.idx = [];

	}

	get count() {

		return this.pos.length / 3;

	}

	vertex( p, n, c, w, rough ) {

		this.pos.push( p.x, p.y, p.z );
		this.nor.push( n.x, n.y, n.z );
		this.col.push( c.r, c.g, c.b );
		this.aux.push( rough, 0, PAT.plain, w );
		return this.count - 1;

	}

	// ribbon along the centre line pts with half widths hw[] across side[] (unit vectors)
	ribbon( pts, side, hw, colors, weights, rough ) {

		const first = this.count;
		const n = new Vector3(), T = new Vector3(), q = new Vector3();
		for ( let k = 0; k < pts.length; k ++ ) {

			T.subVectors( pts[ Math.min( pts.length - 1, k + 1 ) ], pts[ Math.max( 0, k - 1 ) ] ).normalize();
			n.crossVectors( side[ k ], T ).normalize();
			this.vertex( q.copy( pts[ k ] ).addScaledVector( side[ k ], - hw[ k ] ), n, colors[ k ], weights[ k ], rough );
			this.vertex( q.copy( pts[ k ] ).addScaledVector( side[ k ], hw[ k ] ), n, colors[ k ], weights[ k ], rough );

		}

		for ( let k = 0; k < pts.length - 1; k ++ ) {

			const a = first + k * 2;
			this.idx.push( a, a + 1, a + 3, a, a + 3, a + 2 );

		}

	}

	// tapered tube along pts, radii rad[]
	tube( pts, rad, sides, color, weights, rough ) {

		const first = this.count;
		const T = new Vector3(), U = new Vector3(), V = new Vector3(), n = new Vector3(), q = new Vector3();
		for ( let k = 0; k < pts.length; k ++ ) {

			T.subVectors( pts[ Math.min( pts.length - 1, k + 1 ) ], pts[ Math.max( 0, k - 1 ) ] ).normalize();
			U.set( 1, 0, 0 ).cross( T ).normalize();
			V.crossVectors( T, U );
			for ( let s = 0; s < sides; s ++ ) {

				const a = s / sides * Math.PI * 2;
				n.copy( U ).multiplyScalar( Math.cos( a ) ).addScaledVector( V, Math.sin( a ) );
				this.vertex( q.copy( pts[ k ] ).addScaledVector( n, rad[ k ] ), n, color, weights[ k ], rough );

			}

		}

		for ( let k = 0; k < pts.length - 1; k ++ ) {

			for ( let s = 0; s < sides; s ++ ) {

				const a = first + k * sides + s, b = first + k * sides + ( s + 1 ) % sides;
				this.idx.push( a, b, b + sides, a, b + sides, a + sides );

			}

		}

	}

	// One plant from the holdfast at `anchor` on rock with normal `rn`: a stiff stipe, then the
	// flattened primary lamina bending over with the current (heading `cur`), lateral blades
	// along both its edges. Scaled down to stay under the surface.
	plant( anchor, rn, cur, rng ) {

		const first = this.count, fi = this.idx.length;
		const up = new Vector3( 0, 1, 0 );
		const flow = new Vector3( Math.cos( cur ), 0, Math.sin( cur ) );
		const tone = 0.85 + rng() * 0.3;
		const tint = ( hex, f = 1 ) => linearColor( hex ).clone().multiplyScalar( tone * f );

		// stipe: 0.3 - 0.8 m, slightly curved, leaning off the rock
		const stipeL = 0.3 + rng() * 0.4;
		const d0 = up.clone().addScaledVector( rn, 0.3 ).addScaledVector( flow, 0.15 + rng() * 0.2 );
		d0.x += ( rng() - 0.5 ) * 0.3; d0.z += ( rng() - 0.5 ) * 0.3;
		d0.normalize();
		const sp = [], sr = [], sw = [];
		for ( let k = 0; k <= 2; k ++ ) {

			const t = k / 2;
			sp.push( anchor.clone().addScaledVector( d0, stipeL * t ).addScaledVector( flow, 0.05 * t * t ) );
			sr.push( lerp( 0.024, 0.014, t ) );
			sw.push( 0.12 * t * t );

		}

		this.tube( sp, sr, 4, tint( KELP_STIPE ), sw, 0.7 );

		// primary lamina: from the stipe top, arching over downstream and drooping at the tip
		const frondL = 0.6 + rng() * 0.5;
		const segs = 5;
		const top = sp[ 2 ];
		const e0 = Math.asin( Math.max( - 1, Math.min( 1, d0.y ) ) ); // elevation of the stipe
		const e1 = - 0.15 - rng() * 0.5;
		const twist = ( rng() - 0.5 ) * 1.2;
		const fp = [ top.clone() ], fd = [], fs = [], fh = [], fc = [], fw = [];
		const dir = new Vector3(), side = new Vector3();
		const heading = flow.clone().lerp( new Vector3( d0.x, 0, d0.z ).normalize(), 0.3 ).normalize();
		for ( let k = 0; k <= segs; k ++ ) {

			const u = k / segs;
			const e = lerp( e0, e1, smoothstep( 0, 1, u * 1.15 ) );
			dir.copy( heading ).multiplyScalar( Math.cos( e ) ).addScaledVector( up, Math.sin( e ) ).normalize();
			if ( k > 0 ) fp.push( fp[ k - 1 ].clone().addScaledVector( dir, frondL / segs ) );
			side.crossVectors( dir, up ).normalize();
			// the flat lamina twists a little along its length
			side.applyAxisAngle( dir, twist * u );
			fd.push( dir.clone() );
			fs.push( side.clone() );
			fh.push( 0.5 * ( 0.02 + 0.11 * smoothstep( 0, 0.2, u ) * ( 1 - 0.55 * u ) ) );
			fc.push( tint( KELP_FROND ).lerp( tint( KELP_TIP ), u * u ) );
			fw.push( 0.12 + 0.88 * u );

		}

		this.ribbon( fp, fs, fh, fc, fw, 0.55 );

		// lateral blades: alternating along both edges, longest mid-frond, angled forward,
		// curling back toward the frond and drooping at the tips
		const nBlades = 7 + Math.floor( rng() * 6 );
		for ( let b = 0; b < nBlades; b ++ ) {

			const u = 0.15 + 0.75 * ( b + rng() * 0.6 ) / nBlades;
			const k = Math.min( segs - 1, Math.floor( u * segs ) ), f = u * segs - k;
			const base = fp[ k ].clone().lerp( fp[ k + 1 ], f );
			const fdir = fd[ k ].clone().lerp( fd[ k + 1 ], f ).normalize();
			const fside = fs[ k ].clone().lerp( fs[ k + 1 ], f ).normalize();
			const fnorm = new Vector3().crossVectors( fside, fdir ).normalize();
			const lr = b % 2 === 0 ? 1 : - 1;
			const hwF = fh[ k ] + ( fh[ k + 1 ] - fh[ k ] ) * f;
			base.addScaledVector( fside, lr * hwF * 0.7 );
			const bl = ( 0.3 + rng() * 0.25 ) * ( 1 - 0.7 * Math.abs( u - 0.5 ) ) * ( frondL / 0.85 );
			const ang = 0.35 + rng() * 0.4;
			const lift = ( rng() - 0.3 ) * 0.5;
			const w0 = fw[ k ] + ( fw[ k + 1 ] - fw[ k ] ) * f;
			const bp = [ base ], bs = [], bh = [], bc = [], bw = [];
			const bdir = new Vector3(), bside = new Vector3();
			const bsegs = 2;
			const roll = ( rng() - 0.5 ) * 1.6; // blades twist out of the frond's plane
			const bladeC = tint( KELP_BLADE, 0.9 + rng() * 0.2 );
			for ( let s = 0; s <= bsegs; s ++ ) {

				const t = s / bsegs;
				const a = ang * ( 1 - 0.45 * t );
				bdir.copy( fdir ).multiplyScalar( Math.cos( a ) ).addScaledVector( fside, lr * Math.sin( a ) ).addScaledVector( fnorm, lift * ( 1 - t ) - 0.35 * t * t ).normalize();
				if ( s > 0 ) bp.push( bp[ s - 1 ].clone().addScaledVector( bdir, bl / bsegs ) );
				bside.crossVectors( bdir, fnorm ).normalize().applyAxisAngle( bdir, roll * t );
				bs.push( bside.clone() );
				// narrow stalk, widest a third along, pointed tip
				bh.push( 0.5 * Math.min( 0.09, bl * 0.34 ) * ( t < 0.3 ? lerp( 0.3, 1, t / 0.3 ) : lerp( 1, 0.1, ( t - 0.3 ) / 0.7 ) ) );
				bc.push( bladeC.clone().lerp( tint( KELP_TIP ), t * 0.6 ) );
				bw.push( w0 + 0.3 * t );

			}

			this.ribbon( bp, bs, bh, bc, bw, 0.55 );

		}

		// keep the whole plant under the surface
		let maxY = - Infinity;
		for ( let v = first; v < this.count; v ++ ) maxY = Math.max( maxY, this.pos[ v * 3 + 1 ] );
		if ( maxY > KELP_CEILING ) {

			const s = ( KELP_CEILING - anchor.y ) / ( maxY - anchor.y );
			if ( s < 0.35 ) {

				// no room: drop it
				this.pos.length = first * 3; this.nor.length = first * 3; this.col.length = first * 3; this.aux.length = first * 4; this.idx.length = fi;
				return;

			}

			for ( let v = first; v < this.count; v ++ ) {

				for ( let c = 0; c < 3; c ++ ) this.pos[ v * 3 + c ] = anchor.getComponent( c ) + ( this.pos[ v * 3 + c ] - anchor.getComponent( c ) ) * s;

			}

		}

	}

	build() {

		const g = new BufferGeometry();
		g.setAttribute( 'position', new Float32BufferAttribute( new Float32Array( this.pos ), 3 ) );
		g.setAttribute( 'normal', new Float32BufferAttribute( new Float32Array( this.nor ), 3 ) );
		g.setAttribute( 'uv', new Float32BufferAttribute( new Float32Array( this.count * 2 ), 2 ) );
		g.setAttribute( 'color', new Float32BufferAttribute( new Float32Array( this.col ), 3 ) );
		g.setAttribute( 'aux', new Float32BufferAttribute( new Float32Array( this.aux ), 4 ) );
		g.setIndex( this.idx );
		g.computeBoundingBox();
		g.computeBoundingSphere();
		return g;

	}

}

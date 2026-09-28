import { Vector3, Vector4, MathUtils, Color, Float32BufferAttribute } from '../../engine/index.js';
import { ShaderModule } from '../../engine/gpu/Shader.js';
import { prepare, mergePrepared, sphere, rod, loft, paintVertices, auxVertices, mat4 } from '../boat/GeoKit.js';
import { createPropMaterial } from '../../game/GameMaterials.js';

// Procedural rays (see Rays.js): the short-tail stingray (Bathytoshia brevicaudata) and the eagle
// ray (Myliobatis tenuicaudatus). Built at a reference size (stingray disc 1.4 m across, eagle ray
// 1.0 m wing span) and scaled per animal by the mesh matrix. Model space as the shark: snout toward
// -Z, back toward +Y, x across the disc.
//
// Geometry: the disc is one lofted lens (rings across the disc, stacked from snout to tail base) with
// a raised body core; the tail is a separate tapering tube. Per-vertex colour does the
// countershading (dark back, pale belly); aux.w = 1 on the back (the shader's markings); uv.x = the
// animal's slot in the wave uniform array.
//
// Animation: the vertex shader bends the disc with the animal's wave state (one vec4 per animal, this
// frame and the last for motion vectors): the stingray's travelling wave along the disc margin, snout
// to tail, and the eagle ray's slow wing beat; the tail whips gently from side to side. Everything is a
// function of the rest position, so the normal comes from finite differences of the same function.

export const RAY_KIND = { stingray: 0, eagle: 1 };
export const MAX_RAYS = 16; // wave uniform slots

// ---- planforms: [ z, half span ] from snout to tail base

const STING_DISC = [
	[ - 0.6, 0.001 ], [ - 0.575, 0.06 ], [ - 0.52, 0.16 ], [ - 0.44, 0.3 ], [ - 0.34, 0.44 ], [ - 0.22, 0.57 ],
	[ - 0.08, 0.67 ], [ 0.04, 0.7 ], [ 0.15, 0.67 ], [ 0.26, 0.58 ], [ 0.36, 0.44 ], [ 0.44, 0.29 ],
	[ 0.5, 0.18 ], [ 0.55, 0.12 ], [ 0.6, 0.075 ], [ 0.64, 0.05 ],
];
const STING_TAIL = { z0: 0.6, len: 0.95, r0: 0.05, r1: 0.003 };

// eagle ray: a rounded head lobe standing proud of the wings (the notch behind it), then pointed,
// swept wings with a concave trailing edge
const EAGLE_DISC = [
	[ - 0.5, 0.001 ], [ - 0.49, 0.042 ], [ - 0.47, 0.068 ], [ - 0.44, 0.084 ], [ - 0.4, 0.09 ], [ - 0.36, 0.087 ],
	[ - 0.33, 0.082 ], [ - 0.3, 0.1 ], [ - 0.26, 0.14 ], [ - 0.2, 0.205 ], [ - 0.12, 0.3 ], [ - 0.04, 0.39 ], [ 0.02, 0.46 ],
	[ 0.05, 0.5 ], [ 0.075, 0.43 ], [ 0.1, 0.33 ], [ 0.13, 0.23 ], [ 0.165, 0.15 ], [ 0.2, 0.095 ],
	[ 0.24, 0.06 ], [ 0.28, 0.04 ],
];
const EAGLE_TAIL = { z0: 0.25, len: 1.25, r0: 0.03, r1: 0.0015 };

// the shader constants (per kind): [ rigid core half width, margin half width, tail base, tail length ]
const KIND_CONST = {
	[ RAY_KIND.stingray ]: [ 0.12, 0.7, STING_TAIL.z0, STING_TAIL.len ],
	[ RAY_KIND.eagle ]: [ 0.08, 0.5, EAGLE_TAIL.z0, EAGLE_TAIL.len ],
};

function planformAt( table, z, smooth ) {

	const n = table.length;
	if ( z <= table[ 0 ][ 0 ] ) return table[ 0 ][ 1 ];
	if ( z >= table[ n - 1 ][ 0 ] ) return table[ n - 1 ][ 1 ];
	let i = 0;
	while ( i < n - 2 && z > table[ i + 1 ][ 0 ] ) i ++;
	const t = ( z - table[ i ][ 0 ] ) / ( table[ i + 1 ][ 0 ] - table[ i ][ 0 ] );
	if ( ! smooth ) return MathUtils.lerp( table[ i ][ 1 ], table[ i + 1 ][ 1 ], t );
	const a = table[ Math.max( 0, i - 1 ) ][ 1 ], b = table[ i ][ 1 ], c = table[ i + 1 ][ 1 ], d = table[ Math.min( n - 1, i + 2 ) ][ 1 ];
	return Math.max( 0.003, 0.5 * ( 2 * b + ( c - a ) * t + ( 2 * a - 5 * b + 4 * c - d ) * t * t + ( 3 * b - a - 3 * c + d ) * t * t * t ) );

}

// species shape: half span, body core half width / height, disc thickness at z
const SHAPES = {
	[ RAY_KIND.stingray ]: {
		disc: STING_DISC, smooth: true, tail: STING_TAIL,
		span: ( z ) => planformAt( STING_DISC, z, true ),
		coreW: ( z ) => 0.05 + 0.15 * Math.exp( - ( ( ( z + 0.02 ) / 0.5 ) ** 2 ) ),
		coreH: ( z ) => 0.012 + 0.07 * Math.exp( - ( ( ( z + 0.08 ) / 0.4 ) ** 2 ) ),
		disc0: 0.02,
		droop: 0.02, // the margin hangs a little lower than the centre
		back: 0x2c2926, backEdge: 0x3a342d, belly: 0xe0ddd2, bellyEdge: 0x8a8680,
		rough: 0.5,
	},
	[ RAY_KIND.eagle ]: {
		disc: EAGLE_DISC, smooth: false, tail: EAGLE_TAIL,
		span: ( z ) => planformAt( EAGLE_DISC, z, false ),
		coreW: ( z ) => 0.085 - 0.02 * MathUtils.smoothstep( z, - 0.1, 0.25 ),
		// the head lobe is thick and rounded; the body humps behind it
		coreH: ( z ) => 0.012 + 0.055 * Math.exp( - ( ( ( z + 0.39 ) / 0.1 ) ** 2 ) ) + 0.05 * Math.exp( - ( ( ( z + 0.12 ) / 0.22 ) ** 2 ) ),
		disc0: 0.014,
		droop: - 0.01, // wings held up a touch
		back: 0x5a4a30, backEdge: 0x4a3d28, belly: 0xebe9e1, bellyEdge: 0xd8d4c8,
		rough: 0.45,
	},
};

// surface of the disc: returns [ yTop, yBottom ] at ( x, z )
function discSurface( sh, x, z ) {

	const hs = sh.span( z );
	const c = MathUtils.clamp( x / hs, - 1, 1 );
	const s = Math.sqrt( Math.max( 0, 1 - c * c ) );
	const w = Math.min( sh.coreW( z ), hs * 0.9 );
	const core = Math.exp( - ( ( x / w ) ** 2 ) * 1.6 );
	const mid = - sh.droop * c * c;
	// rounded off to nothing at the snout and the tail base
	const s2 = s * Math.sqrt( Math.min( 1, hs / 0.06 ) );
	const top = mid + s2 * ( sh.disc0 + sh.coreH( z ) * core );
	const bot = mid - s2 * ( sh.disc0 * 0.75 + sh.coreH( z ) * 0.35 * core );
	return [ top, bot ];

}

function discGeometry( sh, rings, segs ) {

	const z0 = sh.disc[ 0 ][ 0 ], z1 = sh.disc[ sh.disc.length - 1 ][ 0 ];
	const profiles = [];
	const angles = [];
	for ( let j = 0; j < segs; j ++ ) angles.push( j / segs * Math.PI * 2 );
	for ( let i = 0; i <= rings; i ++ ) {

		// denser rings at the ends (the snout / head lobe and the tail base)
		const u = i / rings;
		const z = z0 + ( z1 - z0 ) * ( u - Math.sin( u * Math.PI * 2 ) * 0.06 );
		const hs = sh.span( z );
		const ring = [];
		for ( const a of angles ) {

			const c = Math.cos( a ), sn = Math.sin( a );
			const x = hs * c;
			const [ top, bot ] = discSurface( sh, x, z );
			// the ring angle gives the lens profile: |sin( a )| is the ellipse factor discSurface uses
			const y = sn >= 0 ? top : bot;
			ring.push( new Vector3( x, y, z ) );

		}

		profiles.push( ring );

	}

	const g = loft( profiles, { closed: true } );
	const nj = segs + 1;
	const back = new Color( sh.back ), backEdge = new Color( sh.backEdge ), belly = new Color( sh.belly ), bellyEdge = new Color( sh.bellyEdge );
	paintVertices( g, ( v, i ) => {

		const a = ( i % nj ) / segs * Math.PI * 2;
		const c = Math.cos( a ), sn = Math.sin( a );
		const edge = MathUtils.smoothstep( c * c, 0.55, 0.97 );
		const top = back.clone().lerp( backEdge, edge );
		const bot = belly.clone().lerp( bellyEdge, edge );
		// the rim blends over a thin band so the silhouette edge reads dark from above
		return bot.lerp( top, MathUtils.smoothstep( sn, - 0.12, 0.05 ) );

	} );
	return prepare( auxVertices( g, ( v, i ) => {

		const sn = Math.sin( ( i % nj ) / segs * Math.PI * 2 );
		return [ sh.rough, 0.02, 0, sn > 0 ? 1 : 0 ];

	} ), {} );

}

function tailGeometry( sh, rings, segs, backColor ) {

	const { z0, len, r0, r1 } = sh.tail;
	const profiles = [];
	for ( let i = 0; i <= rings; i ++ ) {

		const t = i / rings;
		const z = z0 + len * t;
		// quick taper off the body, then a long thin whip
		const r = r1 + ( r0 - r1 ) * ( 1 - t ) ** 2.2;
		const ring = [];
		for ( let j = 0; j < segs; j ++ ) {

			const a = j / segs * Math.PI * 2;
			ring.push( new Vector3( Math.cos( a ) * r * 1.25, Math.sin( a ) * r * 0.85 - 0.005 * ( 1 - t ), z ) );

		}

		profiles.push( ring );

	}

	// closing tip point
	const tip = [];
	for ( let j = 0; j < segs; j ++ ) tip.push( new Vector3( 0, 0, z0 + len + 0.01 ) );
	profiles.push( tip );
	const g = loft( profiles, { closed: true } );
	const nj = segs + 1;
	const back = new Color( backColor ), belly = new Color( sh.belly );
	paintVertices( g, ( v, i ) => {

		const sn = Math.sin( ( i % nj ) / segs * Math.PI * 2 );
		const t = ( v.z - z0 ) / len;
		// pale underside only near the root
		return belly.clone().lerp( back, Math.max( MathUtils.smoothstep( sn, - 0.5, 0.2 ), MathUtils.smoothstep( t, 0.05, 0.3 ) ) );

	} );
	return prepare( auxVertices( g, () => [ sh.rough, 0.02, 0, 1 ] ), {} );

}

// Returns the merged geometry of one animal for level of detail `lod` (0 fine, 1 coarse), with
// uv.x = `slot` (its wave uniform).
export function buildRayGeometry( kind, lod, slot ) {

	const sh = SHAPES[ kind ];
	const fine = lod === 0;
	const parts = [];
	parts.push( discGeometry( sh, fine ? 44 : 16, fine ? 40 : 14 ) );
	parts.push( tailGeometry( sh, fine ? 26 : 8, fine ? 8 : 4, kind === RAY_KIND.stingray ? 0x26231f : 0x3d3222 ) );

	const eye = 0x0d0c0b;
	if ( kind === RAY_KIND.stingray ) {

		for ( const side of [ - 1, 1 ] ) {

			// eyes on little turrets on top of the head, the spiracles right behind them
			const ex = side * 0.085, ez = - 0.3;
			const [ ey ] = discSurface( sh, ex, ez );
			parts.push( prepare( sphere( 0.024, fine ? 10 : 5, fine ? 6 : 3 ), { color: 0x2f2b27, rough: 0.5, matrix: mat4( ex, ey - 0.006, ez, 0, 0, 0, 1, 0.6, 1.2 ) } ) );
			if ( fine ) {

				parts.push( prepare( sphere( 0.013, 8, 6 ), { color: eye, rough: 0.1, metal: 0.2, matrix: mat4( ex + side * 0.004, ey + 0.006, ez - 0.004 ) } ) );
				const sx = side * 0.1, sz = - 0.235;
				const [ sy ] = discSurface( sh, sx, sz );
				parts.push( prepare( sphere( 0.018, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2 ), { color: 0x141210, rough: 0.7, matrix: mat4( sx, sy - 0.004, sz, 0, side * 0.3, 0, 1, 0.35, 1.5 ) } ) );

			}

		}

		// the sting: a flat serrated spine on top of the tail, a third of the way along, pointing back
		const { z0, len, r0, r1 } = sh.tail;
		const tb = 0.3, zb = z0 + len * tb;
		const rb = r1 + ( r0 - r1 ) * ( 1 - tb ) ** 2.2;
		parts.push( prepare( rod( new Vector3( 0, rb * 0.8, zb ), new Vector3( 0, rb * 0.9 + 0.006, zb + 0.13 ), 0.007, fine ? 5 : 3, 0.0008 ), { color: 0x6e6252, rough: 0.35 } ) );

	} else {

		for ( const side of [ - 1, 1 ] ) {

			// eyes on the sides of the head lobe, spiracles above and behind them
			const ex = side * 0.076, ez = - 0.42;
			parts.push( prepare( sphere( 0.013, fine ? 10 : 5, fine ? 6 : 3 ), { color: eye, rough: 0.1, metal: 0.2, matrix: mat4( ex, 0.024, ez ) } ) );
			if ( fine ) {

				const sx = side * 0.055, sz = - 0.37;
				const [ sy ] = discSurface( sh, sx, sz );
				parts.push( prepare( sphere( 0.013, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2 ), { color: 0x1a150d, rough: 0.7, matrix: mat4( sx, sy - 0.004, sz, 0, 0, 0, 1, 0.35, 1.6 ) } ) );

			}

		}

		// small dorsal fin at the root of the tail, the sting just behind it
		const { z0 } = sh.tail;
		parts.push( prepare( rod( new Vector3( 0, 0.02, z0 + 0.03 ), new Vector3( 0, 0.055, z0 + 0.08 ), 0.012, fine ? 5 : 3, 0.002 ), { color: 0x4a3d28, rough: 0.5, matrix: mat4( 0, 0, 0, 0, 0, 0, 0.5, 1, 1 ) } ) );
		parts.push( prepare( rod( new Vector3( 0, 0.02, z0 + 0.1 ), new Vector3( 0, 0.024, z0 + 0.18 ), 0.004, fine ? 4 : 3, 0.0006 ), { color: 0x6e6252, rough: 0.35 } ) );

	}

	const g = mergePrepared( parts );
	const uv = g.attributes.uv;
	for ( let i = 0; i < uv.count; i ++ ) uv.setXY( i, slot, 0 );
	// the vertex shader bends the wings / flaps and whips the tail: pad the bounds
	g.boundingSphere.radius *= 1.25;
	return g;

}

// Reference half span (m) of each kind (the ray's scale multiplies this)
export const RAY_HALF_SPAN = { [ RAY_KIND.stingray ]: 0.7, [ RAY_KIND.eagle ]: 0.5 };
// belly clearance below the model origin at rest (reference units)
export const RAY_BELLY = { [ RAY_KIND.stingray ]: 0.05, [ RAY_KIND.eagle ]: 0.04 };

const f = ( x ) => {

	const t = String( + x.toFixed( 6 ) );
	return t.includes( '.' ) || t.includes( 'e' ) ? t : t + '.0';

};

const kc = ( k, i ) => f( KIND_CONST[ k ][ i ] );

const rayModule = new ShaderModule( {
	name: 'rayWave',
	code: /* wgsl */`
// wave state w = ( phase, amplitude, kind, tail phase ); displacement of the rest point p
fn rayDisp( p: vec3f, w: vec4f ) -> vec3f {
	let eagle = w.z > 0.5;
	let core = select( ${ kc( 0, 0 ) }, ${ kc( 1, 0 ) }, eagle );
	let span = select( ${ kc( 0, 1 ) }, ${ kc( 1, 1 ) }, eagle );
	let tb = select( ${ kc( 0, 2 ) }, ${ kc( 1, 2 ) }, eagle );
	let tl = select( ${ kc( 0, 3 ) }, ${ kc( 1, 3 ) }, eagle );
	let u = clamp( ( abs( p.x ) - core ) / ( span - core ), 0.0, 1.0 );
	var dy = 0.0;
	if ( eagle ) {
		// wing beat: the tips lag the root a little and bend more
		dy = w.y * pow( u, 1.5 ) * sin( w.x - u * 0.9 ) + w.y * 0.08 * u * sin( w.x * 2.0 - p.z * 6.0 );
	} else {
		// a wave running round the margin from the snout to the tail, about 1.3 waves on the disc
		dy = w.y * u * u * sin( w.x - p.z * 7.5 );
	}
	// tail: lags and whips from side to side, growing toward the tip
	let t = clamp( ( p.z - tb ) / tl, 0.0, 1.0 );
	let dx = w.y * select( 0.5, 0.25, eagle ) * t * t * sin( w.w - t * 4.5 );
	let tdy = w.y * select( 0.25, 0.3, eagle ) * t * t * sin( w.w * 0.7 - t * 3.0 + 1.0 );
	return vec3f( dx, dy + tdy, 0.0 );
}
`,
} );

// One material for every ray: per animal wave state in `rayWave` ( [ 0, MAX_RAYS ) this frame,
// [ MAX_RAYS, 2 MAX_RAYS ) last frame).
export function createRayMaterial( waves ) {

	const m = createPropMaterial( 'rays', {
		uniforms: { rayWave: [ `vec4f[${ 2 * MAX_RAYS }]`, waves ] },
		vertex: /* wgsl */`
	{
		let slot = i32( v.uv.x + 0.5 );
		let wc = mat.rayWave[ slot ];
		let wl = mat.rayWave[ slot + ${ MAX_RAYS } ];
		let p = v.position;
		let d = rayDisp( p, wc );
		let e = 0.01;
		let fx = ( rayDisp( p + vec3f( e, 0.0, 0.0 ), wc ).y - d.y ) / e;
		let fz = ( rayDisp( p + vec3f( 0.0, 0.0, e ), wc ).y - d.y ) / e;
		v.normal = normalize( v.normal - v.normal.y * vec3f( fx, 0.0, fz ) );
		v.position = p + d;
		v.prevWorldOffset = ( v.prevModel * vec4f( rayDisp( p, wl ) - d, 0.0 ) ).xyz;
	}
`,
		// markings on the back (aux.w): the stingray's faint mottling, the eagle ray's pale blue-grey
		// wavy bars and spots
		surface: /* wgsl */`
	{
		let slotF = in.uv.x + 0.5;
		let kind = mat.rayWave[ i32( slotF ) ].z;
		let back = in.vs.vAux.w;
		let q = in.vs.vLocal;
		let big = gpFbm( vec3f( q.x * 7.0, q.z * 7.0, slotF * 3.1 ) );
		if ( kind > 0.5 ) {
			// wavy pale bars across the wings, broken into dashes and spots
			let warp = gpFbm( vec3f( q.x * 4.0 + 3.0, q.z * 4.0, slotF ) ) * 4.0;
			let line = abs( sin( q.z * 16.0 + abs( q.x ) * 9.0 + warp ) );
			let broken = smoothstep( 0.34, 0.56, gpFbm( vec3f( q.x * 11.0, q.z * 11.0, slotF + 5.0 ) ) );
			let bar = ( 1.0 - smoothstep( 0.2, 0.42, line ) ) * broken * smoothstep( 0.09, 0.16, abs( q.x ) );
			s.albedo = mix( s.albedo * mix( 0.85, 1.12, big ), vec3f( 0.16, 0.2, 0.23 ), bar * back * 0.6 );
		} else {
			s.albedo = s.albedo * mix( 1.0, mix( 0.8, 1.18, big ), back );
		}
		// a thin film of mucus: a soft sheen
		s.roughness = mix( s.roughness, 0.35, back * 0.5 );
	}
`,
	} );
	m.modules.push( rayModule );
	return m;

}

export function newWaveArray() {

	return new Array( 2 * MAX_RAYS ).fill( 0 ).map( () => new Vector4() );

}

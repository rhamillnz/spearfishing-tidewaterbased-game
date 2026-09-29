// Held-catch regression test (node, headless GPU via Dawn): the fish speared and held at the
// speargun muzzle (Speargun 'held' state / Game.heldSpearFish) must stay visible, correctly
// positioned and out of the water once the diver surfaces, boards the boat or steps ashore, and
// must never be lost before it's stashed - see src/world/Fish.js (checkSpearHit / impaleFish /
// updateImpaledFish / releaseImpaledFish, plus the cull() rendering exemption for the impaled
// fish) and src/game/Speargun.js (equip / update). Orchestrates the real production classes
// (FishSchools, Speargun, GameState) the way Game.js does, rather than the whole Game class (which
// needs a full app/scene/UI stack) - the same pattern test/life-shark.mjs uses for Shark.js.
//   node test/spearfish-held.mjs
import './headless.mjs';
import { GPU } from '../src/engine/gpu/GPU.js';
import * as E from '../src/engine/index.js';
import { FishSchools } from '../src/world/Fish.js';
import { Speargun } from '../src/game/Speargun.js';
import { GameState } from '../src/game/GameState.js';
import { fishValue } from '../src/game/FishTable.js';

await GPU.init( { headless: true } );

let fails = 0;
const check = ( ok, msg ) => {

	console.log( ( ok ? 'ok   ' : 'FAIL ' ) + msg );
	if ( ! ok ) fails ++;

};

const center = new E.Vector3( 0, -5, 0 );
const fish = new FishSchools( { parent: new E.Group(), terrain: { heightAt: () => -5 }, center, radius: 40 } );

// a fixed-direction stand-in camera for the speargun's viewmodel math (only what Speargun.js reads)
function fakeCamera( pos ) {

	const camera = new E.PerspectiveCamera( 60, 16 / 9, 0.1, 2000 );
	camera.position.copy( pos );
	camera.lookAt( pos.x, pos.y, pos.z - 1 );
	camera.updateMatrixWorld();
	return camera;

}

const camera = fakeCamera( new E.Vector3( 0, -2, 9 ) );
const speargun = new Speargun( { scene: { add() {} }, camera, query: null, terrain: { heightAt: () => -999 }, audio: null } );
speargun.equip( true );

// ---- spear a live fish underwater, near the reef (mirrors Speargun's fire()/checkSpearHit path)
fish.update( 0, camera.position );
const g = fish.groups.find( ( gr ) => gr.count > 0 );
const gi = g.offset;
const hit = fish.checkSpearHit( new E.Vector3( fish.pos[ gi * 3 ], fish.pos[ gi * 3 + 1 ], fish.pos[ gi * 3 + 2 ] ), camera.position, 5 );
check( !! hit, 'checkSpearHit lands a hit on a nearby fish' );

fish.impaleFish( hit );
check( fish.impaled && fish.impaled.index === hit.index, 'impaleFish records the impaled fish' );
check( !! fish.impaledGroup && fish.impaledGroup.count > 0, 'impaleFish records which school it came from' );

speargun.spearedFish = hit;
speargun.hold();
check( speargun.state === 'held', "speargun.hold() -> state 'held'" );

for ( let i = 0; i < 10; i ++ ) speargun.update( 1 / 60, { visible: true, fishSchools: fish } );
const iu = hit.index * 3;
// 'held': the fish sits ~0.5 m forward of the muzzle, in line with the barrel, so it clears the gun
check( speargun.spearPos.distanceTo( speargun.muzzlePos ) < 0.8, 'held fish tracks just forward of the muzzle underwater' );
check( Math.hypot( fish.pos[ iu ] - speargun.spearPos.x, fish.pos[ iu + 1 ] - speargun.spearPos.y, fish.pos[ iu + 2 ] - speargun.spearPos.z ) < 0.05,
	'updateImpaledFish pins the fish mesh to the held spear position' );

// ---- surface and swim to the boat, well out of the water and far from the reef where it was
// speared (bug: "the fish cannot come out of the water"). Simulate boarding: canSpear goes false
// for 'boat' mode, so Game.js would call speargun.equip( false ) (bug: "disappears" on boarding).
camera.position.set( 500, 20, 500 ); // above water (y > 0), 700+ m from the reef centre
camera.lookAt( 500, 19, 499 );
camera.updateMatrixWorld();
speargun.equip( false );
check( speargun.state === 'held', "equip( false ) while held leaves state 'held' (not reset to 'stowed')" );

for ( let i = 0; i < 10; i ++ ) speargun.update( 1 / 60, { visible: false, fishSchools: fish } );
check( speargun.gunMesh.visible && speargun.spearMesh.visible, 'gun + spear stay visible once unequipped while a fish is held' );
check( speargun.muzzlePos.y > 5, `muzzle position followed the diver above water (y = ${ speargun.muzzlePos.y.toFixed( 1 ) })` );
check( fish.pos[ iu + 1 ] > 5, `the impaled fish followed it out of the water too (fish y = ${ fish.pos[ iu + 1 ].toFixed( 1 ) }, no depth clamp)` );
check( Math.hypot( fish.pos[ iu ] - speargun.spearPos.x, fish.pos[ iu + 1 ] - speargun.spearPos.y, fish.pos[ iu + 2 ] - speargun.spearPos.z ) < 0.05,
	'the impaled fish keeps following the held spear position after boarding' );

fish.update( 1 / 60, camera.position );
check( fish.mesh.visible, 'fish batch mesh stays visible although every school is now far out of its normal cull range' );
const groupStillFar = Math.hypot( fish.impaledGroup.center.x - camera.position.x, fish.impaledGroup.center.z - camera.position.z ) > 65 + fish.impaledGroup.radius;
check( groupStillFar, 'sanity: the impaled fish\'s home school really is beyond SIM_RANGE from the boat' );
fish.cull( camera );
check( fish.batch.visibleInstances > 0, 'the held fish is actually drawn this frame (cull() exemption), not silently dropped' );

// ---- releasing (a shark snatch, a blackout drop, or Game.dropHeldSpearFish()) clears it cleanly
fish.releaseImpaledFish();
check( fish.impaled === null && fish.impaledGroup === null, 'releaseImpaledFish() clears impaled + impaledGroup' );
check( fish.pos[ iu + 1 ] < -500, 'released fish mesh is moved out of view' );
speargun.reload();
check( speargun.state === 'reloading', 'speargun reloads after release' );

// ---- stashing into the cooler: kg and the stone-shot bonus survive (Game.js's stash code calls
// GameState.addFish/recordCatch with heldSpearFish.kg and !!heldSpearFish.stoned)
{

	const state = new GameState();
	state.inventory.length = 0; // start from an empty hold regardless of any saved state
	const kg = 8.4, species = 'yellowtail';
	const entry = state.addFish( species, kg, 12, true ); // stone shot
	check( !! entry && entry.kg === kg, `addFish keeps the exact kg (${ entry && entry.kg })` );
	check( entry.stoned === true, 'addFish keeps the stone-shot flag' );
	const plainValue = fishValue( species, kg );
	check( Math.abs( entry.value - Math.round( plainValue * 1.25 ) ) < 1e-6, `stone shot pays the +25% bonus (value ${ entry.value } vs plain ${ Math.round( plainValue ) })` );
	check( state.inventory.some( ( f ) => f.species === species && f.kg === kg && f.stoned === true ), 'the cooler entry itself keeps kg + stoned' );

	// float -> boat cooler transfer (Game.transferFloatToCooler -> GameState.storeFish): the
	// recordCatch()'d entry (dive float) must carry its value + stoned bonus through storeFish()
	const floatState = new GameState();
	floatState.inventory.length = 0;
	const logged = floatState.recordCatch( species, kg, 12, true );
	const stored = floatState.storeFish( logged );
	check( !! stored && stored.stoned === true, 'storeFish (float -> cooler transfer) keeps the stoned flag' );
	check( stored.value === logged.value, 'storeFish keeps the stone-shot bonus value computed at the float' );

}

console.log( fails ? `\n${ fails } FAILED` : '\nall ok' );
process.exit( fails ? 1 : 0 );

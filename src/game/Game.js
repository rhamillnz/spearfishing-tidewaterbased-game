import { Vector3, Color } from '../engine/index.js';
import { WORLD } from '../world/WorldLayout.js';
import { FISH } from './FishTable.js';
import { habitatAt, pickSpecies, rollWeight, biteDelay } from './Bites.js';
import { CatchMinigame } from './CatchMinigame.js';
import { GameState } from './GameState.js';
import { FishingRod } from './FishingRod.js';
import { Speargun } from './Speargun.js';
import { FishStand } from './FishStand.js';
import { Chandlery } from './Chandlery.js';
import { CatchDisplay } from './CatchDisplay.js';
import { UPGRADES, fuelBurn } from './Gear.js';
import { GameHUD } from './GameHUD.js';
import { Minimap } from './Minimap.js';
import { Guide } from './Guide.js';
import { Bombies } from '../world/Bombies.js';
import { DiveFloat } from '../world/DiveFloat.js';
import { Shark } from '../world/Shark.js';

// how long the catch card stays up unless dismissed (ms)
const CATCH_CARD_MS = 9000;
// a spear hit this far into the front of the fish (0 tail .. 1 snout) is a clean "stone shot": an
// instant kill, no fight, straight through the head
const STONE_SHOT_FRAC = 0.7;

// sharks stay well clear until the diver has landed this many speared fish (reset after each encounter)
const SHARK_ENGAGE_LANDINGS = 4;
const SHARK_SNATCH_RANGE = 2.4; // (m) how close the shark must get to actually snatch a held fish
const SHARK_CHARGE_TOAST_S = 3.0; // throttle for the "poke it!" hint so it doesn't spam during charges

// The fishing game on top of the world:
//   R          take out / put away the rod or speargun
//   1 / 2      switch between Fishing Rod and Speargun
//   hold RMB   aim speargun down sights
//   LMB        shoot spear / strike rod
//   Q          spear poke (fend off sharks, close fish jab)
//   E          stash fish in dive float or sell at fish stand
//   I / Tab    cooler / hold contents and the spearfisher's field guide
export class Game {

	constructor( app ) {

		this.app = app;
		this.state = new GameState();
		this.state.load();
		this.rod = new FishingRod( { scene: app.scene, camera: app.camera, query: app.query, terrain: app.terrainData, audio: app.audio } );
		this.rod.onLand = ( where ) => this.onBobberLanded( where );
		this.speargun = new Speargun( { scene: app.scene, camera: app.camera, query: app.query, terrain: app.terrainData, audio: app.audio } );
		this.weapon = 'speargun';
		this.heldSpearFish = null; // { species, kg, name } when retrieved to diver's hands/stringer
		this._sharkWarningT = 0;
		this.breath = 240; // 4 minutes base breath hold
		this.maxBreath = 240;
		this.blackoutT = 0;
		this._breathWarned = false;
		this._wasInWater = false;
		this._cardT = 0;

		// Spearfishing world entities: Underwater Bombies (rock cover), Dive Float ("Floating Locker"), and Reef Sharks
		this.bombies = new Bombies( { scene: app.scene, terrain: app.terrainData } );
		this.diveFloat = new DiveFloat( { scene: app.scene, query: app.query } );
		this.sharks = [
			new Shark( { scene: app.scene, terrain: app.terrainData, index: 0, homePos: new Vector3( 30, - 8, 115 ) } ),
			new Shark( { scene: app.scene, terrain: app.terrainData, index: 1, homePos: new Vector3( - 30, - 10, 140 ) } ),
		];
		// Sharks stay away (cruising far out) until the diver has landed SHARK_ENGAGE_LANDINGS speared
		// fish; the counter is reset each time a shark's encounter concludes (see the update loop below).
		this.speargunLandings = 0;

		this.speargun.onFishHit = ( hit ) => {

			const fData = FISH[ hit.speciesKey ] || FISH.yellowtail;
			const [ a, b ] = fData.lw;
			const lenCm = ( hit.lengthM || 0.45 ) * 100;
			const calcKg = Math.max( fData.kg[ 0 ], Math.min( fData.kg[ 1 ] * 1.35, ( a * Math.pow( lenCm, b ) ) / 1000 ) );
			hit.kg = calcKg;

			// A hit in the front ~30% of the fish (head/spine) is a clean, instant "stone shot": no
			// fight, the spear glides straight back in, and the catch is worth more
			const stoned = ( hit.bodyFrac ?? 0 ) >= STONE_SHOT_FRAC;
			hit.stoned = stoned;

			if ( stoned ) {

				this.toast( `🎯 STONE SHOT! Clean kill through the head · +25% value`, 3200 );
				if ( this.app.audio && this.app.audio.fishSplash ) this.app.audio.fishSplash( this.speargun.spearPos, 0.5 );
				this.speargun.retrieve();
				return;

			}

			// Otherwise it's on properly: the same tension-band fight as the fishing rod, using a
			// shooting line strength and reel speed in the rod's own range so a fish of a given size
			// fights just as hard on the speargun as it would on the rod
			const g = this.state.stats;
			const dist = this.speargun.spearPos.distanceTo( this.speargun.muzzlePos );
			this.fight = new CatchMinigame( {
				species: hit.speciesKey,
				kg: calcKg,
				lineKg: g.spearLineKg,
				reelSpeed: g.spearReelSpeed,
				distance: Math.max( 2.5, dist )
			} );
			this.fight._isSpeargun = true;
			this.speargun.startFight();

			this.toast( `Fish on! Hold LMB to reel it in · keep the tension in the green band`, 2800 );
			if ( this.app.audio && this.app.audio.fishSplash ) this.app.audio.fishSplash( this.speargun.spearPos, 0.6 );

		};

		// a fish reeled straight back in without a fight (a stone shot): land it the same way a fought
		// catch lands, just without ever creating a CatchMinigame
		this.speargun.onFishLanded = ( landed ) => {

			if ( ! landed.stoned ) return;
			const name = landed.name;
			this.speargunLandings = ( this.speargunLandings || 0 ) + 1; // counts toward the next shark encounter

			if ( this.app.audio && this.app.audio.fishFlop ) this.app.audio.fishFlop();

			if ( this.app.player.mode === 'swim' ) {

				this.speargun.hold();
				this.heldSpearFish = { species: landed.speciesKey, kg: landed.kg, name, stoned: true };
				this.toast( `Landed ${ name } (${ landed.kg.toFixed( 1 ) } kg)! It's held on your spear - stash it in your Dive Float [E]!`, 4200 );

			} else {

				const entry = this.state.addFish( landed.speciesKey, landed.kg, this.hour, true );
				const info = this.state.lastCatch;
				if ( this.hud && info ) this.hud.showCatch( info, CATCH_CARD_MS );
				else if ( entry ) this.toast( `${ name } · ${ entry.kg.toFixed( 2 ) } kg · $${ entry.value }`, 3600 );

			}

		};

		this.speargun.onPokeShark = () => {

			this.toast( 'Shark poked on the snout! Repelled!', 2200 );

		};

		this.stand = new FishStand( { scene: app.scene, terrain: app.terrainData, colliders: app.colliders } );
		this.display = new CatchDisplay( { scene: app.scene, stall: this.stand.iceFish() } );
		this.landing = null; // { species, kg } while the caught fish swings in view
		this.chandlery = new Chandlery( { scene: app.scene, terrain: app.terrainData, colliders: app.colliders, material: this.stand.material } );
		this.vendors = [ this.stand.vendor, this.chandlery.vendor ];
		// boat upgrades: engine (thrust / top speed) and deck floodlights for night fishing
		const b = app.boatCtl;
		this._engineBase = { maxThrust: b.maxThrust, pitchSpeed: b.pitchSpeed };
		this.floods = [];
		if ( app.localLights ) this.addFloodlights( app.localLights, app.boat );
		this._fuelOut = false;
		this._sonarT = 0;
		this._sonar = null;
		this.hud = null;
		this.fight = null; // CatchMinigame while a fish is on
		this.bite = null; // { phase: 'wait' | 'nibble' | 'take', t, nibbles, species, kg }
		this._lmb = false;
		this._rmb = false;
		this._hookedSpecies = null;
		this._pier = WORLD.pier;
		this.applyGear();
		this.state.onChange( () => this.applyGear() );

	}

	applyGear() {

		const g = this.state.stats;
		this.rod.setGear( { castM: g.castM, reelSpeed: g.reelSpeed } );
		if ( this.speargun ) this.speargun.setGear( { rangeM: g.rangeM, spearVel: g.spearVel } );
		if ( this.app.player ) this.app.player.swimSpeedMul = g.swimSpeedMul || 1.0;
		if ( g.breathSec ) this.maxBreath = g.breathSec;
		const b = this.app.boatCtl;
		if ( b && this._engineBase ) {

			b.maxThrust = this._engineBase.maxThrust * g.speedMul * g.speedMul;
			b.pitchSpeed = this._engineBase.pitchSpeed * g.speedMul;

		}

		for ( const f of this.floods || [] ) f.scale = g.deckLights ? 1 : 0;

	}

	// two floodlights under the back of the wheelhouse roof, lighting the cockpit and the water
	// astern (night only, like every local light; switched by the lights upgrade)
	addFloodlights( lights, boat ) {

		const obj = boat.group;
		for ( const x of [ - 0.8, 0.8 ] ) {

			const local = new Vector3( x, 2.25, - 1.0 );
			const localDir = new Vector3( x * 0.25, - 0.75, - 0.62 ).normalize();
			const src = {
				position: new Vector3(), color: new Color( 1.0, 0.93, 0.8 ), intensity: 3.2, range: 14, kind: 'boatFlood',
				dir: new Vector3(), cosInner: 0.8, cosOuter: 0.45, scale: 0,
				update() {

					obj.updateWorldMatrix( true, false );
					this.position.copy( local ).applyMatrix4( obj.matrixWorld );
					this.dir.copy( localDir ).transformDirection( obj.matrixWorld );

				},
			};
			src.update();
			this.floods.push( src );
			lights.add( src );

		}

	}

	buy( key ) {

		const r = this.state.buy( key );
		if ( r ) this.toast( `${ UPGRADES[ key ].name }: ${ r.label }` );
		return r;

	}

	refuel() {

		const l = this.state.refuel();
		if ( l > 0 ) {

			this._fuelOut = false;
			this.toast( `Filled up · ${ l.toFixed( 0 ) } L` );

		}

		return l;

	}

	toast( text, ms = 2600 ) {

		if ( this.hud ) this.hud.toast( text, ms );
		else console.log( '[game]', text );

	}

	get canFish() {

		const app = this.app, p = app.player;
		return ! app.freeCam && ( p.mode === 'walk' || p.mode === 'deck' ) && ! ( app.ui && app.ui.ui && app.ui.ui._photo );

	}

	get canSpear() {

		const app = this.app, p = app.player;
		return ! app.freeCam && ( p.mode === 'swim' || p.mode === 'walk' || p.mode === 'deck' ) && ! ( app.ui && app.ui.ui && app.ui.ui._photo );

	}

	// ---- per frame (after the player / camera update)
	update( dt ) {

		const app = this.app, p = app.player, inp = app.input, rod = this.rod, speargun = this.speargun;
		this._cardDismissed = false;
		if ( ! this.hud && app.ui && app.ui.ui && typeof document !== 'undefined' && document.head ) {

			const ui = app.ui.ui;
			this.hud = new GameHUD( ui, this );
			// the minimap (lower right) and the first-play guide (intro, one-time tips; replay from F1)
			this.minimap = new Minimap( ui.hud || ui.root, this );
			this.guide = new Guide( ui, this, this.minimap );
			ui.onReplayGuide = () => this.guide.replay();

		}

		const can = this.canFish;
		const canSpear = this.canSpear;

		// Weapon selection hotkeys: 1 for Rod, 2 for Speargun
		if ( inp.hit( 'Digit1' ) ) {

			if ( this.fight ) {

				this.toast( 'Finish the fight first!', 1400 );

			} else if ( this.weapon !== 'rod' ) {

				speargun.equip( false );
				this.weapon = 'rod';
				if ( can ) {

					rod.equip( true );
					this.toast( 'Fishing Rod equipped · [2] Speargun', 1600 );

				} else {

					this.toast( 'Fishing Rod selected (cannot fish while swimming)', 2000 );
					this.weapon = 'speargun';
					speargun.equip( true );

				}

			}

		} else if ( inp.hit( 'Digit2' ) ) {

			if ( this.fight ) {

				this.toast( 'Finish the fight first!', 1400 );

			} else if ( this.weapon !== 'speargun' ) {

				this.cancelLine( true );
				rod.equip( false );
				this.weapon = 'speargun';
				speargun.equip( true );
				this.toast( 'Speargun equipped · [1] Fishing Rod', 1600 );

			}

		}

		// When entering swim mode, automatically switch to speargun and notify about dive float
		if ( p.mode === 'swim' && ! this._wasInWater ) {

			if ( this.weapon === 'rod' ) {

				this.cancelLine( true );
				rod.equip( false );
				this.weapon = 'speargun';
				speargun.equip( true );

			}
			this.toast( '🛟 Dive Float deployed! Swim to it and press [E] to stash your catch.', 4500 );

		}
		this._wasInWater = ( p.mode === 'swim' );

		// KeyR toggles the current weapon, or retrieves spear if it was fired
		if ( inp.hit( 'KeyR' ) && ! ( this.hud && ( this.hud.invOpen || this.hud.standOpen ) ) ) {

			if ( this.weapon === 'speargun' && canSpear ) {

				if ( speargun.state === 'spearOut' ) {

					speargun.retrieve();

				} else if ( this.heldSpearFish && speargun.equipped ) {

					this.toast( `Stash your ${ this.heldSpearFish.name } first! [E]`, 2200 );

				} else {

					speargun.equip( ! speargun.equipped );
					this.toast( speargun.equipped ? 'Speargun ready · Hold RMB to aim, LMB to shoot' : 'Speargun stowed', 1800 );

				}

			} else if ( this.weapon === 'rod' && can && ! this.fight ) {

				rod.equip( ! rod.equipped );
				if ( ! rod.equipped ) this.cancelLine();
				this.toast( rod.equipped ? 'Rod out · hold left mouse to cast' : 'Rod away', 1600 );

			}

		}

		if ( ! can && rod.equipped ) {

			// swimming, driving, free camera: the line comes in and the rod goes away
			this.cancelLine( true );
			rod.equip( false );

		}

		if ( ! canSpear && speargun.equipped ) {

			speargun.equip( false );

		}

		if ( this.hud && ( inp.hit( 'KeyI' ) || inp.hit( 'Tab' ) ) ) this.hud.toggleInventory();
		if ( this.hud && inp.hit( 'Escape' ) ) {

			this.hud.toggleInventory( false );
			this.hud.closeStand();

		}

		// mouse edges (the left button also looks around while the pointer isn't captured)
		const lmb = inp.mouseDown && inp.enabled, rmb = inp.rightDown && inp.enabled;
		const lDown = lmb && ! this._lmb, lUp = ! lmb && this._lmb, rDown = rmb && ! this._rmb;
		this._lmb = lmb;
		this._rmb = rmb;
		const panelOpen = this.hud && ( this.hud.invOpen || this.hud.standOpen );

		if ( this.weapon === 'rod' && rod.equipped && ! panelOpen ) {

			if ( rod.state === 'idle' && lDown ) rod.startWindup();
			else if ( rod.state === 'windup' && lUp ) rod.release();
			else if ( rod.state === 'floating' ) {

				if ( lDown ) this.strike();
				else if ( rDown ) {

					rod.retrieve();
					this.bite = null;

				}

			} else if ( rod.state === 'flying' && rDown ) rod.retrieve();

		} else if ( this.weapon === 'speargun' && speargun.equipped && ! panelOpen ) {

			// Q key: Spear Poke (repel sharks / close jab) - still works with a fish held on the spear
			if ( inp.hit( 'KeyQ' ) && ! this.fight ) {

				speargun.poke( this.sharks, app.reef?.fish );

			} else if ( this.heldSpearFish ) {

				// A fish is impaled and loaded at the muzzle: stash it before shooting again
				if ( lDown ) this.toast( `You already have a ${ this.heldSpearFish.name } on your spear · stash it first! [E]`, 2400 );

			} else if ( speargun.state === 'spearOut' && ! this.fight ) {

				// Spear in water: RMB or R retrieves it
				if ( rDown ) speargun.retrieve();

			} else if ( speargun.loaded && ! this.fight ) {

				if ( lDown ) {

					speargun.fire();

				}

			}

		}

		// bites and the fight
		if ( rod.state === 'floating' ) this.updateBite( dt );
		else if ( ! this.fight ) rod.dip = Math.max( 0, rod.dip - dt * 4 );
		if ( this.fight ) this.updateFight( dt, lmb && ! panelOpen );

		rod.update( dt, { visible: can && this.weapon === 'rod', fight: this.fight } );
		speargun.update( dt, { visible: canSpear && this.weapon === 'speargun', aiming: rmb && speargun.equipped && ! panelOpen, fishSchools: app.reef?.fish, fight: this.fight } );

		// ---- Oxygen / Breath Hold & Blackout Simulation
		const isSubmerged = ( p.mode === 'swim' ) && ( ! p.floating || app.camera.position.y < p.waterH - 0.05 );
		if ( isSubmerged ) {

			this.breath = Math.max( 0, this.breath - dt );
			if ( this.breath <= 0 && this.blackoutT <= 0 ) {

				// Shallow water blackout!
				this.blackoutT = 3.2;
				this.toast( '⚠️ Blackout! You ran out of oxygen and passed out! Floating to surface...', 4000 );
				if ( this.heldSpearFish ) {

					this.toast( `Dropped ${ this.heldSpearFish.name } during the blackout!`, 3500 );
					this.dropHeldSpearFish();

				}
				// Float player to surface
				p.floating = true;
				p.position.y = p.waterH - 0.15;
				p.velocity.set( 0, 0, 0 );

			} else if ( this.breath <= 30 && ! this._breathWarned ) {

				this._breathWarned = true;
				this.toast( '⚠️ Low oxygen! 30s remaining · Head for the surface!', 3000 );

			}

		} else {

			// Surfaced or out of water: recover breath quickly (~5-6s full recovery)
			this.breath = Math.min( this.maxBreath, this.breath + dt * ( this.maxBreath / 5 ) );
			if ( this.breath > 45 ) this._breathWarned = false;

		}

		if ( this.blackoutT > 0 ) {

			this.blackoutT = Math.max( 0, this.blackoutT - dt );
			p.floating = true;
			p.position.y = Math.max( p.position.y, p.waterH - 0.15 );
			p.velocity.set( 0, 0, 0 );

		}

		// ---- Spearfishing Systems: Dive Float, Bombies Cover, and Shark AI
		this.diveFloat.update( dt, p.position, p.mode === 'swim', p.waterH );

		const bombieCover = ( p.mode === 'swim' ) ? this.bombies.checkCover( p.position ) : null;
		if ( app.reef && app.reef.fish ) {

			app.reef.fish.stealthCover = !! bombieCover;

		}

		// Sharks stay clear until the diver has proven themselves; then just one at a time comes in for
		// an encounter (circle the float / diver, maybe steal an unattended fish, a few bluff charges,
		// then either a poke sends it packing or it snatches a held fish) while the rest keep cruising
		// far off. See src/world/Shark.js for the state machine and its tuning constants.
		const sharksHungry = ( p.mode === 'swim' ) && ( this.speargunLandings >= SHARK_ENGAGE_LANDINGS );
		let anyEngaged = this.sharks.some( ( s ) => s.engaged );

		for ( const shark of this.sharks ) {

			const wasEngaged = shark.engaged;
			shark.update( dt, {
				playerPos: p.position,
				playerInWater: p.mode === 'swim',
				allowEngage: sharksHungry && ! anyEngaged,
				floatActive: this.diveFloat.active,
				floatPos: this.diveFloat.position,
			} );

			// An encounter just concluded (poked off, snatched and fled, or gave up): the cooldown for
			// the next one starts fresh from here.
			if ( wasEngaged && ! shark.engaged ) this.speargunLandings = 0;
			if ( ! shark.engaged ) continue;
			anyEngaged = true; // lock every other shark out of engaging for the rest of this frame

			// Theft: while circling the float, if the diver has drifted well away, it can grab one fish
			if ( shark.wantsToSteal && this.diveFloat.stashedFish.length ) {

				const stolen = this.diveFloat.stashedFish.shift();
				shark.markStolen();
				const sName = ( FISH[ stolen.species ] || {} ).name || 'fish';
				this.toast( `A shark tore a ${ sName } from your dive float!`, 3200 );

			}

			// Bluff charges: a brief, throttled heads-up so the player knows to poke it
			if ( shark.state === 'charge' && this._sharkWarningT <= 0 ) {

				this._sharkWarningT = SHARK_CHARGE_TOAST_S;
				this.toast( 'Shark! Poke it with [Q] before it gets close!', 2200 );

			}

			// Charges are done: if the diver never poked it off and still has a fish, the shark takes it
			if ( shark.state === 'snatch' ) {

				const hasFish = !! this.heldSpearFish || !! speargun.spearedFish;
				if ( hasFish && shark.position.distanceTo( p.position ) < SHARK_SNATCH_RANGE ) {

					const name = this.heldSpearFish ? this.heldSpearFish.name : ( FISH[ speargun.spearedFish?.speciesKey ] || {} ).name || 'fish';
					if ( this.dropHeldSpearFish ) this.dropHeldSpearFish();
					this.toast( `A shark snatched your ${ name }! Poke it early next time with [Q]!`, 3500 );
					shark.snatch();

				} else if ( ! hasFish ) {

					shark.disengage();

				}

			}

		}
		if ( this._sharkWarningT > 0 ) this._sharkWarningT -= dt;

		// Stash speared fish into Dive Float (or aboard Boat / on land into cooler)
		const nearFloat = ( p.mode === 'swim' ) && ( p.position.distanceTo( this.diveFloat.position ) < 3.5 );
		const onBoatOrDeck = ( p.mode === 'deck' || p.mode === 'boat' );
		const onLand = ( p.mode === 'walk' );
		const canStash = this.heldSpearFish && ( nearFloat || onBoatOrDeck || onLand );

		if ( canStash && inp.hit( 'KeyE' ) && ! panelOpen && ! this._cardDismissed ) {

			const fish = this.heldSpearFish;
			if ( nearFloat ) {

				if ( ! this.diveFloat.fits( fish.kg ) ) {

					this.toast( `⚠️ Dive Float is full (${ this.diveFloat.totalKg.toFixed( 1 ) } / ${ this.diveFloat.maxKg } kg)! Return to boat or shore to transfer fish to cooler.`, 4000 );

				} else {

					this.heldSpearFish = null;
					this.releaseSpear();
					const logged = this.state.recordCatch( fish.species, fish.kg, this.hour, !! fish.stoned );
					this.diveFloat.stash( logged );
					const info = this.state.lastCatch;
					if ( this.hud && info ) this.hud.showCatch( info, CATCH_CARD_MS );
					this.toast( `Stashed ${ fish.name } in Dive Float (${ this.diveFloat.totalKg.toFixed( 1 ) } / ${ this.diveFloat.maxKg } kg)!`, 3500 );
					if ( app.audio && app.audio.fishFlop ) app.audio.fishFlop();

				}

			} else if ( onBoatOrDeck || onLand ) {

				if ( ! this.state.fits( fish.kg ) ) {

					this.toast( `⚠️ Cooler is full (${ this.state.holdKg.toFixed( 1 ) } / ${ this.state.stats.holdKg } kg)! Sell fish at Joe's pier stall to free space.`, 4000 );

				} else {

					this.heldSpearFish = null;
					this.releaseSpear();
					const entry = this.state.addFish( fish.species, fish.kg, this.hour, !! fish.stoned );
					const info = this.state.lastCatch;
					if ( this.hud && info ) this.hud.showCatch( info, CATCH_CARD_MS );
					else if ( entry ) this.toast( `Stashed ${ fish.name } in Cooler (${ this.state.holdKg.toFixed( 1 ) } / ${ this.state.stats.holdKg } kg)!`, 3500 );
					if ( app.audio && app.audio.fishFlop ) app.audio.fishFlop();

				}

			}

		}

		// Transfer fish from Dive Float into Boat Cooler / Hold
		const hasFloatFish = this.diveFloat && this.diveFloat.stashedFish.length > 0;
		const canTransferFloat = ( onBoatOrDeck || onLand ) && hasFloatFish && ! this.heldSpearFish;
		if ( canTransferFloat && inp.hit( 'KeyE' ) && ! panelOpen && ! this._cardDismissed ) {

			this.transferFloatToCooler();

		}

		// the landed fish hangs on the end of the line, turned to face you, then goes in the cooler. With
		// the HUD the catch card comes up once the fish has swung in, and the fish stays (slowly turning)
		// until the card is dismissed (click, E, Esc) or times out.
		const L = this.landing;
		if ( L && rod.state === 'landing' && can ) {

			const c = app.camera.position, m = rod.bobber;
			let yaw = Math.atan2( c.x - m.x, c.z - m.z );
			if ( L.card ) {

				if ( ! L.shown && rod.t > 0.3 ) {

					L.shown = true;
					this.hud.showCatch( L.card, CATCH_CARD_MS );

				}

				if ( L.shown ) {

					// a slow turn so both flanks show
					L.cardT += dt;
					yaw += Math.sin( L.cardT * 0.7 ) * 0.55;
					if ( lDown || inp.hit( 'KeyE' ) || inp.hit( 'Escape' ) || L.cardT > CATCH_CARD_MS / 1000 ) {

						this._cardDismissed = true; // this frame's E / click belong to the card
						this.endLanding();

					}

				}

			}

			if ( this.landing ) {

				// with the HUD the fish is shown on the full-screen catch card (studio portrait), not on
				// the line; without it (headless) it hangs on the line for a moment
				if ( ! L.card ) this.display.show( L.species, L.kg, m, yaw, dt );
				else if ( this.display.shown ) this.display.hide();
				if ( ! L.card && rod.t > 2.8 ) this.endLanding();

			}

		} else if ( this.landing || this.display.shown ) this.endLanding();

		// Universal Catch Card dismissal (works for spearfishing, diving, boat, or rod)
		if ( this.hud && this.hud.catchOpen ) {

			this._cardT = ( this._cardT || 0 ) + dt;
			if ( this._cardT > 0.25 ) {

				if ( lDown || rDown || inp.hit( 'KeyE' ) || inp.hit( 'Escape' ) || inp.hit( 'Space' ) || this._cardT > CATCH_CARD_MS / 1000 ) {

					this._cardDismissed = true;
					this._cardT = 0;
					this.hud.hideCatch();
					if ( this.landing ) this.endLanding();

				}

			}

		} else {

			this._cardT = 0;
			if ( ! inp.down( 'KeyE' ) && ! inp.mouseDown ) this._cardDismissed = false;

		}

		p.busy = rod.lineInWater || rod.state === 'windup';

		this.updateBoat( dt );

		// the traders
		for ( const v of this.vendors ) v.update( dt, p.mode === 'walk' ? p.position : null );
		this.updateVendors( inp, p );

		// prompts when the player has nothing to say, or when holding fish / float transfer is available
		const hasFloatTransfer = ( p.mode === 'deck' || p.mode === 'boat' || p.mode === 'walk' ) && this.diveFloat && this.diveFloat.stashedFish.length > 0;
		if ( this.heldSpearFish || hasFloatTransfer ) {

			p.prompt = this.prompt();

		} else if ( ! p.prompt && ( can || canSpear ) ) {

			p.prompt = this.prompt();

		}

		const aboard = p.mode === 'boat' || p.mode === 'deck';
		// the catch card's live fish portrait (or one queued thumbnail)
		if ( this.hud && this.hud.portrait ) this.hud.portrait.update( dt );
		const inWater = ( p.mode === 'swim' );
		const floatDist = inWater ? p.position.distanceTo( this.diveFloat.position ) : null;
		if ( this.hud ) this.hud.update( {
			fuel: aboard ? { litres: this.state.fuelL, tank: this.state.stats.fuelL } : null,
			sonar: aboard && this.state.stats.finder ? this._sonar : null,
			fight: this.fight,
			casting: rod.state === 'windup',
			power: rod.power,
			bite: this.bite && this.bite.phase === 'take',
			aiming: ( this.weapon === 'rod' && rod.equipped ) || ( this.weapon === 'speargun' && speargun.equipped ),
			breath: this.breath,
			maxBreath: this.maxBreath,
			blackout: this.blackoutT > 0,
			heldFish: this.heldSpearFish,
			floatDist: floatDist,
			floatKg: this.diveFloat ? this.diveFloat.totalKg : 0,
			floatMaxKg: this.diveFloat ? this.diveFloat.maxKg : 15,
			inWater: inWater,
		} );
		if ( this.minimap ) this.minimap.update( dt );
		if ( this.guide ) this.guide.update( dt );

	}

	prompt() {

		const rod = this.rod, speargun = this.speargun, p = this.app.player;

		if ( this.fight ) {

			// the speargun fight uses the same tension-band controls and HUD as the rod: one prompt for both
			const f = this.fight;
			return f.tension > f.band[ 1 ]
				? { key: 'LMB', text: 'Too much tension · let go!' }
				: { key: 'LMB', text: 'Hold to reel · let go when the tension goes red' };

		}

		if ( this.heldSpearFish ) {

			const nearFloat = ( p.mode === 'swim' ) && ( p.position.distanceTo( this.diveFloat.position ) < 3.5 );
			const onBoatOrDeck = ( p.mode === 'deck' || p.mode === 'boat' );
			const onLand = ( p.mode === 'walk' );
			if ( nearFloat ) {

				return { key: 'E', text: `Stash ${ this.heldSpearFish.name } in Dive Float (${ this.diveFloat.totalKg.toFixed( 1 ) } / ${ this.diveFloat.maxKg } kg)` };

			}
			if ( onBoatOrDeck ) {

				return { key: 'E', text: `Stash ${ this.heldSpearFish.name } in Boat Cooler` };

			}
			if ( onLand ) {

				return { key: 'E', text: `Stash ${ this.heldSpearFish.name } in Cooler` };

			}

			const dist = p.position.distanceTo( this.diveFloat.position ).toFixed( 1 );
			return { text: `Swim to Dive Float (${ dist }m) or Boat to stash ${ this.heldSpearFish.name }! Watch for sharks!` };

		}

		// Offer float transfer if diver boarded boat or walked ashore with fish in float
		if ( ( p.mode === 'deck' || p.mode === 'boat' || p.mode === 'walk' ) && this.diveFloat && this.diveFloat.stashedFish.length > 0 ) {

			const target = ( p.mode === 'deck' || p.mode === 'boat' ) ? 'Boat Cooler' : 'Cooler';
			return { key: 'E', text: `Transfer ${ this.diveFloat.totalKg.toFixed( 1 ) } kg fish from Dive Float to ${ target }` };

		}

		const cover = ( p.mode === 'swim' ) ? this.bombies.checkCover( p.position ) : null;
		const coverTag = cover ? `   ·   🪨 In Cover: ${ cover.name }` : '';
		const floatTag = ( p.mode === 'swim' ) ? `   ·   🛟 Float deployed: [E] stash (${ this.diveFloat.totalKg.toFixed( 1 ) }/15kg)` : '';

		if ( this.weapon === 'speargun' ) {

			if ( ! speargun.equipped ) {

				return { key: 'R', text: 'Take out speargun   ·   1  Fishing rod' + coverTag };

			}

			if ( speargun.state === 'spearOut' ) {

				return { key: 'RMB', text: 'Retrieve spear & reload' + ( ( p.mode === 'swim' ) ? '   ·   🛟 Float deployed (stash with [E])' : '' ) };

			}

			if ( speargun.state === 'reloading' ) {

				return { text: 'Loading spear and cocking bands...' + ( ( p.mode === 'swim' ) ? '   ·   🛟 Float deployed' : '' ) };

			}

			if ( speargun.aiming ) {

				return { key: 'LMB', text: 'Shoot spear   ·   Release RMB to lower' + floatTag + coverTag };

			}

			return { key: 'LMB', text: 'Shoot spear   ·   Hold RMB: Aim   ·   Q: Spear poke' + floatTag + coverTag };

		}

		if ( ! rod.equipped ) {

			// by the water (boat deck, pier, the wet beach, wading): suggest the rod
			const byWater = p.mode === 'deck' || ( p.mode === 'walk' && [ 'wood', 'wetsand', 'water' ].includes( p.surface ) );
			return byWater ? { key: 'R', text: 'Take out the rod   ·   2  Speargun' } : null;

		}

		const b = this.bite;
		switch ( rod.state ) {

			case 'idle': return { key: 'LMB', text: 'Hold to wind up, release to cast   ·   R  put the rod away' };
			case 'windup': return { key: 'LMB', text: 'Release to cast (hold longer to cast farther)' };
			case 'flying': return null;
			case 'floating':
				if ( b && b.phase === 'take' ) return { key: 'LMB', text: 'Strike now!' };
				if ( b && b.phase === 'nibble' ) return { key: '…', text: 'Something\'s nibbling · wait until the bobber is pulled under' };
				return { key: 'RMB', text: 'Waiting for a bite · right-click to reel the line in' };
			case 'retrieving': return { key: 'RMB', text: 'Reeling in' };
			case 'landing': return null;
			default: return null;

		}

	}

	// fuel burn at the helm (the engine stops when the tank is dry) and the fish finder
	updateBoat( dt ) {

		const app = this.app, b = app.boatCtl, p = app.player, s = this.state;
		if ( b.driven ) {

			const left = s.burn( fuelBurn( b.rpm ) * dt );
			if ( left <= 0 ) {

				b.throttle = 0;
				if ( ! this._fuelOut ) this.toast( 'Out of fuel · buy diesel at the chandlery by the boathouse', 4000 );
				this._fuelOut = true;

			}

		} else if ( this._wasDriven ) s.save();
		this._wasDriven = b.driven;

		if ( ( p.mode === 'boat' || p.mode === 'deck' ) && s.stats.finder ) {

			this._sonarT -= dt;
			if ( this._sonarT <= 0 ) {

				this._sonarT = 0.5;
				const x = b.position.x, z = b.position.z;
				const depth = Math.max( 0, - app.terrainData.heightAt( x, z ) );
				const h = this.habitatAtPoint( x, z, depth );
				let rich = 0;
				for ( const k in h ) rich += h[ k ];
				this._sonar = { depth, fish: Math.min( 1, rich / 1.4 ) };

			}

		}

	}

	updateVendors( inp, p ) {

		const hud = this.hud;
		let near = null;
		if ( p.mode === 'walk' ) for ( const v of this.vendors ) if ( v.inRange( p.position ) ) near = v;
		for ( const v of this.vendors ) v.talking = !! ( hud && hud.standOpen && hud.vendor === v );
		if ( hud && hud.standOpen && ( ! near || near !== hud.vendor ) ) hud.closeStand();
		if ( ! near || this.fight || this._cardDismissed || ( hud && hud.catchOpen ) ) return;
		if ( ! p.prompt ) p.prompt = { key: 'E', text: hud && hud.standOpen ? 'Leave' : `Talk to ${ near.name.split( ' ·' )[ 0 ] }` };
		if ( inp.hit( 'KeyE' ) ) {

			if ( ! hud ) {

				if ( near.kind === 'buyer' ) this.sellAll(); // headless: straight sale

			} else if ( hud.standOpen ) hud.closeStand();
			else hud.openStand( near );

		}

	}

	transferFloatToCooler() {

		if ( ! this.diveFloat || ! this.diveFloat.stashedFish.length ) return;
		const stashed = this.diveFloat.empty();
		let transferred = 0;
		let transferredKg = 0;
		const leftover = [];
		for ( const f of stashed ) {

			if ( this.state.storeFish( f ) ) {

				transferred ++;
				transferredKg += f.kg;

			} else {

				leftover.push( f );

			}

		}
		for ( const f of leftover ) this.diveFloat.stash( f );

		if ( transferred > 0 ) {

			if ( this.app.audio && this.app.audio.fishFlop ) this.app.audio.fishFlop();
			const onBoat = ( this.app.player.mode === 'deck' || this.app.player.mode === 'boat' );
			const target = onBoat ? 'Boat Cooler' : 'Cooler';
			if ( leftover.length === 0 ) {

				this.toast( `✅ Transferred ${ transferred } fish (${ transferredKg.toFixed( 1 ) } kg) from Float into ${ target }! Float emptied (0 / 15 kg).`, 4200 );

			} else {

				this.toast( `⚠️ Cooler full! Transferred ${ transferred } fish (${ transferredKg.toFixed( 1 ) } kg). ${ leftover.length } fish remain in Float. Sell catch to free space!`, 4500 );

			}

		} else {

			this.toast( `⚠️ Cooler is full (${ this.state.holdKg.toFixed( 1 ) } / ${ this.state.stats.holdKg } kg)! Sell fish at Joe's pier stall to store more.`, 4000 );

		}

	}

	sellAll() {

		const r = this.state.sell();
		if ( r.count ) this.toast( `Sold ${ r.count } fish for $${ r.total }` );
		if ( this.app.audio && this.app.audio.coin ) this.app.audio.coin();
		return r;

	}

	sell( ids ) {

		const r = this.state.sell( ids );
		if ( r.count ) this.toast( `Sold for $${ r.total }` );
		return r;

	}

	// ---- bites
	habitat() {

		return this.habitatAtPoint( this.rod.bobber.x, this.rod.bobber.z, this.rod.depth );

	}

	habitatAtPoint( x, z, depth ) {

		const b = { x, z };
		const reef = WORLD.reef;
		const reefDist = Math.hypot( b.x - reef.center.x, b.z - reef.center.z ) - reef.radius;
		const P = this._pier;
		const rect = ( x0, x1, z0, z1 ) => Math.hypot( Math.max( x0 - b.x, 0, b.x - x1 ), Math.max( z0 - b.z, 0, b.z - z1 ) );
		const walk = rect( P.x - P.width / 2, P.x + P.width / 2, P.zStart, P.zEnd );
		const head = rect( P.x - P.headWidth / 2, P.x + P.headWidth / 2, P.zEnd - P.headDepth, P.zEnd );
		return habitatAt( { depth, reefDist, pierDist: Math.min( walk, head ) } );

	}

	get hour() {

		return this.app.settings.timeOfDay;

	}

	onBobberLanded( where ) {

		if ( where !== 'water' ) {

			this.toast( 'Landed on the sand', 1400 );
			return;

		}

		this.bite = { phase: 'wait', t: biteDelay( this.habitat(), this.hour ) };

	}

	updateBite( dt ) {

		const rod = this.rod;
		const b = this.bite;
		if ( ! b ) return;
		b.t -= dt;
		// bobber motion for the cues
		if ( b.phase === 'nibble' ) rod.dip = Math.max( 0, Math.sin( Math.min( 1, ( b.pulse || 0 ) ) * Math.PI ) * 0.45 );
		else if ( b.phase === 'take' ) rod.dip += ( 1.4 - rod.dip ) * ( 1 - Math.exp( - dt * 14 ) );
		else rod.dip = Math.max( 0, rod.dip - dt * 3 );
		if ( b.phase === 'nibble' ) b.pulse = ( b.pulse || 0 ) + dt * 3.2;

		if ( b.t > 0 ) return;
		if ( b.phase === 'wait' ) {

			const h = this.habitat();
			const species = pickSpecies( h, this.hour );
			if ( ! species ) {

				b.t = 8;
				return;

			}

			b.species = species;
			b.kg = rollWeight( species );
			b.phase = 'nibble';
			b.nibbles = 1 + Math.floor( Math.random() * 3 );
			b.t = 0.7 + Math.random() * 0.8;
			b.pulse = 0;

		} else if ( b.phase === 'nibble' ) {

			b.nibbles --;
			b.pulse = 0;
			if ( b.nibbles > 0 ) b.t = 0.6 + Math.random() * 1.0;
			else {

				b.phase = 'take';
				// big, strong fish give a (slightly) shorter window
				b.t = 2.4 - FISH[ b.species ].fight * 0.5;
				if ( this.app.audio && this.app.audio.fishSplash ) this.app.audio.fishSplash( rod.bobber, 0.35 );

			}

		} else if ( b.phase === 'take' ) {

			this.toast( 'It took the bait and ran', 1800 );
			this.bite = { phase: 'wait', t: biteDelay( this.habitat(), this.hour ) };

		}

	}

	strike() {

		const b = this.bite;
		if ( ! b || b.phase === 'wait' || b.phase === 'nibble' ) {

			// too early: a nibbling fish isn't hooked yet; it keeps nibbling (a hint, no penalty)
			if ( b && b.phase === 'nibble' ) this.toast( 'Not yet · wait for it to pull under', 1500 );
			return;

		}

		const g = this.state.stats;
		this.fight = new CatchMinigame( { species: b.species, kg: b.kg, lineKg: g.lineKg, reelSpeed: g.reelSpeed, distance: Math.max( 3, this.rod.lineOut ) } );
		this.bite = null;
		this.rod.hook();
		this.toast( 'Fish on!', 1200 );

	}

	// The held catch has been stashed: release the impaled fish mesh and let the gun reload
	releaseSpear() {

		if ( this.app.reef?.fish ) this.app.reef.fish.releaseImpaledFish();
		this.speargun.spearedFish = null;
		this.speargun.reload();

	}

	// Cleanly loses whatever fish is currently on the spear - impaled and being fought, or landed and
	// held at the muzzle - without stashing it: releases the impaled fish mesh, clears the held-fish
	// state and re-enables the gun. Used for a shark snatch and a blackout drop; called by name from
	// the shark AI too, so keep the name and no-argument signature stable.
	dropHeldSpearFish() {

		if ( this.fight && this.fight._isSpeargun ) this.fight = null;
		if ( this.app.reef?.fish ) this.app.reef.fish.releaseImpaledFish();
		this.speargun.spearedFish = null;
		if ( this.speargun.state === 'held' ) this.speargun.reload();
		else if ( this.speargun.state === 'fighting' || this.speargun.state === 'spearOut' ) this.speargun.retrieve();
		this.heldSpearFish = null;

	}

	updateFight( dt, reeling ) {

		const f = this.fight;
		const st = f.update( dt, reeling );
		const au = this.app.audio;

		if ( f._isSpeargun ) {

			// The speargun's own update() positions and thrashes the impaled fish along the shooting
			// line each frame (mirrors how the rod fight drives the bobber) - nothing to drive here.

			// Thrashing splash as each surge starts, same cue as the rod
			if ( f.surge > 0.6 && ! f._splashed && au && au.fishSplash ) au.fishSplash( this.speargun.spearPos, 0.3 + 0.5 * Math.min( 1, f.kg / 8 ) );
			f._splashed = f.surge > 0.6 ? true : f.surge < 0.3 ? false : f._splashed;

			if ( st === 'fighting' ) return;
			this.fight = null;
			const name = FISH[ f.species ].name;

			if ( st === 'caught' ) {

				// Count every landed speargun catch toward the next shark encounter
				this.speargunLandings = ( this.speargunLandings || 0 ) + 1;

				// Fish reeled in! It stays impaled, loaded at the muzzle, until it's stashed
				if ( au && au.fishSplash ) au.fishSplash( this.speargun.muzzlePos, 0.8 );
				if ( au && au.fishFlop ) au.fishFlop();

				if ( this.app.player.mode === 'swim' ) {

					this.speargun.hold();
					this.heldSpearFish = { species: f.species, kg: f.kg, name: name, stoned: false };
					this.toast( `Landed ${ name } (${ f.kg.toFixed( 1 ) } kg)! It's held on your spear - stash it in your Dive Float [E]!`, 4200 );

				} else {

					// On boat or shore: directly into cooler/hold, spear clears at once
					this.releaseSpear();
					const entry = this.state.addFish( f.species, f.kg, this.hour );
					const info = this.state.lastCatch;
					if ( this.hud && info ) this.hud.showCatch( info, CATCH_CARD_MS );
					else if ( entry ) this.toast( `${ name } · ${ entry.kg.toFixed( 2 ) } kg · $${ entry.value }`, 3600 );

				}

			} else if ( st === 'snapped' ) {

				// The shooting line itself snapped: the whole spear (and the fish on it) is lost
				this.toast( 'Snap! The shooting line snapped - you lost the spear and the fish!', 2800 );
				if ( au && au.lineSnap ) au.lineSnap();
				this.releaseSpear();

			} else {

				// Slack for too long: the barb tears out and the fish escapes, but the spear comes back
				this.toast( 'The fish tore off the spear barb and escaped!', 2400 );
				if ( this.app.reef?.fish ) this.app.reef.fish.releaseImpaledFish();
				this.speargun.spearedFish = null;
				this.speargun.retrieve();

			}

			return;

		}

		// the fish thrashes at the surface as each run starts
		if ( f.surge > 0.6 && ! f._splashed && au && au.fishSplash ) au.fishSplash( this.rod.bobber, 0.3 + 0.5 * Math.min( 1, f.kg / 8 ) );
		f._splashed = f.surge > 0.6 ? true : f.surge < 0.3 ? false : f._splashed;
		if ( st === 'fighting' ) return;
		this.fight = null;
		this.rod.dip = 0;
		const name = FISH[ f.species ].name;
		if ( st === 'caught' ) {

			const entry = this.state.addFish( f.species, f.kg, this.hour );
			const info = this.state.lastCatch;
			if ( au && au.fishSplash ) au.fishSplash( this.rod.bobber, 0.8 );
			if ( au && au.fishFlop ) au.fishFlop();
			// the catch card (with a HUD) while the fish hangs on the line; a toast otherwise
			if ( this.hud ) this.landing = { species: f.species, kg: f.kg, card: info, cardT: 0 };
			else {

				if ( entry ) this.toast( `${ info.record ? 'New record! ' : '' }${ name } · ${ entry.kg.toFixed( 2 ) } kg · $${ entry.value }`, 3600 );
				else this.toast( `${ name } · ${ f.kg.toFixed( 1 ) } kg · no room in the ${ this.state.upgrades.hold > 0 ? 'hold' : 'cooler' }, let it go`, 3600 );
				this.landing = { species: f.species, kg: f.kg };

			}

			this.rod.land();

		} else if ( st === 'snapped' ) {

			this.toast( 'Snap! The line broke', 2400 );
			if ( au && au.lineSnap ) au.lineSnap();
			this.rod.setState( 'idle' );

		} else {

			this.toast( 'It threw the hook', 2000 );
			this.rod.endFight();

		}

	}

	// the landed fish goes in the cooler: card, fish and line away
	endLanding() {

		this.landing = null;
		this.display.hide();
		if ( this.hud && this.hud.catchOpen ) this.hud.hideCatch();
		if ( this.rod.state === 'landing' ) this.rod.setState( 'idle' );

	}

	// line in at once (mode change)
	cancelLine( silent = false ) {

		if ( this.fight && ! silent ) this.toast( 'Lost it', 1400 );
		if ( this.fight && this.fight._isSpeargun ) {

			if ( this.app.reef?.fish ) this.app.reef.fish.releaseImpaledFish();
			if ( this.speargun.spearedFish ) this.speargun.spearedFish = null;
			this.speargun.retrieve();

		}
		this.fight = null;
		this.bite = null;
		if ( this.rod.state !== 'stowed' ) this.rod.setState( this.rod.equipped ? 'idle' : 'stowed' );

	}

}

// Catchable fish: game data for the species the world already swims (world/fish/FishSpecies.js).
//
//   name      display name
//   sci       scientific name
//   lw        [ a, b ] length-weight relation W (g) = a * L (cm, total length) ^ b (FishBase-style values)
//   model     key in SPECIES (the swimming model / skin)
//   habitat   weights per water type (see Bites.habitatAt): shallows (sand, < 3 m), reef (over the
//             reef), pier (around the piles), bay (open water 3–20 m), deep (offshore, > 20 m)
//   kg        [ min, max ] weight; sizes follow a skewed distribution (most fish are small). The
//             min is set so fishLengthCm( id, kg[0] ) clears `mls` with a little headroom, so a
//             rod or spear catch can never be an undersized fish (see rollWeight / onFishHit).
//   mls       recreational minimum legal size in cm (Fisheries New Zealand / MPI, general North
//             Island figure — some areas differ), or null where MPI sets no minimum size.
//             Sources: MPI "Recreational daily bag limits and size restrictions for finfish"
//             (mpi.govt.nz/dmsdocument/47794) and the Auckland & Kermadec area fishing rules
//             (mpi.govt.nz/fishing-aquaculture/recreational-fishing/fishing-rules/auckland-kermadec-fishing-rules).
//   price     $ per kg at the fish stand
//   fight     0..1 how hard it pulls (surge strength and frequency in the catch mini-game)
//   stamina   seconds of good pressure it takes to tire a typical one
//   time      activity by time of day: 'day', 'dawnDusk', 'night' or 'any'
//   rarity    0..1, scales how often it bites relative to the others in the same water
export const FISH = {
	silverside: { name: 'Inanga / Smelt (Pōrohe)', sci: 'Galaxias maculatus', lw: [ 0.0074, 3.1 ], model: 'silverside', habitat: { shallows: 1, pier: 0.6, bay: 0.3 }, kg: [ 0.02, 0.08 ], mls: null, price: 3, fight: 0.05, stamina: 1.5, time: 'any', rarity: 0.3 },
	mullet: { name: 'Yellow-eye Mullet (Aua)', sci: 'Aldrichetta forsteri', lw: [ 0.0112, 2.98 ], model: 'mullet', habitat: { shallows: 1, pier: 0.6, bay: 0.4 }, kg: [ 0.08, 0.7 ], mls: null, price: 6, fight: 0.3, stamina: 5, time: 'day', rarity: 0.8 },
	needlefish: { name: 'Piper / Garfish (Takeke)', sci: 'Hyporhamphus ihi', lw: [ 0.0012, 3.1 ], model: 'needlefish', habitat: { shallows: 0.7, bay: 0.5, pier: 0.3 }, kg: [ 0.03, 0.25 ], mls: null, price: 5, fight: 0.45, stamina: 5, time: 'day', rarity: 0.5 },
	sergeant: { name: 'Tarakihi', sci: 'Nemadactylus macropterus', lw: [ 0.0234, 3.0 ], model: 'sergeant', habitat: { pier: 1, reef: 0.9, bay: 0.6 }, kg: [ 0.4, 3.9 ], mls: 25, price: 14, fight: 0.25, stamina: 3.5, time: 'day', rarity: 1 },
	grunt: { name: 'Blue Cod (Rāwaru)', sci: 'Parapercis colias', lw: [ 0.0145, 3.06 ], model: 'grunt', habitat: { pier: 1, reef: 0.9, bay: 0.4 }, kg: [ 0.5, 2.1 ], mls: 30, price: 15, fight: 0.25, stamina: 4, time: 'any', rarity: 1 },
	yellowtail: { name: 'Yellowtail Kingfish (Kahu)', sci: 'Seriola lalandi', lw: [ 0.0137, 2.98 ], model: 'yellowtail', habitat: { reef: 1, pier: 0.6, bay: 0.7 }, kg: [ 5.5, 28 ], mls: 75, price: 22, fight: 0.4, stamina: 5, time: 'dawnDusk', rarity: 0.9 },
	chromis: { name: 'Two-tone Demoiselle', sci: 'Chromis dispilus', lw: [ 0.0209, 3.0 ], model: 'chromis', habitat: { reef: 1 }, kg: [ 0.03, 0.1 ], mls: null, price: 4, fight: 0.05, stamina: 1.5, time: 'day', rarity: 0.4 },
	tang: { name: 'Red Moki (Nanua)', sci: 'Cheilodactylus spectabilis', lw: [ 0.0282, 2.95 ], model: 'tang', habitat: { reef: 1 }, kg: [ 1.6, 5 ], mls: 40, price: 10, fight: 0.2, stamina: 3, time: 'day', rarity: 0.6 },
	wrasse: { name: 'Butterfish / Greenbone (Mararī)', sci: 'Odax pullus', lw: [ 0.0151, 3.07 ], model: 'wrasse', habitat: { reef: 0.9, bay: 0.4 }, kg: [ 0.9, 3.4 ], mls: 35, price: 17, fight: 0.35, stamina: 6, time: 'day', rarity: 0.5 },
	parrot: { name: 'Porae', sci: 'Nemadactylus douglasii', lw: [ 0.0151, 3.06 ], model: 'parrot', habitat: { reef: 1 }, kg: [ 0.8, 4 ], mls: null, price: 11, fight: 0.35, stamina: 6, time: 'day', rarity: 0.5 },
	angel: { name: 'John Dory (Kuparu)', sci: 'Zeus faber', lw: [ 0.0302, 2.94 ], model: 'angel', habitat: { reef: 1, bay: 0.4 }, kg: [ 0.4, 1.6 ], mls: null, price: 21, fight: 0.25, stamina: 4, time: 'day', rarity: 0.4 },
	jack: { name: 'Silver Trevally (Araara)', sci: 'Pseudocaranx georgianus', lw: [ 0.02, 2.93 ], model: 'jack', habitat: { shallows: 0.5, pier: 0.7, bay: 0.8, reef: 0.8 }, kg: [ 0.35, 3.3 ], mls: 25, price: 12, fight: 0.75, stamina: 12, time: 'dawnDusk', rarity: 0.7 },
	barracuda: { name: 'Barracouta (Mangā)', sci: 'Thyrsites atun', lw: [ 0.00437, 3.07 ], model: 'barracuda', habitat: { reef: 0.5, bay: 0.8, deep: 0.5 }, kg: [ 0.9, 8 ], mls: null, price: 7, fight: 0.7, stamina: 11, time: 'any', rarity: 0.45 },
	grouper: { name: 'Hāpuku / Grouper', sci: 'Polyprion oxygenios', lw: [ 0.0107, 3.07 ], model: 'grouper', habitat: { reef: 0.6, deep: 0.8 }, kg: [ 3, 20 ], mls: null, price: 20, fight: 0.6, stamina: 12, time: 'any', rarity: 0.35 },
	redSnapper: { name: 'NZ Snapper (Tāmure)', sci: 'Chrysophrys auratus', lw: [ 0.0137, 2.98 ], model: 'redSnapper', habitat: { deep: 1, bay: 0.5, reef: 0.8 }, kg: [ 0.45, 9.2 ], mls: 30, price: 19, fight: 0.5, stamina: 9, time: 'any', rarity: 0.8 },
	tuna: { name: 'Southern Bluefin Tuna', sci: 'Thunnus maccoyii', lw: [ 0.0145, 3.0 ], model: 'tuna', habitat: { deep: 1 }, kg: [ 8, 32 ], mls: null, price: 25, fight: 0.85, stamina: 16, time: 'dawnDusk', rarity: 0.5 },
	mahi: { name: 'Albacore Tuna (Ahipaoa)', sci: 'Thunnus alalunga', lw: [ 0.0079, 3.0 ], model: 'mahi', habitat: { deep: 0.8, bay: 0.3 }, kg: [ 4, 18 ], mls: null, price: 18, fight: 0.8, stamina: 15, time: 'day', rarity: 0.4 },
	tarpon: { name: 'Kahawai (Arripis)', sci: 'Arripis trutta', lw: [ 0.0077, 3.02 ], model: 'tarpon', habitat: { pier: 0.35, bay: 0.5, shallows: 0.15 }, kg: [ 0.55, 7 ], mls: null, price: 8, fight: 1, stamina: 24, time: 'night', rarity: 0.2 },
};

export const FISH_IDS = Object.keys( FISH );

// $ value of a fish; trophy-sized ones fetch a bit more per kg
export function fishValue( id, kg ) {

	const f = FISH[ id ];
	const t = ( kg - f.kg[ 0 ] ) / Math.max( f.kg[ 1 ] - f.kg[ 0 ], 1e-6 );
	return Math.max( 1, Math.round( f.price * kg * ( 1 + 0.25 * Math.max( 0, t - 0.7 ) / 0.3 ) ) );

}

// total length (cm) of a fish of `kg`, from its species' length-weight relation
export function fishLengthCm( id, kg ) {

	const [ a, b ] = FISH[ id ].lw;
	return Math.pow( Math.max( kg, 0.001 ) * 1000 / a, 1 / b );

}

import type { PresentationPack } from './presentation-schema';

/**
 * Published presentation packs. Append-only: a published (packId, packVersion)
 * is immutable. Changed or replacement artwork (including later raster art) is
 * a new packVersion with its own versioned asset directory, never an edit of
 * files under an existing one.
 *
 * Assets are public static files served by the web app from
 * apps/web/public/interactive/<packId>/v<packVersion>/.
 *
 * Alt text describes what the picture shows and adds nothing the player has not
 * been told by the current scene. s-end-quiet is reached by two delivery routes
 * (parcel left at the door, parcel handed over), so its art is a neutral
 * departure that asserts neither.
 */
export const WARSAW_NOIR_V1_DATA = {
  packId: 'warsaw-noir',
  packVersion: 1,
  scenarioId: 'warsaw-last-delivery',
  scenarioVersion: 1,
  scenes: {
    's-courtyard': [
      {
        id: 'p-courtyard',
        src: '/interactive/warsaw-noir/v1/s-courtyard.svg',
        width: 1200,
        height: 800,
        alt: 'A rain-soaked courtyard at night between tall tenement walls. A courier in the foreground holds a parcel while a lone figure with a broom stands across the wet cobbles, near a lit stairwell door.',
      },
    ],
    's-caretaker': [
      {
        id: 'p-caretaker',
        src: '/interactive/warsaw-noir/v1/s-caretaker.svg',
        width: 1200,
        height: 800,
        alt: 'A caretaker holding a broom stands under a hanging lamp in a brick gateway, rain falling in the courtyard behind her and a long shadow across the cobbles.',
      },
    ],
    's-mailboxes': [
      {
        id: 'p-mailboxes',
        src: '/interactive/warsaw-noir/v1/s-mailboxes.svg',
        width: 1200,
        height: 800,
        alt: 'Two rows of dented metal mailboxes in a dim stairwell under a bare bulb, with a small folded sheet of paper wedged behind the end of the row.',
      },
    ],
    's-door': [
      {
        id: 'p-door',
        src: '/interactive/warsaw-noir/v1/s-door.svg',
        width: 1200,
        height: 800,
        alt: 'A silent fourth-floor landing: a closed wooden door with a dozen letters wedged in its frame, a rain-streaked window to one side and a stair rail in the foreground.',
      },
    ],
    's-flat': [
      {
        id: 'p-flat',
        src: '/interactive/warsaw-noir/v1/s-flat.svg',
        width: 1200,
        height: 800,
        alt: 'A dark flat at night. A desk lamp still burns over a cold half-eaten meal, with a small note taped beneath the lamp and a rainy window behind an empty chair.',
      },
    ],
    's-cellar': [
      {
        id: 'p-cellar',
        src: '/interactive/warsaw-noir/v1/s-cellar.svg',
        width: 1200,
        height: 800,
        alt: 'A brick-vaulted cellar workshop lit by one hanging bulb. A man stands behind a workbench in front of a wall of tools, and a strip of light shows under the door at the left.',
      },
    ],
    's-end-quiet': [
      {
        id: 'p-end-quiet',
        src: '/interactive/warsaw-noir/v1/s-end-quiet.svg',
        width: 1200,
        height: 800,
        alt: 'A lone cyclist rides away down a rain-washed street at night, away from the glowing arch of a courtyard gate, past a row of dwindling street lamps.',
      },
    ],
    's-end-exposed': [
      {
        id: 'p-end-exposed',
        src: '/interactive/warsaw-noir/v1/s-end-exposed.svg',
        width: 1200,
        height: 800,
        alt: 'A lamp-lit table with an open ledger on it, a still figure with a broom standing across from it, and a rainy window where the sky is turning pale with early morning light.',
      },
    ],
  },
} satisfies PresentationPack;

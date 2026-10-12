import type { ScenarioDefinition } from '../../domain/scenario-schema';
import type { ScenarioBrief } from '../brief';

/**
 * Evaluation-corpus fixture: single-use inventory and reconverging branches.
 * Two one-time items (a spare key and a spare fuse) can each be spent once, the
 * key on either of two jobs; spending one closes choices later in the story.
 * Four different routes reconverge on one scene and two on one ending, and the
 * narration there depends on what was spent and what was kept.
 *
 * Original and fictional: the Hollin Clock Museum and its people are invented.
 * Hand-authored and scripted; it is NOT registered, has no catalogue entry or
 * presentation pack, and is never served to players.
 */

export const CLOCK_BLACKOUT_BRIEF: ScenarioBrief = {
  scenarioId: 'clock-museum-blackout',
  version: 1,
  premise:
    'During a winter power cut at a small fictional clock museum, the conservator holds one spare brass key and has an hour of generator fuel to decide whether the founder regulator clock runs again tonight.',
  setting:
    'The lobby, workshop, gallery and regulator room of the Hollin Clock Museum, a small invented museum in a quiet provincial town.',
  tone: 'Quiet, tactile and a little tense; a puzzle about what can only be spent once.',
  characters: [
    {
      id: 'mira',
      name: 'Mira Holloway',
      role: 'Museum conservator',
      description:
        'Careful and unhurried; she would rather leave an object alone than risk it for a gesture.',
      isPlayer: true,
    },
    {
      id: 'jonas',
      name: 'Jonas Pike',
      role: 'Night guard',
      description:
        'A retired railway signalman who knows every door, and every draught, in the building.',
      isPlayer: false,
    },
    {
      id: 'cecily',
      name: 'Cecily Ward',
      role: 'Visiting horologist',
      description:
        'Exacting and a little theatrical; she came to see the regulator run and is not used to disappointment.',
      isPlayer: false,
    },
  ],
  endings: [
    {
      id: 'regulator-restarted',
      title: 'The Regulator Runs',
      concept:
        'Mira opens the case and starts the pendulum, and the founder clock keeps time through the rest of the blackout.',
    },
    {
      id: 'regulator-preserved',
      title: 'The Regulator Rests',
      concept:
        'Mira leaves the clock stopped and untouched, and records its condition so the morning restorers can decide.',
    },
  ],
};

export const CLOCK_BLACKOUT_SCENARIO: ScenarioDefinition = {
  id: 'clock-museum-blackout',
  version: 1,
  language: 'en',
  title: 'The Regulator Clock',
  entrySceneId: 's-lobby',
  characters: [
    { id: 'mira', name: 'Mira Holloway', role: 'Museum conservator', isPlayer: true },
    { id: 'jonas', name: 'Jonas Pike', role: 'Night guard', isPlayer: false },
    { id: 'cecily', name: 'Cecily Ward', role: 'Visiting horologist', isPlayer: false },
  ],
  facts: [
    {
      id: 'f-generator-hour',
      text: 'The backup generator has fuel for about one more hour.',
    },
    {
      id: 'f-fuse-in-cabinet',
      text: 'The only spare fuse is kept in the locked workshop cabinet.',
    },
    {
      id: 'f-case-needs-key',
      text: 'The regulator’s glass case opens only with the spare brass key.',
    },
    {
      id: 'f-case-open-risk',
      text: 'Opening the glass case in the dark risks knocking the pendulum.',
    },
    {
      id: 'f-lights-back',
      text: 'The gallery lights are back on.',
    },
  ],
  items: [
    { id: 'spare-key', name: 'Spare brass key', oneTime: true },
    { id: 'fuse', name: 'Spare fuse', oneTime: true },
  ],
  flags: [
    'workshop-opened',
    'crossed-gallery',
    'lights-restored',
    'case-opened-early',
    'case-opened-late',
    'case-left-shut',
  ],
  initial: {
    playerKnowledge: ['f-generator-hour', 'f-fuse-in-cabinet', 'f-case-needs-key'],
    npcKnowledge: {
      jonas: ['f-generator-hour', 'f-fuse-in-cabinet'],
      cecily: ['f-case-needs-key', 'f-case-open-risk'],
    },
    inventory: ['spare-key'],
  },
  scenes: [
    {
      id: 's-lobby',
      title: 'The dark lobby',
      narration: [
        {
          id: 't-lobby-base',
          text: 'The power went at nine, and the lobby is lit only by the afterglow of the exit signs and the guard’s torch. Mira Holloway stands at the foot of the stairs with a single brass key warm in her fist.',
        },
        {
          id: 't-lobby-jonas',
          text: '“Generator has an hour in it, no more,” Jonas says, swinging the torch toward the workshop stair. “And the one spare fuse is in the cabinet down there.”',
          speakerId: 'jonas',
          factIds: ['f-generator-hour', 'f-fuse-in-cabinet'],
        },
        {
          id: 't-lobby-mira',
          text: '“The same key fits the regulator’s case,” Mira reminds him. “It can do one of those two jobs tonight, and then it is finished.”',
          speakerId: 'mira',
          factIds: ['f-case-needs-key'],
        },
      ],
      choices: [
        {
          id: 'c-open-workshop',
          label: 'Use the brass key on the workshop cabinet and take the spare fuse',
          to: 's-workshop',
          requires: [
            { kind: 'hasItem', item: 'spare-key' },
            { kind: 'playerKnows', fact: 'f-fuse-in-cabinet' },
          ],
          effects: [
            { kind: 'consumeItem', item: 'spare-key' },
            { kind: 'giveItem', item: 'fuse' },
            { kind: 'setFlag', flag: 'workshop-opened' },
          ],
        },
        {
          id: 'c-cross-gallery',
          label: 'Keep the key and feel her way across the dark gallery',
          to: 's-gallery',
          effects: [{ kind: 'setFlag', flag: 'crossed-gallery' }],
        },
      ],
    },
    {
      id: 's-workshop',
      title: 'The workshop',
      narration: [
        {
          id: 't-workshop-base',
          text: 'The cabinet lock turns once, and the brass key will not come back out of it; it has bent a hair in the barrel and will never turn another lock. Inside, wrapped in a clean cloth, is the spare fuse.',
        },
      ],
      choices: [
        {
          id: 'c-carry-fuse-to-regulator',
          label: 'Carry the fuse through the dark to the regulator room',
          to: 's-regulator-room',
          effects: [],
        },
      ],
    },
    {
      id: 's-gallery',
      title: 'The dark gallery',
      narration: [
        {
          id: 't-gallery-base',
          text: 'Mira crosses the gallery by touch, one palm on the glass of each case, past a hundred silent faces. The key stays in her pocket, still unspent.',
        },
      ],
      choices: [
        {
          id: 'c-reach-the-regulator',
          label: 'Follow the wall to the regulator room',
          to: 's-regulator-room',
          effects: [],
        },
      ],
    },
    {
      id: 's-regulator-room',
      title: 'The regulator room',
      narration: [
        {
          id: 't-regulator-base',
          text: 'The founder’s regulator stands against the far wall, its pendulum hanging dead still behind a pane of glass. The room is cold, and the only light comes from Jonas’s torch at the door.',
        },
        {
          id: 't-regulator-cecily',
          text: '“If that case is opened in this gloom, one clumsy elbow is all it takes,” Cecily says. “I came a long way to see it run, but I would rather see it whole and still.”',
          speakerId: 'cecily',
          factIds: ['f-case-open-risk'],
        },
        {
          id: 't-regulator-fuse',
          text: 'The spare fuse sits in Mira’s palm, and the key that fetched it is gone for good.',
          when: [{ kind: 'flag', flag: 'workshop-opened' }],
        },
        {
          id: 't-regulator-key',
          text: 'The brass key is still in Mira’s pocket, and nothing waits in her other hand.',
          when: [{ kind: 'flag', flag: 'crossed-gallery' }],
        },
      ],
      choices: [
        {
          id: 'c-fit-fuse',
          label: 'Fit the spare fuse and bring the gallery lights back',
          to: 's-clock-face',
          requires: [{ kind: 'hasItem', item: 'fuse' }],
          effects: [
            { kind: 'consumeItem', item: 'fuse' },
            { kind: 'learnFact', fact: 'f-lights-back' },
            { kind: 'npcLearns', character: 'jonas', fact: 'f-lights-back' },
            { kind: 'setFlag', flag: 'lights-restored' },
          ],
        },
        {
          id: 'c-unlock-glass-case',
          label: 'Use the brass key to unlock the regulator’s glass case',
          to: 's-clock-face',
          requires: [
            { kind: 'hasItem', item: 'spare-key' },
            { kind: 'playerKnows', fact: 'f-case-needs-key' },
          ],
          effects: [
            { kind: 'consumeItem', item: 'spare-key' },
            { kind: 'setFlag', flag: 'case-opened-early' },
          ],
        },
        {
          id: 'c-leave-case-shut',
          label: 'Leave the case shut for now',
          to: 's-clock-face',
          effects: [{ kind: 'setFlag', flag: 'case-left-shut' }],
        },
      ],
    },
    {
      id: 's-clock-face',
      title: 'The clock face',
      narration: [
        {
          id: 't-clockface-base',
          text: 'Close up, the dial is plain: white enamel, black numerals, a single second hand frozen between two marks. A small brass plate beneath it carries the founder’s name and a date a hundred years gone.',
        },
        {
          id: 't-clockface-lit',
          text: '“Lights are back,” Jonas calls from the doorway, and the dial brightens as the gallery fills with a steady yellow glow. “I can see the whole thing now. Mind it.”',
          speakerId: 'jonas',
          factIds: ['f-lights-back'],
          when: [{ kind: 'flag', flag: 'lights-restored' }],
        },
        {
          id: 't-clockface-dark',
          text: 'Without the lights, the dial is a pale disc in Jonas’s torch beam, and every shadow looks like a hand that is not there.',
          when: [{ kind: 'notFlag', flag: 'lights-restored' }],
        },
        {
          id: 't-clockface-open',
          text: 'The glass case stands open at Mira’s elbow, the pendulum within reach and perfectly still.',
          when: [{ kind: 'flag', flag: 'case-opened-early' }],
        },
        {
          id: 't-clockface-shut',
          text: 'The glass case is still shut, and the pendulum is still beyond reach.',
          when: [{ kind: 'flag', flag: 'case-left-shut' }],
        },
        {
          id: 't-clockface-key',
          text: 'The brass key is still in her pocket, unspent.',
          when: [{ kind: 'hasItem', item: 'spare-key' }],
        },
      ],
      choices: [
        {
          id: 'c-start-pendulum',
          label: 'Give the pendulum its gentle push',
          to: 's-ending-restarted',
          requires: [{ kind: 'flag', flag: 'case-opened-early' }],
          effects: [],
        },
        {
          id: 'c-open-case-and-start',
          label: 'Use the key on the case at last and start the pendulum',
          to: 's-ending-restarted',
          requires: [
            { kind: 'hasItem', item: 'spare-key' },
            { kind: 'playerKnows', fact: 'f-case-needs-key' },
          ],
          effects: [
            { kind: 'consumeItem', item: 'spare-key' },
            { kind: 'setFlag', flag: 'case-opened-late' },
          ],
        },
        {
          id: 'c-note-damage-and-lock-up',
          label: 'Record the clock’s condition and lock up for the night',
          to: 's-ending-preserved',
          effects: [],
        },
      ],
    },
    {
      id: 's-ending-restarted',
      title: 'The regulator runs',
      endingId: 'regulator-restarted',
      narration: [
        {
          id: 't-restarted-base',
          text: 'The pendulum swings once, hesitates, and finds its beat. The tick fills the room, patient and exact, and for a long moment nobody in it breathes.',
        },
        {
          id: 't-restarted-early',
          text: 'Mira had opened the case earlier with the key she brought, and so she needs only a fingertip to start it.',
          when: [{ kind: 'flag', flag: 'case-opened-early' }],
        },
        {
          id: 't-restarted-late',
          text: 'She had held the key back until the last moment, and the lock gives way to it only now, with the whole room watching.',
          when: [{ kind: 'flag', flag: 'case-opened-late' }],
        },
      ],
      choices: [],
    },
    {
      id: 's-ending-preserved',
      title: 'The regulator rests',
      endingId: 'regulator-preserved',
      narration: [
        {
          id: 't-preserved-base',
          text: 'The pendulum hangs where it has hung since the founder’s anniversary a year ago. Mira writes down the dial, the case, the date and the draught, and signs the page with the time.',
        },
        {
          id: 't-preserved-lit',
          text: 'The gallery lights are on at last, which will make the morning inspection easier.',
          when: [{ kind: 'flag', flag: 'lights-restored' }],
        },
        {
          id: 't-preserved-dark',
          text: 'The gallery stays dark; the restorers will bring their own lamps.',
          when: [{ kind: 'notFlag', flag: 'lights-restored' }],
        },
        {
          id: 't-preserved-open',
          text: 'She notes that the case was opened tonight and not started, and why.',
          when: [{ kind: 'flag', flag: 'case-opened-early' }],
        },
        {
          id: 't-preserved-shut',
          text: 'She notes that the case was never opened.',
          when: [{ kind: 'flag', flag: 'case-left-shut' }],
        },
        {
          id: 't-preserved-key',
          text: 'The spare key goes back on its hook, unspent.',
          when: [{ kind: 'hasItem', item: 'spare-key' }],
        },
      ],
      choices: [],
    },
  ],
  endings: [
    {
      id: 'regulator-restarted',
      title: 'The Regulator Runs',
      summary:
        'The founder’s regulator is running again, and it keeps time through the rest of the blackout.',
    },
    {
      id: 'regulator-preserved',
      title: 'The Regulator Rests',
      summary:
        'The regulator is left stopped and untouched, with its condition recorded for the morning restorers.',
    },
  ],
};

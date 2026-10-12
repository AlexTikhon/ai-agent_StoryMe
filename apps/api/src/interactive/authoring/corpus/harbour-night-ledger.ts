import type { ScenarioDefinition } from '../../domain/scenario-schema';
import type { ScenarioBrief } from '../brief';

/**
 * Evaluation-corpus fixture: knowledge-dependent dialogue. What the player has
 * learned decides which choices exist and what each character says, and what
 * the player tells Bram changes what Bram can voice. There are no items.
 *
 * Original and fictional: Port Kesterel, its people and every event are
 * invented. Hand-authored and scripted; it is NOT registered, has no catalogue
 * entry or presentation pack, and is never served to players.
 */

export const HARBOUR_LEDGER_BRIEF: ScenarioBrief = {
  scenarioId: 'harbour-night-ledger',
  version: 1,
  premise:
    'Before the first boats land at a small fictional harbour, the auction clerk finds page fourteen torn from the weekly sales ledger and has until the morning bell to learn who took it, and why.',
  setting:
    'The auction hall, the net-mending quay and the cold room of Port Kesterel, a small invented fishing harbour in the hour before dawn.',
  tone: 'Patient, wry and quietly humane; a puzzle about what people know and what they will say.',
  characters: [
    {
      id: 'ines',
      name: 'Ines Calloway',
      role: 'Harbour auction clerk',
      description:
        'Methodical and fair-minded; she keeps the co-operative accounts and notices what is missing from them.',
      isPlayer: true,
    },
    {
      id: 'bram',
      name: 'Bram Oakes',
      role: 'Quay foreman',
      description: 'A slow-talking net mender who says little unless he is sure of what he saw.',
      isPlayer: false,
    },
    {
      id: 'solveig',
      name: 'Solveig Marsh',
      role: 'Fish auctioneer',
      description:
        'Brisk and well liked, and quietly frightened that one bad sale will cost her the trust of the co-operative.',
      isPlayer: false,
    },
  ],
  endings: [
    {
      id: 'page-returned',
      title: 'The Page Returned',
      concept:
        'Solveig hands back the missing page and corrects the sale in the open, with Ines standing beside her.',
    },
    {
      id: 'ledger-sealed',
      title: 'The Ledger Sealed',
      concept:
        'With no way in, Ines seals the ledger with the gap recorded and leaves the question to the co-operative board.',
    },
  ],
};

export const HARBOUR_LEDGER_SCENARIO: ScenarioDefinition = {
  id: 'harbour-night-ledger',
  version: 1,
  language: 'en',
  title: 'The Missing Page',
  entrySceneId: 's-auction-hall',
  characters: [
    { id: 'ines', name: 'Ines Calloway', role: 'Harbour auction clerk', isPlayer: true },
    { id: 'bram', name: 'Bram Oakes', role: 'Quay foreman', isPlayer: false },
    { id: 'solveig', name: 'Solveig Marsh', role: 'Fish auctioneer', isPlayer: false },
  ],
  facts: [
    {
      id: 'f-page-missing',
      text: 'Page fourteen of the weekly auction ledger has been torn out.',
    },
    {
      id: 'f-edge-frozen',
      text: 'The torn edge of the ledger is stiff with frost, so the page was torn out in the cold room.',
    },
    {
      id: 'f-bram-saw-solveig',
      text: 'Bram saw Solveig carry the ledger into the cold room after the auction closed.',
    },
    {
      id: 'f-solveig-afraid',
      text: 'Solveig fears the co-operative will think she cheated the fishermen on one sale.',
    },
    {
      id: 'f-page-sold-short',
      text: 'Page fourteen recorded a crate of eels sold far below market price to Solveig’s cousin.',
    },
  ],
  items: [],
  flags: ['ledger-read', 'bram-pressed', 'bram-chatted'],
  initial: {
    playerKnowledge: ['f-page-missing'],
    npcKnowledge: {
      bram: ['f-bram-saw-solveig', 'f-solveig-afraid'],
      solveig: ['f-solveig-afraid', 'f-page-sold-short'],
    },
    inventory: [],
  },
  scenes: [
    {
      id: 's-auction-hall',
      title: 'The auction hall',
      narration: [
        {
          id: 't-hall-base',
          text: 'The auction hall smells of salt and wet pine. Ines Calloway, the harbour clerk, opens the weekly ledger on the tally desk and counts the pages twice, because the first count cannot be right.',
        },
        {
          id: 't-hall-ines',
          text: '“Page fourteen is gone,” Ines says to the empty hall. “Torn out, not lost.” Outside, the first lamps are going out along the quay, and the morning bell is not far off.',
          speakerId: 'ines',
          factIds: ['f-page-missing'],
        },
      ],
      choices: [
        {
          id: 'c-read-ledger',
          label: 'Study the torn edge of the ledger under the lamp',
          to: 's-ledger-desk',
          effects: [
            { kind: 'learnFact', fact: 'f-edge-frozen' },
            { kind: 'setFlag', flag: 'ledger-read' },
          ],
        },
        {
          id: 'c-go-to-quay',
          label: 'Leave the ledger on the desk and go straight to the quay',
          to: 's-quay',
          effects: [],
        },
      ],
    },
    {
      id: 's-ledger-desk',
      title: 'The torn edge',
      narration: [
        {
          id: 't-desk-base',
          text: 'Under the lamp the stub of page fourteen is ragged, and a fine white crust clings to it. Ines scrapes a little onto her thumbnail and it melts at once.',
        },
        {
          id: 't-desk-frost',
          text: '“Frost,” she says. “This page was torn out where it is cold enough to freeze paper. There is only one room in the harbour like that.”',
          speakerId: 'ines',
          factIds: ['f-edge-frozen'],
        },
      ],
      choices: [
        {
          id: 'c-carry-ledger-to-quay',
          label: 'Tuck the ledger under her arm and walk down to the quay',
          to: 's-quay',
          effects: [],
        },
      ],
    },
    {
      id: 's-quay',
      title: 'The net-mending quay',
      narration: [
        {
          id: 't-quay-base',
          text: 'Grey light is coming up behind the cranes. On the quay, Bram Oakes sits among drying nets with a netting needle in his fist, and he does not look up when Ines arrives.',
        },
        {
          id: 't-quay-guarded',
          text: 'Bram says only that he went home after the auction and that the hall is not his business. His needle never stops moving.',
          speakerId: 'bram',
          when: [{ kind: 'notFlag', flag: 'ledger-read' }],
        },
        {
          id: 't-quay-frost',
          text: '“The torn edge is frozen,” Ines says, holding the ledger so Bram can see the white crust. “Whoever took that page took it into the cold room.”',
          speakerId: 'ines',
          factIds: ['f-edge-frozen'],
          when: [{ kind: 'flag', flag: 'ledger-read' }],
        },
      ],
      choices: [
        {
          id: 'c-press-bram',
          label: 'Tell Bram about the frost and ask what he saw',
          to: 's-bram-names-her',
          requires: [{ kind: 'playerKnows', fact: 'f-edge-frozen' }],
          effects: [
            { kind: 'learnFact', fact: 'f-bram-saw-solveig' },
            { kind: 'npcLearns', character: 'bram', fact: 'f-edge-frozen' },
            { kind: 'setFlag', flag: 'bram-pressed' },
          ],
        },
        {
          id: 'c-small-talk',
          label: 'Ask Bram how the night went and let him talk',
          to: 's-bram-shrugs',
          effects: [
            { kind: 'learnFact', fact: 'f-solveig-afraid' },
            { kind: 'setFlag', flag: 'bram-chatted' },
          ],
        },
      ],
    },
    {
      id: 's-bram-names-her',
      title: 'What Bram saw',
      narration: [
        {
          id: 't-names-base',
          text: 'Bram sets down his needle for the first time. For a while the only sound is the water slapping at the piles.',
        },
        {
          id: 't-names-bram',
          text: '“Frost on the paper,” Bram says slowly. “Then you already know where it went. I watched Solveig carry that ledger into the cold room after the auction closed, and she would not meet my eye coming out.”',
          speakerId: 'bram',
          factIds: ['f-edge-frozen', 'f-bram-saw-solveig'],
        },
      ],
      choices: [
        {
          id: 'c-walk-to-cold-room',
          label: 'Thank him and walk to the cold room',
          to: 's-cold-room',
          effects: [],
        },
      ],
    },
    {
      id: 's-bram-shrugs',
      title: 'Harbour gossip',
      narration: [
        {
          id: 't-shrugs-base',
          text: 'Bram talks about the tide tables, the price of diesel, and a gull that has stolen his sandwich three mornings running. He is easier with Ines than he was.',
        },
        {
          id: 't-shrugs-bram',
          text: '“Solveig has been jumpy since the board asked about the eel sale,” he says, almost to himself. “She thinks the lads believe she cheated them. She would not, though. Not Solveig.”',
          speakerId: 'bram',
          factIds: ['f-solveig-afraid'],
        },
        {
          id: 't-shrugs-held-back',
          text: 'Ines keeps the frost on the ledger to herself for now. Bram has not asked, and she is not sure what it would cost him to know.',
          when: [{ kind: 'flag', flag: 'ledger-read' }],
        },
      ],
      choices: [
        {
          id: 'c-head-to-cold-room',
          label: 'Head for the cold room',
          to: 's-cold-room',
          effects: [],
        },
      ],
    },
    {
      id: 's-cold-room',
      title: 'The cold room',
      narration: [
        {
          id: 't-cold-base',
          text: 'The cold room door sighs shut behind Ines. Frost furs the rails, and Solveig Marsh stands among the ice crates with her breath showing, holding nothing, doing nothing, as though she has been waiting for someone to come.',
        },
        {
          id: 't-cold-ines-evidence',
          text: 'Ines says it plainly: Bram saw her carry the ledger in here after the auction closed. Solveig’s shoulders go very still.',
          speakerId: 'ines',
          factIds: ['f-bram-saw-solveig'],
          when: [{ kind: 'flag', flag: 'bram-pressed' }],
        },
        {
          id: 't-cold-solveig-afraid',
          text: '“Everyone thinks I cheated them,” Solveig says before Ines has asked a thing. “I did not. But I know how a bad sale looks when it is written down.”',
          speakerId: 'solveig',
          factIds: ['f-solveig-afraid'],
          when: [{ kind: 'flag', flag: 'bram-chatted' }],
        },
      ],
      choices: [
        {
          id: 'c-name-the-page',
          label: 'Say what Bram saw and ask for page fourteen',
          to: 's-ending-returned',
          requires: [{ kind: 'playerKnows', fact: 'f-bram-saw-solveig' }],
          effects: [],
        },
        {
          id: 'c-offer-quiet-word',
          label: 'Say she understands the fear, and ask for the page as a favour',
          to: 's-ending-returned',
          requires: [{ kind: 'playerKnows', fact: 'f-solveig-afraid' }],
          effects: [],
        },
        {
          id: 'c-seal-the-ledger',
          label: 'Say nothing, seal the ledger and note the gap',
          to: 's-ending-sealed',
          effects: [],
        },
      ],
    },
    {
      id: 's-ending-returned',
      title: 'Page fourteen',
      endingId: 'page-returned',
      narration: [
        {
          id: 't-returned-base',
          text: 'Solveig unbuttons her coat and takes a folded, frost-stiff page from the inside pocket. She smooths it on a crate lid, and Ines finds the line where a price was written and then crossed through.',
        },
        {
          id: 't-returned-evidence',
          text: '“A crate of eels, sold to my cousin for a third of what it was worth,” Solveig says. “I wrote it down honestly and then I tore it out, because I could not bear to read it. Bram saw me, and he was right to.”',
          speakerId: 'solveig',
          factIds: ['f-page-sold-short'],
          when: [{ kind: 'flag', flag: 'bram-pressed' }],
        },
        {
          id: 't-returned-empathy',
          text: '“You were not going to hang me for it, were you,” Solveig says, half laughing, half not. “I was so afraid they would think I cheated that I did exactly what a cheat would do.”',
          speakerId: 'solveig',
          factIds: ['f-solveig-afraid'],
          when: [{ kind: 'flag', flag: 'bram-chatted' }],
        },
      ],
      choices: [],
    },
    {
      id: 's-ending-sealed',
      title: 'Sealed until the board',
      endingId: 'ledger-sealed',
      narration: [
        {
          id: 't-sealed-base',
          text: 'Ines closes the ledger, ties the tape and signs across the seal. The gap where page fourteen should be goes into the margin in her neat clerk’s hand: removed, by whom unknown, to be put to the board.',
        },
        {
          id: 't-sealed-frost',
          text: 'She adds one line she is sure of: the torn edge was frozen, so the page was taken to the cold room. Past that, the ledger will not say.',
          speakerId: 'ines',
          factIds: ['f-edge-frozen'],
          when: [{ kind: 'flag', flag: 'ledger-read' }],
        },
        {
          id: 't-sealed-unknown',
          text: 'She adds no theory. A clerk writes down what the book shows, and the book shows only a gap.',
          when: [{ kind: 'notFlag', flag: 'ledger-read' }],
        },
      ],
      choices: [],
    },
  ],
  endings: [
    {
      id: 'page-returned',
      title: 'The Page Returned',
      summary:
        'Solveig hands back the torn page and corrects the sale in the open, and the co-operative keeps both its book and its auctioneer.',
    },
    {
      id: 'ledger-sealed',
      title: 'The Ledger Sealed',
      summary:
        'The ledger is sealed with its gap recorded, and what became of page fourteen is left for the co-operative board to ask.',
    },
  ],
};

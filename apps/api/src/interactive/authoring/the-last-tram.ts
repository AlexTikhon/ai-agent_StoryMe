import type { ScenarioDefinition } from '../domain/scenario-schema';
import type { ScenarioBrief } from './brief';

/**
 * Original, fictional mock episode used by the deterministic mock provider and
 * as the worked example. Characters, the charity drive and every event are
 * invented; nothing here refers to a real crime, person or historical fact.
 * It is NOT registered in the scenario registry and is never served to players.
 */

export const LAST_TRAM_BRIEF: ScenarioBrief = {
  scenarioId: 'warsaw-last-tram',
  version: 1,
  premise:
    'On the last tram of a contemporary Warsaw night, a charity drive cash box vanishes between two stops, and the night inspector has until the terminus to learn what happened.',
  setting:
    'A nearly empty night tram crossing present-day Warsaw, from the Wola loop to the end of the line.',
  tone: 'Quiet, low-stakes, humane mystery with a little dry humour.',
  characters: [
    {
      id: 'nina',
      name: 'Nina Sadowska',
      role: 'Night tram inspector',
      description: 'Patient and observant; she would rather solve a problem than punish anyone.',
      isPlayer: true,
    },
    {
      id: 'wiktor',
      name: 'Wiktor Lis',
      role: 'Tram driver',
      description: 'A gruff driver of nineteen years who notices everything in his mirrors.',
      isPlayer: false,
    },
    {
      id: 'hanna',
      name: 'Hanna Brzoza',
      role: 'Charity volunteer treasurer',
      description: 'An anxious, conscientious volunteer who is hiding a small, desperate secret.',
      isPlayer: false,
    },
  ],
  endings: [
    {
      id: 'report-filed',
      title: 'Report Filed',
      concept: 'Nina follows procedure and files an incident report with the depot supervisor.',
    },
    {
      id: 'quiet-repayment',
      title: 'A Quiet Repayment',
      concept: 'Nina gives Hanna the chance to repay the money herself, without a formal report.',
    },
  ],
};

export const LAST_TRAM_SCENARIO: ScenarioDefinition = {
  id: 'warsaw-last-tram',
  version: 1,
  language: 'en',
  title: 'The Last Tram',
  entrySceneId: 's-boarding',
  characters: [
    { id: 'nina', name: 'Nina Sadowska', role: 'Night tram inspector', isPlayer: true },
    { id: 'wiktor', name: 'Wiktor Lis', role: 'Tram driver', isPlayer: false },
    { id: 'hanna', name: 'Hanna Brzoza', role: 'Charity volunteer treasurer', isPlayer: false },
  ],
  facts: [
    {
      id: 'f-box-missing',
      text: 'The charity cash box disappeared from the rear platform between two stops.',
    },
    {
      id: 'f-driver-saw-hanna',
      text: 'Wiktor saw Hanna kneeling by the rear service panel at the ninth stop.',
    },
    {
      id: 'f-receipt-shortfall',
      text: 'The float receipt is 480 zloty lower than the total on the charity poster.',
    },
    {
      id: 'f-box-under-panel',
      text: 'The cash box is hidden behind the rear service panel.',
    },
    {
      id: 'f-hanna-borrowed',
      text: 'Hanna borrowed the money to cover a deposit and meant to repay it by morning.',
    },
  ],
  items: [
    { id: 'service-key', name: 'Brass panel key', oneTime: true },
    { id: 'torn-receipt', name: 'Torn float receipt', oneTime: false },
  ],
  flags: ['asked-driver', 'searched-carriage', 'panel-opened', 'receipt-shown', 'waited-quietly'],
  initial: {
    playerKnowledge: ['f-box-missing'],
    npcKnowledge: {
      wiktor: ['f-driver-saw-hanna'],
      hanna: ['f-box-under-panel', 'f-hanna-borrowed', 'f-receipt-shortfall'],
    },
    inventory: [],
  },
  scenes: [
    {
      id: 's-boarding',
      title: 'The Wola loop',
      narration: [
        {
          id: 't-boarding-arrive',
          text: 'The last tram of the night idles at the Wola loop, its windows yellow against the dark. Nina Sadowska, the night inspector, steps aboard with the shift report still folded in her glove.',
        },
        {
          id: 't-boarding-nina',
          text: 'Nina goes over what she has been told: the volunteers’ cash box was on the rear platform earlier tonight, and somewhere between two stops it vanished.',
          speakerId: 'nina',
          factIds: ['f-box-missing'],
        },
        {
          id: 't-boarding-crew',
          text: 'Up front, driver Wiktor Lis stares straight ahead. Behind him, volunteer treasurer Hanna Brzoza hugs a clipboard and does not look up.',
        },
      ],
      choices: [
        {
          id: 'c-ask-driver',
          label: 'Ask Wiktor what he saw from the cab',
          to: 's-cab',
          effects: [
            { kind: 'learnFact', fact: 'f-driver-saw-hanna' },
            { kind: 'giveItem', item: 'service-key' },
            { kind: 'setFlag', flag: 'asked-driver' },
          ],
        },
        {
          id: 'c-inspect-carriage',
          label: 'Search the carriage floor and seats',
          to: 's-carriage',
          effects: [
            { kind: 'learnFact', fact: 'f-receipt-shortfall' },
            { kind: 'giveItem', item: 'torn-receipt' },
            { kind: 'setFlag', flag: 'searched-carriage' },
          ],
        },
      ],
    },
    {
      id: 's-cab',
      title: 'Wiktor’s cab',
      narration: [
        {
          id: 't-cab-intro',
          text: 'Wiktor keeps one hand on the controller and speaks to the windscreen. He has driven this line for nineteen years and does not enjoy questions in the dark.',
        },
        {
          id: 't-cab-saw-hanna',
          text: '“At the ninth stop I glanced in the mirror,” Wiktor says. “Hanna was kneeling by the rear service panel. I thought she had dropped a coin.”',
          speakerId: 'wiktor',
          factIds: ['f-driver-saw-hanna'],
        },
        {
          id: 't-cab-key',
          text: 'He slides a flat brass key across the dashboard. “In case you want a look behind that panel. The depot does not need to know I lent it.”',
        },
      ],
      choices: [
        {
          id: 'c-leave-cab',
          label: 'Take the key and walk back down the aisle',
          to: 's-midline',
          effects: [],
        },
      ],
    },
    {
      id: 's-carriage',
      title: 'The carriage floor',
      narration: [
        {
          id: 't-carriage-intro',
          text: 'Under the rear bench, between a lost glove and a dried orange peel, Nina finds a torn slip of paper with the charity’s logo printed along the top.',
        },
        {
          id: 't-carriage-receipt',
          text: 'It is a float receipt. The total written on it is 480 zloty lower than the figure on the charity poster above the doors.',
          speakerId: 'nina',
          factIds: ['f-receipt-shortfall'],
        },
      ],
      choices: [
        {
          id: 'c-pocket-receipt',
          label: 'Pocket the receipt and move toward the middle of the tram',
          to: 's-midline',
          effects: [],
        },
      ],
    },
    {
      id: 's-midline',
      title: 'Between stops',
      narration: [
        {
          id: 't-midline-intro',
          text: 'The tram rocks through the empty streets. Hanna half rises as Nina approaches, then sits again. The rear service panel gives a faint metallic knock whenever the carriage shakes.',
        },
        {
          id: 't-midline-key',
          text: 'Wiktor’s brass key sits heavy in Nina’s pocket.',
          when: [{ kind: 'flag', flag: 'asked-driver' }],
        },
        {
          id: 't-midline-receipt',
          text: 'The torn receipt is folded small inside her glove.',
          when: [{ kind: 'flag', flag: 'searched-carriage' }],
        },
      ],
      choices: [
        {
          id: 'c-open-panel',
          label: 'Use the brass key on the rear service panel',
          to: 's-terminus',
          requires: [{ kind: 'hasItem', item: 'service-key' }],
          effects: [
            { kind: 'consumeItem', item: 'service-key' },
            { kind: 'learnFact', fact: 'f-box-under-panel' },
            { kind: 'setFlag', flag: 'panel-opened' },
          ],
        },
        {
          id: 'c-show-receipt',
          label: 'Show Hanna the torn receipt and ask about the shortfall',
          to: 's-terminus',
          requires: [{ kind: 'hasItem', item: 'torn-receipt' }],
          effects: [
            { kind: 'learnFact', fact: 'f-hanna-borrowed' },
            { kind: 'npcLearns', character: 'wiktor', fact: 'f-hanna-borrowed' },
            { kind: 'setFlag', flag: 'receipt-shown' },
          ],
        },
        {
          id: 'c-wait-for-terminus',
          label: 'Say nothing and let the tram run to the end of the line',
          to: 's-terminus',
          effects: [{ kind: 'setFlag', flag: 'waited-quietly' }],
        },
      ],
    },
    {
      id: 's-terminus',
      title: 'The end of the line',
      narration: [
        {
          id: 't-terminus-arrive',
          text: 'The tram sighs to a stop at the terminus. The doors fold open onto an empty platform and one flickering lamp.',
        },
        {
          id: 't-terminus-panel',
          text: 'Nina carries the cash box she found behind the panel out onto the platform. Its lid is dented, but its lock is intact.',
          speakerId: 'nina',
          factIds: ['f-box-under-panel'],
          when: [{ kind: 'flag', flag: 'panel-opened' }],
        },
        {
          id: 't-terminus-receipt',
          text: '“I only meant to borrow the money,” Hanna says, staring at the receipt. “A deposit was due on Friday. I would have put it back by morning.” Up front, Wiktor’s eyes lift to his mirror, and he says nothing.',
          speakerId: 'hanna',
          factIds: ['f-hanna-borrowed'],
          when: [{ kind: 'flag', flag: 'receipt-shown' }],
        },
        {
          id: 't-terminus-waited',
          text: 'Nobody speaks. Hanna studies her clipboard, Wiktor studies the windscreen, and the box stays missing.',
          when: [{ kind: 'flag', flag: 'waited-quietly' }],
        },
      ],
      choices: [
        {
          id: 'c-report-to-depot',
          label: 'File an incident report with the depot supervisor',
          to: 's-ending-report',
          effects: [],
        },
        {
          id: 'c-let-hanna-repay',
          label: 'Give Hanna until morning to return the money herself',
          to: 's-ending-quiet',
          requires: [{ kind: 'playerKnows', fact: 'f-hanna-borrowed' }],
          effects: [],
        },
      ],
    },
    {
      id: 's-ending-report',
      title: 'A report at the depot',
      endingId: 'report-filed',
      narration: [
        {
          id: 't-report-base',
          text: 'Nina writes the incident into the depot log in careful block capitals. By the time the supervisor arrives, the platform lamp has stopped flickering and the paperwork is done.',
        },
        {
          id: 't-report-driver',
          text: 'Wiktor confirms what he saw in his mirror at the ninth stop. His statement is short and exact.',
          speakerId: 'wiktor',
          factIds: ['f-driver-saw-hanna'],
          when: [{ kind: 'flag', flag: 'asked-driver' }],
        },
        {
          id: 't-report-recovered',
          text: 'Nina logs the recovered box, its dented lid and intact lock, and the panel where she found it. How it came to be there is left for the supervisor to ask.',
          when: [{ kind: 'flag', flag: 'panel-opened' }],
        },
        {
          id: 't-report-confession',
          text: 'Hanna’s own account of the borrowed money goes into the log beside the torn receipt. The box itself is still missing.',
          when: [{ kind: 'flag', flag: 'receipt-shown' }],
        },
        {
          id: 't-report-waited',
          text: 'The log records the box as missing, and no one has said where it went.',
          when: [{ kind: 'flag', flag: 'waited-quietly' }],
        },
      ],
      choices: [],
    },
    {
      id: 's-ending-quiet',
      title: 'Until morning',
      endingId: 'quiet-repayment',
      narration: [
        {
          id: 't-quiet-base',
          text: 'Nina closes her notebook without writing a word. The tram’s brakes tick as they cool, and Hanna nods once, her hands trembling around the clipboard.',
        },
        {
          id: 't-quiet-hanna',
          text: '“The box and the money will both be back by morning,” Hanna whispers.',
          speakerId: 'hanna',
        },
        {
          id: 't-quiet-driver',
          text: '“She will bring it back,” Wiktor says quietly. “I will make sure of it.”',
          speakerId: 'wiktor',
          factIds: ['f-hanna-borrowed'],
        },
      ],
      choices: [],
    },
  ],
  endings: [
    {
      id: 'report-filed',
      title: 'Report Filed',
      summary:
        'The incident is logged and passed to the depot supervisor, and the matter leaves Nina’s hands.',
    },
    {
      id: 'quiet-repayment',
      title: 'A Quiet Repayment',
      summary:
        'Nina lets Hanna set things right before morning, trusting that the charity will be whole again without a formal report.',
    },
  ],
};

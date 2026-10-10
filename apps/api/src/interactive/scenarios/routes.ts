/**
 * Known complete routes through warsaw-last-delivery v1, shared by tests and
 * the offline evaluation. Each is a list of choice ids from the entry scene.
 */
export const WARSAW_ROUTES = {
  /** Caretaker -> flat -> cellar -> confront Ines. */
  exposed: [
    'c-ask-caretaker',
    'c-climb-from-caretaker',
    'c-use-card',
    'c-take-service-stairs',
    'c-confront-ines',
  ],
  /** Same path, but hand the parcel over instead of confronting. */
  quietViaFlat: [
    'c-ask-caretaker',
    'c-climb-from-caretaker',
    'c-use-card',
    'c-take-service-stairs',
    'c-hand-over-parcel',
  ],
  /** Mailbox clue -> stamp shortcut to the cellar (flat skipped, confrontation locked). */
  quietViaStamp: [
    'c-read-mailboxes',
    'c-climb-from-mailboxes',
    'c-follow-stamp',
    'c-hand-over-parcel',
  ],
  /** Leave the parcel at the door. */
  quietAtDoor: ['c-ask-caretaker', 'c-climb-from-caretaker', 'c-leave-parcel'],
} as const;

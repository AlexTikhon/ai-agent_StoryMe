import { Pronouns, type CharacterCard, type CharacterProfile } from '@book/types';
import { buildCharacterConsistencyBlock } from './story-generation-contracts';

/**
 * The only boundary that projects visual identity into a newly generated
 * CharacterCard. It copies the already-finalized CharacterProfile contract;
 * it never parses prose or invents unavailable physical characteristics.
 */
export function createCharacterCard(profile: CharacterProfile): CharacterCard {
  return {
    name: profile.childName,
    age: profile.age,
    pronouns: Pronouns.TheyThem,
    personality: {
      traits: [],
      favoriteAnimals: [],
      favoriteColors: [],
      favoriteToys: [],
      hobbies: [],
    },
    visualAnchor: profile.lockedVisualDescription ?? buildCharacterConsistencyBlock(profile),
    narrativeDescription: profile.personalitySummary,
  };
}

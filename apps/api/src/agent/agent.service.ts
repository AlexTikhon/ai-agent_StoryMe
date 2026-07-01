import { Injectable } from '@nestjs/common';
import { AgentLogStatus, AgentStep, BookStatus, Prisma, type Book } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { Pronouns, type CharacterCard, type PagePlan, type StoryPlan } from '@book/types';

function buildCharacterCard(name: string, age: number): CharacterCard {
  return {
    name,
    age,
    pronouns: Pronouns.SheHer,
    appearance: {
      hairColor: 'brown',
      hairStyle: 'wavy',
      eyeColor: 'brown',
      skinTone: 'medium',
      distinctiveFeatures: ['bright smile'],
    },
    personality: {
      traits: ['curious', 'brave', 'kind'],
      favoriteAnimals: ['rabbit', 'butterfly'],
      favoriteColors: ['purple', 'yellow'],
      favoriteToys: ['building blocks'],
      hobbies: ['drawing', 'exploring'],
    },
    visualAnchor: `A ${age}-year-old child named ${name} with wavy brown hair, brown eyes, and a bright smile`,
    narrativeDescription: `${name} is a ${age}-year-old child full of curiosity and wonder, always ready for a new adventure.`,
  };
}

function buildStoryPlan(name: string, theme: string): StoryPlan {
  const titleTheme = theme.split(' ')[0] ?? theme;
  return {
    title: `${name}'s ${titleTheme} Adventure`,
    theme,
    educationalMessage: `Through ${theme}, we learn the importance of courage, kindness, and believing in ourselves.`,
    openingHook: `One sunny morning, ${name} discovered something magical that would change everything.`,
    resolution: `${name} returned home with a heart full of joy, knowing that every adventure begins with a single brave step.`,
    chapters: [
      {
        chapterNumber: 1,
        title: 'A Magical Discovery',
        summary: `${name} finds something unexpected and decides to investigate.`,
        setting: 'The backyard garden',
        emotionalArc: 'curiosity to excitement',
        keyEvents: [`${name} notices a glowing light`, 'A friendly creature appears'],
        illustrableScenes: [`${name} discovering a glowing light in the garden`],
      },
      {
        chapterNumber: 2,
        title: 'The Journey Begins',
        summary: `${name} sets off on a journey and faces a small challenge with courage.`,
        setting: 'An enchanted forest',
        emotionalArc: 'nervousness to bravery',
        keyEvents: [`${name} and friend enter the forest`, 'They face a small challenge and overcome it'],
        illustrableScenes: [`${name} and friend walking through colorful mushrooms`],
      },
      {
        chapterNumber: 3,
        title: 'Home Again',
        summary: `${name} returns home having learned something important about ${theme}.`,
        setting: 'Home',
        emotionalArc: 'pride and happiness',
        keyEvents: [`${name} shares the story with family`, 'A final magical moment'],
        illustrableScenes: [`${name} hugging family with a big smile`],
      },
    ],
  };
}

function buildPagePlan(storyPlan: StoryPlan): PagePlan[] {
  const pages: PagePlan[] = [];
  let pageNumber = 1;

  for (let chapterIndex = 0; chapterIndex < storyPlan.chapters.length; chapterIndex++) {
    const chapter = storyPlan.chapters[chapterIndex]!;
    for (let pageInChapter = 1; pageInChapter <= 2; pageInChapter++) {
      const scene =
        chapter.illustrableScenes[pageInChapter - 1] ??
        `Scene ${pageInChapter} of ${chapter.title}`;
      pages.push({
        pageNumber: pageNumber++,
        chapterIndex,
        title: `${chapter.title} — Part ${pageInChapter}`,
        sceneDescription: scene,
        narration:
          pageInChapter === 1
            ? `${chapter.summary} It all began with ${scene.charAt(0).toLowerCase() + scene.slice(1)}.`
            : `The story continued as ${chapter.emotionalArc} filled the air.`,
        illustrationPrompt: `Children's book illustration: ${scene}, ${chapter.setting}, bright and colorful, watercolor style`,
        learningGoal: storyPlan.educationalMessage,
      });
    }
  }

  return pages;
}

@Injectable()
export class AgentService {
  constructor(private readonly prisma: PrismaService) {}

  async startBookGeneration(book: Book): Promise<Book> {
    const traceId = randomUUID();
    const childName = book.childName ?? 'Alex';
    const childAge = book.childAge ?? 6;
    const theme = book.theme ?? 'adventure';

    const characterCard = buildCharacterCard(childName, childAge);
    const storyPlan = buildStoryPlan(childName, theme);
    const pages = buildPagePlan(storyPlan);
    const storyPlanWithPages = { ...storyPlan, pages };

    const updated = await this.prisma.book.update({
      where: { id: book.id },
      data: {
        status: BookStatus.page_plan,
        title: storyPlan.title,
        characterCard: characterCard as unknown as Prisma.InputJsonValue,
        storyPlan: storyPlanWithPages as unknown as Prisma.InputJsonValue,
      },
    });

    await this.prisma.agentLog.createMany({
      data: [
        {
          bookId: book.id,
          agent: 'LocalPipelineAgent',
          step: AgentStep.char_build,
          status: AgentLogStatus.success,
          attempt: 1,
          traceId,
        },
        {
          bookId: book.id,
          agent: 'LocalPipelineAgent',
          step: AgentStep.story_plan,
          status: AgentLogStatus.success,
          attempt: 1,
          traceId,
        },
        {
          bookId: book.id,
          agent: 'LocalPipelineAgent',
          step: AgentStep.page_plan,
          status: AgentLogStatus.success,
          attempt: 1,
          traceId,
        },
      ],
    });

    return updated;
  }
}

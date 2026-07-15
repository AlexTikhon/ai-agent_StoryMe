import type { PrismaService } from '../../database/prisma.service';

type DeepMockOf<T> = {
  [K in keyof T]: T[K] extends (...args: unknown[]) => unknown
    ? ReturnType<typeof vi.fn>
    : T[K] extends object
      ? DeepMockOf<T[K]>
      : T[K];
};

/**
 * Creates a deep mock of PrismaService suitable for unit tests.
 *
 * Usage:
 *   const prisma = createMockPrisma();
 *   prisma.user.findUnique.mockResolvedValue({ id: '...', ... });
 */
export function createMockPrisma(): DeepMockOf<PrismaService> {
  const mockModel = () => ({
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    findFirst: vi.fn(),
    findFirstOrThrow: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    createMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    count: vi.fn(),
    aggregate: vi.fn(),
    groupBy: vi.fn(),
  });

  return {
    user: mockModel(),
    refreshToken: mockModel(),
    childProfile: mockModel(),
    upload: mockModel(),
    book: mockModel(),
    bookPage: mockModel(),
    characterCard: mockModel(),
    bookSeries: mockModel(),
    wizardDraft: mockModel(),
    shareLink: mockModel(),
    creditTransaction: mockModel(),
    subscription: mockModel(),
    agentLog: mockModel(),
    generationJob: mockModel(),
    generationRun: mockModel(),
    outboxEvent: mockModel(),
    recoveryLease: mockModel(),
    userBookState: mockModel(),
    notification: mockModel(),
    $connect: vi.fn().mockResolvedValue(undefined),
    $disconnect: vi.fn().mockResolvedValue(undefined),
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    onModuleInit: vi.fn().mockResolvedValue(undefined),
    onModuleDestroy: vi.fn().mockResolvedValue(undefined),
  } as unknown as DeepMockOf<PrismaService>;
}
